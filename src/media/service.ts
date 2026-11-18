import { log } from "../util/logger.js";
import {
  formatChatImageFollowUp,
  formatDuitangLinkCaption,
  formatInternalImageAttribution,
} from "./attribution.js";
import { cacheKey, getCachedHits, setCachedHits } from "./cache.js";
import {
  assertNotLocalPath,
  downloadImageSafely,
  ImageDownloadError,
  isRetryableImageDownloadError,
} from "./download.js";
import { isDeadImage, rememberDeadImage } from "./dead-urls.js";
import { normalizeImageSearchQuery } from "./entities.js";
import {
  buildDuitangQueries,
  buildImageProviderRegistry,
  enabledProviderIds,
  orderProvidersForSearch,
  searchAcrossProviders,
  type ImageSearchProvider,
} from "./providers/index.js";
import { SlidingWindowRateLimiter } from "./rate-limit.js";
import { recentlySentIds, rememberSentImage } from "./recent-sent.js";
import { assessImageRelevance, listRelevantImages } from "./relevance.js";
import {
  DEFAULT_IMAGE_MEDIA_CONFIG,
  type DownloadedImage,
  type DuitangDeliveryMode,
  type ImageMediaConfig,
  type ImageProviderId,
  type ImageSearchHit,
} from "./types.js";
import { expandWebImageQueries } from "./entities.js";

export interface ImageFindImageResult {
  ok: true;
  delivery: "image";
  hit: ImageSearchHit;
  downloaded: DownloadedImage;
  /** Short conversational QQ text sent AFTER the image (not as image caption). */
  chatReply: string;
  /** Internal credit for Bridge actions / logs. */
  attribution: string;
  /** @deprecated alias of chatReply */
  caption: string;
}

export interface ImageFindLinkResult {
  ok: true;
  delivery: "link";
  hit: ImageSearchHit;
  caption: string;
  attribution: string;
}

/** @deprecated Prefer ImageFindImageResult | ImageFindLinkResult */
export type ImageFindResult = ImageFindImageResult | ImageFindLinkResult;

export interface ImageFindFailure {
  ok: false;
  error: string;
}

export type ImageFindOutcome = ImageFindResult | ImageFindFailure;

function prefersChineseFandom(normalized: {
  subject: string;
  entity?: { kind: string; aliases: string[] };
}): boolean {
  if (normalized.entity?.kind === "person") return true;
  if (/[\u4e00-\u9fff]/.test(normalized.subject)) return true;
  return false;
}

export class ImageMediaService {
  private readonly cfg: Required<
    Pick<
      ImageMediaConfig,
      | "enabled"
      | "provider"
      | "maxDownloadBytes"
      | "searchTimeoutMs"
      | "downloadTimeoutMs"
      | "maxDownloadAttempts"
      | "totalTimeoutMs"
      | "minWidth"
      | "minHeight"
      | "rateLimitPerMinute"
      | "maxImagesPerRequest"
    >
  > &
    Pick<
      ImageMediaConfig,
      | "openverseClientId"
      | "openverseClientSecret"
      | "pexelsApiKey"
      | "duitang"
      | "ddgs"
      | "searxng"
      | "providerPriority"
      | "autoFallback"
    >;
  private readonly limiter: SlidingWindowRateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveHost?: (hostname: string) => Promise<void>;
  /** All backends available for explicit `--provider=` pins. */
  private readonly availableProviders: ImageSearchProvider[];
  /** Ordinary-search order (default: DDGS only). */
  private readonly providers: ImageSearchProvider[];
  private forceProvider?: ImageProviderId;

  constructor(
    config: ImageMediaConfig = {},
    opts: {
      fetchImpl?: typeof fetch;
      /** Injected for tests — skip DNS when set. */
      resolveHost?: (hostname: string) => Promise<void>;
      providers?: ImageSearchProvider[];
    } = {},
  ) {
    this.cfg = { ...DEFAULT_IMAGE_MEDIA_CONFIG, ...config };
    this.limiter = new SlidingWindowRateLimiter(
      this.cfg.rateLimitPerMinute,
      60_000,
    );
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.resolveHost = opts.resolveHost;
    // Custom fetchImpl in unit tests → skip DDGS subprocess (Openverse mock path).
    const ddgsEnabled =
      this.cfg.ddgs?.enabled !== false && opts.fetchImpl === undefined;
    const buildOpts = {
      openverseClientId: this.cfg.openverseClientId,
      openverseClientSecret: this.cfg.openverseClientSecret,
      pexelsApiKey: this.cfg.pexelsApiKey,
      duitangEnabled: !!this.cfg.duitang?.enabled,
      ddgsEnabled,
      ddgsPythonPath: this.cfg.ddgs?.pythonPath,
      searxngBaseUrl:
        this.cfg.searxng?.enabled === false
          ? undefined
          : this.cfg.searxng?.baseUrl || process.env.SEARXNG_BASE_URL,
      priority: this.cfg.providerPriority,
      autoFallback: this.cfg.autoFallback === true,
      forceProvider: undefined as ImageProviderId | undefined,
    };
    if (opts.providers) {
      // Tests may inject fakes; still honor providerPriority for ordinary search.
      this.availableProviders = opts.providers;
      const byId = new Map(opts.providers.map((p) => [p.id, p]));
      this.providers = orderProvidersForSearch(byId, buildOpts);
    } else {
      const registry = buildImageProviderRegistry(buildOpts, this.fetchImpl);
      this.availableProviders = [...registry.values()];
      this.providers = orderProvidersForSearch(registry, buildOpts);
    }
  }

  /** Per-request provider pin (e.g. /image --provider=ddgs). */
  withForcedProvider(id: ImageProviderId | undefined): this {
    this.forceProvider = id;
    return this;
  }

  get enabled(): boolean {
    return this.cfg.enabled !== false;
  }

  private duitangDeliveryMode(): DuitangDeliveryMode {
    return this.cfg.duitang?.deliveryMode === "image" ? "image" : "link";
  }

  async findAndDownloadMany(
    query: string,
    conversationId: string,
    opts: {
      preferDifferent?: boolean;
      count?: number;
      provider?: ImageProviderId;
    } = {},
  ): Promise<ImageFindOutcome[]> {
    const n = Math.min(
      Math.max(1, opts.count ?? 1),
      this.cfg.maxImagesPerRequest,
    );
    const out: ImageFindOutcome[] = [];
    for (let i = 0; i < n; i++) {
      const one = await this.findAndDownload(query, conversationId, {
        preferDifferent: opts.preferDifferent || i > 0,
        provider: opts.provider,
      });
      out.push(one);
      if (!one.ok) break;
    }
    return out;
  }

  async findAndDownload(
    query: string,
    conversationId: string,
    opts: { preferDifferent?: boolean; provider?: ImageProviderId } = {},
  ): Promise<ImageFindOutcome> {
    if (!this.enabled) {
      return { ok: false, error: "图片搜索未启用。" };
    }
    const normalized = normalizeImageSearchQuery(query);
    if (!normalized.subject || normalized.searchQueries.length === 0) {
      return { ok: false, error: "请告诉我要找什么图。" };
    }
    if (!this.limiter.tryTake()) {
      return { ok: false, error: "搜图太频繁了，稍后再试。" };
    }

    const started = Date.now();
    const deadline = started + this.cfg.totalTimeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    const timedOut = () => Date.now() >= deadline;

    const exclude = recentlySentIds(conversationId);
    // Only deepen the pool when the user asked for a different image — not merely
    // because this conversation previously sent unrelated subjects.
    const wantDifferent = !!opts.preferDifferent;
    const linkOnlyDuitang =
      !!this.cfg.duitang?.enabled && this.duitangDeliveryMode() === "link";

    try {
      const pin = opts.provider || this.forceProvider;
      const cacheId = cacheKey(
        pin || this.cfg.provider,
        `${normalized.entity?.id ?? "raw"}:${normalized.searchQueries.join("|")}:dt${this.cfg.duitang?.enabled ? 1 : 0}:dd${this.cfg.ddgs?.enabled !== false ? 1 : 0}`,
      );
      let hits = getCachedHits(cacheId);
      const searchStarted = Date.now();
      if (!hits) {
        hits = await this.searchHits(normalized, {
          page: 1,
          timeoutMs: Math.min(this.cfg.searchTimeoutMs, remaining()),
          provider: pin,
        });
        if (timedOut()) {
          return {
            ok: false,
            error: "搜图超时了，稍后再试。",
          };
        }
        setCachedHits(cacheId, hits);
      }

      // Deepen only on explicit “再来一张 / 其他的” — and only if page-1 pool is thin
      // after excluding already-sent + dead URLs.
      if (wantDifferent && !timedOut()) {
        const usableNow = listRelevantImages(hits, {
          subject: normalized.subject,
          entity: normalized.entity,
          requireStrongEvidence: normalized.requireStrongEvidence,
          minWidth: this.cfg.minWidth,
          minHeight: this.cfg.minHeight,
          excludeIds: exclude,
        }).filter((p) => {
          if (p.hit.provider === "duitang" && linkOnlyDuitang) return true;
          return !isDeadImage({ id: p.hit.id, url: p.hit.url });
        });
        if (usableNow.length < 3) {
          const more = await this.searchHits(normalized, {
            page: 2,
            timeoutMs: Math.min(this.cfg.searchTimeoutMs, remaining()),
            provider: pin,
          });
          const seen = new Set(hits.map((h) => h.id));
          for (const h of more) {
            if (!seen.has(h.id)) hits.push(h);
          }
        }
      }

      const searchMs = Date.now() - searchStarted;
      const sourceCounts: Record<string, number> = {};
      for (const h of hits) {
        const s = (h.source || h.provider || "?").toLowerCase();
        sourceCounts[s] = (sourceCounts[s] ?? 0) + 1;
      }
      const selectedProviders = (
        pin
          ? [pin]
          : enabledProviderIds({
              pexelsApiKey: this.cfg.pexelsApiKey,
              duitang: this.cfg.duitang,
              ddgs: this.cfg.ddgs,
              searxng: this.cfg.searxng,
              providerPriority: this.cfg.providerPriority,
              autoFallback: this.cfg.autoFallback,
            })
      );
      log.info("media:search_results", {
        entityId: normalized.entity?.id ?? null,
        originalQuery: normalized.subject.slice(0, 40),
        hitCount: hits.length,
        queryCount: normalized.searchQueries.length,
        selectedProviders,
        autoFallback: this.cfg.autoFallback === true,
        sources: sourceCounts,
        preferDifferent: wantDifferent,
        excludedSent: exclude.size,
        searchMs,
        budgetLeftMs: remaining(),
        duitangDelivery: this.cfg.duitang?.enabled
          ? this.duitangDeliveryMode()
          : null,
      });

      const pickOpts = {
        subject: normalized.subject,
        entity: normalized.entity,
        requireStrongEvidence: normalized.requireStrongEvidence,
        minWidth: this.cfg.minWidth,
        minHeight: this.cfg.minHeight,
      };

      const allRelevant = listRelevantImages(hits, pickOpts);
      let ranked = listRelevantImages(hits, {
        ...pickOpts,
        excludeIds: exclude,
      }).filter((p) => {
        if (p.hit.provider === "duitang" && linkOnlyDuitang) return true;
        return !isDeadImage({ id: p.hit.id, url: p.hit.url });
      });

      if (!ranked.length && exclude.size && !wantDifferent) {
        ranked = listRelevantImages(hits, pickOpts).filter((p) => {
          if (p.hit.provider === "duitang" && linkOnlyDuitang) return true;
          return !isDeadImage({ id: p.hit.id, url: p.hit.url });
        });
      }

      if (!ranked.length) {
        if (allRelevant.length > 0) {
          log.info("media:no_other_usable", {
            entityId: normalized.entity?.id ?? null,
            relevant: allRelevant.length,
            excludedSent: exclude.size,
          });
          return {
            ok: false,
            error: wantDifferent || exclude.size > 0
              ? `暂时没有其他「${normalized.displayName}」相关结果了（可用链接有限）。`
              : `相关图的下载链接都失效了，这次发不出来。`,
          };
        }
        const rejectSamples = hits.slice(0, 8).map((h) => {
          const a = assessImageRelevance(h, {
            subject: normalized.subject,
            entity: normalized.entity,
            requireStrongEvidence: normalized.requireStrongEvidence,
          });
          return {
            provider: h.provider,
            strong: a.strong,
            topical: a.topical,
            reasons: a.reasons.slice(0, 4),
          };
        });
        log.info("media:relevance_reject", {
          entityId: normalized.entity?.id ?? null,
          originalQuery: normalized.subject.slice(0, 40),
          expandedQuery: normalized.searchQueries[0]?.slice(0, 80) ?? null,
          requireStrong: normalized.requireStrongEvidence,
          candidateCount: hits.length,
          validationResult: "all_rejected",
          rejectionReason: normalized.requireStrongEvidence
            ? "no_strong_identity_evidence"
            : "no_topical_match",
          deliveryResult: "not_sent",
          rejectSamples,
        });
        const tried = (
          pin
            ? [pin]
            : this.providers.map((p) => p.id)
        ).join("/");
        return {
          ok: false,
          error: normalized.requireStrongEvidence
            ? `用 ${tried} 搜了，但没找到能确认是「${normalized.displayName}」的图（只按标题/标签匹配，不做脸部识别）。这次不换成别的图源，也不随手发无关图。`
            : `用 ${tried} 搜了，没找到和「${normalized.displayName}」对得上的图，这次不发了（不会改用其他图源）。`,
        };
      }

      const maxAttempts = Math.min(
        this.cfg.maxDownloadAttempts,
        ranked.length,
      );
      let lastError: unknown;
      let hardFails = 0;
      const downloadStarted = Date.now();

      for (let i = 0; i < maxAttempts; i++) {
        if (timedOut()) {
          log.warn("media:download_exhausted", {
            entityId: normalized.entity?.id ?? null,
            relevant: ranked.length,
            attempted: i,
            reason: "total_timeout",
            searchMs,
            downloadMs: Date.now() - downloadStarted,
            totalMs: Date.now() - started,
          });
          return {
            ok: false,
            error: wantDifferent
              ? `暂时没有其他「${normalized.displayName}」相关结果了（超时）。`
              : `搜图超时了，稍后再试。`,
          };
        }

        const picked = ranked[i]!;
        const hit = picked.hit;

        // Duitang link-only: no CDN byte fetch / QQ redistrib.
        if (hit.provider === "duitang" && linkOnlyDuitang) {
          rememberSentImage(conversationId, hit.id);
          const caption = formatDuitangLinkCaption(hit);
          const attribution = formatInternalImageAttribution(hit);
          log.info("media:image_ready", {
            provider: hit.provider,
            id: hit.id,
            source: hit.source ?? null,
            delivery: "link",
            relevance: picked.assessment.score,
            reasons: picked.assessment.reasons.slice(0, 6),
            attempt: i + 1,
            searchMs,
            totalMs: Date.now() - started,
          });
          return { ok: true, delivery: "link", hit, caption, attribution };
        }

        try {
          assertNotLocalPath(hit.url);
          const downloaded = await downloadImageSafely(hit.url, {
            maxBytes: this.cfg.maxDownloadBytes,
            timeoutMs: Math.min(this.cfg.downloadTimeoutMs, remaining()),
            fetchImpl: this.fetchImpl,
            resolveHost: this.resolveHost,
          });

          rememberSentImage(conversationId, hit.id);
          const attribution = formatInternalImageAttribution(hit);
          const chatReply = formatChatImageFollowUp(hit, {
            preferDifferent: wantDifferent,
          });

          log.info("media:image_ready", {
            provider: hit.provider,
            id: hit.id,
            source: hit.source ?? null,
            delivery: "image",
            deliveryResult: "sent",
            originalQuery: normalized.subject.slice(0, 40),
            expandedQuery: normalized.searchQueries[0]?.slice(0, 80) ?? null,
            entityId: normalized.entity?.id ?? null,
            validationResult: picked.assessment.strong
              ? "strong"
              : picked.assessment.topical
                ? "topical"
                : "weak",
            bytes: downloaded.byteLength,
            mime: downloaded.contentType,
            relevance: picked.assessment.score,
            reasons: picked.assessment.reasons.slice(0, 6),
            attempt: i + 1,
            searchMs,
            downloadMs: Date.now() - downloadStarted,
            totalMs: Date.now() - started,
          });

          return {
            ok: true,
            delivery: "image",
            hit,
            downloaded,
            chatReply,
            attribution,
            caption: chatReply,
          };
        } catch (err) {
          lastError = err;
          const stage =
            err instanceof ImageDownloadError ? err.stage : "unknown";
          const httpStatus =
            err instanceof ImageDownloadError ? err.httpStatus : undefined;
          const retryable = isRetryableImageDownloadError(err);
          log.warn("media:download_attempt", {
            id: hit.id,
            attempt: i + 1,
            maxAttempts,
            stage,
            httpStatus: httpStatus ?? null,
            retryable,
            budgetLeftMs: remaining(),
          });

          if (
            err instanceof ImageDownloadError &&
            err.stage === "http" &&
            (err.httpStatus === 404 || err.httpStatus === 410)
          ) {
            rememberDeadImage({ id: hit.id, url: hit.url });
            hardFails += 1;
          }

          if (!retryable || i + 1 >= maxAttempts) {
            break;
          }
        }
      }

      log.warn("media:download_exhausted", {
        entityId: normalized.entity?.id ?? null,
        relevant: ranked.length,
        attempted: maxAttempts,
        hardFails,
        searchMs,
        downloadMs: Date.now() - downloadStarted,
        totalMs: Date.now() - started,
        lastStage:
          lastError instanceof ImageDownloadError
            ? lastError.stage
            : "unknown",
        lastHttpStatus:
          lastError instanceof ImageDownloadError
            ? (lastError.httpStatus ?? null)
            : null,
      });

      return {
        ok: false,
        error: wantDifferent
          ? `暂时没有其他「${normalized.displayName}」相关结果了（链接失效或源站不可用）。`
          : `搜到相关图但下载失败（链接失效或源站不可用），这次发不出来。`,
      };
    } catch (err) {
      log.warn("media:image_failed", {
        message: (err as Error).message,
        totalMs: Date.now() - started,
      });
      return {
        ok: false,
        error: `搜图或下载失败：${(err as Error).message}`.slice(0, 200),
      };
    }
  }

  private async searchHits(
    normalized: ReturnType<typeof normalizeImageSearchQuery>,
    opts: { page: number; timeoutMs: number; provider?: ImageProviderId },
  ): Promise<ImageSearchHit[]> {
    if (opts.timeoutMs < 500) return [];
    const person = normalized.entity?.kind === "person";
    const webQueries = expandWebImageQueries(normalized.subject);
    const pin = opts.provider || this.forceProvider;
    // Ordinary search: only priority list (default DDGS). Never soft-prefer Duitang
    // unless autoFallback is on and Duitang is already in the search set.
    const autoFallback = this.cfg.autoFallback === true;
    const preferDuitang =
      autoFallback &&
      !!this.cfg.duitang?.enabled &&
      prefersChineseFandom(normalized) &&
      !pin &&
      this.providers.some((p) => p.id === "duitang");
    const duitangQueries =
      this.cfg.duitang?.enabled &&
      (pin === "duitang" || this.providers.some((p) => p.id === "duitang"))
        ? buildDuitangQueries({
            subject: normalized.subject,
            aliases: normalized.entity?.aliases,
            englishQueries: person ? normalized.searchQueries.slice(0, 2) : [],
          })
        : undefined;

    let providers: ImageSearchProvider[];
    if (pin) {
      // Explicit pin: only that backend — never fall back to the default chain.
      providers = this.availableProviders.filter((p) => p.id === pin);
      if (!providers.length) {
        log.info("media:provider_pin_missing", {
          provider: pin,
          available: this.availableProviders.map((p) => p.id),
        });
        return [];
      }
    } else {
      providers = this.providers;
    }

    return searchAcrossProviders(providers, {
      queries: normalized.searchQueries,
      preferSources: person ? ["wikimedia"] : undefined,
      personQuery: person,
      preferDuitang,
      duitangQueries,
      ddgsQueries: webQueries,
      searxngQueries: webQueries,
      pageSize: 12,
      page: opts.page,
      timeoutMs: opts.timeoutMs,
      stopAfterHits: person ? 12 : 10,
      maxQueries: person ? 2 : 1,
      // Pin → single id; ordinary → configured priority (default ["ddgs"]).
      priority: pin
        ? [pin]
        : this.cfg.providerPriority?.length
          ? this.cfg.providerPriority
          : undefined,
      originalQuery: normalized.subject,
      // Within the selected provider set only: raw hits do not satisfy quota.
      countTowardQuota: (hit) => {
        const a = assessImageRelevance(hit, {
          subject: normalized.subject,
          entity: normalized.entity,
          requireStrongEvidence: normalized.requireStrongEvidence,
        });
        return normalized.requireStrongEvidence
          ? a.strong
          : a.topical || a.strong;
      },
      onProviderResult: (info) => {
        log.info("media:provider_search", {
          provider: info.provider,
          originalQuery: info.originalQuery,
          expandedQuery: info.expandedQuery,
          candidateCount: info.candidateCount,
          validationAccepted: info.acceptedCount,
          quotaAccepted: info.quotaAccepted,
          fallbackReason: info.fallbackReason ?? null,
          deliveryPolicy: pin
            ? `pin:${pin}`
            : autoFallback
              ? "auto_fallback"
              : "priority_only",
          entityId: normalized.entity?.id ?? null,
          requireStrong: normalized.requireStrongEvidence,
        });
      },
    });
  }
}

let singleton: ImageMediaService | undefined;

export function getImageMediaService(): ImageMediaService {
  if (!singleton) {
    singleton = new ImageMediaService({});
  }
  return singleton;
}

export function configureImageMediaService(config?: ImageMediaConfig): void {
  singleton = new ImageMediaService(config ?? {});
}

export function resetImageMediaServiceForTests(
  service?: ImageMediaService,
): void {
  singleton = service;
}

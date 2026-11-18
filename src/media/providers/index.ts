import type { ImageSearchHit, ImageMediaConfig, ImageProviderId } from "../types.js";
import { DdgsImageProvider } from "./ddgs.js";
import { DuitangImageProvider, buildDuitangQueries } from "./duitang.js";
import { OpenverseImageProvider } from "./openverse-provider.js";
import { tryCreatePexelsProvider } from "./pexels.js";
import { tryCreateSearxngProvider } from "./searxng.js";
import { dedupeHits, type ImageSearchProvider } from "./types.js";

export type { ImageSearchProvider } from "./types.js";
export { dedupeHits } from "./types.js";
export { OpenverseImageProvider } from "./openverse-provider.js";
export { PexelsImageProvider, tryCreatePexelsProvider } from "./pexels.js";
export {
  DuitangImageProvider,
  buildDuitangQueries,
  mapDuitangObject,
  duitangBlogUrl,
} from "./duitang.js";
export {
  DdgsImageProvider,
  mapDdgsResult,
  parseDdgsScriptOutput,
} from "./ddgs.js";
export {
  SearxngImageProvider,
  tryCreateSearxngProvider,
  mapSearxngResult,
  normalizeSearxngBaseUrl,
} from "./searxng.js";

/**
 * Default ordinary-search order: DDGS only.
 * Other providers stay implemented for explicit `--provider=` / config.
 */
export const DEFAULT_PROVIDER_PRIORITY: ImageProviderId[] = ["ddgs"];

export interface ProviderBuildOpts {
  openverseClientId?: string;
  openverseClientSecret?: string;
  pexelsApiKey?: string;
  duitangEnabled?: boolean;
  ddgsEnabled?: boolean;
  ddgsPythonPath?: string;
  searxngBaseUrl?: string;
  /** Ordered provider ids for ordinary search. Missing/unconfigured ids are skipped. */
  priority?: ImageProviderId[];
  /** Force a single provider when set. */
  forceProvider?: ImageProviderId;
  /**
   * When true, append Openverse if not already listed (legacy multi-provider fill).
   * Default false — ordinary requests never silently substitute another provider.
   */
  autoFallback?: boolean;
}

/** Instantiate every configured backend (for explicit pin + ordinary order). */
export function buildImageProviderRegistry(
  opts: ProviderBuildOpts = {},
  fetchImpl: typeof fetch = fetch,
): Map<string, ImageSearchProvider> {
  const byId = new Map<string, ImageSearchProvider>();

  const ddgsOn = opts.ddgsEnabled !== false;
  if (ddgsOn) {
    byId.set(
      "ddgs",
      new DdgsImageProvider({ pythonPath: opts.ddgsPythonPath }),
    );
  }

  const searx = tryCreateSearxngProvider(opts.searxngBaseUrl, fetchImpl);
  if (searx) byId.set("searxng", searx);

  if (opts.duitangEnabled) {
    byId.set("duitang", new DuitangImageProvider(fetchImpl));
  }

  byId.set(
    "openverse",
    new OpenverseImageProvider(
      {
        openverseClientId: opts.openverseClientId,
        openverseClientSecret: opts.openverseClientSecret,
      },
      fetchImpl,
    ),
  );

  const pexels = tryCreatePexelsProvider(opts.pexelsApiKey, fetchImpl);
  if (pexels) byId.set("pexels", pexels);

  return byId;
}

/**
 * Order providers for an ordinary (non-pinned) search.
 * Does not invent providers beyond `priority` unless `autoFallback` is true.
 */
export function orderProvidersForSearch(
  byId: Map<string, ImageSearchProvider>,
  opts: Pick<ProviderBuildOpts, "priority" | "forceProvider" | "autoFallback"> = {},
): ImageSearchProvider[] {
  const priority = opts.forceProvider
    ? [opts.forceProvider]
    : opts.priority?.length
      ? opts.priority
      : DEFAULT_PROVIDER_PRIORITY;

  const ordered: ImageSearchProvider[] = [];
  const seen = new Set<string>();
  for (const id of priority) {
    const p = byId.get(id);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    ordered.push(p);
  }

  // Legacy multi-provider fill only when explicitly enabled.
  if (opts.autoFallback === true && !seen.has("openverse")) {
    const ov = byId.get("openverse");
    if (ov) ordered.push(ov);
  }

  return ordered;
}

/**
 * Build the ordinary-search provider list.
 * Unconfigured optional backends are omitted from the registry; Openverse is
 * always registered for explicit `--provider=openverse` but is NOT auto-queried
 * unless listed in priority or `autoFallback: true`.
 */
export function createImageProviders(
  opts: ProviderBuildOpts = {},
  fetchImpl: typeof fetch = fetch,
): ImageSearchProvider[] {
  const byId = buildImageProviderRegistry(opts, fetchImpl);
  return orderProvidersForSearch(byId, opts);
}

/**
 * Sequential fallback: call the next provider when earlier ones did not yield
 * enough *usable* hits. Raw candidate spam must not block fallback — pass
 * `countTowardQuota` so only validation-passing hits satisfy the request.
 */
export async function searchAcrossProviders(
  providers: ImageSearchProvider[],
  opts: {
    queries: string[];
    preferSources?: string[];
    personQuery?: boolean;
    preferDuitang?: boolean;
    duitangQueries?: string[];
    ddgsQueries?: string[];
    searxngQueries?: string[];
    pageSize?: number;
    page?: number;
    timeoutMs?: number;
    stopAfterHits?: number;
    maxQueries?: number;
    /** Override order for this call (e.g. forceProvider already applied in list). */
    priority?: string[];
    /**
     * When set, only hits returning true count toward `stopAfterHits`.
     * All unique hits are still retained for ranking/logging.
     */
    countTowardQuota?: (hit: ImageSearchHit) => boolean;
    /** Optional structured progress logger (no raw QQ message bodies). */
    onProviderResult?: (info: {
      provider: string;
      originalQuery: string;
      expandedQuery: string;
      candidateCount: number;
      acceptedCount: number;
      quotaAccepted: number;
      fallbackReason?: string;
    }) => void;
    /** Short original subject for logs (not full chat text). */
    originalQuery?: string;
  },
): Promise<ImageSearchHit[]> {
  let ordered = [...providers];
  if (opts.priority?.length) {
    const byId = new Map(ordered.map((p) => [p.id, p]));
    ordered = opts.priority
      .map((id) => byId.get(id))
      .filter((p): p is ImageSearchProvider => !!p);
  } else if (opts.preferDuitang) {
    // Soft preference only when Duitang is already in the list — still sequential.
    ordered.sort((a, b) => {
      if (a.id === "duitang" && b.id !== "duitang") return -1;
      if (b.id === "duitang" && a.id !== "duitang") return 1;
      return 0;
    });
  }

  const need = Math.max(1, opts.stopAfterHits ?? 10);
  const chunks: ImageSearchHit[] = [];
  const seenId = new Set<string>();
  const seenUrl = new Set<string>();
  let quotaAccepted = 0;
  const countFn = opts.countTowardQuota;

  for (const p of ordered) {
    if (quotaAccepted >= need) break;
    if (opts.personQuery && p.id === "pexels") continue;
    const remaining = Math.max(2, need - quotaAccepted + 2);
    try {
      let queries = opts.queries;
      if (p.id === "duitang" && opts.duitangQueries?.length) {
        queries = opts.duitangQueries;
      } else if (p.id === "ddgs" && opts.ddgsQueries?.length) {
        queries = opts.ddgsQueries;
      } else if (p.id === "searxng" && opts.searxngQueries?.length) {
        queries = opts.searxngQueries;
      }
      const expandedQuery = (queries[0] ?? "").slice(0, 80);
      const hits = await p.search({
        queries,
        preferSources: p.id === "openverse" ? opts.preferSources : undefined,
        pageSize: opts.pageSize,
        page: opts.page,
        timeoutMs: opts.timeoutMs,
        stopAfterHits: remaining + 2,
        maxQueries:
          p.id === "duitang" || p.id === "ddgs" || p.id === "searxng"
            ? Math.min(opts.maxQueries ?? 2, 2)
            : opts.maxQueries,
      });
      let acceptedThis = 0;
      for (const h of hits) {
        if (seenId.has(h.id)) continue;
        const urlKey = h.url.trim().toLowerCase();
        if (seenUrl.has(urlKey)) continue;
        seenId.add(h.id);
        seenUrl.add(urlKey);
        chunks.push(h);
        const ok = countFn ? countFn(h) : true;
        if (ok) {
          acceptedThis += 1;
          quotaAccepted += 1;
        }
      }
      const fallbackReason =
        quotaAccepted >= need
          ? undefined
          : acceptedThis === 0
            ? hits.length === 0
              ? "provider_empty"
              : "no_usable_after_validation"
            : "insufficient_relevant";
      opts.onProviderResult?.({
        provider: p.id,
        originalQuery: (opts.originalQuery ?? "").slice(0, 40),
        expandedQuery,
        candidateCount: hits.length,
        acceptedCount: acceptedThis,
        quotaAccepted,
        fallbackReason,
      });
    } catch {
      opts.onProviderResult?.({
        provider: p.id,
        originalQuery: (opts.originalQuery ?? "").slice(0, 40),
        expandedQuery: "",
        candidateCount: 0,
        acceptedCount: 0,
        quotaAccepted,
        fallbackReason: "provider_error",
      });
      // Continue to next provider.
    }
  }
  return dedupeHits(chunks);
}

export function enabledProviderIds(
  cfg: Pick<
    ImageMediaConfig,
    | "pexelsApiKey"
    | "duitang"
    | "ddgs"
    | "searxng"
    | "providerPriority"
    | "autoFallback"
  > = {},
): string[] {
  const priority =
    cfg.providerPriority?.length ? cfg.providerPriority : DEFAULT_PROVIDER_PRIORITY;
  const ids: string[] = [];
  for (const id of priority) {
    if (id === "ddgs" && cfg.ddgs?.enabled === false) continue;
    if (id === "searxng") {
      const url = (cfg.searxng?.baseUrl || process.env.SEARXNG_BASE_URL || "").trim();
      if (!url) continue;
    }
    if (id === "duitang" && !cfg.duitang?.enabled) continue;
    if (id === "pexels") {
      if (!(cfg.pexelsApiKey || process.env.PEXELS_API_KEY || "").trim()) continue;
    }
    if (!ids.includes(id)) ids.push(id);
  }
  // Openverse only when listed or legacy autoFallback is on.
  if (cfg.autoFallback === true && !ids.includes("openverse")) {
    ids.push("openverse");
  }
  return ids;
}

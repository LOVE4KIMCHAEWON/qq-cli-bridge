import { formatInternalImageAttribution } from "../attribution.js";
import type { ImageSearchHit } from "../types.js";
import type { ImageSearchProvider } from "./types.js";

export interface SearxngProviderOpts {
  /** Base URL of a SearXNG instance that allows format=json (no default public host). */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  img_src?: string;
  thumbnail_src?: string;
  thumbnail?: string;
  resolution?: string;
  engine?: string;
  source?: string;
  category?: string;
  template?: string;
}

interface SearxngResponse {
  results?: SearxngResult[];
}

function parseResolution(
  res: string | undefined,
): { width?: number; height?: number } {
  if (!res) return {};
  const m = res.match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!m) return {};
  return { width: Number(m[1]), height: Number(m[2]) };
}

export function normalizeSearxngBaseUrl(raw: string): string | undefined {
  const t = raw.trim().replace(/\/+$/, "");
  if (!t) return undefined;
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

export function mapSearxngResult(
  raw: SearxngResult,
  index: number,
): ImageSearchHit | undefined {
  const image = (raw.img_src || "").trim();
  if (!image || !/^https:\/\//i.test(image)) return undefined;
  const { width, height } = parseResolution(raw.resolution);
  const idSeed = Buffer.from(image).toString("base64url").slice(0, 24);
  const hit: ImageSearchHit = {
    id: `searxng:${idSeed}:${index}`,
    provider: "searxng",
    title: raw.title?.trim().slice(0, 120) || undefined,
    url: image,
    thumbnailUrl: (raw.thumbnail_src || raw.thumbnail || "").trim() || undefined,
    width,
    height,
    foreignLandingUrl:
      raw.url && /^https?:\/\//i.test(raw.url) ? raw.url.trim() : undefined,
    source: raw.engine || raw.source || "searxng",
    description: raw.content?.trim().slice(0, 200),
    // No verified redistribution license — do not invent a QQ-visible credit.
    // Unverified note lives only in formatInternalImageAttribution.
  };
  hit.attribution = formatInternalImageAttribution(hit);
  return hit;
}

export class SearxngImageProvider implements ImageSearchProvider {
  readonly id = "searxng";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SearxngProviderOpts) {
    const base = normalizeSearxngBaseUrl(opts.baseUrl);
    if (!base) throw new Error("invalid SearXNG baseUrl");
    this.baseUrl = base;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(opts: {
    queries: string[];
    pageSize?: number;
    page?: number;
    timeoutMs?: number;
    stopAfterHits?: number;
    maxQueries?: number;
  }): Promise<ImageSearchHit[]> {
    const stopAfter = opts.stopAfterHits ?? opts.pageSize ?? 12;
    const maxQueries = Math.min(opts.maxQueries ?? 2, 3);
    const page = Math.max(1, opts.page ?? 1);
    const out: ImageSearchHit[] = [];
    const seen = new Set<string>();

    for (const query of opts.queries.slice(0, maxQueries)) {
      const q = query.trim();
      if (!q) continue;
      const params = new URLSearchParams({
        q,
        format: "json",
        categories: "images",
        pageno: String(page),
        language: "all",
      });
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 8_000);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/search?${params}`, {
          headers: {
            Accept: "application/json",
            "User-Agent": "qq-cli-bridge/0.1 (searxng-images)",
          },
          signal: ac.signal,
        });
      } catch {
        clearTimeout(timer);
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) continue;
      let json: SearxngResponse;
      try {
        json = (await res.json()) as SearxngResponse;
      } catch {
        continue;
      }
      const list = Array.isArray(json.results) ? json.results : [];
      for (let i = 0; i < list.length; i++) {
        const hit = mapSearxngResult(list[i]!, i);
        if (!hit || seen.has(hit.url)) continue;
        seen.add(hit.url);
        out.push(hit);
        if (out.length >= stopAfter) return out;
      }
      if (out.length >= Math.min(4, stopAfter)) break;
    }
    return out;
  }
}

export function tryCreateSearxngProvider(
  baseUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): SearxngImageProvider | undefined {
  const normalized = normalizeSearxngBaseUrl(baseUrl || "");
  if (!normalized) return undefined;
  try {
    return new SearxngImageProvider({ baseUrl: normalized, fetchImpl });
  } catch {
    return undefined;
  }
}

import { formatQqImageCaption } from "../attribution.js";
import type { ImageSearchHit } from "../types.js";
import type { ImageSearchProvider } from "./types.js";

/**
 * Optional Pexels stock provider (requires PEXELS_API_KEY).
 * Suitable for animals / ordinary photography — NOT for named K-pop idols
 * (no reliable person metadata; relevance gate will reject celebrity queries).
 *
 * Terms: free API key; credit photographer + Pexels when possible.
 * New key issuance may be paused by Pexels — provider stays inert without a key.
 */
export class PexelsImageProvider implements ImageSearchProvider {
  readonly id = "pexels";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(opts: {
    queries: string[];
    pageSize?: number;
    page?: number;
    timeoutMs?: number;
    stopAfterHits?: number;
    maxQueries?: number;
  }): Promise<ImageSearchHit[]> {
    const q = opts.queries[0]?.trim();
    if (!q || !this.apiKey) return [];

    const params = new URLSearchParams({
      query: q,
      per_page: String(Math.min(15, Math.max(1, opts.pageSize ?? 12))),
      page: String(Math.min(3, Math.max(1, opts.page ?? 1))),
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 12_000);
    let res: Response;
    try {
      res = await this.fetchImpl(
        `https://api.pexels.com/v1/search?${params}`,
        {
          headers: {
            Authorization: this.apiKey,
            Accept: "application/json",
            "User-Agent": "qq-cli-bridge/0.1 (pexels-search)",
          },
          signal: ac.signal,
        },
      );
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return [];

    const json = (await res.json()) as {
      photos?: Array<{
        id: number;
        width?: number;
        height?: number;
        url?: string;
        photographer?: string;
        photographer_url?: string;
        alt?: string;
        src?: { large2x?: string; large?: string; original?: string };
      }>;
    };
    const photos = Array.isArray(json.photos) ? json.photos : [];
    const out: ImageSearchHit[] = [];
    for (const p of photos) {
      const url = p.src?.large2x || p.src?.large || p.src?.original;
      if (!url || !/^https?:\/\//i.test(url)) continue;
      const hit: ImageSearchHit = {
        id: `pexels:${p.id}`,
        provider: "pexels",
        title: p.alt?.slice(0, 80) || undefined,
        url,
        width: p.width,
        height: p.height,
        license: "Pexels License",
        licenseUrl: "https://www.pexels.com/license/",
        creator: p.photographer,
        foreignLandingUrl: p.url,
        tags: [],
        source: "pexels",
      };
      hit.attribution = formatQqImageCaption(hit);
      out.push(hit);
      if (out.length >= (opts.stopAfterHits ?? 12)) break;
    }
    return out;
  }
}

export function tryCreatePexelsProvider(
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): PexelsImageProvider | undefined {
  const key = (apiKey || process.env.PEXELS_API_KEY || "").trim();
  if (!key) return undefined;
  return new PexelsImageProvider(key, fetchImpl);
}

import type { ImageSearchHit, ImageSearchOptions } from "./types.js";
import { formatQqImageCaption } from "./attribution.js";

const OPENVERSE_BASE = "https://api.openverse.org/v1";

interface OpenverseTag {
  name?: string;
}

interface OpenverseResult {
  id: string;
  title?: string;
  url?: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  license?: string;
  license_url?: string;
  license_version?: string;
  creator?: string;
  foreign_landing_url?: string;
  attribution?: string;
  tags?: OpenverseTag[] | string[];
  description?: string;
  source?: string;
  category?: string;
  provider?: string;
}

interface OpenverseResponse {
  result_count?: number;
  results?: OpenverseResult[];
}

let cachedToken: { value: string; expiresAt: number } | undefined;

async function getOpenverseToken(
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });
  const res = await fetchImpl(`${OPENVERSE_BASE}/auth_tokens/token/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "qq-cli-bridge/0.1 (openverse-search)",
    },
    body,
  });
  if (!res.ok) return undefined;
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return undefined;
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + Math.max(60, Number(json.expires_in ?? 3600)) * 1000,
  };
  return cachedToken.value;
}

/** Reset cached OAuth token (tests). */
export function resetOpenverseTokenCache(): void {
  cachedToken = undefined;
}

function mapTags(tags: OpenverseResult["tags"]): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => (typeof t === "string" ? t : t?.name))
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .map((t) => t.trim())
    .slice(0, 24);
}

function mapHit(r: OpenverseResult): ImageSearchHit | undefined {
  if (typeof r.url !== "string" || !/^https?:\/\//i.test(r.url)) return undefined;
  const license = [r.license, r.license_version].filter(Boolean).join(" ").trim();
  const hit: ImageSearchHit = {
    id: `openverse:${r.id}`,
    provider: "openverse",
    title: r.title,
    url: r.url,
    width: typeof r.width === "number" ? r.width : undefined,
    height: typeof r.height === "number" ? r.height : undefined,
    license: license || undefined,
    licenseUrl: r.license_url,
    creator: r.creator,
    foreignLandingUrl: r.foreign_landing_url,
    tags: mapTags(r.tags),
    description:
      typeof r.description === "string" ? r.description.slice(0, 500) : undefined,
    source: r.source || r.provider,
    category: r.category,
  };
  hit.attribution = formatQqImageCaption(hit);
  return hit;
}

/**
 * Search Openverse for openly licensed images (no key required; optional OAuth).
 * Docs: https://api.openverse.org/v1/
 */
export async function searchOpenverse(
  opts: ImageSearchOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<ImageSearchHit[]> {
  const q = opts.query.trim();
  if (!q) return [];

  const params = new URLSearchParams({
    q,
    page_size: String(Math.min(20, Math.max(1, opts.pageSize ?? 12))),
    page: String(Math.min(5, Math.max(1, opts.page ?? 1))),
    mature: "false",
  });
  if (opts.source) params.set("source", opts.source);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "qq-cli-bridge/0.1 (openverse-search; contact: local-operator)",
  };

  const clientId = opts.openverseClientId ?? process.env.OPENVERSE_CLIENT_ID;
  const clientSecret =
    opts.openverseClientSecret ?? process.env.OPENVERSE_CLIENT_SECRET;
  if (clientId && clientSecret) {
    const token = await getOpenverseToken(clientId, clientSecret, fetchImpl);
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 12_000);
  let res: Response;
  try {
    res = await fetchImpl(`${OPENVERSE_BASE}/images/?${params}`, {
      headers,
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      throw new Error("Image search timed out");
    }
    throw new Error(`Image search failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    throw new Error("Image search rate-limited; try again later");
  }
  if (!res.ok) {
    throw new Error(`Image search HTTP ${res.status}`);
  }

  const json = (await res.json()) as OpenverseResponse;
  const results = Array.isArray(json.results) ? json.results : [];
  return results.map(mapHit).filter((h): h is ImageSearchHit => !!h);
}

/**
 * Try several queries; stop early once we have enough candidate hits.
 * Dedupes by id. Used for entity alias expansion.
 */
export async function searchOpenverseMulti(
  queries: string[],
  opts: Omit<ImageSearchOptions, "query"> & {
    maxQueries?: number;
    stopAfterHits?: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ImageSearchHit[]> {
  const seen = new Set<string>();
  const out: ImageSearchHit[] = [];
  const maxQueries = opts.maxQueries ?? 3;
  const stopAfter = opts.stopAfterHits ?? 8;

  for (const query of queries.slice(0, maxQueries)) {
    const hits = await searchOpenverse({ ...opts, query }, fetchImpl);
    for (const h of hits) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      out.push(h);
    }
    if (out.length >= stopAfter) break;
  }
  return out;
}

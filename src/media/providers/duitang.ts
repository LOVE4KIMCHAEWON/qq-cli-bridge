import { formatQqImageCaption } from "../attribution.js";
import type { ImageSearchHit } from "../types.js";
import type { ImageSearchProvider } from "./types.js";

/**
 * Optional Duitang (堆糖) search provider.
 *
 * Uses the historically observed site JSON endpoint:
 *   GET https://www.duitang.com/napi/blog/list/by_search/?kw=&start=&limit=
 *
 * This is NOT an official public developer API. Enable only via explicit config.
 * Default Bridge delivery for Duitang hits is link-only (no QQ image-byte
 * redistribution) unless the operator opts into `deliveryMode: "image"`.
 */

const DUITANG_SEARCH =
  "https://www.duitang.com/napi/blog/list/by_search/";

interface DuitangPhoto {
  id?: number;
  width?: number;
  height?: number;
  path?: string;
  size?: number;
}

interface DuitangObject {
  id?: number;
  msg?: string;
  photo?: DuitangPhoto;
  tags?: Array<string | { name?: string }>;
  sender_id?: number;
}

interface DuitangResponse {
  status?: number;
  data?: {
    total?: number;
    next_start?: number;
    object_list?: DuitangObject[];
  };
}

export function duitangBlogUrl(blogId: number | string): string {
  return `https://www.duitang.com/blog/?id=${blogId}`;
}

export function mapDuitangObject(
  obj: DuitangObject,
): ImageSearchHit | undefined {
  const path = obj.photo?.path?.trim();
  if (!path || !/^https:\/\//i.test(path)) return undefined;
  const blogId = obj.id;
  if (blogId == null) return undefined;
  const tags = (obj.tags ?? [])
    .map((t) => (typeof t === "string" ? t : t?.name))
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .slice(0, 16);
  const hit: ImageSearchHit = {
    id: `duitang:${blogId}`,
    provider: "duitang",
    title: obj.msg?.trim().slice(0, 80) || undefined,
    url: path,
    width: typeof obj.photo?.width === "number" ? obj.photo.width : undefined,
    height: typeof obj.photo?.height === "number" ? obj.photo.height : undefined,
    license: "堆糖用户内容（署名+非商业转载规则；作者可禁止转载）",
    creator:
      typeof obj.sender_id === "number" ? `用户${obj.sender_id}` : undefined,
    foreignLandingUrl: duitangBlogUrl(blogId),
    tags,
    description: obj.msg?.trim().slice(0, 200),
    source: "duitang",
  };
  hit.attribution = formatQqImageCaption(hit);
  return hit;
}

export class DuitangImageProvider implements ImageSearchProvider {
  readonly id = "duitang";

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async search(opts: {
    queries: string[];
    pageSize?: number;
    page?: number;
    timeoutMs?: number;
    stopAfterHits?: number;
    maxQueries?: number;
  }): Promise<ImageSearchHit[]> {
    const limit = Math.min(20, Math.max(1, opts.pageSize ?? 12));
    const page = Math.max(1, opts.page ?? 1);
    const start = (page - 1) * limit;
    const stopAfter = opts.stopAfterHits ?? 12;
    const maxQueries = Math.min(opts.maxQueries ?? 2, 3);
    const out: ImageSearchHit[] = [];
    const seen = new Set<string>();

    for (const query of opts.queries.slice(0, maxQueries)) {
      const q = query.trim();
      if (!q) continue;
      const params = new URLSearchParams({
        kw: q,
        start: String(start),
        limit: String(limit),
      });
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 8_000);
      let res: Response;
      try {
        res = await this.fetchImpl(`${DUITANG_SEARCH}?${params}`, {
          headers: {
            Accept: "application/json",
            "User-Agent":
              "qq-cli-bridge/0.1 (duitang-search; optional; operator-enabled)",
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
      let json: DuitangResponse;
      try {
        json = (await res.json()) as DuitangResponse;
      } catch {
        continue;
      }
      const list = Array.isArray(json.data?.object_list)
        ? json.data!.object_list!
        : [];
      for (const obj of list) {
        const hit = mapDuitangObject(obj);
        if (!hit || seen.has(hit.id)) continue;
        seen.add(hit.id);
        out.push(hit);
        if (out.length >= stopAfter) return out;
      }
      if (out.length >= Math.min(6, stopAfter)) break;
    }
    return out;
  }
}

/** Chinese-first query list for Duitang (fandom corpus is CJK-heavy). */
export function buildDuitangQueries(opts: {
  subject: string;
  aliases?: string[];
  englishQueries?: string[];
}): string[] {
  const out: string[] = [];
  const push = (s: string | undefined) => {
    const t = s?.trim();
    if (!t) return;
    if (!out.includes(t)) out.push(t);
  };
  push(opts.subject);
  for (const a of opts.aliases ?? []) {
    if (/[\u4e00-\u9fff]/.test(a)) push(a);
  }
  for (const a of opts.aliases ?? []) {
    if (!/[\u4e00-\u9fff]/.test(a) && a.length >= 3) push(a);
  }
  for (const q of opts.englishQueries ?? []) push(q);
  return out.slice(0, 4);
}

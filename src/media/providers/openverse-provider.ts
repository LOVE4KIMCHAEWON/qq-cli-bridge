import { searchOpenverse, searchOpenverseMulti } from "../openverse.js";
import type { ImageSearchHit, ImageSearchOptions } from "../types.js";
import { dedupeHits, type ImageSearchProvider } from "./types.js";

/**
 * Openverse search with bounded fan-out.
 * Prefer a small number of high-value queries; only broaden when the preferred
 * source pool is thin. Avoids the prior sequential 8–16 API-call storms.
 */
export class OpenverseImageProvider implements ImageSearchProvider {
  readonly id = "openverse";

  constructor(
    private readonly creds: Pick<
      ImageSearchOptions,
      "openverseClientId" | "openverseClientSecret"
    > = {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(opts: {
    queries: string[];
    preferSources?: string[];
    pageSize?: number;
    page?: number;
    timeoutMs?: number;
    stopAfterHits?: number;
    maxQueries?: number;
  }): Promise<ImageSearchHit[]> {
    const stopAfter = opts.stopAfterHits ?? 12;
    const maxQueries = Math.min(opts.maxQueries ?? 2, 3);
    const common = {
      timeoutMs: opts.timeoutMs,
      pageSize: Math.min(opts.pageSize ?? 12, 16),
      page: opts.page ?? 1,
      openverseClientId: this.creds.openverseClientId,
      openverseClientSecret: this.creds.openverseClientSecret,
    };
    const prefer = opts.preferSources ?? [];
    const chunks: ImageSearchHit[] = [];

    if (prefer.length) {
      for (const source of prefer) {
        chunks.push(
          ...(await searchOpenverseMulti(
            opts.queries,
            {
              ...common,
              source,
              maxQueries,
              stopAfterHits: stopAfter,
            },
            this.fetchImpl,
          )),
        );
        if (dedupeHits(chunks).length >= Math.min(8, stopAfter)) {
          return dedupeHits(chunks);
        }
      }
    }

    // Broaden only when preferred sources were thin (or none requested).
    if (dedupeHits(chunks).length < Math.min(6, stopAfter)) {
      chunks.push(
        ...(await searchOpenverseMulti(
          opts.queries,
          {
            ...common,
            maxQueries: prefer.length ? 1 : maxQueries,
            stopAfterHits: stopAfter,
          },
          this.fetchImpl,
        )),
      );
    }

    // Single primary query fallback if somehow empty.
    if (!chunks.length && opts.queries[0]) {
      chunks.push(
        ...(await searchOpenverse(
          { ...common, query: opts.queries[0]! },
          this.fetchImpl,
        )),
      );
    }

    return dedupeHits(chunks);
  }
}

import type { ImageEntity } from "./entities.js";
import { pickRelevantImage } from "./relevance.js";
import type { ImageSearchHit } from "./types.js";

export interface SelectImageOptions {
  minWidth: number;
  minHeight: number;
  /** Recently sent image ids to avoid duplicates. */
  excludeIds?: Set<string>;
  subject?: string;
  entity?: ImageEntity;
  requireStrongEvidence?: boolean;
}

/**
 * Deterministic ranking with relevance gating.
 * Prefer calling with subject/entity so person queries cannot fall through to noise.
 */
export function selectBestImage(
  hits: ImageSearchHit[],
  opts: SelectImageOptions,
): ImageSearchHit | undefined {
  const subject = opts.subject?.trim() || "";
  const requireStrongEvidence = opts.requireStrongEvidence ?? false;
  // Without a subject, refuse to pick arbitrarily (prevents “first result wins”).
  if (!subject && !opts.entity) return undefined;

  const picked = pickRelevantImage(hits, {
    subject: subject || opts.entity?.displayName || "",
    entity: opts.entity,
    requireStrongEvidence,
    minWidth: opts.minWidth,
    minHeight: opts.minHeight,
    excludeIds: opts.excludeIds,
  });
  return picked?.hit;
}

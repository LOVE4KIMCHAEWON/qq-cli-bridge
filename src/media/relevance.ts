import type { ImageEntity } from "./entities.js";
import type { ImageSearchHit } from "./types.js";

export interface RelevanceAssessment {
  hit: ImageSearchHit;
  score: number;
  /** Strong enough to send (especially for named people). */
  strong: boolean;
  /** Soft topical match for non-person queries (e.g. cat). */
  topical: boolean;
  reasons: string[];
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_·・./(),[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Path/query text from URLs — helps when titles omit the Chinese name. */
function urlEvidenceText(hit: ImageSearchHit): string {
  const parts: string[] = [];
  for (const raw of [hit.foreignLandingUrl, hit.url, hit.thumbnailUrl]) {
    if (!raw?.trim()) continue;
    try {
      const u = new URL(raw);
      // Host alone is noisy (reddit/cdn); path/query often carry names.
      parts.push(decodeURIComponent(`${u.pathname} ${u.search}`));
    } catch {
      parts.push(raw);
    }
  }
  return parts.join(" ");
}

function haystackOf(hit: ImageSearchHit): string {
  return normalizeText(
    [
      hit.title ?? "",
      hit.creator ?? "",
      ...(hit.tags ?? []),
      hit.description ?? "",
      hit.source ?? "",
      urlEvidenceText(hit),
    ].join(" "),
  );
}

/**
 * Bare Latin given/stage names are ambiguous across artists (Yuna, Mina, …).
 * Multi-word romanizations ("kim chaewon"), CJK, and Hangul are distinctive.
 */
export function isAmbiguousPersonEvidenceToken(token: string): boolean {
  const t = normalizeText(token);
  if (!t) return true;
  if (/[\u4e00-\u9fff]/.test(t)) return t.length < 2;
  if (/[\uac00-\ud7af]/.test(t)) return t.length < 2;
  if (t.includes(" ")) return false;
  // Single Latin token (minji / yuna / chaewon / wonyoung) needs group context.
  if (/^[a-z0-9]+$/i.test(t)) return true;
  return false;
}

/** Camera-roll style titles with no semantic content. */
export function looksLikeMeaninglessTitle(title: string | undefined): boolean {
  if (!title) return true;
  const t = title.trim();
  if (!t) return true;
  if (/^IMG[_\s-]?\d+/i.test(t)) return true;
  if (/^DSC[_\s-]?\d+/i.test(t)) return true;
  if (/^(?:IMG|DSC|DCIM|photo|image|untitled)[\s._-]*\d*$/i.test(t)) return true;
  if (/^P\d{6,}$/i.test(t)) return true;
  return false;
}

function tokenPresent(hay: string, token: string): boolean {
  const t = normalizeText(token);
  if (!t) return false;
  if (
    t.length <= 2 &&
    !/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t)
  ) {
    return new RegExp(`(?:^|\\s)${escapeReg(t)}(?:\\s|$)`).test(hay);
  }
  return hay.includes(t);
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function anyTokenPresent(hay: string, tokens: string[]): string | undefined {
  for (const tok of tokens) {
    if (tokenPresent(hay, tok)) return tok;
  }
  return undefined;
}

/**
 * Score a hit against the user subject / curated entity.
 *
 * For persons: require the person's name (or known romanization/hangul) in
 * title/tags — preferably the title. This is metadata evidence only, not
 * visual identity verification.
 */
export function assessImageRelevance(
  hit: ImageSearchHit,
  opts: {
    subject: string;
    entity?: ImageEntity;
    requireStrongEvidence: boolean;
  },
): RelevanceAssessment {
  const hay = haystackOf(hit);
  const titleN = normalizeText(hit.title ?? "");
  const reasons: string[] = [];
  let score = 0;

  const w = hit.width ?? 0;
  const h = hit.height ?? 0;
  if (w > 0 && h > 0) {
    score += Math.min(w * h, 4_000_000) / 10_000;
    const ratio = w / h;
    if (ratio > 0.35 && ratio < 3.2) score += 20;
  }

  if (looksLikeMeaninglessTitle(hit.title)) {
    score -= 80;
    reasons.push("generic-filename");
  }

  let strong = false;
  let topical = false;

  if (opts.entity?.kind === "person") {
    const titleHit = anyTokenPresent(titleN, opts.entity.evidenceTokens);
    const tagHit = (hit.tags ?? [])
      .map((t) => normalizeText(t))
      .some((tag) => anyTokenPresent(tag, opts.entity!.evidenceTokens));
    const urlN = normalizeText(urlEvidenceText(hit));
    const urlHit = anyTokenPresent(urlN, opts.entity.evidenceTokens);
    const hayHit = anyTokenPresent(hay, opts.entity.evidenceTokens);
    const contextHit = anyTokenPresent(hay, opts.entity.contextTokens ?? []);

    if (titleHit) {
      score += 180;
      reasons.push(`title:${titleHit}`);
    }
    if (tagHit) {
      score += 80;
      reasons.push("tags-evidence");
    }
    if (urlHit) {
      score += 60;
      reasons.push(`url:${urlHit}`);
    }
    if (contextHit) {
      score += 45;
      reasons.push(`context:${contextHit}`);
    }
    if ((hit.source ?? "").toLowerCase() === "wikimedia" && (titleHit || hayHit)) {
      score += 35;
      reasons.push("wikimedia");
    }

    // Strong evidence (metadata only — not face ID):
    // - distinctive name in title, or
    // - ambiguous given name in title/URL only with group context, or
    // - tags + group context.
    // Never accept bare group-name titles (e.g. "NewJeans") as the person.
    const distinctiveTitle =
      !!titleHit && !isAmbiguousPersonEvidenceToken(titleHit);
    const ambiguousNameWithContext =
      ((!!titleHit && isAmbiguousPersonEvidenceToken(titleHit)) ||
        (!!urlHit && isAmbiguousPersonEvidenceToken(urlHit))) &&
      !!contextHit;
    const tagsWithContext = !!tagHit && !!contextHit;
    const urlDistinctive =
      !!urlHit && !isAmbiguousPersonEvidenceToken(urlHit) && !!contextHit;

    strong =
      !looksLikeMeaninglessTitle(hit.title) &&
      (distinctiveTitle ||
        ambiguousNameWithContext ||
        tagsWithContext ||
        urlDistinctive);
    topical = !!hayHit;
    if (!strong) {
      score -= 500;
      if (!reasons.includes("weak-identity")) reasons.push("weak-identity");
    }
  } else {
    const subject = normalizeText(opts.subject);
    const parts = new Set<string>();
    for (const p of subject.split(" ")) {
      if (p.length > 1) parts.add(p);
    }
    if (/[\u4e00-\u9fff\uac00-\ud7af]/.test(opts.subject)) {
      parts.add(subject);
    }
    let hits = 0;
    for (const p of parts) {
      if (tokenPresent(hay, p)) {
        hits += 1;
        score += 90;
        reasons.push(`topic:${p}`);
      }
    }
    topical = hits >= 1;
    strong = topical && !looksLikeMeaninglessTitle(hit.title);
    if (!topical) score -= 200;
  }

  return { hit, score, strong, topical, reasons };
}

export type RelevantImagePick = {
  hit: ImageSearchHit;
  assessment: RelevanceAssessment;
};

/**
 * Rank all relevance-gated candidates (best first). Does not download.
 * Callers should attempt downloads in this order and skip stale URLs.
 */
export function listRelevantImages(
  hits: ImageSearchHit[],
  opts: {
    subject: string;
    entity?: ImageEntity;
    requireStrongEvidence: boolean;
    minWidth: number;
    minHeight: number;
    excludeIds?: Set<string>;
  },
): RelevantImagePick[] {
  const exclude = opts.excludeIds ?? new Set();
  return hits
    .filter((h) => h.url && !exclude.has(h.id))
    .filter((h) => {
      const w = h.width ?? 0;
      const hgt = h.height ?? 0;
      if (w > 0 && w < opts.minWidth) return false;
      if (hgt > 0 && hgt < opts.minHeight) return false;
      return true;
    })
    .map((h) =>
      assessImageRelevance(h, {
        subject: opts.subject,
        entity: opts.entity,
        requireStrongEvidence: opts.requireStrongEvidence,
      }),
    )
    .filter((a) =>
      opts.requireStrongEvidence ? a.strong : a.topical || a.strong,
    )
    .sort((a, b) => b.score - a.score)
    .map((a) => ({ hit: a.hit, assessment: a }));
}

export function pickRelevantImage(
  hits: ImageSearchHit[],
  opts: {
    subject: string;
    entity?: ImageEntity;
    requireStrongEvidence: boolean;
    minWidth: number;
    minHeight: number;
    excludeIds?: Set<string>;
  },
): RelevantImagePick | undefined {
  return listRelevantImages(hits, opts)[0];
}

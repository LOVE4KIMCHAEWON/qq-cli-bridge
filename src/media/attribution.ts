import type { ImageSearchHit } from "./types.js";

const SOURCE_LABELS: Record<string, string> = {
  wikimedia: "Wikimedia Commons",
  flickr: "Flickr",
  rawpixel: "Rawpixel",
  wordpress: "WordPress",
  nasa: "NASA",
  metropolitan: "The Met",
  pexels: "Pexels",
  unsplash: "Unsplash",
  openverse: "Openverse",
  duitang: "堆糖",
  ddgs: "DDGS",
  searxng: "SearXNG",
};

/** Casual follow-ups after a successful QQ image send (no metadata). */
const CHAT_REPLIES = [
  "这张不错",
  "这张你看看",
  "这个好棒",
  "看看这张呢",
  "发你一张",
  "先看这张",
] as const;

/** PreferDifferent / “换一张” variants. */
const CHAT_REPLIES_DIFFERENT = [
  "换了张，看看合不合你口味",
  "换一张试试",
  "再来一张这个",
  "换了，你看看",
  "这张呢",
] as const;

let chatReplyCursor = 0;

/**
 * Aggregator / scrape disclaimers that were historically stuffed into `hit.license`.
 * These are NOT redistribution licenses and must never become QQ-visible credits.
 */
export function isUnverifiedLicenseDisclaimer(license: string | undefined): boolean {
  if (!license) return false;
  const raw = license.trim();
  if (!raw) return false;
  return /许可证未验证|仅作搜索聚合|经\s*SearXNG\s*聚合|来源网页|堆糖用户内容|搜索聚合/u.test(
    raw,
  );
}

/** Map Openverse / CC license codes to short display forms. */
export function formatLicenseLabel(license: string | undefined): string | undefined {
  if (!license) return undefined;
  const raw = license.trim();
  if (!raw) return undefined;
  // Keep disclaimer text for internal logs only — callers must not treat as CC.
  if (isUnverifiedLicenseDisclaimer(raw)) return raw.slice(0, 40);
  const n = raw.toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();

  if (n === "cc0" || n.startsWith("cc0 ")) return "CC0";
  if (n === "pdm" || n.includes("public domain mark") || n === "public domain") {
    return "公有领域";
  }
  if (n === "cc0 1.0" || n === "cc0-1.0") return "CC0 1.0";

  const cc = n.match(
    /^(?:cc\s*)?(by(?:[- ](?:sa|nc|nd|nc[- ]sa|nc[- ]nd))?)(?:\s+(\d(?:\.\d)?))?$/i,
  );
  if (cc) {
    const feat = cc[1]!.toUpperCase().replace(/\s+/g, "-");
    const ver = cc[2] ? ` ${cc[2]}` : "";
    return `CC ${feat}${ver}`.replace(/\s+/g, " ").trim();
  }

  const short = n.match(/^(by(?:-(?:sa|nc|nd|nc-sa|nc-nd))?)\s+(\d(?:\.\d)?)$/i);
  if (short) {
    return `CC ${short[1]!.toUpperCase()} ${short[2]}`;
  }

  return raw.slice(0, 24);
}

export function formatSourceLabel(source: string | undefined): string {
  if (!source) return "Openverse";
  const key = source.trim().toLowerCase();
  return SOURCE_LABELS[key] ?? source.trim().slice(0, 28);
}

/**
 * CC0 / public-domain do not require visible credit.
 * CC-BY* (and similar) typically require creator + license when redistributing.
 * DDGS / SearXNG / Duitang: license is unverified or undocumented — never invent
 * QQ-facing “图：host · 许可证未验证…” credits (metadata stays internal).
 */
export function requiresVisibleAttribution(hit: ImageSearchHit): boolean {
  if (
    hit.provider === "duitang" ||
    hit.source === "duitang" ||
    hit.provider === "ddgs" ||
    hit.provider === "searxng"
  ) {
    return false;
  }
  if (isUnverifiedLicenseDisclaimer(hit.license)) return false;
  const license = formatLicenseLabel(hit.license);
  if (!license || isUnverifiedLicenseDisclaimer(license)) return false;
  const n = license.toLowerCase();
  if (n === "cc0" || n.startsWith("cc0 ") || n === "公有领域") return false;
  // Real CC BY* / named redistribution licenses → minimal credit
  if (/^cc\s+by/i.test(license) || /^Pexels License$/i.test(hit.license ?? "")) {
    return true;
  }
  // Unknown non-disclaimer labels: only when we also have a creator (avoid host dumps)
  return !!hit.creator?.trim();
}

/** One-line credit when redistribution terms expect attribution. */
export function formatMinimalVisibleCredit(hit: ImageSearchHit): string | undefined {
  if (!requiresVisibleAttribution(hit)) return undefined;
  const who = hit.creator?.trim().slice(0, 24);
  const license = formatLicenseLabel(hit.license);
  if (!license || isUnverifiedLicenseDisclaimer(license)) return undefined;
  // Never surface raw hostnames / aggregator labels as the “图：” credit alone.
  if (who) return `图：${who} · ${license}`.slice(0, 60);
  if (/^cc\s+by/i.test(license) || /^Pexels License$/i.test(hit.license ?? "")) {
    const source = formatSourceLabel(hit.source || hit.provider);
    // Prefer stable provider labels (Wikimedia/Pexels), not www.reddit.com.
    if (/^(wikimedia|flickr|pexels|unsplash|openverse|nasa|the met|rawpixel)/i.test(source)) {
      return `图：${source} · ${license}`.slice(0, 60);
    }
  }
  return undefined;
}

/** True when QQ text still contains banned technical attribution strings. */
export function containsTechnicalAttributionText(text: string): boolean {
  return /许可证未验证|仅作搜索聚合|来源网页|经\s*SearXNG\s*聚合|堆糖用户内容/u.test(
    text,
  );
}

/**
 * Short conversational QQ text after a successful image send.
 * Rotates phrases; optionally appends minimal license credit (no tech disclaimers).
 */
export function formatChatImageFollowUp(
  hit: ImageSearchHit,
  opts: { preferDifferent?: boolean } = {},
): string {
  const pool = opts.preferDifferent ? CHAT_REPLIES_DIFFERENT : CHAT_REPLIES;
  const phrase = pool[chatReplyCursor % pool.length]!;
  chatReplyCursor += 1;
  const credit = formatMinimalVisibleCredit(hit);
  if (!credit || containsTechnicalAttributionText(credit)) return phrase;
  const out = `${phrase}\n${credit}`.slice(0, 80);
  if (containsTechnicalAttributionText(out)) return phrase;
  return out;
}

/** @internal test helper — reset rotation. */
export function resetImageChatReplyCursorForTests(): void {
  chatReplyCursor = 0;
}

/**
 * Internal / Bridge-action attribution — not shown as QQ image caption.
 * Keeps creator, license, landing URL for traceability.
 */
/** Internal-only note for aggregator hits (never QQ-visible). */
function internalUnverifiedNote(hit: ImageSearchHit): string | undefined {
  if (hit.provider === "ddgs") {
    return "来源网页（许可证未验证；仅作搜索聚合）";
  }
  if (hit.provider === "searxng") {
    return "来源网页（许可证未验证；经 SearXNG 聚合）";
  }
  if (isUnverifiedLicenseDisclaimer(hit.license)) {
    return formatLicenseLabel(hit.license);
  }
  return undefined;
}

export function formatInternalImageAttribution(hit: ImageSearchHit): string {
  if (hit.provider === "duitang" || hit.source === "duitang") {
    const who = hit.creator?.trim().slice(0, 28);
    const link = (hit.foreignLandingUrl?.trim() || "").slice(0, 140);
    return [
      who ? `堆糖 ${who}` : "堆糖",
      hit.title?.trim().slice(0, 40),
      link || undefined,
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 200);
  }

  const source = formatSourceLabel(hit.source || hit.provider);
  const who = hit.creator?.trim().slice(0, 28);
  const license =
    hit.provider === "ddgs" || hit.provider === "searxng"
      ? internalUnverifiedNote(hit)
      : formatLicenseLabel(hit.license);
  const link = (
    hit.foreignLandingUrl?.trim() ||
    hit.licenseUrl?.trim() ||
    ""
  ).slice(0, 140);

  return [source, who, license, link].filter(Boolean).join(" · ").slice(0, 200);
}

/**
 * @deprecated Prefer formatChatImageFollowUp for QQ text and
 * formatInternalImageAttribution for logs. Kept for provider hit.attribution.
 */
export function formatQqImageCaption(hit: ImageSearchHit): string {
  return formatInternalImageAttribution(hit);
}

/** Caption when QQ actually received image bytes from Duitang CDN (internal). */
export function formatDuitangImageCaption(hit: ImageSearchHit): string {
  return formatInternalImageAttribution(hit);
}

/**
 * Link-only Duitang delivery: must include the blog URL (that is the payload).
 * No API/face-verification disclaimers in chat.
 */
export function formatDuitangLinkCaption(hit: ImageSearchHit): string {
  const title = hit.title?.trim().slice(0, 40);
  const link = (
    hit.foreignLandingUrl?.trim() ||
    hit.url?.trim() ||
    ""
  ).slice(0, 160);
  const who = hit.creator?.trim().slice(0, 28);
  return [
    "找到一张，先发来源链接给你：",
    title ? title : undefined,
    who ? who : undefined,
    link || undefined,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 280);
}

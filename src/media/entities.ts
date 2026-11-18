/**
 * Curated entity aliases for image search.
 * Chinese-only Openverse queries for K-pop idols routinely return unrelated Flickr noise;
 * romanized + group names hit Wikimedia titles that actually name the person.
 */

export type ImageEntityKind = "person" | "topic";

export interface ImageEntity {
  id: string;
  kind: ImageEntityKind;
  /** Canonical display label for user-facing errors. */
  displayName: string;
  /** Surface forms that identify this entity (Chinese, English, Hangul, aliases). */
  aliases: string[];
  /**
   * Ordered Openverse search strings. Prefer english/hangul person+group forms first.
   * Do not put bare Chinese alone first for K-pop idols.
   */
  searchQueries: string[];
  /** Tokens that must appear (normalized) in title/tags/creator for a strong match. */
  evidenceTokens: string[];
  /** Optional group/org tokens that strengthen person matches. */
  contextTokens?: string[];
}

/**
 * Small curated set — extend as needed. Not a general knowledge graph.
 */
export const IMAGE_ENTITIES: ImageEntity[] = [
  {
    id: "jang-wonyoung",
    kind: "person",
    displayName: "张元英 / Jang Wonyoung",
    aliases: [
      "张元英",
      "張元英",
      "元英",
      "jang wonyoung",
      "jang won young",
      "jang won-young",
      "wonyoung",
      "won young",
      "장원영",
      "ive wonyoung",
      "wonyoung ive",
    ],
    searchQueries: [
      "Jang Wonyoung IVE",
      "Jang Wonyoung",
      "장원영",
      "Wonyoung IVE",
    ],
    evidenceTokens: [
      "jang wonyoung",
      "jang won-young",
      "jang won young",
      "wonyoung",
      "장원영",
      "张元英",
      "張元英",
    ],
    contextTokens: ["ive", "아이브", "produce48", "produce 48"],
  },
  {
    id: "shin-yuna",
    kind: "person",
    displayName: "申有娜 / Shin Yuna",
    aliases: [
      "申有娜",
      "有娜",
      "shin yuna",
      "shin yu na",
      "yuna itzy",
      "itzy yuna",
      "itzy shin yuna",
      "신유나",
      "유나",
    ],
    searchQueries: ["Shin Yuna ITZY", "Shin Yuna", "신유나", "ITZY Yuna"],
    evidenceTokens: [
      "shin yuna",
      "shin yu-na",
      "shin yu na",
      "yuna",
      "신유나",
      "유나",
      "申有娜",
    ],
    contextTokens: ["itzy", "있지"],
  },
  {
    id: "kim-chaewon",
    kind: "person",
    displayName: "金采源 / Kim Chaewon",
    aliases: [
      "金采源",
      "金彩源",
      "采源",
      "kim chaewon",
      "kim chae won",
      "kim chae-won",
      "chaewon",
      "chae won",
      "김채원",
      "채원",
      "le sserafim chaewon",
      "chaewon le sserafim",
      "lesserafim chaewon",
      "le sserafim kim chaewon",
    ],
    searchQueries: [
      "Kim Chaewon LE SSERAFIM",
      "Kim Chaewon",
      "김채원",
      "LE SSERAFIM Chaewon",
      "金采源 LE SSERAFIM",
    ],
    evidenceTokens: [
      "kim chaewon",
      "kim chae-won",
      "kim chae won",
      "chaewon",
      "김채원",
      "채원",
      "金采源",
      "金彩源",
    ],
    contextTokens: [
      "le sserafim",
      "lesserafim",
      "르세라핌",
      "fearless",
      "izone",
      "아이즈원",
    ],
  },
  {
    id: "newjeans-minji",
    kind: "person",
    displayName: "Minji / 金玟池 / NewJeans",
    aliases: [
      "minji",
      "金玟池",
      "민지",
      "newjeans minji",
      "minji newjeans",
      "뉴진스 민지",
      "kim minji",
      "kim min-ji",
    ],
    searchQueries: [
      "NewJeans Minji",
      "NewJeans Minji airport",
      "민지 뉴진스",
      "金玟池 NewJeans",
      "Kim Minji NewJeans",
    ],
    // Do NOT put bare "newjeans" in evidence — that would accept any group photo.
    evidenceTokens: ["minji", "민지", "金玟池", "kim minji", "kim min-ji"],
    contextTokens: ["newjeans", "뉴진스", "ador"],
  },
  {
    id: "newjeans-hanni",
    kind: "person",
    displayName: "Hanni / NewJeans",
    aliases: ["hanni", "하니", "newjeans hanni", "hanni newjeans"],
    searchQueries: ["NewJeans Hanni", "하니 뉴진스", "Hanni NewJeans stage"],
    evidenceTokens: ["hanni", "하니"],
    contextTokens: ["newjeans", "뉴진스"],
  },
  {
    id: "newjeans-group",
    kind: "topic",
    displayName: "NewJeans",
    aliases: ["newjeans", "뉴진스", "纽金斯", "new jeans"],
    searchQueries: [
      "NewJeans five members group photo",
      "NewJeans OT5",
      "NewJeans group photo",
      "뉴진스 단체사진",
    ],
    evidenceTokens: ["newjeans", "뉴진스", "ot5"],
    contextTokens: ["newjeans", "뉴진스", "ador"],
  },
];

/** Map Chinese scene/modifier words into English web-search phrases. */
const SCENE_EN_EXPAND: Array<{ re: RegExp; en: string }> = [
  { re: /机场(?:照|图)?/u, en: "airport photos" },
  { re: /舞台(?:照|图)?|直拍/u, en: "stage performance" },
  { re: /五人(?:合照|合影)|五个人一起|全员合照|合照|合影/u, en: "five members group photo" },
  { re: /自拍/u, en: "selfie" },
  { re: /更清晰|清晰一?点|高清/u, en: "high resolution" },
];

/**
 * Build multilingual / alias-expanded queries for web aggregators (DDGS / SearXNG).
 * Avoids extra model calls — deterministic only.
 */
export function expandWebImageQueries(rawSubject: string): string[] {
  const subject = stripImageQueryFillers(rawSubject);
  const entity = matchImageEntity(subject);
  const out: string[] = [];
  const push = (s: string | undefined) => {
    const t = s?.trim();
    if (!t) return;
    if (!out.includes(t)) out.push(t);
  };

  if (entity) {
    for (const q of entity.searchQueries) push(q);
    // Attach scene expansion to primary English form.
    let sceneEn = "";
    for (const { re, en } of SCENE_EN_EXPAND) {
      if (re.test(subject)) {
        sceneEn = en;
        break;
      }
    }
    if (sceneEn && entity.searchQueries[0]) {
      push(`${entity.searchQueries[0]} ${sceneEn}`);
    }
  } else {
    push(subject);
    let rest = subject;
    let sceneEn = "";
    for (const { re, en } of SCENE_EN_EXPAND) {
      if (re.test(rest)) {
        sceneEn = en;
        rest = rest.replace(re, " ").replace(/\s+/g, " ").trim();
        break;
      }
    }
    if (rest && sceneEn) push(`${rest} ${sceneEn}`);
    else if (sceneEn) push(sceneEn);
  }

  // Keep original CJK subject for Duitang-style corpora.
  push(subject);
  return out.slice(0, 5);
}

/** Strip aesthetic / medium fillers so “张元英美图” → “张元英”. */
const FILLER_RE =
  /(?:的)?(?:美图|美照|好看|高清|壁纸|写真|自拍|生图|照片|图片|表情包|meme|图)$/gu;

const LEADING_FILLER_RE = /^(?:好看的?|高清的?|美丽的?|漂亮的?)\s*/u;

/** 「有没有其他的张元英」→「张元英」 */
const VARIETY_LEADING_RE =
  /^(?:有没有|还有)?(?:其他的?|别的)\s*/u;

export function stripImageQueryFillers(raw: string): string {
  let q = raw.trim().replace(/\s+/g, " ");
  q = q.replace(VARIETY_LEADING_RE, "");
  q = q.replace(LEADING_FILLER_RE, "");
  // Peel trailing aesthetic nouns repeatedly (美图, 图, …)
  for (let i = 0; i < 3; i++) {
    const next = q.replace(FILLER_RE, "").trim();
    if (next === q) break;
    q = next;
  }
  return q.replace(/的$/u, "").trim();
}

function normKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_·・]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Match a user query (already filler-stripped) to a curated entity.
 * Longer aliases win to prefer “jang wonyoung” over bare “yuna”.
 */
export function matchImageEntity(query: string): ImageEntity | undefined {
  const q = normKey(stripImageQueryFillers(query));
  if (!q) return undefined;
  let best: { entity: ImageEntity; len: number } | undefined;
  for (const entity of IMAGE_ENTITIES) {
    for (const alias of entity.aliases) {
      const a = normKey(alias);
      if (!a) continue;
      if (q === a || q.includes(a) || a.includes(q)) {
        const len = a.length;
        if (!best || len > best.len) best = { entity, len };
      }
    }
  }
  return best?.entity;
}

export interface NormalizedImageQuery {
  /** Original user subject after filler strip. */
  subject: string;
  /** Label for honest errors. */
  displayName: string;
  /** Ordered Openverse `q` values to try. */
  searchQueries: string[];
  entity?: ImageEntity;
  /** Person entities require strong metadata evidence before send. */
  requireStrongEvidence: boolean;
}

export function normalizeImageSearchQuery(rawQuery: string): NormalizedImageQuery {
  const subject = stripImageQueryFillers(rawQuery);
  const entity = matchImageEntity(subject);
  const expanded = expandWebImageQueries(rawQuery);
  if (entity) {
    return {
      subject,
      displayName: entity.displayName,
      searchQueries: expanded.length ? expanded : [...entity.searchQueries],
      entity,
      requireStrongEvidence: entity.kind === "person",
    };
  }
  return {
    subject,
    displayName: subject,
    searchQueries: expanded.length ? expanded : subject ? [subject] : [],
    requireStrongEvidence: false,
  };
}

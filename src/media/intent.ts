/**
 * Deterministic image-search intent detection (Bridge-owned, no LLM).
 * Does NOT treat AI image-generation requests as search — those get a refusal cue.
 */
import { stripImageQueryFillers } from "./entities.js";

export type ImageIntent =
  | {
      kind: "search";
      query: string;
      preferDifferent?: boolean;
      /** Requested image count (再来三张). Bounded by config later. */
      count?: number;
      /** Optional explicit provider from NL/slash. */
      provider?: string;
    }
  | { kind: "generate_refused"; query?: string }
  | { kind: "none" };

export interface ImageIntentContext {
  /** Last delivered IMAGE_SENT query in this conversation (from Bridge actions / session). */
  lastImageQuery?: string;
  /**
   * Subject awaiting delivery (Bridge set pending, or prior search not confirmed).
   * Used for nudges like「发啊」.
   */
  pendingImageQuery?: string;
}

const GEN_RE =
  /^(?:请|帮我|给我)?(?:画|生成|创作|AI\s*画|文生图|diffusion)\s*(?:一|一?张|个)?|^draw\s+(?:me\s+)?(?:a|an)\b|^generate\s+(?:an?\s+)?(?:image|picture|photo)\b|^create\s+(?:an?\s+)?(?:image|picture)\b/i;

const EN_SEARCH_RE =
  /^(?:(?:please\s+)?(?:find|search(?:\s+for)?|send|show|get)\s+(?:me\s+)?(?:a|an|some)\s+)?(?:pic(?:ture)?|photo|image|meme)s?\s+(?:of\s+)?(.+)$/i;

const EN_SEARCH_ALT_RE =
  /^(?:(?:please\s+)?(?:find|search(?:\s+for)?|send|show|get)\s+(?:me\s+)?)(.+?)\s+(?:pic(?:ture)?|photo|image|meme)s?$/i;

/** Trailing visual nouns (kept in query when meaningful, e.g. 合照 / 机场照). */
const VISUAL_NOUN =
  "(?:的)?(?:美图|美照|合照|合影|机场照|舞台照|自拍|生图|照片|图片|写真|壁纸|表情包|meme|梗图|直拍|图|照)";

const VISUAL_NOUN_END_RE = new RegExp(`${VISUAL_NOUN}$`, "u");

/** Classic form: 找张…图 / 发个…表情包 / 给我找点…舞台图. */
const ZH_SEARCH_WITH_NOUN_RE = new RegExp(
  `^(?:请|帮我|给我|麻烦)?(?:找|搜|搜索|查|来|发|整)(?:一)?(?:张|个|点|些|几)?\\s*(.+?)${VISUAL_NOUN}$`,
  "u",
);

/**
 * Fetch-classifier form WITHOUT trailing 图 — requires 张 (photo classifier).
 * Covers「来张张元英」,「发张申有娜」,「整张猫猫」.
 */
const ZH_FETCH_ZHANG_RE =
  /^(?:请|帮我|给我|麻烦)?(?:找|搜|搜索|查|来|发|整)(?:一)?张\s*(.+)$/u;

/** 「再来一张张元英」/「换一张张元英」/「再发一张猫猫」 */
const ZH_ANOTHER_ZHANG_RE =
  /^(?:请|帮我|给我|麻烦)?(?:再来|再发|再找|换)(?:一)?张\s*(.+)$/u;

/** 「有没有其他的张元英图」/「还有别的猫猫图」 */
const ZH_OTHER_WITH_NOUN_RE = new RegExp(
  `^(?:有没有|还有)?(?:其他的?|别的)\\s*(.+?)${VISUAL_NOUN}$`,
  "u",
);

/**
 * Existence / soft request:「有没有newjeans五人合照」「有木有张元英」
 */
const ZH_YOUMEI_RE =
  /^(?:有没有|有木有|还有没有)\s*(.+?)(?:吗|呢|呀|啊)?$/u;

/** 「想看看Minji的机场照」「想看张元英」 */
const ZH_WANT_SEE_RE = new RegExp(
  `^(?:我)?(?:想|想要)?看(?:看)?\\s*(.+?)${VISUAL_NOUN}$`,
  "u",
);

/** 「有那种五个人一起拍的吗」— scene follow-up; needs lastImageQuery. */
const ZH_THAT_KIND_RE =
  /^有那种(.+?)(?:吗|呢|呀|啊)?$/u;

const ZH_COMPACT_RE = new RegExp(
  `^([\\u4e00-\\u9fffA-Za-z0-9 ·・]{1,40}?)${VISUAL_NOUN}$`,
  "u",
);

/**
 * Follow-ups that refer to the last Bridge-sent image without naming the subject:
 * 「换一张」「再来一张」「再来几张」「还有别的吗」
 */
const ZH_FOLLOWUP_RE =
  /^(?:这张(?:不太?好看|不行|不要|丑|难看).{0,12})?(?:请|帮我|给我|我要|想)?(?:再来|再发|再找|换|看)?(?:一|两|二|三|四|五|几)?(?:张|点|些)?(?:其他的?|别的)?(?:的)?(?:她|他|它)?(?:的)?(?:美图|美照|合照|图|图片|照片|写真)?$|^还有别的吗$|^换一张$|^再来一张$|^再来几张$|^再发几张$|^再来三张$|^其他的呢$/u;

const ZH_COUNT_FOLLOWUP_RE =
  /^(?:请|帮我|给我)?(?:再来|再发|再找|换)(?:一|两|二|三|四|五|几)张(?:吧|啊|呢)?$/u;

/** 「换一批」「换一波」— another batch of the same subject (needs lastImageQuery). */
const ZH_BATCH_RE =
  /^(?:请|帮我|给我)?(?:再)?换(?:一)?(?:批|波|组)(?:吧|啊|呢|哟)?$|^(?:再来|来)(?:一)?(?:批|波)(?:吧|啊|呢)?$/u;

/**
 * 「继续张元英」「继续看她」「继续」—
 * continue/search more of a named subject or last subject.
 * Must not hijack ordinary chat (「继续说」「继续聊」).
 */
const ZH_CONTINUE_RE =
  /^(?:请|帮我|给我)?继续(?:看|发|搜|找)?(?:一下|一些)?\s*(.*)$/u;

/** Rests after「继续」that are ordinary chat, not image subjects. */
const ZH_CONTINUE_CHAT_REST_RE =
  /^(?:说|聊|讲|谈|聊天|说话|下去)(?:吧|啊|呀|呢|啦)?$|^(?:吧|啊|呀|呢|啦|着)$/u;

/**
 * Nudge to actually send after an acknowledge:「发啊」「倒是发啊」「快发」.
 * Requires pendingImageQuery or lastImageQuery.
 */
const ZH_SEND_NUDGE_RE =
  /^(?:你)?(?:倒是|赶紧|快)?(?:给)?发(?:啊|呀|嘛|啦|吧|过来|一下)?$|^(?:倒是|赶紧|快)发$|^发！$/u;

/** Reject subjects that are chat particles / pronouns / conversational filler. */
const REJECT_SUBJECT_RE =
  /^(?:我|你|他|她|它|咱|谁|啥|什么|吗|呢|啊|吧|嘛|哈|嗯|哦|额|谢谢|你好|在吗|一下|好看|不好看|其他|别的)$/u;

const VARIETY_PREFIX_RE =
  /^(?:有没有|有木有|还有没有|还有)?(?:其他的?|别的)?\s*/u;

const PRONOUN_OR_DEIXIS_RE = /^(?:她|他|它|这张|那个|这个)$/u;

/** Quality-only refinements — keep last subject, do not search these alone. */
const QUALITY_ONLY_RE =
  /^(?:更)?(?:清晰|高清|清楚|好看|漂亮)(?:一?点|一些|的)?$/u;

/** Scene / shot-type modifiers that refine the last subject. */
const SCENE_MODIFIER_RE =
  /^(?:那种)?(?:五人?|几人?|全员)?(?:合照|合影|团拍)$|^(?:那种)?五个人一起(?:拍(?:的)?)?$|^(?:机场|舞台|自拍|直拍|预览|生图)(?:照|图)?$|^(?:其他的?|别的)(?:的)?(?:图|照|合照)?$/u;

/**
 * Factual / chat questions about people or images — must NOT become search.
 */
const FACTUAL_QUESTION_RE =
  /(?:出道|几岁|哪年|什么时候|为什么|怎么|如何|是什么意思|什么意思|成员有谁|有几个人|几个人|是谁拍的|谁拍的|多少钱|哪个公司|什么组合)/u;

/**
 * Parse natural-language image search / generation requests.
 * Pass `lastImageQuery` from Bridge recent actions to resolve “她/这张/换一张”.
 */
export function parseImageIntent(
  text: string,
  ctx: ImageIntentContext = {},
): ImageIntent {
  const raw = text.trim().replace(/\s+/g, " ");
  if (!raw || raw.startsWith("/")) return { kind: "none" };

  if (GEN_RE.test(raw)) {
    const q = raw
      .replace(GEN_RE, "")
      .replace(/^(?:一|一?张|个|of|a|an)\s*/i, "")
      .trim();
    return { kind: "generate_refused", query: q || undefined };
  }

  // Ordinary factual Qs about idols/photos stay with the Agent.
  if (looksLikeFactualQuestion(raw)) {
    return { kind: "none" };
  }

  const last = ctx.lastImageQuery?.trim();
  const pending = ctx.pendingImageQuery?.trim();

  // 「发啊」— only fulfill an explicit pending Bridge request (not bare last).
  if (ZH_SEND_NUDGE_RE.test(raw)) {
    if (!pending) return { kind: "none" };
    return searchIntent(pending, true, undefined);
  }

  // 「换一批」— another batch of the same subject.
  if (ZH_BATCH_RE.test(raw)) {
    if (!last) return { kind: "none" };
    return searchIntent(last, true, 2);
  }

  // 「继续」「继续张元英」「继续看她」— only when unambiguous image context/subject.
  const cont = raw.match(ZH_CONTINUE_RE);
  if (cont) {
    const rest = (cont[1] ?? "").trim();
    // Ordinary chat continuations never become image search.
    if (rest && ZH_CONTINUE_CHAT_REST_RE.test(rest)) {
      return { kind: "none" };
    }
    // Bare「继续」/「继续看」needs lastImageQuery.
    if (!rest) {
      if (!last) return { kind: "none" };
      return searchIntent(last, true);
    }
    // 「继续看她」
    if (
      PRONOUN_OR_DEIXIS_RE.test(sanitizeQuery(rest)) ||
      /^(?:她|他|它)的?$/u.test(rest)
    ) {
      if (!last) return { kind: "none" };
      return searchIntent(last, true);
    }
    // Strip leading 看/发 and trailing particles / “的图”
    const subjectRaw = rest
      .replace(/^(?:看|发|搜|找)\s*/u, "")
      .replace(/(?:的)?(?:图|照片|美图|美照)?$/u, "")
      .trim();
    if (!subjectRaw || ZH_CONTINUE_CHAT_REST_RE.test(subjectRaw)) {
      if (!subjectRaw && last) return searchIntent(last, true);
      return { kind: "none" };
    }
    const subject = acceptSubject(subjectRaw);
    if (subject) {
      const preferDifferent =
        !!last && subject.toLowerCase() === last.toLowerCase();
      // Named subject (继续张元英) is actionable even without prior IMAGE_SENT.
      return searchIntent(subject, preferDifferent || !!last);
    }
    return { kind: "none" };
  }

  // Pronoun / deictic / “再来几张/三张” follow-ups — only with recent IMAGE_SENT.
  if (last && ZH_COUNT_FOLLOWUP_RE.test(raw)) {
    return searchIntent(last, true, parseImageCount(raw));
  }
  if (last && ZH_FOLLOWUP_RE.test(raw)) {
    return searchIntent(last, true, parseImageCount(raw));
  }

  const en = raw.match(EN_SEARCH_RE) ?? raw.match(EN_SEARCH_ALT_RE);
  if (en?.[1]) {
    const query = sanitizeQuery(en[1]);
    if (query) {
      return resolveSubject(
        query,
        /another|different|other|more/i.test(raw),
        last,
      );
    }
  }

  const zhThatKind = raw.match(ZH_THAT_KIND_RE);
  if (zhThatKind?.[1]) {
    const mod = sanitizeQuery(zhThatKind[1]);
    if (last && (isSceneModifier(mod) || isModifierOnly(mod))) {
      return searchIntent(mergeWithLast(last, normalizeModifier(mod)), true);
    }
    // Without context, “有那种…” alone is too vague → Agent.
    if (!last) return { kind: "none" };
  }

  const zhYoumei = raw.match(ZH_YOUMEI_RE);
  if (zhYoumei?.[1]) {
    const remainder = stripTrailingParticles(zhYoumei[1]);
    const handled = resolveYoumeiOrModifier(remainder, last);
    if (handled) return handled;
  }

  const zhWantSee = raw.match(ZH_WANT_SEE_RE);
  if (zhWantSee?.[1]) {
    const query = acceptSubjectKeepVisual(zhWantSee[1], raw);
    if (query) return resolveSubject(query, false, last);
  }

  const zhOther = raw.match(ZH_OTHER_WITH_NOUN_RE);
  if (zhOther?.[1]) {
    const query = acceptSubjectKeepVisual(zhOther[1], raw);
    if (query) return resolveSubject(query, true, last);
  }

  const zhAnother = raw.match(ZH_ANOTHER_ZHANG_RE);
  if (zhAnother?.[1]) {
    const rawSub = zhAnother[1];
    const cleaned = sanitizeQuery(rawSub);
    if (last && (isPronounOrEmpty(rawSub) || isModifierOnly(cleaned))) {
      if (isSceneModifier(cleaned)) {
        return searchIntent(
          mergeWithLast(last, normalizeModifier(cleaned)),
          true,
        );
      }
      return searchIntent(last, true);
    }
    const query = acceptSubject(rawSub);
    if (query) return resolveSubject(query, true, last);
  }

  // Prefer explicit “…图/照片/表情包/合照” forms.
  const zhNoun = raw.match(ZH_SEARCH_WITH_NOUN_RE);
  if (zhNoun?.[1]) {
    const query = acceptSubjectKeepVisual(zhNoun[1], raw);
    if (query) {
      return resolveSubject(
        query,
        hasVarietyCue(raw) || hasVarietyCue(zhNoun[1]),
        last,
      );
    }
  }

  // 「来张张元英」/「来张更清晰的」
  const zhZhang = raw.match(ZH_FETCH_ZHANG_RE);
  if (zhZhang?.[1]) {
    const rawSub = zhZhang[1];
    const cleaned = sanitizeQuery(rawSub);
    if (last && isModifierOnly(cleaned)) {
      if (isQualityOnly(cleaned)) return searchIntent(last, true);
      return searchIntent(mergeWithLast(last, normalizeModifier(cleaned)), true);
    }
    const query = acceptSubject(rawSub);
    if (query) {
      return resolveSubject(query, hasVarietyCue(zhZhang[1]), last);
    }
  }

  // Short “猫猫表情包” / “张元英照片” / “newjeans五人合照”
  if (ZH_COMPACT_RE.test(raw) && !/^(?:你好|谢谢|在吗)/u.test(raw)) {
    const compact = raw.match(ZH_COMPACT_RE);
    const body = compact?.[1] ?? "";
    if (!/^(?:有没有|有木有)/u.test(body)) {
      const query = acceptSubjectKeepVisual(body, raw);
      if (query && query.length <= 40) {
        return resolveSubject(query, hasVarietyCue(raw), last);
      }
      if (last && isPronounOrEmpty(body) && hasVarietyCue(raw)) {
        return searchIntent(last, true);
      }
    }
  }

  // Conversational “这张不好看，我要看其他的她的图” when regex follow-up is loose.
  if (
    last &&
    /(?:其他的?|别的|换一张|再来一张|再来几张).{0,8}(?:她|他|它)?(?:的)?(?:图|照片|合照)?|(?:这张).{0,8}(?:不好看|不行|不要)/u.test(
      raw,
    ) &&
    /(?:图|照片|合照|换|其他|别的)/u.test(raw)
  ) {
    return searchIntent(last, true);
  }

  return { kind: "none" };
}

function looksLikeFactualQuestion(raw: string): boolean {
  if (!FACTUAL_QUESTION_RE.test(raw)) return false;
  // Strong fetch cues still win (e.g.「有没有出道照」).
  if (
    /(?:来|发|整|找)(?:一)?张|(?:找|搜)(?:一)?(?:点|些|张)|想看(?:看)?|有没有.{0,24}(?:合照|合影|图|照|写真|壁纸)/u.test(
      raw,
    )
  ) {
    return false;
  }
  return true;
}

function resolveYoumeiOrModifier(
  remainder: string,
  last: string | undefined,
): ImageIntent | undefined {
  const cleaned = sanitizeQuery(remainder);
  if (!cleaned) {
    if (last) return searchIntent(last, true);
    return { kind: "none" };
  }
  if (isModifierOnly(cleaned)) {
    if (!last) return { kind: "none" };
    if (isQualityOnly(cleaned)) return searchIntent(last, true);
    return searchIntent(mergeWithLast(last, normalizeModifier(cleaned)), true);
  }
  const withVisual = keepVisualTail(remainder, cleaned);
  const query = acceptSubject(withVisual) ?? acceptSubject(cleaned);
  if (!query) return { kind: "none" };
  return resolveSubject(query, true, last);
}

function stripIntentWrappers(s: string): string {
  return s
    .replace(/^(?:请|帮我|给我|麻烦)/u, "")
    .replace(/^(?:有没有|有木有|还有没有|还有)\s*/u, "")
    .replace(/^(?:想|想要)?看(?:看)?\s*/u, "")
    .replace(/^(?:找|搜|搜索|查|来|发|整)(?:一)?(?:张|个|点|些|几)?\s*/u, "")
    .trim();
}

function keepVisualTail(original: string, cleaned: string): string {
  const o = stripIntentWrappers(stripTrailingParticles(original)).trim();
  const scene = o.match(
    /((?:五人?|几人?|全员)?(?:合照|合影)|(?:机场|舞台)照)$/u,
  )?.[1];
  if (scene) {
    if (cleaned.toLowerCase().includes(scene.toLowerCase())) return cleaned;
    if (/五人?$|几人?$|全员$/u.test(cleaned) && /合照|合影/u.test(scene)) {
      return `${cleaned}${scene.replace(/^(?:五人?|几人?|全员)/u, "")}`;
    }
    // Subject + scene: "newjeans" + "五人合照" / "Minji" + "机场照"
    const withoutScene = o
      .slice(0, Math.max(0, o.length - scene.length))
      .replace(/的$/u, "")
      .trim();
    const sub = sanitizeQuery(withoutScene);
    if (sub) return mergeWithLast(sub, scene);
    return mergeWithLast(cleaned, scene);
  }
  // Only re-attach scene nouns that stripImageQueryFillers would drop incorrectly.
  // Do NOT re-attach aesthetic fillers (美图/图/照片) — those should stay stripped.
  return cleaned;
}

function acceptSubjectKeepVisual(
  captured: string,
  fullRaw: string,
): string | undefined {
  const base = acceptSubject(captured);
  if (!base) return undefined;
  // Prefer captured+tail from the matched subject span, not the whole utterance
  // (avoids leaking「想看看」into the query).
  const tail = fullRaw.match(VISUAL_NOUN_END_RE)?.[0] ?? "";
  const source = `${captured}${tail.startsWith("的") || captured.endsWith("的") ? tail.replace(/^的/u, "") : tail}`;
  return keepVisualTail(source, base) || base;
}

function resolveSubject(
  query: string,
  preferDifferent: boolean,
  last: string | undefined,
): ImageIntent {
  if (PRONOUN_OR_DEIXIS_RE.test(query)) {
    if (last) return searchIntent(last, true);
    return { kind: "none" };
  }
  if (isModifierOnly(query)) {
    if (!last) return { kind: "none" };
    if (isQualityOnly(query)) return searchIntent(last, true);
    return searchIntent(mergeWithLast(last, normalizeModifier(query)), true);
  }
  if (
    /^(?:我要|我想|看|换一张)/u.test(query) ||
    (/她|他|它/.test(query) && query.length <= 6)
  ) {
    if (last && (preferDifferent || /她|他|它|其他|别的/.test(query))) {
      return searchIntent(last, true);
    }
    return { kind: "none" };
  }
  return searchIntent(query, preferDifferent);
}

function mergeWithLast(last: string, modifier: string): string {
  const l = last.trim();
  const m = modifier.trim();
  if (!m) return l.slice(0, 80);
  if (!l) return m.slice(0, 80);
  const ll = l.toLowerCase();
  const ml = m.toLowerCase();
  if (ll.includes(ml)) return l.slice(0, 80);
  if (ml.includes(ll)) return m.slice(0, 80);
  return `${l} ${m}`.replace(/\s+/g, " ").trim().slice(0, 80);
}

function isQualityOnly(q: string): boolean {
  return QUALITY_ONLY_RE.test(q.trim());
}

function isSceneModifier(q: string): boolean {
  return SCENE_MODIFIER_RE.test(q.trim());
}

function isModifierOnly(q: string): boolean {
  const s = q.trim();
  return isQualityOnly(s) || isSceneModifier(s);
}

function normalizeModifier(q: string): string {
  const s = q.trim();
  if (/五个人一起/u.test(s)) return "五人合照";
  if (/^那种/u.test(s)) return s.replace(/^那种/u, "").trim() || s;
  return s;
}

function isPronounOrEmpty(raw: string): boolean {
  const q = sanitizeQuery(raw);
  return !q || PRONOUN_OR_DEIXIS_RE.test(q) || REJECT_SUBJECT_RE.test(q);
}

function searchIntent(
  query: string,
  preferDifferent: boolean,
  count?: number,
): Extract<ImageIntent, { kind: "search" }> {
  const base: Extract<ImageIntent, { kind: "search" }> = preferDifferent
    ? { kind: "search", query, preferDifferent: true }
    : { kind: "search", query };
  if (count && count > 1) base.count = count;
  return base;
}

const PROVIDER_IDS = new Set([
  "ddgs",
  "searxng",
  "duitang",
  "openverse",
  "pexels",
]);

/** Parse `/image --provider=ddgs cat` or `/image @searxng cat`. */
export function parseImageSlashArgs(args: string[]): {
  query: string;
  provider?: string;
} {
  let provider: string | undefined;
  const rest: string[] = [];
  for (const a of args) {
    const m = a.match(/^--provider=(.+)$/i) ?? a.match(/^@([\w-]+)$/i);
    if (m?.[1] && PROVIDER_IDS.has(m[1].toLowerCase())) {
      provider = m[1].toLowerCase();
      continue;
    }
    rest.push(a);
  }
  return { query: rest.join(" ").trim(), provider };
}

/** Parse 再来三张 / 再来几张 → count (几 → 2). */
export function parseImageCount(text: string): number | undefined {
  const m = text.match(/(?:再来|再发|再找|换|来|发)(一|两|二|三|四|五|几)张/u);
  if (!m?.[1]) return undefined;
  const map: Record<string, number> = {
    一: 1,
    两: 2,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    几: 2,
  };
  return map[m[1]] ?? undefined;
}

function hasVarietyCue(s: string): boolean {
  return /(?:其他|别的|再来|再发|换一张|another|different)/u.test(s);
}

function stripTrailingParticles(q: string): string {
  return q.replace(/(?:吗|呢|呀|啊)+$/u, "").trim();
}

function sanitizeQuery(q: string): string {
  return stripImageQueryFillers(
    q
      .replace(/[“”"']/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(VARIETY_PREFIX_RE, "")
      .replace(/^(?:a|an|the|some|一张|一个|点|些|几)\s+/i, "")
      .trim(),
  ).slice(0, 80);
}

function acceptSubject(raw: string): string | undefined {
  const query = sanitizeQuery(raw);
  if (!query || query.length < 1 || query.length > 40) return undefined;
  if (REJECT_SUBJECT_RE.test(query)) return undefined;
  if (PRONOUN_OR_DEIXIS_RE.test(query)) return undefined;
  return query;
}

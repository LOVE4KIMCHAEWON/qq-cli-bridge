/**
 * Curated Chinese internet-slang seed (no scraping / no paid APIs).
 * Small baseline for Phase 0–2; corrections grow the KB per conversation.
 */
import type { CultureConfidence, CultureSourceKind } from "./types.js";

export type SeedTerm = {
  term: string;
  aliases?: string[];
  gloss: string;
  community?: string;
  confidence?: CultureConfidence;
  source?: CultureSourceKind;
  sourceNote?: string;
};

export type SeedPattern = {
  name: string;
  template: string;
  gloss: string;
  example?: string;
  community?: string;
  confidence?: CultureConfidence;
  source?: CultureSourceKind;
  sourceNote?: string;
};

export const SEED_TERMS: SeedTerm[] = [
  {
    term: "破防",
    gloss: "情绪防线被击穿；被戳中痛点或感动到失控。",
    community: "泛中文互联网",
    confidence: "confirmed",
  },
  {
    term: "摆烂",
    gloss: "主动放弃努力、躺平式应对，带自嘲。",
    community: "泛中文互联网",
    confidence: "confirmed",
  },
  {
    term: "内卷",
    gloss: "非必要的过度竞争，投入增加但收益不增。",
    community: "泛中文互联网",
    confidence: "confirmed",
  },
  {
    term: "躺平",
    gloss: "降低欲望与投入，拒绝卷竞争。",
    community: "泛中文互联网",
    confidence: "confirmed",
  },
  {
    term: "社死",
    aliases: ["社会性死亡"],
    gloss: "因尴尬场面感到无地自容。",
    community: "泛中文互联网",
    confidence: "confirmed",
  },
  {
    term: "绝绝子",
    gloss: "夸张夸赞或反讽「太绝了」。",
    community: "小红书/年轻女性向用语圈",
    confidence: "community_local",
  },
  {
    term: "yyds",
    aliases: ["永远的神"],
    gloss: "永远的神；极致夸赞。",
    community: "弹幕/直播",
    confidence: "confirmed",
  },
  {
    term: "xswl",
    aliases: ["笑死我了"],
    gloss: "笑死我了。",
    community: "弹幕/聊天",
    confidence: "confirmed",
  },
  {
    term: "栓Q",
    gloss: "谐音 thank you；常带阴阳或无语。",
    community: "泛中文互联网",
    confidence: "community_local",
  },
  {
    term: "典",
    gloss: "典型、经典操作；常用于吐槽「又来这套」。",
    community: "抽象/玩梗圈",
    confidence: "community_local",
  },
  {
    term: "蚌埠住了",
    aliases: ["绷不住了"],
    gloss: "谐音「绷不住了」；忍不住笑或破防。",
    community: "泛中文互联网",
    confidence: "confirmed",
  },
  {
    term: "小作文",
    gloss: "较长情绪化或控诉式文字；常指争议帖。",
    community: "微博/论坛",
    confidence: "confirmed",
  },
  {
    term: "打工人",
    gloss: "自嘲式称呼上班族。",
    community: "泛中文互联网",
    confidence: "confirmed",
  },
  {
    term: "鸡娃",
    gloss: "鸡血式催娃；高压教育内卷。",
    community: "家长圈",
    confidence: "confirmed",
  },
  {
    term: "吃瓜",
    gloss: "围观他人八卦/热点，不深度参与。",
    community: "泛中文互联网",
    confidence: "confirmed",
  },
  {
    term: "真香",
    gloss: "先嫌弃后立刻爱上；打脸式反转。",
    community: "泛中文互联网",
    confidence: "confirmed",
  },
  {
    term: "爷青回",
    gloss: "爷的青春回来了；怀旧共鸣。",
    community: "弹幕",
    confidence: "confirmed",
  },
  {
    term: "整活",
    gloss: "搞事情、整节目效果；故意整出笑点或看点。",
    community: "直播/短视频",
    confidence: "confirmed",
  },
  {
    term: "电子榨菜",
    gloss: "下饭的轻松内容（播客/综艺/废话流）。",
    community: "播客/内容圈",
    confidence: "community_local",
  },
  {
    term: "偷感",
    gloss: "做事缩手缩脚、生怕被发现的气质。",
    community: "年轻网民",
    confidence: "community_local",
  },
  {
    term: "尊嘟假嘟",
    aliases: ["真的假的"],
    gloss: "可爱/撒娇式「真的假的」。",
    community: "年轻女性向用语圈",
    confidence: "community_local",
  },
  {
    term: "遥遥领先",
    gloss: "本义领先很多；网络常反讽或玩梗式夸大。",
    community: "科技圈梗",
    confidence: "community_local",
  },
  {
    term: "集美",
    gloss: "姐妹；亲昵称呼女性朋友。",
    community: "小红书等",
    confidence: "community_local",
  },
  {
    term: "emo",
    gloss: "情绪低落、伤感一会儿（非临床诊断）。",
    community: "泛中文互联网",
    confidence: "confirmed",
  },
  {
    term: "干饭人",
    gloss: "热爱吃饭的人；轻松自嘲。",
    community: "泛中文互联网",
    confidence: "confirmed",
  },
];

export const SEED_PATTERNS: SeedPattern[] = [
  {
    name: "五X一",
    template: "五{slot}一",
    gloss:
      "能产格式：五 + 单音节/短语槽 + 一。槽位填具体对象或梗核，整体像口号式缩略，需结合语境理解槽位含义。",
    example: "五福一、五杀一（槽位不同，含义随社区约定）",
    community: "玩梗/口号式缩略",
    confidence: "plausible",
    sourceNote: "productive-pattern",
  },
  {
    name: "X中X",
    template: "{slot}中{slot}",
    gloss: "叠用同一词强调「最典型/最X」；如「典中典」。两槽通常相同。",
    example: "典中典、离谱中离谱",
    community: "抽象/玩梗圈",
    confidence: "confirmed",
  },
  {
    name: "一整个X住",
    template: "一整个{slot}住",
    gloss: "被某种状态完全拿住；X 多为动词/形容词词干。",
    example: "一整个哭住、一整个无语住",
    community: "年轻网民",
    confidence: "community_local",
  },
  {
    name: "属于是X了",
    template: "属于是{slot}了",
    gloss: "总结句式：给前述行为定性为 X。",
    example: "属于是破防了",
    community: "泛中文互联网",
    confidence: "community_local",
  },
];

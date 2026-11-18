/**
 * Culture KB — shared Bridge intelligence for Chinese internet slang / community norms.
 * Distinct from Persona (how) and personal Memory (what about this user).
 * Backend-neutral: no Claude/Codex/Gemini transport imports.
 */

export type CultureConfidence =
  | "confirmed"
  | "community_local"
  | "plausible"
  | "unknown";

export type CultureScope = "global" | "conversation";

export type CultureEntryKind = "term" | "pattern" | "norm";

export type CultureSourceKind =
  | "seed:curated"
  | "user-correction"
  | "community"
  | "derived";

export type CultureConfig = {
  enabled: boolean;
  /** Soft cap for the Culture section injected into session context. */
  contextBudgetTokens: number;
  /** Max glossary / pattern lines in one injection. */
  maxSnippets: number;
  /** Seed curated baseline on first open of an empty DB. */
  seedOnEmpty: boolean;
};

export const DEFAULT_CULTURE_CONFIG: CultureConfig = {
  enabled: true,
  contextBudgetTokens: 900,
  maxSnippets: 8,
  seedOnEmpty: true,
};

export type CultureTerm = {
  id: number;
  term: string;
  aliases: string[];
  gloss: string;
  community?: string;
  confidence: CultureConfidence;
  scope: CultureScope;
  conversationId?: string;
  source: CultureSourceKind;
  sourceNote?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CulturePattern = {
  id: number;
  /** Human label, e.g. 五X一 */
  name: string;
  /**
   * Match template using {slot} placeholders for productive slots.
   * Example: 五{slot}一 matches 五福一 / 五杀一.
   */
  template: string;
  gloss: string;
  example?: string;
  community?: string;
  confidence: CultureConfidence;
  scope: CultureScope;
  conversationId?: string;
  source: CultureSourceKind;
  sourceNote?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CultureHit = {
  kind: CultureEntryKind;
  id: number;
  label: string;
  gloss: string;
  community?: string;
  confidence: CultureConfidence;
  source: CultureSourceKind;
  sourceNote?: string;
  /** Pattern fill when kind=pattern */
  matched?: string;
  score: number;
};

export type CultureContextBundle = {
  cultureSection: string;
  cultureHash: string;
  estimatedTokens: number;
  hitCount: number;
};

export type CultureCorrection = {
  term: string;
  gloss: string;
  /** Default false → conversation-scoped. */
  makeGlobal: boolean;
  community?: string;
  raw: string;
};

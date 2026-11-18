import { log } from "../util/logger.js";
import { extractCultureCorrections } from "./corrections.js";
import { buildCultureContext } from "./context.js";
import { CultureStore } from "./store.js";
import {
  DEFAULT_CULTURE_CONFIG,
  type CultureConfig,
  type CultureContextBundle,
  type CultureTerm,
} from "./types.js";

export type CultureManagerOptions = {
  config?: Partial<CultureConfig>;
  store?: CultureStore;
  dbPath?: string;
  skipSeed?: boolean;
};

/**
 * Bridge-owned Culture KB manager.
 * Persona = how; Memory = personal facts; Culture = slang / community norms.
 * No Claude/Codex/Gemini imports — adapters consume sections via shared context assembly.
 */
export class CultureManager {
  readonly config: CultureConfig;
  readonly store: CultureStore;
  private closed = false;

  constructor(opts: CultureManagerOptions = {}) {
    this.config = { ...DEFAULT_CULTURE_CONFIG, ...opts.config };
    this.store =
      opts.store ??
      new CultureStore({
        dbPath: opts.dbPath,
        skipSeed: opts.skipSeed ?? !this.config.seedOnEmpty,
      });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store.close();
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Remember last user utterance for next session-start retrieval (not injected every turn). */
  noteUserText(conversationId: string, text: string): void {
    if (!this.config.enabled) return;
    this.store.setLastQuery(conversationId, text);
  }

  /**
   * Learn from explicit corrections in user text.
   * Default scope = this conversation only.
   */
  ingestUserUtterance(input: {
    conversationId: string;
    text: string;
  }): { corrections: CultureTerm[] } {
    if (!this.config.enabled) return { corrections: [] };
    this.noteUserText(input.conversationId, input.text);
    const extracted = extractCultureCorrections(input.text);
    const corrections: CultureTerm[] = [];
    for (const c of extracted) {
      const term = this.store.upsertTerm({
        term: c.term,
        gloss: c.gloss,
        confidence: "confirmed",
        scope: c.makeGlobal ? "global" : "conversation",
        conversationId: c.makeGlobal ? undefined : input.conversationId,
        source: "user-correction",
        sourceNote: c.makeGlobal ? "explicit-global" : "explicit-conversation",
        community: c.community,
      });
      corrections.push(term);
      log.info("culture:correction_learned", {
        term: term.term,
        scope: term.scope,
        conversationId: input.conversationId,
      });
    }
    return { corrections };
  }

  buildCultureSection(
    conversationId: string,
    opts: { queryHints?: string } = {},
  ): CultureContextBundle {
    return buildCultureContext(this.store, conversationId, this.config, opts);
  }

  currentCultureHash(conversationId: string): string {
    return this.store.profileHash(conversationId);
  }

  cultureHashChanged(conversationId: string, atStart: string | undefined): boolean {
    if (atStart === undefined) return false;
    return this.currentCultureHash(conversationId) !== atStart;
  }

  noteInjected(conversationId: string, bundle: CultureContextBundle): void {
    this.store.setSessionCultureHash(conversationId, bundle.cultureHash);
  }
}

let singleton: CultureManager | undefined;

export function getCultureManager(opts?: CultureManagerOptions): CultureManager {
  if (!singleton) {
    singleton = new CultureManager(opts);
  }
  return singleton;
}

export function configureCultureManager(opts: CultureManagerOptions = {}): CultureManager {
  if (singleton) {
    singleton.close();
  }
  singleton = new CultureManager(opts);
  return singleton;
}

export function resetCultureManagerForTests(manager?: CultureManager): void {
  if (singleton) {
    try {
      singleton.close();
    } catch {
      // ignore
    }
  }
  singleton = manager;
}

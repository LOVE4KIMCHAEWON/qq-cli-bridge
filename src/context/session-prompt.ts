/**
 * Shared session system-prompt writer for any backend that uses a single prompt file.
 * Pulls Memory + Culture via Bridge managers; does not import Claude transport.
 */
import fs from "node:fs";
import { formatBridgeActionsSection } from "../bridge/recent-actions.js";
import { getCultureManager } from "../culture/manager.js";
import type { CultureContextBundle } from "../culture/types.js";
import { getMemoryManager } from "../memory/manager.js";
import type { SessionContextBundle } from "../memory/types.js";
import { assembleBridgeContext } from "./assemble.js";

export type SessionPromptResult = {
  path: string;
  fullText: string;
  memory: SessionContextBundle;
  culture: CultureContextBundle;
  sections: Array<"persona" | "memory" | "culture" | "bridgeActions">;
};

/**
 * Build Persona + Memory + Culture (+ Bridge actions) once per session start/rotation.
 * Safe for Claude stream and future adapters sharing the same file path.
 */
export function writeBridgeSessionPrompt(
  personaBody: string,
  conversationId: string,
  opts: {
    queryHints?: string;
    includeCarryOverNote?: boolean;
  } = {},
): SessionPromptResult {
  const memory = getMemoryManager();
  const culture = getCultureManager();

  const queryHints =
    opts.queryHints ?? culture.store.getLastQuery(conversationId) ?? undefined;

  const cultureBundle = culture.buildCultureSection(conversationId, {
    queryHints,
  });

  const { path, bundle: memoryBundle } = memory.writeSystemPromptFile(
    personaBody,
    conversationId,
    {
      queryHints: opts.queryHints,
      includeCarryOverNote: opts.includeCarryOverNote,
      cultureSection: cultureBundle.cultureSection || undefined,
    },
  );

  culture.noteInjected(conversationId, cultureBundle);

  const bridgeActionsSection =
    formatBridgeActionsSection(conversationId) || undefined;

  const assembled = assembleBridgeContext({
    personaBody,
    memorySection: memoryBundle.memorySection || undefined,
    cultureSection: cultureBundle.cultureSection || undefined,
    bridgeActionsSection,
  });

  // Ensure the on-disk system prompt includes Bridge actions (Memory writer may omit them).
  if (assembled.fullText !== fs.readFileSync(path, "utf8")) {
    fs.writeFileSync(path, assembled.fullText, "utf8");
  }

  return {
    path,
    fullText: assembled.fullText,
    memory: memoryBundle,
    culture: cultureBundle,
    sections: assembled.sections,
  };
}

/**
 * Backend-neutral Bridge context assembly.
 * Distinct sections: Persona | Memory | Culture | Bridge actions (ephemeral).
 * Capability framing inside Persona is profile-specific so backends do not
 * contradict real tool availability (e.g. Codex hosted web_search, Bridge images).
 */
import {
  buildPersonaSystemSection,
  type PersonaCapabilityProfile,
} from "../persona/load.js";
import { estimateTokens } from "../memory/tokens.js";

export type BridgeContextParts = {
  /** Raw persona body (without framing header). */
  personaBody: string;
  /** Pre-formatted memory section (may be empty). */
  memorySection?: string;
  /** Pre-formatted culture section (may be empty). */
  cultureSection?: string;
  /**
   * Recent Bridge-operated actions (image send, etc.).
   * Not permanent Memory/Culture — bounded, conversation-scoped.
   */
  bridgeActionsSection?: string;
  /**
   * Backend capability claims embedded in the Persona framing.
   * Default claude-chat (no tools). Codex restricted must pass codex-restricted.
   */
  capabilityProfile?: PersonaCapabilityProfile;
};

export type AssembledBridgeContext = {
  personaSection: string;
  memorySection: string;
  cultureSection: string;
  bridgeActionsSection: string;
  /** Joined text for backends that take a single system prompt file/string. */
  fullText: string;
  estimatedTokens: number;
  capabilityProfile: PersonaCapabilityProfile;
  /** Which optional sections were non-empty. */
  sections: Array<"persona" | "memory" | "culture" | "bridgeActions">;
};

/**
 * Assemble Persona + Memory + Culture (+ optional Bridge actions) as distinct sections.
 * Order is fixed so adapters stay consistent across backends.
 */
export function assembleBridgeContext(parts: BridgeContextParts): AssembledBridgeContext {
  const capabilityProfile = parts.capabilityProfile ?? "claude-chat";
  const personaSection = buildPersonaSystemSection(parts.personaBody, capabilityProfile);
  const memorySection = parts.memorySection?.trim()
    ? parts.memorySection.trimEnd() + "\n"
    : "";
  const cultureSection = parts.cultureSection?.trim()
    ? parts.cultureSection.trimEnd() + "\n"
    : "";
  const bridgeActionsSection = parts.bridgeActionsSection?.trim()
    ? parts.bridgeActionsSection.trimEnd() + "\n"
    : "";

  const sections: AssembledBridgeContext["sections"] = ["persona"];
  const chunks = [personaSection];
  if (memorySection) {
    sections.push("memory");
    chunks.push(memorySection);
  }
  if (cultureSection) {
    sections.push("culture");
    chunks.push(cultureSection);
  }
  if (bridgeActionsSection) {
    sections.push("bridgeActions");
    chunks.push(bridgeActionsSection);
  }

  const fullText = chunks.join("\n");
  return {
    personaSection,
    memorySection,
    cultureSection,
    bridgeActionsSection,
    fullText,
    estimatedTokens: estimateTokens(fullText),
    capabilityProfile,
    sections,
  };
}

/**
 * Convenience: produce the single-string system prompt used by Claude stream/oneshot.
 * Other adapters should prefer `assembleBridgeContext` and map sections themselves.
 */
export function composeBridgeSystemPrompt(parts: BridgeContextParts): string {
  return assembleBridgeContext(parts).fullText;
}

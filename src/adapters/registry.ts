import type { AgentAdapter, AgentKind, AppConfig } from "../types.js";
import { createGeminiAdapter } from "./gemini.js";
import { createGeminiAcpAdapter } from "./gemini-acp.js";
import { createCodexAdapter } from "./codex.js";
import { createCodexAppServerAdapter } from "./codex-app-server.js";
import { createClaudeAdapter } from "./claude.js";
import { createClaudeStreamAdapter } from "./claude-stream.js";
import { createAgentAdapter } from "./agent.js";
import { createAgentAcpAdapter } from "./agent-acp.js";
import { CustomAdapter } from "./custom.js";

export function createAdapter(
  kind: AgentKind,
  config: AppConfig,
  customName?: string,
): AgentAdapter {
  switch (kind) {
    case "gemini": {
      const transport = config.agents.gemini.transport ?? "oneshot";
      if (transport === "acp") {
        // Chat-only: always reject tool permissions (ignore allow-once config).
        return createGeminiAcpAdapter(
          config.agents.gemini.command,
          config.agents.gemini.extraArgs,
          "reject",
          config.bridge.usageWarnings,
        );
      }
      return createGeminiAdapter(
        config.agents.gemini.command,
        config.agents.gemini.extraArgs,
      );
    }
    case "codex": {
      const transport = config.agents.codex.transport ?? "oneshot";
      if (transport === "app-server") {
        return createCodexAppServerAdapter(
          config.agents.codex.command,
          config.agents.codex.extraArgs,
          config.bridge.usageWarnings,
        );
      }
      return createCodexAdapter(config.agents.codex.command, config.agents.codex.extraArgs, {
        skipGitRepoCheck: config.agents.codex.skipGitRepoCheck ?? false,
      });
    }
    case "claude": {
      const transport = config.agents.claude.transport ?? "oneshot";
      if (transport === "stream") {
        return createClaudeStreamAdapter(
          config.agents.claude.command,
          config.agents.claude.extraArgs,
          config.bridge.usageWarnings,
        );
      }
      return createClaudeAdapter(
        config.agents.claude.command,
        config.agents.claude.extraArgs,
      );
    }
    case "agent": {
      const transport = config.agents.agent.transport ?? "oneshot";
      if (transport === "acp") {
        // Chat-only: reject permissions + ask mode (ignore allow-once / agent mode).
        return createAgentAcpAdapter(
          config.agents.agent.command,
          config.agents.agent.extraArgs,
          "reject",
          "ask",
          config.bridge.usageWarnings,
        );
      }
      return createAgentAdapter(config.agents.agent.command, config.agents.agent.extraArgs);
    }
    case "custom": {
      if (!customName) throw new Error("Custom agent name required");
      const entry = config.agents.custom[customName];
      if (!entry) throw new Error(`Unknown custom agent: ${customName}`);
      return new CustomAdapter(
        customName,
        entry.command,
        entry.args,
        entry.sessionResumeTemplate,
      );
    }
    default:
      throw new Error(`Unsupported agent: ${kind}`);
  }
}

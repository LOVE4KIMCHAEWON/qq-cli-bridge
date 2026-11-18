import type { AgentAdapter } from "../types.js";
import { formatHelpText } from "./help.js";
import { handleModelCommand } from "./model.js";
import { parseSlashCommand } from "./parse.js";
import { loadPersona } from "../persona/load.js";
import { getMemoryManager } from "../memory/manager.js";

export interface SlashCommandContext {
  adapter?: AgentAdapter;
  conversationId: string;
  /** Sender already passed allowlist; kept for future admin gates. */
  senderId: string;
}

export interface SlashCommandResult {
  handled: boolean;
  /** Reply text when handled (never forwarded to the LLM). */
  reply?: string;
}

/**
 * Local slash-command router. Must not invoke an LLM.
 * Unknown slash commands are handled with a short help hint (not forwarded).
 */
export async function routeSlashCommand(
  text: string,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const parsed = parseSlashCommand(text);
  if (!parsed) return { handled: false };

  switch (parsed.name) {
    case "help":
      return { handled: true, reply: formatHelpText() };

    case "model": {
      if (!ctx.adapter) {
        return {
          handled: true,
          reply:
            "No active agent. On the PC run: qqbridge gemini|codex|claude|agent",
        };
      }
      const reply = await handleModelCommand(parsed.args, {
        adapter: ctx.adapter,
        conversationId: ctx.conversationId,
      });
      return { handled: true, reply };
    }

    case "persona": {
      // Never include Persona body or composed system prompt in QQ replies.
      const persona = loadPersona();
      return {
        handled: true,
        reply: [
          "Persona config (Chat-only Claude)",
          `File: ${persona.path}`,
          `Status: ${persona.source}, hash ${persona.hash.slice(0, 8)}…`,
          "Edit that UTF-8 file, then send another message — the stream restarts with --resume/--fork-session so history is kept.",
          "Or restart qqbridge. Persona text is never shown here.",
        ].join("\n"),
      };
    }

    case "memory": {
      const mem = getMemoryManager();
      const [sub, ...rest] = parsed.args;
      const subCmd = (sub ?? "list").toLowerCase();
      if (subCmd === "list") {
        const items = mem.listMemories(ctx.conversationId);
        if (!items.length) {
          return {
            handled: true,
            reply: "No long-term memories for this conversation yet.",
          };
        }
        return {
          handled: true,
          reply: [
            "Long-term memory (this QQ conversation only):",
            ...items.map((m) => `#${m.id} [${m.kind}] ${m.content}`),
          ].join("\n"),
        };
      }
      if (subCmd === "clear") {
        const n = mem.clearMemories(ctx.conversationId);
        return { handled: true, reply: `Cleared ${n} memory item(s).` };
      }
      if (subCmd === "forget" && rest[0] && /^\d+$/.test(rest[0])) {
        const id = Number(rest[0]);
        const ok = mem.forgetMemory(ctx.conversationId, id);
        return {
          handled: true,
          reply: ok ? `Forgot memory #${id}.` : `Memory #${id} not found.`,
        };
      }
      if (subCmd === "correct" && rest[0] && /^\d+$/.test(rest[0])) {
        const id = Number(rest[0]);
        const content = rest.slice(1).join(" ").trim();
        if (!content) {
          return { handled: true, reply: "Usage: /memory correct <id> <text>" };
        }
        const item = mem.correctMemory(ctx.conversationId, id, content);
        return {
          handled: true,
          reply: item ? `Updated memory #${id}.` : `Memory #${id} not found.`,
        };
      }
      return {
        handled: true,
        reply:
          "Usage: /memory | /memory forget <id> | /memory correct <id> <text> | /memory clear",
      };
    }

    default:
      return {
        handled: true,
        reply: `Unknown command /${parsed.name}. Send /help for available commands.`,
      };
  }
}

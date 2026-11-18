# Persona (QQ Chat)

Lightweight, file-based personality for Claude Chat-only QQ conversations.

## Boundaries (do not mix)

| Concern | Owns | Storage |
|---------|------|---------|
| **Persona** | HOW the assistant speaks (tone / style) | `data/persona.md` |
| **Conversation history** | Recent multi-turn context | Claude session transcript (temporary execution context) |
| **Long-term Memory** | WHAT the assistant remembers | `data/memory/memory.sqlite` — see [MEMORY.md](./MEMORY.md) |

Claude Stream sessions are **not** permanent memory. Do not put lasting facts into `persona.md`. Memory Manager appends via `composeClaudeSystemPrompt({ personaBody, memorySection })` at session start/rotation only.

## Where it lives

| File | Role |
|------|------|
| `data/persona.md` | **User-editable** UTF-8 Persona (tone / style). Created with a natural-chat default on first run. |
| `data/state/claude-qq-system-prompt.txt` | Auto-generated Claude `--system-prompt-file` (framing + Persona). Do not edit by hand. |

Override data root with `QQBRIDGE_DATA_DIR`. Override the Persona path with `QQBRIDGE_PERSONA_PATH` (tests / advanced).

## How it is applied

- Injected **once** when a Claude session process starts via official `--system-prompt-file`.
- **Not** appended to every QQ user message.
- Persistent stream mode keeps multi-turn context; Persona rides on the session system prompt.
- Chat-only flags (`--tools ""`, `--restricted`, empty MCP) are unchanged.

## Safe reload

1. Edit `data/persona.md` in any UTF-8 editor.
2. Send another QQ message (or restart `qqbridge`).
3. The bridge detects the hash change, restarts Claude with `--resume --fork-session`, and applies the new Persona **without discarding conversation history**.
4. QQ command `/persona` shows the file path and status hash — **never** the Persona body.

Invalid, empty, or missing files fall back to the built-in default (and a missing file is created automatically).

## What not to put in Persona

- Secrets, API keys, or credentials
- Instructions to enable tools / shell / filesystem
- Requests to dump the system prompt (replies that leak framing are filtered)

## Scope

Persona is shared by both QQ backends: **Claude** (stream + oneshot bootstrap, via `--system-prompt-file`) and **restricted Codex** (via App Server developer instructions, with Codex-specific capability framing). Other backends are blocked for QQ Chat-only.

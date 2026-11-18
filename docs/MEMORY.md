# Long-term Memory Manager

Bridge-owned memory for Chat-only QQ conversations. Independent of Claude session IDs.

## Boundaries

| Concern | Role | Storage |
|---------|------|---------|
| **Persona** | HOW the assistant speaks | `data/persona.md` |
| **Long-term Memory** | WHAT is remembered per QQ conversation | `data/memory/memory.sqlite` |
| **Claude Session** | Temporary execution context | Claude transcript + stream process |

Do not put lasting facts in Persona. Do not treat Claude sessions as permanent memory.

## What is stored

- **Turns:** user/assistant text with timestamps, keyed by QQ conversation id (`scope:targetId`). Deduped by QQ message id.
- **Memory profile:** compact preferences / facts / plans / corrections extracted deterministically (e.g. “请记住…”, “我喜欢…”, “叫我…”).
- Sensitive-looking strings (phones, emails, passwords, etc.) are skipped by default.

Chat history is archival. It is **not** replayed in full every turn.

## Context budget

At **new Claude session start** or **rotation** only, the Bridge injects:

1. Persona (once)
2. Compact long-term memory section
3. Rolling recent window
4. Optional FTS-retrieved snippets (budgeted)

Already-running persistent Claude processes do **not** get the full memory profile prepended on every turn.

## Session rotation

When estimated/measured context reaches `bridge.memory.rotationThresholdTokens`:

1. Wait for the current turn to finish
2. Persist history + memory
3. Start a **new** Chat-only Claude session with Persona + carry-over memory
4. Activate the new session only after successful init
5. Keep the old session if init fails

## Background maintenance

Idle-time deterministic extraction (no Claude calls). Skips while a turn is in progress. Checkpoints progress so history is not reprocessed forever.

**Limitation:** model-based summarization is intentionally not used; extraction is rule-based for latency and cost.

## Configuration

In `data/config.json` → `bridge.memory`:

```json
{
  "enabled": true,
  "contextBudgetTokens": 6000,
  "rotationThresholdTokens": 80000,
  "recentWindowTurns": 12,
  "maxMemoryItems": 40,
  "maxRetrievalSnippets": 4,
  "maintenanceIdleMs": 45000,
  "maintenanceMinIntervalMs": 120000,
  "maintenanceBatchTurns": 40
}
```

## QQ commands

- `/memory` — list memories for this conversation
- `/memory forget <id>` — deactivate one item
- `/memory correct <id> <text>` — replace an item
- `/memory clear` — clear all active memories for this conversation

## Privacy

- DB path: `data/memory/memory.sqlite` (separate from `data/secrets/` and Persona)
- Bridge process may open the DB; Claude has **no** filesystem/MCP/tools access
- Application-level separation is **not** OS-level isolation; protect the host account
- Logs never include memory body text

## Requirements

Node.js **≥ 22.5** recommended (`node:sqlite` + FTS5). Verified on Node 24.

## End-to-end QQ check

1. `qqbridge claude --transport stream --no-terminal`
2. Send: `请记住：我喜欢绿茶`
3. `/memory` should list a preference
4. Restart the bridge; send a new message — tone stays Persona; preference remains in `/memory`
5. `/memory forget <id>` removes it

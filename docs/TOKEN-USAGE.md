# Token usage & efficiency (QQ CLI Bridge)

## What Cursor ACP exposes (measured 2026-11-17)

Local probe (`scripts/probe-acp-usage.ts`) against installed `agent acp`:

- `session/prompt` result: `{ stopReason: "end_turn" }` only — **no** input/output/cache token fields.
- `session/update` kinds observed: `available_commands_update`, `session_info_update`, `agent_thought_chunk`, `agent_message_chunk`.
- **`usage_update` was not emitted** in this probe.
- Session config options include `mode` (current `agent`) and `model` (current `default`).

Therefore QQ Bridge **cannot** attribute Cursor dashboard rows (e.g. 11k / 14k / 441k) to a specific QQ turn from ACP metadata alone. Those dashboard figures may include cache, other IDE agents, or multi-request turns.

## Telemetry implemented

Per completed agent turn → `data/logs/usage.jsonl` + structured log `usage:turn`:

- turnId, backend, transport (`acp`|`oneshot`)
- modelId when known, else `"unavailable"`
- hashed session/conversation fingerprints (not raw ids)
- latencyMs when known
- `modelRequestCount`: **`"unavailable"`** unless the provider sends it (never assumed = 1)
- token fields: input/output/cacheRead/cacheWrite/thought/total/contextUsed/contextSize — each `"unavailable"` when missing
- soft warnings when context occupancy / growth / totals exceed configurable thresholds

Config (`bridge.usageWarnings`):

```json
{
  "contextUsedWarn": 200000,
  "turnTotalWarn": 100000,
  "contextGrowthWarn": 50000
}
```

Warnings are diagnostic only — **no hard cutoffs** on missing/unreliable data.

## Optimizations implemented (evidence-based)

| Change | Evidence | Effect |
|--------|----------|--------|
| Removed oneshot seed prompt (`QQ CLI Bridge session start…`) | Was a full `agent -p` model turn on every start | Saves **one paid turn per oneshot start** |
| Skip redundant ACP `session/load` when session already live | Avoids unnecessary history replay traffic on warm turns | Lower overhead; no duplicate prompt submission |
| In-flight duplicate prompt guard per conversation | Prevents concurrent double `session/prompt` | No accidental double model submission |
| Optional `agents.agent.acpMode` (`ask`\|`agent`\|`plan`) | Cursor exposes mode config; default remains `agent` | Operators may choose `ask` for chat-oriented QQ to reduce tool schemas — **opt-in** |

## Not implemented / remaining unknowns

- Exact input/output/cache split for Cursor ACP turns — **unavailable** from protocol in local probe.
- Mapping Cursor web Usage UI rows to qqbridge turns — **unverified**.
- Whether `agent_thought_chunk` bills as separate tokens — unknown.
- Hard token limits — intentionally not added.

## Prefer ask mode for light QQ chat (optional)

```powershell
# in data/config.json agents.agent:
#   "acpMode": "ask"
qqbridge agent --transport acp --no-terminal
```

Keep `agent` when QQ users need coding tools.

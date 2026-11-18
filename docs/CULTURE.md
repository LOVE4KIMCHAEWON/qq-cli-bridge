# Culture KB (Phase 0–2)

Bridge-owned slang / community-norm knowledge. **Not** Persona (how to speak) and **not** personal Memory (facts about a user).

## Design

| Store | Owns | Path |
|-------|------|------|
| Persona | Tone / identity | `data/persona.md` |
| Memory | Per-conversation personal facts + turn archive | `data/memory/memory.sqlite` |
| Culture KB | Terms, productive patterns, corrections | `data/culture/culture.sqlite` |

Culture is a **backend-independent** Bridge capability. Adapters consume sections via `assembleBridgeContext` / `writeBridgeSessionPrompt`. No Claude/Codex/Gemini transport imports live under `src/culture/`.

## Behavior

- Curated seed on first empty DB (no scraping, no paid APIs).
- Token-bounded retrieval from the current user utterance (and last noted query).
- Productive patterns such as `五{slot}一`, `X中X`, `一整个X住`.
- Explicit user corrections (`破防的意思是…`, `纠正：…`, `文化库：…`) are learned.
- Default correction scope = **this conversation**. Add 全局/永久记住 to write global.
- Injected **once** at session start / rotation / profile-change fork — not every QQ turn.
- Survives Bridge restarts and Claude session rotations (SQLite on disk).

## Config

`data/config.json` → `bridge.culture`:

```json
{
  "enabled": true,
  "contextBudgetTokens": 900,
  "maxSnippets": 8,
  "seedOnEmpty": true
}
```

## Context sections (order)

1. Persona  
2. Long-term Memory  
3. Culture KB  

## Security

Chat-only Claude Stream is unchanged. Culture never grants tools or weakens allowlists.

# Chat-only QQ bot (mandatory)

This product is a **lightweight QQ chatbot**: message in → AI text out.

It is **not** a remote coding agent, remote shell, or computer-control bridge.

## Allowed QQ backend

| Backend | QQ status | Why |
|---------|-----------|-----|
| **Claude Code** (`oneshot` or `stream`) | **Allowed (default)** | Official `--tools ""` disables the built-in tool set. Plus `--restricted` and empty MCP. |
| **Codex App Server (restricted)** | **Allowed after verify** | Isolated `CODEX_HOME`, local tools disabled, hosted web_search only, Bridge rejects approvals. See `docs/CODEX-RESTRICTED.md`. Oneshot Codex remains disabled. |
| Cursor Agent | **Disabled for QQ** | `ask`/`plan` are read-only modes that still load tools. No verified no-tools API. |
| Gemini CLI | **Disabled for QQ** | `plan` is read-only, not tool-free. |
| Custom CLIs | **Disabled for QQ** | Cannot verify tool disablement. |

Recommended launch:

```powershell
qqbridge claude --transport stream --no-terminal
```

## What Claude Chat-only enforces

- `--tools ""` — no built-in tools
- `--restricted` — strips command/code tools and ignores project settings that re-enable them
- `--strict-mcp-config --mcp-config {"mcpServers":{}}` — no MCP servers (a bare `{}` is rejected by Claude Code)
- `--permission-mode dontAsk` + `--permission-prompts none` — nothing interactive
- Working directory = `data/chat-runtime/` (not the bridge repo)
- Scrubbed child environment (QQ credentials never passed into the model process)
- Dangerous `extraArgs` stripped (`--yolo`, `--force`, `--dangerously-*`, …)
- Interactive terminal attach disabled
- Prior Agent / project sessions are **not resumed** (files left on disk; new chat sessions start fresh)

## Session data policy

- QQ credentials and config are **not** reset.
- Session JSON under `data/state/` is **not** deleted.
- Privileged sessions (wrong cwd / missing chat-only marker) are **ignored** at resume time.

## Tool schemas / project context

With Claude `--tools ""` + `--restricted`, built-in tools are not offered to the model for the QQ process. Project `CLAUDE.md` / local settings that would reintroduce agent behavior are ignored under `--restricted`.

We do **not** claim a Windows AppContainer/VM sandbox.

## Latency / tokens

Persistence (`--transport stream`) avoids CLI cold start on warm turns. Disabling tools can reduce prompt overhead versus full Agent tool schemas; measure with:

```powershell
npx tsx scripts/bench-persistent-latency.ts --backend claude --n 2
```

Do not claim token savings without that measurement.

## Tests

```powershell
npm test
```

See `test/chat-only-security.test.ts` and `test/chat-only-execution.test.ts`.

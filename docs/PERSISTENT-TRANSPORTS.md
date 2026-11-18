# Persistent agent transports

Opt-in persistent process modes that avoid cold-starting the CLI on every QQ message.

Defaults remain **oneshot** for every backend (backward compatible).

**All transports are Chat-only.** See [`docs/CHAT-ONLY-SECURITY.md`](./CHAT-ONLY-SECURITY.md).
QQ Bridge never grants filesystem/shell/MCP control of the host.

## Enable / revert

```powershell
# Claude — stream-json (process reused across turns)
qqbridge set-transport claude stream
qqbridge claude --transport stream --no-terminal
# Revert:
qqbridge set-transport claude oneshot

# Codex — app-server JSON-RPC
qqbridge set-transport codex app-server
qqbridge codex --transport app-server --no-terminal
# Revert:
qqbridge set-transport codex oneshot

# Gemini — ACP (requires Gemini CLI installed)
qqbridge set-transport gemini acp
qqbridge gemini --transport acp --no-terminal
# Revert:
qqbridge set-transport gemini oneshot

# Cursor Agent — ACP (unchanged)
qqbridge set-transport agent acp
qqbridge agent --transport acp --no-terminal
# Legacy shorthand still works:
qqbridge set-transport acp
```

Config keys (`data/config.json`):

```json
{
  "agents": {
    "claude": { "transport": "oneshot" },
    "codex": { "transport": "oneshot", "skipGitRepoCheck": false },
    "gemini": { "transport": "oneshot", "acpPermission": "reject" },
    "agent": { "transport": "oneshot", "acpPermission": "reject" }
  }
}
```

## Mechanisms (verified)

| Backend | Persistent mode | Launch | Process reuse |
|---------|-----------------|--------|---------------|
| Claude Code 2.1.323 | `stream` | `claude -p --verbose --input-format stream-json --output-format stream-json` | **Yes** — one process, many stdin user messages |
| Codex CLI 0.169 | `app-server` | `codex app-server --stdio` | **Yes** — one process, many `turn/start` |
| Gemini CLI | `acp` | `gemini --acp` | **Yes** when CLI is installed (ACP stdio) |
| Cursor Agent | `acp` | `agent acp` | **Yes** (existing) |

## Session policy

- Persistent session ids are stored separately from oneshot resume ids.
- Files under `data/state/`:
  - `claude-stream-sessions.json`
  - `codex-app-server-sessions.json`
  - `gemini-acp-sessions.json`
  - `acp-sessions.json` (Cursor)
- Switching oneshot ↔ persistent starts a **new** session namespace (history is not silently migrated).
- Crash mid-turn → completion treated as **unknown**; prompt is **not** auto-replayed.

## Permissions / safety

- Claude stream: `--permission-mode dontAsk` (no interactive hangs).
- Codex app-server: `approvalPolicy=never` + server approval RPCs **rejected** (no silent tool approve).
- Gemini/Cursor ACP: default `acpPermission=reject`.
- Raw JSON-RPC / stream-json / usage metadata never forwarded to QQ.

## Model switching

| Backend | Behavior |
|---------|----------|
| Claude stream | May **restart** the process with `--model` + `--resume` (explicit status). History preserved via resume when possible. |
| Codex app-server | Passes `model` on `turn/start` (sticky for subsequent turns). |
| Gemini ACP | `session/set_config_option` when supported; otherwise reports refusal. |
| Cursor ACP | Existing `set_config_option` path. |

## Gemini note

This machine may not have `gemini` on PATH. Install `@google/gemini-cli` (or set `agents.gemini.command`) before enabling ACP. If ACP handshake fails, revert to oneshot.

## Codex notes

- `--skip-git-repo-check` applies to **exec/oneshot only** (no app-server equivalent). App-server `thread/start` with a non-git `cwd` succeeded in local probes.
- Token usage from `thread/tokenUsage/updated` is recorded in telemetry only (not QQ).
- Do **not** assume app-server reduces input tokens vs resume; measure before claiming savings.

## Benchmarks

```powershell
cd <repo>
npx tsx scripts/bench-persistent-latency.ts --backend claude --n 2
npx tsx scripts/bench-persistent-latency.ts --backend codex --n 2
```

Ask before large/expensive batches.

### Measured locally (2026-11-17, N=2, prompt=`Reply with exactly: PONG`)

**Claude Code 2.1.323** (same machine):

| Mode | Turn | Final ms | Notes |
|------|------|----------|-------|
| oneshot | 0 | 3440 | new process each turn |
| oneshot | 1 | 3351 | new process |
| stream cold | 0 | 4552 | first prompt on live process (pid reused) |
| stream warm | 1 | 3049 | **same pid**; ~0.3–0.4s under oneshot |

**Codex CLI 0.169** (cwd=`<repo>`, sandbox read-only):

| Mode | Turn | Final ms | input_tokens | Notes |
|------|------|----------|--------------|-------|
| exec oneshot | 0 | 4915 | (not parsed here) | `--skip-git-repo-check --json` |
| exec oneshot | 1 | 4356 | | new process |
| app-server cold | 0 | 5555 | 16555 | includes MCP startup on first thread |
| app-server warm | 1 | 3014 | 18535 | **~1.3–1.9s faster than oneshot** |

Token note: warm app-server **input_tokens rose** (16555 → 18535) because the thread keeps history. **No token savings claimed** from persistence — only latency/process reuse.

## QQ end-to-end check

1. `qqbridge set-transport claude stream`
2. `qqbridge claude --transport stream --no-terminal`
3. Send a short QQ message (e.g. `Reply with exactly: PONG`).
4. Confirm reply is natural language only (no JSON).
5. Send a second message; confirm faster warm turn and context continuity.
6. `/model sonnet` then another message — confirm explicit status if process restarts.
7. Ctrl+C — confirm no orphan `claude`/`codex` children (`qqbridge status` / Task Manager).

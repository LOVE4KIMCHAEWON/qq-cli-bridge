# CLI Compatibility Matrix

Verified against public docs / local `--help` on Windows (2026-11).

> **QQ Chat-only policy:** only **Claude Code** and **restricted Codex App Server** may serve QQ traffic. Gemini, Cursor Agent and custom CLIs are refused at launch. Rows below describe CLI capabilities used by the adapters, not what is enabled for QQ. See [docs/CHAT-ONLY-SECURITY.md](docs/CHAT-ONLY-SECURITY.md).

| CLI | Session resume | Structured output | Shared live TUI (two writers) | Model list / switch | qqbridge default |
|-----|----------------|-------------------|-------------------------------|---------------------|------------------|
| **Gemini CLI** (`gemini`) | Yes: `--resume` / `-r` with `-p` / prompt | `--output-format json\|stream-json` | **Not supported** by Gemini | `models` / `--list-models` + `--model`/`-m` | `session` |
| **Codex CLI** (`codex`) | Yes: `codex exec resume --last\|<id>` | `codex exec --json` | **Not supported** | `codex debug models` + `--model`/`-m`; non-Git cwd via `--skip-git-repo-check` | `session` |
| **Claude Code** (`claude`) | Yes: `claude -p --resume <session_id>` | `--output-format json\|stream-json` | **Not supported** | No headless catalog; `--model` aliases (`sonnet`/`opus`/`fable`) | `session` |
| **Cursor Agent** (`agent`) | Yes: `--resume` / `--continue` with `-p` | `--output-format json\|stream-json` | **Not supported** | `--list-models` / `models` + `--model` | `session` |
| **Custom** | Only if you set `sessionResumeTemplate` | Unknown | Best-effort via `node-pty` stdin inject | Unsupported | `pty` or template |

See [docs/MODEL-COMMANDS.md](docs/MODEL-COMMANDS.md) for QQ `/model` and `/help`.

## What “same session” means here

Official CLIs persist conversation state to disk and resume it in a **new process**.
They do **not** document a safe way for a terminal TUI and an external bot to type into the **same live process** concurrently.

qqbridge therefore:

1. Creates / tracks a **session id** with each CLI’s supported API.
2. Attaches your PowerShell terminal with that CLI’s interactive resume flags.
3. Forwards QQ messages with the CLI’s **non-interactive resume** path.
4. Serializes turns with a process-local lock so terminal and QQ do not overlap.

## Fallbacks

- If a CLI is missing session APIs: configure a custom agent with PTY inject (requires optional `node-pty`).
- If `node-pty` is unavailable on Windows: custom agents run as one-shot commands; known CLIs still use session resume.

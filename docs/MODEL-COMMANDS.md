# QQ Slash Commands: `/model` and `/help`

Local slash-command router (no LLM tokens). Handled before the agent adapter.

## Usage (QQ chat)

```text
/help
/model
/model <model-id>
/model default
```

Example:

```text
/model

Backend: Cursor Agent
Current model: Auto

Available models:
1. auto — Auto (current, default)
2. composer-2.5 — Composer 2.5
…

Use /model <model-id> to switch.
```

```text
/model composer-2.5
→ Effective model: composer-2.5
```

Model preference is **per QQ conversation** (`scope:targetId`). The QQ connection is not restarted. Session resume continues with the same session id; subsequent turns pass the CLI’s `--model` (or equivalent) flag.

## Discovery methods (by CLI)

| CLI | List models | Switch model | Notes |
|-----|-------------|--------------|-------|
| **Cursor Agent** (`agent`) | `agent --list-models` / `agent models` | `--model <id>` on `-p` / `--resume` | Dynamic, account-scoped. Verified locally. |
| **Gemini CLI** (`gemini`) | `gemini models list -o json` / `gemini --list-models -o json` | `--model` / `-m` | Dynamic when CLI installed. |
| **Codex CLI** (`codex`) | `codex debug models` (JSON catalog) | `--model` / `-m` on `codex exec` | Dynamic when CLI installed. |
| **Claude Code** (`claude`) | **No** safe non-interactive catalog (`claude models` invokes the LLM) | `--model <alias\|full-name>` | Documented aliases from `claude --help`: `sonnet`, `opus`, `fable`. Full names accepted without entitlement verification. |
| **Custom** | Unavailable | Not supported | Configure command/args instead. |

Interactive TUI commands such as `/model` inside a CLI REPL are **not** used in headless bridge turns.

## Unsupported / limitations

- Live QQ model switching is unit-tested in the bridge; **do not claim end-to-end QQ success until exercised with a real QQ message** (see TESTING.md).
- Claude: aliases only for listing; account entitlement is not verified.
- Gemini/Codex: if the binary is missing, `/model` reports discovery unavailable instead of inventing names.
- Switching model mid-session relies on each CLI honoring `--model` together with `--resume`. If a CLI ignores model changes on resume, the bridge still passes the flag and reports the selected id.

## Safety

- Slash commands never reach the LLM.
- Deduped once via existing message-identity dedupe.
- Subject to the same QQ allowlist as normal messages.
- Credentials are never included in `/model` replies.

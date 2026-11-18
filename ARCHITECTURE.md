# Architecture

## Goals

1. Use the official Tencent QQ Bot transport (QR binding and WebSocket gateway).
2. Keep adapters provider-independent behind one `AgentAdapter` interface.
3. Run **Chat-only** QQ traffic: text in, text out, with no agent tools on the host.
4. Ship secure defaults:
   - allowlists
   - encrypted QQ credentials
   - an approval gate
   - sanitized replies
   - per-conversation state

## Process model

```
PowerShell ──► qqbridge (Node.js, dist/cli.js)
                 │
                 ├─ QqTransport (@tencent-connect/qqbot-nodejs)
                 │     credentials from @tencent-connect/qqbot-connector (QR)
                 │     middleware: dedup → contentSanitizer (strip <@…>) → accessPolicy → mentionGate
                 │
                 ├─ BridgeRuntime
                 │     slash-command router (/help /model /persona /memory) — local, no LLM
                 │     image intent → Openverse (SSRF-checked)
                 │     TurnLock (serialize turns), approval gate (/approve once | /deny)
                 │     per-conversation model prefs, sessions, Memory, Culture KB
                 │
                 └─ AgentAdapter (Chat-only)
                       Claude Code: oneshot | stream (persistent stream-json)
                       Codex: app-server (restricted, isolated CODEX_HOME)
                       Gemini / Cursor Agent / custom: present in source, refused for QQ
```

Message path:

```
QQ message → dedupe → allowlist → @mention gate (groups)
           → /command?        → command router → QQ reply
           → image intent?    → Openverse search → QQ image
           → else             → context (Persona → Memory → Culture at session start)
                              → AgentAdapter → sanitize → QQ reply
```

The AI CLI always runs with `cwd = <data>/chat-runtime/` and a scrubbed environment. An interactive terminal is never attached in Chat-only mode, so start with `--no-terminal`.

## Data layout

`<data>` is `<repo>/data` by default, or the path in `QQBRIDGE_DATA_DIR`. It is git-ignored.

```
<data>/
  config.json                         non-secret settings
  persona.md                          user-editable Persona
  secrets/qq.enc.json                 AES-256-GCM QQ credentials
  secrets/event-hash.key              HMAC key for inbound-event content hashes
  chat-runtime/                       empty cwd for AI CLIs
  codex-qq-home/                      isolated Codex home (config.toml + copied auth.json)
  memory/memory.sqlite                Memory + chat archive
  culture/culture.sqlite              Culture KB
  state/runtime.json                  last status snapshot
  state/conversation-models.json      per-conversation model prefs
  state/*-sessions.json               per-conversation backend session ids
  state/instance.lock/                single-instance lock
  state/codex-restricted-verify.json  Codex verification marker
  logs/qqbridge.log                   operational log
  logs/usage.jsonl                    token usage (no prompt contents)
  logs/inbound-events.jsonl           inbound event identity journal (HMAC hashes, no plaintext)
```

## Session policy

| Backend | Transport | Behaviour |
|---------|-----------|-----------|
| Claude | `stream` | One persistent `claude` stream-json process per conversation. Persona changes trigger `--resume --fork-session`. |
| Claude | `oneshot` | One process per turn, using `claude -p --resume <id>`. |
| Codex | `app-server` | Persistent App Server, one thread per conversation, under the restricted profile. |

Sessions created outside the Chat-only runtime are **not resumed**. That covers sessions with the wrong cwd or a missing policy marker. Their files are left on disk.

When context grows past `bridge.memory.rotationThresholdTokens`, the Bridge starts a fresh session seeded with Persona, Memory and Culture.

## Security controls

See [SECURITY.md](./SECURITY.md) and [docs/CHAT-ONLY-SECURITY.md](./docs/CHAT-ONLY-SECURITY.md).

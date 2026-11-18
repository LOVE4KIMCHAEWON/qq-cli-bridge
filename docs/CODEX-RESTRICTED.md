# Codex QQ Restricted Mode

Alternative QQ backend: **Codex App Server** under Bridge-enforced isolation.

Claude Stream remains the default. Codex oneshot stays disabled for QQ.

## Protections

| Layer | What it enforces |
|-------|------------------|
| **Isolated `CODEX_HOME`** (`data/codex-qq-home/`) | No user plugins, MCP servers, or marketplace tools. Auth copied from user login only. |
| **Feature disables** | `shell_tool`, `unified_exec`, `browser_use`, `computer_use`, `plugins`, `apps`, … forced off via config + `--disable`. |
| **Hosted `web_search=live`** | Allowed; separate from local command networking. |
| **Sandbox** | `read-only` cwd = `data/chat-runtime/`. |
| **Approvals** | `on-request` + Bridge **rejects every** approval/permission RPC. QQ text never expands privileges. |
| **Execution monitor** | If a forbidden local tool item appears (`command`, `mcp`, `fileChange`, …), the turn fails closed. |
| **Context** | Shared Persona / Memory / Culture via `developerInstructions` (same assemblers as Claude) with **`capabilityProfile: codex-restricted`**. |
| **OS AppContainer** | **Not available** on Codex 0.169 (`windows_sandbox_service` experimental/off). Do not claim OS isolation beyond process cwd/env. |

### Capability framing (important)

Claude Persona framing says **no tools / no browsing**. That text must **not** be injected into Codex, or the model will refuse hosted `web_search` even when it is enabled.

Codex uses `PERSONA_SYSTEM_FRAMING_CODEX_RESTRICTED`: hosted web search allowed; local shell/FS/MCP/plugins/browser/computer-use forbidden. Stale threads without the current `capabilityKey` are discarded and restarted.

**App Server note (0.169):** hosted `web_search` is routed through `code_mode_host`. Disabling `code_mode` / `code_mode_host` makes search fail with `code-mode host is disabled` even when `web_search=live`. Restricted mode keeps those features enabled while still disabling shell/unified_exec/browser/computer-use.

## Remaining attack surfaces

- Model may still *see* some tool schemas; mitigations are disable + deny, not Claude-style empty tools.
- Hosted web_search results can contain prompt-injection content (treat as untrusted).
- Auth tokens live under the isolated home copy of `auth.json`.
- Feature flags / Codex upgrades can regress — re-run `verify-codex-restricted` after Codex updates.

## Startup

```powershell
cd <repo>
npm run build
qqbridge verify-codex-restricted
qqbridge codex --transport app-server --no-terminal
```

Default Claude path (unchanged):

```powershell
qqbridge claude --transport stream --no-terminal
```

## Verify marker

Successful execution probes write `data/state/codex-restricted-verify.json` (7-day freshness, policy version match). Launch fails closed without it.

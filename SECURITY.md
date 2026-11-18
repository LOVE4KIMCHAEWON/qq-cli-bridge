# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

- Use GitHub's **private vulnerability reporting** (Security → Report a vulnerability) on this repository.
- If that is unavailable, contact the maintainer privately via their GitHub profile.

Include affected version or commit, reproduction steps, and impact. Never include real QQ credentials, AI tokens, openids, or private chat content in reports. Use placeholders.

Only the latest release on the default branch receives fixes.

## Scope and threat model

qq-cli-bridge exposes a locally logged-in AI CLI to QQ users. The main risks:

1. Unauthorized QQ users driving your AI account.
2. A QQ message, Persona text or web content making the AI CLI act on your PC (files, shell, network, MCP).
3. Leaking credentials or private conversation data.

### What the Bridge enforces

| Control | Mechanism | Limits |
|---------|-----------|--------|
| **Backend allowlist** | Only Claude Code and restricted Codex may serve QQ. Gemini, Cursor Agent and custom CLIs are refused. | Policy lives in Bridge code (`src/security/chat-only.ts`). |
| **Claude Chat-only** | The CLI runs with `--tools ""`, `--restricted`, `--strict-mcp-config` with `{"mcpServers":{}}`, `--permission-mode dontAsk` and `--permission-prompts none`. | Relies on Claude Code honouring these flags. No OS sandbox. Re-check after Claude Code upgrades (`npm run test:live`). |
| **Restricted Codex** | 1. Isolated `CODEX_HOME` (`data/codex-qq-home/`) without user plugins or MCP. 2. Local-tool feature flags disabled (`shell_tool`, `unified_exec`, `browser_use`, `computer_use`, `plugins`, `apps`, `image_generation`, `view_image`, …). 3. `sandbox_mode = "read-only"`. 4. The Bridge **rejects every** approval or permission request. 5. A runtime monitor fails the turn on forbidden tool items. 6. Fail-closed startup verification (`qqbridge verify-codex-restricted`). | **Codex is not fully OS-sandboxed.** Windows AppContainer was unavailable in the tested build. Tool schemas may still be visible to the model. Feature names can change between Codex releases, so re-verify after every upgrade. |
| **Working directory and environment** | AI CLIs run in the empty `data/chat-runtime/` directory, never in the repo or your home. The child environment is limited to `PATH`, OS basics and AI-provider auth variables. QQ credentials are never passed to it. | This is application-level hygiene, not isolation. |
| **Argument sanitising** | Dangerous `extraArgs` are stripped: `--yolo`, `--force`, `--dangerously-*`, `--add-dir`, `--mcp-config`, bypass flags. | Pattern-based. |
| **QQ access control** | Separate C2C user and group allowlists (default: allowlist mode). Groups additionally require an @mention. Approval is never inferred from free text: only `/approve once` counts. | Allowlisting is per group, so **every member** of an allowlisted group can use the bot. |
| **Conversation separation** | Sessions, model choices and Memory are keyed by conversation (`c2c:<openid>`, `group:<group_openid>`). | Application-level only: one process, one SQLite file. A single pending "dangerous message" approval is shared runtime-wide, so any allowlisted user in any conversation can answer it. |
| **Output filtering** | ANSI codes and credential-like lines are removed from replies. Prompt-leak filtering is applied. | Heuristic. |
| **Image fetching** | Bridge-owned providers (DDGS by default; SearXNG, Duitang, Openverse, Pexels opt-in). http(s) only, with SSRF checks (private, link-local and metadata IPs blocked; redirects validated). Size limits, MIME and magic-byte checks. | Third-party content. |

### What it does not provide

- **No guaranteed isolation.** No VM, container or AppContainer sandbox. A bug or regression in an AI CLI that ignores its tool-disable flags could expose your user account.
- **Hosted web search (Codex) returns untrusted content.** It can contain prompt injection, misinformation or offensive text, and the model may repeat it into QQ.
- **Model output is not moderated.** You are responsible for what your bot says in QQ.
- **Weak credential encryption.**
  - `data/secrets/qq.enc.json` is AES-256-GCM encrypted.
  - The key is derived from the computer name, Windows user name and data path. None of these is secret.
  - This protects against accidentally sharing the file, **not** against malware or other users who can read your profile.
- **Plain copy of your Codex login.** `data/codex-qq-home/auth.json` is a plain copy of your Codex `auth.json`.
- **Plaintext chat archive.** `data/memory/memory.sqlite` stores the full conversation text.

## Operator guidance

- Keep `c2cMode` and `groupMode` at `allowlist`. Do not use `open` unless you accept that anyone can use your AI subscription.
- Do not add the bot to groups whose members you do not trust. Group context and memory are shared by all members.
- Run the bridge under a normal (non-administrator) Windows account. A dedicated account is better.
- Re-run `qqbridge verify-codex-restricted` and `npm run test:live` after upgrading Claude Code or Codex.
- **Never commit or share** any of the following:
  - `data/` (credentials, Persona, Memory, Culture KB, logs, sessions)
  - `auth.json`
  - `*.enc.json`
  - `*.sqlite`
  - `.env`

  The repository `.gitignore` and the CI guard step help, but are not a substitute for checking `git status` before every commit.
- If credentials leak:
  - Reset the AppSecret on the QQ Open Platform, then run `qqbridge setup` again.
  - Run `codex logout` / `codex login`, and revoke Claude/Anthropic tokens or API keys.

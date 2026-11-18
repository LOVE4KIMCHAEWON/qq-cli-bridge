# Contributing

Thanks for your interest! This is a small, security-sensitive project. Please keep changes focused.

## Setup

```powershell
git clone https://github.com/LOVE4KIMCHAEWON/qq-cli-bridge.git
cd qq-cli-bridge
npm ci
npm run build
npm test
```

Node.js ≥ 22.13 on Windows 10/11 is required. See the README.

## Ground rules

- **Never commit private data.** That includes:
  - `data/`
  - QQ AppID/AppSecret and openids
  - `auth.json`
  - `*.enc.json`
  - SQLite databases
  - logs
  - your Persona
  - chat transcripts

  Run `git status` and review `git diff --cached` before every commit.
- **Use placeholders** in tests, docs and issues:
  - openids: `0123456789ABCDEF0123456789ABCDEF`
  - AppID: `app-1`
  - paths: `C:\Users\example\...`
- **Do not weaken Chat-only security** without discussion. That means changes to tool-disable flags, the backend allowlist, the Codex feature list, approval rejection or env scrubbing. Any change there needs tests in `test/chat-only-security.test.ts` or `test/codex-restricted.test.ts`.
- **Keep tests offline.**
  - `npm test` must pass without QQ credentials, AI CLIs or network access.
  - Tests that call real CLIs must be skipped unless `QQBRIDGE_LIVE_TESTS=1`.
  - The test runner sets a temporary `QQBRIDGE_DATA_DIR`. Do not hard-code `data/` paths.
- **Write source comments and documentation in English.** User-facing QQ strings may be bilingual.
- **Don't claim untested platforms or capabilities** in docs.

## Pull requests

1. Branch from `main`.
2. `npm run build && npm test` must pass. CI runs the same checks on Windows with Node 22 and 24.
3. Describe what you changed and how you verified it. For changes visible in QQ, list which steps of [TESTING.md](./TESTING.md) you ran.
4. Update docs and `CHANGELOG.md` when behaviour changes.

## Reporting security issues

See [SECURITY.md](./SECURITY.md). Do not open public issues for vulnerabilities.

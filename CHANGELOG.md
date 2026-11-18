# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may break).

## [0.1.0] - Unreleased

First public release. Windows-only, Chat-only.

### Added

- Official Tencent QQ Bot transport.
  - QR-code binding and WebSocket gateway.
  - De-duplication and a single-instance lock.
- Chat-only backends:
  - **Claude Code**, `stream` or `oneshot`, with all model tools disabled.
  - **Codex App Server** in restricted mode:
    - isolated `CODEX_HOME`
    - local tools disabled and approvals rejected
    - a runtime monitor
    - hosted web search only
    - mandatory `verify-codex-restricted` probes
- Separate C2C user and group allowlists, and an @mention gate for groups.
- Per-conversation model selection (`/model`), sessions and long-term Memory (`/memory`).
- Editable Persona (`data/persona.md`) with history-preserving reload.
- Culture KB (Chinese internet slang and community norms) with learned corrections.
- Openverse image search and send (`/image`). No AI image generation.
- Explicit `/approve once` gate for messages that look dangerous.
- Offline test suite with an isolated data directory. Live tests are opt-in (`npm run test:live`).
- GitHub Actions CI (Windows, Node 22 and 24).

### Known limitations

- Windows 10/11 only. Linux and macOS are untested.
- No OS-level sandbox. Codex restricted mode is not AppContainer-isolated.
- Gemini CLI, Cursor Agent and custom CLIs are blocked for QQ.
- `qqbridge claude|codex` must be started with `--no-terminal` and an explicit `--transport`.
- A pending "dangerous message" approval is shared across conversations.

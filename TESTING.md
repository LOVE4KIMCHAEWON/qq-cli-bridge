# Testing

## 1. Automated, offline (CI)

Needs no QQ account, AI CLI or network access.

```powershell
cd <repo>
npm ci
npm run build
npm test
node dist\cli.js compat
node dist\cli.js status
```

`npm test` (`scripts/run-tests.mjs`) always sets `QQBRIDGE_DATA_DIR` to a fresh temporary directory, so it never reads or writes your real `data/`.

## 2. Automated, live (opt-in, local only)

These tests call **real, logged-in** AI CLIs and consume usage:

- Claude Chat-only tool-denial checks
- Cursor Agent `.cmd` spawn regression
- Codex restricted execution probes

```powershell
npm run test:live
```

Gates:

- `QQBRIDGE_LIVE_TESTS=1` for Claude and Cursor.
- `QQBRIDGE_CODEX_LIVE_VERIFY=1` for Codex. `npm run test:live` sets both.

Never run these in CI.

## 3. CLI smoke tests (each CLI authenticated)

```powershell
claude -p "reply with the word PONG" --output-format json
codex exec --json "reply with the word PONG"
qqbridge verify-codex-restricted
```

## 4. QQ binding

1. `qqbridge setup`, then scan the QR code with mobile QQ.
2. Confirm the AppID is printed and the AppSecret is **not**.
3. Confirm the scanner's openid was added to the allowlist. If not, use `qqbridge allowlist add <openid>`.
4. `qqbridge status` shows that credentials are present.

## 5. Full bridge (claim success only if every step passes)

1. `qqbridge claude --transport stream --no-terminal`.
2. Wait for `[qqbridge] QQ connected`.
3. From an allowlisted QQ account, send `Reply with exactly: BRIDGE_OK`. Expect a plain-text reply with no ANSI codes.
4. Send a follow-up that refers to the first message. The reply should show session continuity.
5. From a non-allowlisted account, expect "Access denied".
6. Ask the bot to read or write a local file. It must not be able to, and no file may appear.
7. Send a message containing `rm -rf /`.
   - An approval prompt appears.
   - `sure` does **not** approve.
   - `/approve once` does.
8. Ctrl+C stops cleanly. `qqbridge status` shows no active lock owner.
9. Repeat steps 1–6 with `qqbridge codex --transport app-server --no-terminal`. Also ask about today's news: the reply should use hosted web search, or say plainly that search failed.

## 6. Groups

1. Add the bot to a test group and enable group @-messages on the QQ Open Platform.
2. Without allowlisting, `@bot hi` gets no reply. The log shows `filtered_access_policy`.
3. Run `qqbridge allowlist add-group <group_openid>`, using the value printed by the bridge. Restart the bridge.
4. `@bot hi` gets a reply. `hi` without an @mention does not (`filtered_mention_gate`).

## 7. Slash commands, Persona, Memory and images

1. `/help` returns the local command list without an LLM call.
2. `/model` shows the backend and models. `/model <id>`, `/model default` and an invalid id all behave sensibly.
3. A second conversation picks a different model, and the two preferences do not mix.
4. Edit `data/persona.md` and send a message. The tone changes and history is kept. `/persona` never shows the text.
5. `请记住：我喜欢绿茶`, then `/memory`, lists the item. It survives a restart. `/memory forget <id>` removes it.
6. `/image cat` returns one image with attribution. `画一张…` is refused, because image generation is not implemented.

Until steps 5–7 pass with real QQ messages, claim only unit and regression coverage.

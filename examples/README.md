# Configuration examples

These files are **templates only**. qq-cli-bridge creates its real runtime files
under the data directory (`data/` in the checkout, or `QQBRIDGE_DATA_DIR`) on
first run. The data directory is git-ignored and must never be committed.

| Template | Real file | Created automatically? |
|----------|-----------|------------------------|
| `config.example.json` | `data/config.json` | Yes — written with these defaults on first run |
| `persona.example.md` | `data/persona.md` | Yes — written with this text on first run |

You normally do **not** need to copy anything. Use the templates to see the
available settings, or copy one over a real file to reset it:

```powershell
Copy-Item examples\config.example.json data\config.json
```

Notes:

- `allowlist.users` / `allowlist.groups` hold QQ **openids**. Use
  `qqbridge allowlist add <openid>` / `add-group <group_openid>` instead of
  editing them by hand.
- QQ Bot credentials (AppID / AppSecret) are **not** stored in `config.json`.
  `qqbridge setup` writes them encrypted to `data/secrets/qq.enc.json`.
- Image search defaults to DDGS (`bridge.images.providerPriority: ["ddgs"]`);
  install it with `pip install -r requirements-images.txt`.
- `bridge.images.openverseClientId` / `openverseClientSecret` / `pexelsApiKey`
  are optional and intentionally absent from the template. If you set them,
  `config.json` contains a secret — keep it out of Git.
- Agents `gemini`, `agent` (Cursor) and `custom` appear in the schema but are
  **blocked** for QQ by the Chat-only policy. See the main README.

# QQ Image Search, Receive, Send (No AI Generation)

Bridge-owned media path for finding **existing** publicly licensed images and sending them in QQ. **AI image generation is not implemented and must not be enabled.**

## What it does

| Capability | Behavior |
|------------|----------|
| Search | Sequential free providers: **DDGS → SearXNG → Duitang** (+ Openverse last-resort CC) |
| Ranking | Entity aliases + title/tag evidence; **reject** weak/irrelevant hits |
| Download | Ranked relevant URLs; skip HTTP 404/stale (dead-URL cache); max attempts; never unrelated fallbacks |
| Variety | Per-conversation recently-sent IDs excluded; “再来一张 / 其他的她的图” resolve via last IMAGE_SENT and deepen only when needed |
| Latency | Bounded provider fan-out + hard `totalTimeoutMs` (default 35s) wall clock for search+download |
| Send | Download → validate → `QQBot.sendImage({ buffer })` **or** link-only text (Duitang default) |
| Receive | Parse QQ `attachments`; **do not** invent vision if Chat-only backend cannot inspect |
| Triggers | Natural language (`来张张元英`, `有没有其他的张元英图`, `再来一张猫猫`) or `/image <query>` |
| Generation | Refused (`画一张…` → text explaining search-only) |
| Chat UX | Standalone image first; short separate Chinese reply after successful send |

## Providers (verified status)

| Provider | Status | Notes |
|----------|--------|-------|
| **DDGS** | **Primary (default)** | Free DuckDuckGo image search via Python `ddgs` + `scripts/ddgs_images.py`. No API key. Install: `pip install -r requirements-images.txt`. |
| **SearXNG** | **Secondary** | JSON `/search?categories=images&format=json` against **your** instance. No hardcoded public host — set `bridge.images.searxng.baseUrl` or `SEARXNG_BASE_URL`. Skipped when unset. |
| **Duitang (堆糖)** | **Tertiary** | Undocumented site JSON. Strong Chinese fandom relevance. Configure `duitang.enabled` + `deliveryMode`. Not an official open API. |
| **Openverse** | **Last-resort CC** | Queried only if earlier providers lack usable hits. Aggregates CC/public-domain works. |
| **Pexels** | **Optional** | Needs `PEXELS_API_KEY`. Stock only — not used for named-person queries. |
| **Unsplash** | **Not wired** | API requires **hotlinking** their CDN; QQ send needs a downloaded buffer — incompatible without a partnership exception. |
| **Flickr API** | **Not wired** | Needs API key; Openverse already indexes CC Flickr. Direct API adds little for idols (0 CC hits for Jang Wonyoung in samples). |
| **Official K-pop media** | **Not wired** | Agency / fan-site photos are generally **not** redistributable; no scraping / hotlink bypass. |

## Honest quality limits

**Openverse is only partially suitable for K-pop idol requests.**

- Chinese-only queries like `张元英` often return **unrelated** Flickr noise; Bridge maps curated names → English/Hangul/group queries and prefers Wikimedia titles.
- Even then, many indexed Wikimedia file URLs go **404** (moved/deleted). Bridge skips dead URLs (cached ~2h) and tries the next relevant candidate.
- Matching is **metadata-only**, not face verification. Unrelated images are never sent as filler.

**Duitang (when enabled)** is better for Chinese fandom keyword match, but:

- Endpoint is undocumented; ToS restrict automation / commercial redistribution.
- User content is typically “署名 + 非商业转载”; authors may forbid reprint.
- Default Bridge mode sends the **blog source link**, not image bytes.
- Captions never claim visual identity verification.

## Configuration

`data/config.json` → `bridge.images`:

```json
"images": {
  "enabled": true,
  "providerPriority": ["ddgs", "searxng", "duitang"],
  "maxImagesPerRequest": 3,
  "ddgs": { "enabled": true, "pythonPath": "python" },
  "searxng": { "enabled": true, "baseUrl": "" },
  "duitang": { "enabled": true, "deliveryMode": "image" }
}
```

- Sequential fill: next provider runs only if earlier ones lack enough unique candidates.
- SearXNG: set `baseUrl` to an instance with `format=json` enabled (or `SEARXNG_BASE_URL`).
- Explicit pin: `/image --provider=ddgs Minji` or `/image @searxng cat`.
- Setup DDGS: `pip install -r requirements-images.txt`

## Chat UX + attribution

1. Send a **standalone** QQ image (no metadata caption on the media message).
2. After confirmed delivery, send a **separate** short line (`这张不错` / `换了张，看看合不合你口味`, rotated).
3. No face-verification / “非官方 API” / long license lectures in ordinary replies.
4. Send failure → failure text only (never a success phrase).

Creator, license, and landing URL stay in Bridge Recent Actions / logs. For CC-BY-style works, the follow-up may include one compact credit line (`图：Creator · CC BY 4.0`). Duitang link-only mode still sends the blog URL as the payload.

## Security

SSRF, MIME/magic, size caps, no local paths, same C2C/group allowlists, Claude/Codex Chat-only (no browser/FS/shell for images). Duitang does not bypass CAPTCHA, auth walls, or rate limits.

## QQ verification

1. Restart Bridge after config change.
2. Enable Duitang with `deliveryMode: "link"`; C2C `来张张元英` → source-link text (or Openverse image if Duitang empty/disabled).
3. Allowlisted group: `@bot 来张张元英` / `/image 申有娜` → same Bridge path; unauthorized groups stay blocked by group allowlist.
4. Follow-ups `换一张` / `再来张她的` / `有没有别的` → different id via recent-sent + last IMAGE_SENT.
5. Openverse regressions: `/image cat` still works; generation `画一张…` refused.
6. After a successful send/link, ask `那你刚刚发的什么？` — model should acknowledge Bridge action notes.

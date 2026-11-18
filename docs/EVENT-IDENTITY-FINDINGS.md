# QQ Inbound Event Identity — Findings

Status: **investigation + instrumentation only** (no new dedupe behavior).

## 1. SDK mapping (source of truth)

From `@tencent-connect/qqbot-nodejs` `event-dispatcher.js`:

| Raw `C2C_MESSAGE_CREATE` field | Normalized `InboundMessage` |
|--------------------------------|-----------------------------|
| `d.id` | `messageId` |
| `d.timestamp` | `timestamp` |
| `d.author.user_openid` | `senderId` |
| `d.content` | `content` |
| `d.message_scene.ext` entry `msg_idx=…` | `msgIdx` |
| whole `d` | `raw` |

There is **one** dispatch path into `onMessage` for C2C: `C2C_MESSAGE_CREATE` → `action: "message"`.  
Guild/DM/group use different event type strings. The bridge registers a **single** `bot.on("message")` listener.

Gateway DISPATCH sequence number `s` is stored for RESUME but **not** passed into `onMessage`.

## 2. Evidence from production logs (2026-11-17)

### Pair A — concurrent era (pre content-hash)

`05:12:35.884` and `05:12:35.911` — two Agent sends ~27ms apart.  
Consistent with either platform double-delivery **or** two rapid user taps; IDs were not logged then.

### Pair B — post-dedupe, with pipeline IDs (user-reported 8383ms / 9195ms)

| | Event 1 | Event 2 |
|--|---------|---------|
| Wall clock | `05:29:19.965` → close `05:29:28.347` | `05:29:36.672` → close `05:29:45.865` |
| Gap | — | **~8.3s after event 1 finished** |
| `messageId` | `…<redacted-A>…` | `…<redacted-B>…` (**different**) |
| `msgIdx` | `REFIDX_<redacted-A>…` | `REFIDX_<redacted-B>…` (**different**) |
| Dedupe | `claimed` | `claimed` |
| Spawns / finals / sends | 1 / 1 / 1 | 1 / 1 / 1 |

**Conclusion for pair B:** these are **not** same-`messageId` retries. They are also **not** concurrent. With the user having sent multiple `"hi"` messages, pair B is **indistinguishable from two legitimate user messages** until `contentHash` + a controlled 1:1 experiment are available.

Shared opaque suffixes on `messageId` / `msgIdx` look like **conversation-scoped encoding**, not a stable per-user-message key across deliveries.

### Normalization fidelity

For logged events, `messageId` values are opaque `ROBOT1.0_…` strings matching QQ’s `d.id` shape. There is **no evidence** the bridge invents alternate IDs; mapping is a straight field copy.

## 3. What is *not* proven

- That QQ emits two `C2C_MESSAGE_CREATE` payloads for **one** physical user send.
- That RESUME redelivers the same chat with a new `id`.
- That `msgIdx` is stable across retries (observed values differ per event).

## 4. Instrumentation added (no behavior change)

- `event:raw_inspect` / `[qqbridge:event]` — raw key list, id/timestamp equality flags, ext, lengths, **HMAC content hash** (no plaintext).
- JSONL journal: `data/logs/inbound-events.jsonl`
- `rawEvent` gateway observer for non-message event types
- Adapter `listenerCount` on status emit (diagnoses double log lines)

## 5. Controlled 1:1 experiment (required before any new dedupe)

```powershell
# Terminal A
$env:Path = "<repo>\bin;" + $env:Path
# Optional: clear journal for a clean run
Remove-Item <repo>\data\logs\inbound-events.jsonl -ErrorAction SilentlyContinue
qqbridge agent --no-terminal
```

Then on the phone:

1. Send **exactly one** message with unique text, e.g. `probe-A-001`.
2. Wait **60 seconds**. Do not send anything else.
3. Stop the bridge (Ctrl+C).

Analyze:

```powershell
Get-Content <repo>\data\logs\inbound-events.jsonl |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Select-Object receivedAt, contentHash, contentLen, normalizedMessageId, normalizedMsgIdx, rawTimestamp, idsEqual
```

**Pass criteria**

- Exactly **one** journal row for that probe (one `contentHash`).
- If two rows share the same `contentHash` within seconds but different `messageId`/`msgIdx`, that **proves** multi-representation / retry without a stable id.
- If one row only, visible “duplicate replies” were almost certainly **multiple user sends**.

Repeat with `probe-B-001` once more to confirm.

## 6. Fallback proposal (NOT implemented)

Only if the experiment shows same `contentHash` + different `messageId`/`msgIdx` for one physical send:

- **Narrow claim key:** `conv + contentHash` with a short TTL (e.g. 2–3s) **in addition to** messageId.
- **False-positive risk:** user sends the same text twice quickly → second dropped.
- **Mitigations:** TTL ≤ 3s; require same `senderId`; never apply across conversations; log `fallback_dedupe` with hashes only.

Do **not** enable this without experiment proof.

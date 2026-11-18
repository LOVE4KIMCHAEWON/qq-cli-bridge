# QQ Group @mention replies

## Bridge policy (separate from C2C)

| Setting | Meaning |
|---------|---------|
| `allowlist.groupMode` | `allowlist` (default), `open`, or `disabled` |
| `allowlist.groups` | Group openids authorized to talk to the bot |

C2C users and group openids are **independent**. Authorizing a user for private chat does **not** authorize any group.

Authorize a group:

```powershell
qqbridge allowlist add-group <group_openid>
qqbridge allowlist list
```

When the bot is added to a group (`GROUP_ADD_ROBOT`), qqbridge logs the openid and the exact command to run.

## Why group @ got no reply (common Bridge cause)

With `groupMode: "allowlist"` and `groups: []`, the SDK `accessPolicy` **blocks all group messages before the handler**. Private C2C can still work. Logs show:

`qq:group_access_blocked` / `Group allowlist is empty`

## Platform settings you must enable manually

In [QQ Open Platform](https://q.qq.com/) for this bot:

1. Enable **群聊 / 群@消息** (group @ message) capability for the application.
2. Ensure the bot is **added to the target group**.
3. Confirm the gateway can receive `GROUP_AT_MESSAGE_CREATE` (SDK requests `GROUP_AND_C2C` intents; the console must grant the matching permissions).
4. If the console offers a message scope / sandbox toggle for @mentions, enable it for production or your sandbox as appropriate.

This project does **not** use Hermes `group_policy: open`. Keep an explicit group allowlist unless you intentionally set `groupMode` to `open`.

## Diagnostics

Sanitized stages in logs (`data/logs/qqbridge.log`):

| Stage | Meaning |
|-------|---------|
| `received` | Inbound accepted after access + mention gates |
| `filtered_access_policy` | Blocked by C2C/group allowlist |
| `filtered_mention_gate` | Group message without @bot |
| `filtered_dedupe` | Duplicate delivery |
| `processed` / `sent` | Handler finished / outbound OK |
| `failed_send` | Group/C2C reply API error |

Replies use `bot.sendText(replyTarget)` which posts to `/v2/groups/{group_openid}/messages` for group scope.

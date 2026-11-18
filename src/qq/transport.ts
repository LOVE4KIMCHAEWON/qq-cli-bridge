import {
  QQBot,
  accessPolicy,
  messageFilter,
  contentSanitizer,
  errorHandler,
  mentionGate,
  type QQBotInboundMessage,
  type ReplyTarget,
} from "@tencent-connect/qqbot-nodejs";
import type { AppConfig, QqCredentials } from "../types.js";
import { log } from "../util/logger.js";
import { sanitizeForQq } from "../util/output-filter.js";
import { MessageDeduper } from "../bridge/message-dedupe.js";
import { PipelineTrace } from "../bridge/pipeline-trace.js";
import { inspectInboundMessage, logInboundInspection } from "./event-inspect.js";
import {
  describeGroupAccessPolicy,
  formatGroupAccessBlockHint,
} from "./access.js";
import { normalizeInboundQqText, stripQqMentionMarkers } from "./mentions.js";
import {
  extractInboundImages,
  type QqInboundAttachmentLike,
} from "../media/receive.js";

export type InboundHandler = (msg: {
  text: string;
  senderId: string;
  scope: string;
  conversationId: string;
  replyTarget: ReplyTarget;
  raw: QQBotInboundMessage;
  attachments: QqInboundAttachmentLike[];
  trace: PipelineTrace;
}) => Promise<void>;

export class QqTransport {
  private bot?: QQBot;
  private startPromise?: Promise<void>;
  private connected = false;
  private onMessage?: InboundHandler;
  private readonly deduper = new MessageDeduper();
  private starting?: Promise<void>;

  constructor(
    private readonly credentials: QqCredentials,
    private readonly config: AppConfig,
  ) {}

  setMessageHandler(handler: InboundHandler): void {
    this.onMessage = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Exposed for tests */
  getDeduper(): MessageDeduper {
    return this.deduper;
  }

  async start(): Promise<void> {
    if (this.bot) return;
    if (this.starting) return this.starting;

    this.starting = this.startBot();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startBot(): Promise<void> {
    if (this.bot) return;

    const bot = new QQBot({
      appId: this.credentials.appId,
      appSecret: this.credentials.appSecret,
      logger: {
        debug: (m) => log.debug(String(m)),
        info: (m) => log.info(String(m)),
        warn: (m) => log.warn(String(m)),
        error: (m) => log.error(String(m)),
      },
    });

    bot.use(errorHandler());
    bot.use(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 5000 } }));
    // SDK stripBotMention only removes <@appId>; QQ groups use <@hexOpenid>.
    // Also strip all mention markers so `@bot /model` reaches the Bridge router.
    bot.use(
      contentSanitizer({
        stripBotMention: true,
        transform: (content) => stripQqMentionMarkers(content),
      }),
    );

    const c2cMode =
      this.config.allowlist.c2cMode === "allowlist" &&
      this.config.allowlist.users.length === 0
        ? "open"
        : this.config.allowlist.c2cMode;

    const groupAccess = describeGroupAccessPolicy(this.config);
    log.info("qq:access_policy", {
      c2cMode,
      groupMode: groupAccess.mode,
      allowedUsers: this.config.allowlist.users.length,
      allowedGroups: groupAccess.allowedGroupCount,
      willReceiveGroupAt: groupAccess.willReceiveGroupAt,
    });
    if (groupAccess.startupWarning) {
      log.warn("qq:group_access_warning", { warning: groupAccess.startupWarning });
      console.warn(`[qqbridge] ${groupAccess.startupWarning}`);
    }

    bot.use(
      accessPolicy({
        c2c: {
          mode: c2cMode,
          allow: this.config.allowlist.users,
        },
        // Separate group policy — never reuse C2C user allowlist for groups.
        group: {
          mode: this.config.allowlist.groupMode,
          allow: this.config.allowlist.groups,
        },
        onBlock: (ctx, reason) => {
          const kind = ctx.message.kind;
          const groupOpenid = ctx.message.groupOpenid;
          if (kind === "group") {
            const hint = formatGroupAccessBlockHint(groupOpenid, reason);
            log.warn("qq:group_access_blocked", {
              reason,
              groupOpenid: groupOpenid ?? null,
              senderId: ctx.message.senderId,
              rawEventType: ctx.message.rawEventType,
              stage: "filtered_access_policy",
            });
            console.warn(`[qqbridge] ${hint}`);
          } else {
            log.warn("qq:c2c_access_blocked", {
              reason,
              senderId: ctx.message.senderId,
              rawEventType: ctx.message.rawEventType,
              stage: "filtered_access_policy",
            });
          }
        },
      }),
    );
    bot.use(
      mentionGate({
        requireMentionInGroup: true,
        onSkip: (ctx, decision) => {
          log.info("qq:mention_gate_skip", {
            reason: decision.reason,
            wasMentioned: decision.wasMentioned,
            groupOpenid: ctx.message.groupOpenid ?? null,
            rawEventType: ctx.message.rawEventType,
            stage: "filtered_mention_gate",
          });
        },
      }),
    );

    bot.on("ready", () => {
      this.connected = true;
      log.info("QQ gateway ready");
      console.log("[qqbridge] QQ connected");
      if (groupAccess.startupWarning) {
        console.warn(`[qqbridge] ${groupAccess.startupWarning}`);
      }
    });
    bot.on("resumed", () => {
      this.connected = true;
      log.info("QQ gateway resumed");
    });
    bot.on("disconnected", (ev) => {
      this.connected = false;
      log.warn("QQ disconnected", ev);
      console.log(`[qqbridge] QQ disconnected (willReconnect=${ev.willReconnect})`);
    });
    bot.on("error", (err) => log.error("QQ error", { message: err.message }));

    // Exactly one message listener on this bot instance.
    bot.on("message", async (_ctx, msg) => {
      await this.dispatchInbound(bot, msg);
    });

    // Observe non-message gateway events (lifecycle, etc.) without treating them as chat.
    bot.on("rawEvent", (ctx) => {
      const data =
        ctx.data && typeof ctx.data === "object"
          ? (ctx.data as Record<string, unknown>)
          : undefined;
      const groupOpenid =
        typeof data?.group_openid === "string" ? data.group_openid : undefined;
      log.info("event:raw_gateway", {
        eventType: ctx.eventType,
        groupOpenid: groupOpenid ?? null,
        dataKeys: data ? Object.keys(data).sort() : [],
      });
      // When the bot is added to a group, surface the openid for allowlisting.
      if (
        (ctx.eventType === "GROUP_ADD_ROBOT" ||
          ctx.eventType === "GROUP_MSG_RECEIVE") &&
        groupOpenid
      ) {
        log.info("qq:group_lifecycle", {
          eventType: ctx.eventType,
          groupOpenid,
          hint: `qqbridge allowlist add-group ${groupOpenid}`,
          stage: "received",
        });
        console.log(
          `[qqbridge] Group event ${ctx.eventType}: openid=${groupOpenid}. Authorize with: qqbridge allowlist add-group ${groupOpenid}`,
        );
      }
    });

    this.bot = bot;
    this.startPromise = bot.start().catch((err) => {
      this.connected = false;
      log.error("QQ start failed", { message: (err as Error).message });
      throw err;
    });

    await Promise.race([
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (this.connected) {
            clearInterval(check);
            resolve();
          }
        }, 200);
        setTimeout(() => {
          clearInterval(check);
          resolve();
        }, 15_000);
      }),
    ]);
  }

  private async dispatchInbound(_bot: QQBot, msg: QQBotInboundMessage): Promise<void> {
    const trace = new PipelineTrace();
    const conversationId = `${msg.replyTarget.scope}:${msg.replyTarget.targetId}`;
    // Defense in depth: sanitize again here even if middleware missed a format.
    const text = normalizeInboundQqText(msg.content ?? "");

    // Inspect raw payload BEFORE dedupe / handler — required to correlate events.
    const inspection = inspectInboundMessage(msg, text, {
      handlerId: trace.handlerId,
      conversationId,
    });
    logInboundInspection(inspection);

    trace.markInbound({
      rawEventType: msg.rawEventType,
      messageId: msg.messageId,
      conversationId,
      msgIdx: msg.msgIdx,
      contentHash: inspection.contentHash,
      rawTimestamp: inspection.rawTimestamp,
      idsEqual: inspection.idsEqual,
    });

    const claim = this.deduper.tryClaim({
      messageId: msg.messageId,
      msgIdx: msg.msgIdx,
      conversationId,
      timestamp: msg.timestamp,
      rawEventType: msg.rawEventType,
    });
    trace.markDedupe(claim.result, claim.hitKey);

    if (claim.result === "duplicate") {
      log.info("qq:inbound_deduped", {
        conversationId,
        rawEventType: msg.rawEventType,
        scope: msg.replyTarget.scope,
        stage: "filtered_dedupe",
      });
      trace.close("deduped");
      return;
    }

    log.info("qq:inbound_accepted", {
      conversationId,
      rawEventType: msg.rawEventType,
      scope: msg.replyTarget.scope,
      kind: msg.kind,
      contentLen: text.length,
      stage: "received",
    });

    const attachments = msg.attachments ?? [];
    const imageCount = extractInboundImages(attachments).length;

    // @-only group pings leave empty content after stripBotMention — still acknowledge.
    // Image-only messages (no text) must still reach the runtime.
    if (!text && imageCount === 0) {
      if (msg.kind === "group" || msg.replyTarget.scope === "group") {
        log.info("qq:inbound_empty_after_mention_strip", {
          conversationId,
          rawEventType: msg.rawEventType,
          stage: "processed_empty_prompt",
        });
        await this.sendText(
          msg.replyTarget,
          "收到。请在 @我 后面写上你的问题或指令。",
          trace,
        );
        trace.close("empty_group_mention");
        return;
      }
      log.info("qq:inbound_empty", {
        conversationId,
        rawEventType: msg.rawEventType,
        stage: "filtered_empty",
      });
      trace.close("empty_content");
      return;
    }

    if (!this.onMessage) {
      log.warn("qq:inbound_no_handler", {
        conversationId,
        stage: "filtered_no_handler",
      });
      trace.close("no_handler");
      return;
    }

    try {
      await this.onMessage({
        text,
        senderId: msg.senderId || "unknown",
        scope: msg.replyTarget.scope,
        conversationId,
        replyTarget: msg.replyTarget,
        raw: msg,
        attachments,
        trace,
      });
      log.info("qq:inbound_handler_done", {
        conversationId,
        scope: msg.replyTarget.scope,
        stage: "processed",
      });
      trace.close("handler_done");
    } catch (err) {
      log.error("Inbound handler failed", {
        message: (err as Error).message,
        handlerId: trace.handlerId,
        scope: msg.replyTarget.scope,
        stage: "failed_handler",
      });
      await this.sendText(msg.replyTarget, "Bridge error while handling your message.", trace);
      trace.close("handler_error");
    }
  }

  /**
   * Send an image that the Bridge already downloaded into a Buffer.
   * localPath / arbitrary model-chosen files are intentionally unsupported.
   */
  async sendImageBuffer(
    target: ReplyTarget,
    buffer: Buffer,
    opts?: { content?: string; trace?: PipelineTrace },
  ): Promise<boolean> {
    if (!this.bot) throw new Error("QQ bot not started");
    if (!buffer?.length) {
      opts?.trace?.markOutbound("skipped");
      return false;
    }
    try {
      const caption = opts?.content
        ? sanitizeForQq(opts.content, this.config.bridge.maxQqReplyChars)
        : undefined;
      await this.bot.sendImage(
        target,
        { buffer },
        caption ? { content: caption } : undefined,
      );
      opts?.trace?.markOutbound("success");
      log.info("qq:outbound_image_ok", {
        scope: target.scope,
        targetIdLen: target.targetId?.length ?? 0,
        bytes: buffer.length,
        stage: "sent",
      });
      return true;
    } catch (err) {
      opts?.trace?.markOutbound("error");
      log.error("qq:outbound_image_failed", {
        message: (err as Error).message,
        scope: target.scope,
        stage: "failed_send",
      });
      return false;
    }
  }

  async sendText(
    target: ReplyTarget,
    text: string,
    trace?: PipelineTrace,
  ): Promise<boolean> {
    if (!this.bot) throw new Error("QQ bot not started");
    const max = this.config.bridge.maxQqReplyChars;
    const clean = sanitizeForQq(text, max);
    if (!clean) {
      trace?.markOutbound("skipped");
      return false;
    }
    try {
      // SDK routes by scope: C2C → /v2/users/{openid}/messages,
      // group → /v2/groups/{group_openid}/messages.
      await this.bot.sendText(target, clean);
      trace?.markOutbound("success");
      log.info("qq:outbound_ok", {
        scope: target.scope,
        targetIdLen: target.targetId?.length ?? 0,
        contentLen: clean.length,
        stage: "sent",
      });
      return true;
    } catch (err) {
      trace?.markOutbound("error");
      log.error("QQ sendText failed", {
        message: (err as Error).message,
        scope: target.scope,
        targetIdLen: target.targetId?.length ?? 0,
        stage: "failed_send",
      });
      throw err;
    }
  }

  async sendTyping(target: ReplyTarget): Promise<void> {
    if (!this.bot) return;
    if (target.scope !== "c2c") return;
    try {
      await this.bot.sendTyping(target);
    } catch (err) {
      log.debug("typing failed", { message: (err as Error).message });
    }
  }

  async stop(): Promise<void> {
    this.bot?.stop();
    this.bot = undefined;
    this.connected = false;
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // ignore
      }
    }
  }
}

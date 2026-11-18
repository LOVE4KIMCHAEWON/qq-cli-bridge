import fs from "node:fs";
import type { AgentAdapter, AgentKind, AppConfig, RuntimeStatus } from "../types.js";
import { createAdapter } from "../adapters/registry.js";
import { getConfigWithSecrets, loadConfig, saveConfig } from "../config/store.js";
import { QqTransport } from "../qq/transport.js";
import { globalTurnLock } from "./turn-lock.js";
import { PipelineTrace, TurnReplyGate } from "./pipeline-trace.js";
import { LatencyTrace } from "./latency-trace.js";
import { ensureDataDirs, statePath } from "../paths.js";
import { log } from "../util/logger.js";
import {
  approvalHelpText,
  looksDangerous,
  parseApprovalMessage,
} from "../security/approval.js";
import { routeSlashCommand } from "../commands/router.js";
import { parseSlashCommand } from "../commands/parse.js";
import { normalizeInboundQqText } from "../qq/mentions.js";
import { getConversationModel } from "../models/conversation-store.js";
import {
  formatBridgeActionsTurnNote,
  lastDeliveredImageQuery,
  recordBridgeAction,
  stripBridgeActionsTurnNote,
} from "./recent-actions.js";
import {
  buildTurnUsageRecord,
  recordTurnUsage,
} from "../telemetry/usage.js";
import {
  backendCanInspectImages,
  configureImageMediaService,
  containsTechnicalAttributionText,
  extractInboundImages,
  getImageMediaService,
  imagePresenceNoteForModel,
  imageReceivedAckText,
  parseImageIntent,
  parseImageSlashArgs,
  rememberImageDelivered,
  resolveLastImageQuery,
  resolvePendingImageQuery,
  setPendingImageRequest,
  type QqInboundAttachmentLike,
} from "../media/index.js";
import type { ImageProviderId } from "../media/types.js";
import type { ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { randomUUID } from "node:crypto";

interface PendingApproval {
  message: string;
  replyTarget: ReplyTarget;
  sessionId: string;
}

export class BridgeRuntime {
  private config: AppConfig;
  private transport?: QqTransport;
  private adapter?: AgentAdapter;
  private pendingApproval?: PendingApproval;
  private lastReplyTarget?: ReplyTarget;
  private stopping = false;
  private ensureQqLock?: Promise<QqTransport>;
  private persistTimer?: NodeJS.Timeout;
  private pendingPersist?: {
    agent: AgentKind;
    sessionId: string | undefined;
    cwd: string;
    customName?: string;
  };

  constructor() {
    this.config = getConfigWithSecrets({ force: true });
  }

  reloadConfig(force = false): void {
    this.config = getConfigWithSecrets({ force });
  }

  getStatus(): RuntimeStatus {
    return {
      qqConnected: this.transport?.isConnected() ?? false,
      activeAgent: this.adapter?.kind,
      sessionId: this.adapter?.getSessionId() ?? this.config.active?.sessionId,
      cwd: this.config.active?.cwd,
      bridgeMode: this.config.bridge.mode,
      busy: globalTurnLock.isBusy(),
      allowlistCount: this.config.allowlist.users.length,
    };
  }

  async ensureQq(): Promise<QqTransport> {
    this.reloadConfig(true);
    if (!this.config.qq) {
      throw new Error("QQ is not configured. Run: qqbridge setup");
    }
    if (this.transport) return this.transport;
    if (this.ensureQqLock) return this.ensureQqLock;

    this.ensureQqLock = (async () => {
      if (this.transport) return this.transport;
      const transport = new QqTransport(this.config.qq!, this.config);
      transport.setMessageHandler(async (msg) => {
        await this.handleQqMessage(
          msg.text,
          msg.replyTarget,
          msg.senderId,
          msg.trace,
          msg.conversationId,
          msg.attachments,
        );
      });
      await transport.start();
      this.transport = transport;
      return transport;
    })();

    try {
      return await this.ensureQqLock;
    } finally {
      this.ensureQqLock = undefined;
    }
  }

  async switchAgent(
    kind: AgentKind,
    options: { cwd?: string; customName?: string; attachTerminal?: boolean } = {},
  ): Promise<void> {
    await this.ensureQq();

    const {
      ensureChatRuntimeDir,
      prepareChatOnlyStartup,
      chatOnlyStatusLine,
      isQqChatBackendAllowed,
      qqChatBackendBlockReason,
    } = await import("../security/chat-only.js");

    if (!isQqChatBackendAllowed(kind)) {
      throw new Error(qqChatBackendBlockReason(kind));
    }

    if (kind === "codex") {
      const transport = this.config.agents.codex.transport ?? "oneshot";
      if (transport !== "app-server") {
        throw new Error(
          "Codex QQ requires agents.codex.transport=app-server (restricted mode). " +
            "Run: qqbridge verify-codex-restricted && qqbridge codex --transport app-server --no-terminal",
        );
      }
      const { assertCodexRestrictedReadyForQq } = await import(
        "../security/codex-restricted.js"
      );
      assertCodexRestrictedReadyForQq();
    }

    const prepared = prepareChatOnlyStartup();
    const cwd = ensureChatRuntimeDir();
    console.log(`[qqbridge] ${prepared.note}`);

    if (this.adapter) {
      await this.adapter.stop();
      this.adapter = undefined;
    }

    this.reloadConfig(true);
    const { configureMemoryManager } = await import("../memory/manager.js");
    configureMemoryManager({ config: this.config.bridge.memory });
    console.log(
      `[qqbridge] Memory Manager ${this.config.bridge.memory?.enabled === false ? "disabled" : "enabled"} (data/memory/memory.sqlite)`,
    );
    const { configureCultureManager } = await import("../culture/manager.js");
    configureCultureManager({ config: this.config.bridge.culture });
    console.log(
      `[qqbridge] Culture KB ${this.config.bridge.culture?.enabled === false ? "disabled" : "enabled"} (data/culture/culture.sqlite)`,
    );
    configureImageMediaService(this.config.bridge.images);
    {
      const img = this.config.bridge.images;
      const priority = (img?.providerPriority?.length
        ? img.providerPriority
        : ["ddgs"]
      ).join("→");
      const fb = img?.autoFallback === true ? "+autoFallback" : "";
      console.log(
        `[qqbridge] Image search ${img?.enabled === false ? "disabled" : "enabled"} (${priority}${fb}; explicit --provider= still available; no AI generation)`,
      );
    }
    const adapter = createAdapter(kind, this.config, options.customName);
    const transportMode =
      kind === "agent" ? (this.config.agents.agent.transport ?? "oneshot") : undefined;
    if (transportMode) {
      console.log(`[qqbridge] Cursor transport: ${transportMode}`);
    }
    adapter.onOutput((output) => {
      if (output.sessionId) {
        this.persistActive(kind, output.sessionId, cwd, options.customName);
      }
      // status lines are logged once in adapter.emit with listenerCount
    });

    console.log(`[qqbridge] Starting ${adapter.displayName}…`);
    console.log(`[qqbridge] ${chatOnlyStatusLine(adapter.displayName)}`);
    await adapter.start({
      cwd,
      // Never resume a stored oneshot/privileged session id under chat-only.
      sessionId: undefined,
      bridgeMode: this.config.bridge.mode,
      interactive: false,
    });

    this.adapter = adapter;
    this.persistActive(kind, adapter.getSessionId(), cwd, options.customName);
    this.writeRuntimeState();

    console.log(`[qqbridge] Agent ready. session=${adapter.getSessionId() ?? "(none)"}`);
    console.log("[qqbridge] QQ remains connected. Send a private message to the bot.");
    console.log("[qqbridge] Chat-only mode: interactive terminal attach is disabled.");

    // Chat-only: never attach a full interactive agent terminal from QQ bridge.
    if (options.attachTerminal) {
      console.log(
        "[qqbridge] Ignoring --terminal: Chat-only policy keeps the agent headless.",
      );
    }
  }

  async handleQqMessage(
    text: string,
    replyTarget: ReplyTarget,
    senderId: string,
    trace: PipelineTrace = new PipelineTrace(),
    conversationId?: string,
    attachments: QqInboundAttachmentLike[] = [],
  ): Promise<void> {
    this.lastReplyTarget = replyTarget;
    // Use cached config for hot path; force-refresh only when allowlist empty (setup race).
    this.reloadConfig(false);
    const convId =
      conversationId ?? `${replyTarget.scope}:${replyTarget.targetId}`;
    const latency = new LatencyTrace("qq_message");
    latency.mark("qq_inbound");
    (trace as PipelineTrace & { latency?: LatencyTrace }).latency = latency;

    // C2C-only empty-allowlist guard — must not block group @mentions.
    const { shouldBlockForEmptyC2cAllowlist } = await import("../qq/access.js");
    if (shouldBlockForEmptyC2cAllowlist(this.config, replyTarget.scope)) {
      await this.transport?.sendText(
        replyTarget,
        `Access denied. Your openid is not allowlisted.\nAsk the operator to run:\n  qqbridge allowlist add ${senderId}`,
        trace,
      );
      return;
    }

    // Strip QQ <@openid> markers before slash routing / agent turns (group @bot /cmd).
    const inbound = normalizeInboundQqText(text);
    const images = extractInboundImages(attachments);

    // Inbound images: no verified multimodal backend → honest ack, never invent vision.
    if (images.length > 0 && !backendCanInspectImages(this.adapter?.kind)) {
      if (!inbound) {
        await this.transport?.sendText(
          replyTarget,
          imageReceivedAckText(images.length),
          trace,
        );
        return;
      }
      // Text + image: continue with text only and a clear non-vision note for the model.
    }

    // Explicit /image <query> (Bridge-owned; never forwarded to Claude/Codex tools).
    // Optional: /image --provider=ddgs <query> or /image @searxng <query>
    const slashParsed = parseSlashCommand(inbound);
    if (slashParsed?.name === "image" || slashParsed?.name === "img") {
      const parsedImg = parseImageSlashArgs(slashParsed.args);
      if (!parsedImg.query) {
        await this.transport?.sendText(
          replyTarget,
          "Usage: /image <query>  — e.g. /image cat  or  /image --provider=ddgs Minji",
          trace,
        );
        return;
      }
      const preferDifferent = !!resolveLastImageQuery(
        convId,
        lastDeliveredImageQuery(convId),
      );
      log.info("media:intent", {
        kind: "search",
        via: "slash",
        queryLen: parsedImg.query.length,
        preferDifferent,
        provider: parsedImg.provider ?? null,
        scope: replyTarget.scope,
      });
      await this.handleImageSearchRequest(
        parsedImg.query,
        replyTarget,
        convId,
        trace,
        {
          preferDifferent,
          provider: parsedImg.provider as ImageProviderId | undefined,
        },
      );
      return;
    }

    // Slash commands are local — no LLM, no agent required for /help.
    // Dedup already happened in transport; handle exactly once here.
    const slash = await routeSlashCommand(inbound, {
      adapter: this.adapter,
      conversationId: convId,
      senderId,
    });
    if (slash.handled) {
      if (slash.reply) {
        await this.transport?.sendText(replyTarget, slash.reply, trace);
      }
      return;
    }

    // Natural-language image search / generation refusal (Bridge layer).
    // Must run before any LLM turn so Codex cannot invent "图片正在路上".
    // Resolve “她/这张/换一批/继续…” from IMAGE_SENT + Bridge image-session state.
    const imageIntent = parseImageIntent(inbound, {
      lastImageQuery: resolveLastImageQuery(
        convId,
        lastDeliveredImageQuery(convId),
      ),
      pendingImageQuery: resolvePendingImageQuery(convId),
    });
    if (imageIntent.kind === "generate_refused") {
      log.info("media:intent", {
        kind: "generate_refused",
        queryLen: imageIntent.query?.length ?? 0,
        scope: replyTarget.scope,
      });
      await this.transport?.sendText(
        replyTarget,
        "我不会用 AI 生成图片。直接说「来张…」「有没有…图」之类的就行，我去公开图库里找现成的。",
        trace,
      );
      return;
    }
    if (imageIntent.kind === "search") {
      log.info("media:intent", {
        kind: "search",
        queryLen: imageIntent.query.length,
        preferDifferent: !!imageIntent.preferDifferent,
        count: imageIntent.count ?? 1,
        via: "nl",
        scope: replyTarget.scope,
      });
      await this.handleImageSearchRequest(
        imageIntent.query,
        replyTarget,
        convId,
        trace,
        {
          preferDifferent: imageIntent.preferDifferent,
          count: imageIntent.count,
        },
      );
      return;
    }

    if (!this.adapter) {
      await this.transport?.sendText(
        replyTarget,
        "No active agent. On the PC run: qqbridge gemini|codex|claude|agent",
        trace,
      );
      return;
    }

    const decision = parseApprovalMessage(inbound);
    if (this.pendingApproval) {
      if (decision === "approve_once") {
        const pending = this.pendingApproval;
        this.pendingApproval = undefined;
        await this.runAgentTurn(
          pending.message,
          pending.replyTarget,
          pending.sessionId,
          trace,
          convId,
        );
        return;
      }
      if (decision === "deny") {
        this.pendingApproval = undefined;
        await this.transport?.sendText(
          replyTarget,
          "Denied. The pending action was not sent to the agent.",
          trace,
        );
        return;
      }
      await this.transport?.sendText(replyTarget, approvalHelpText(), trace);
      return;
    }

    if (decision !== "not_approval") {
      await this.transport?.sendText(
        replyTarget,
        "No pending dangerous action. Your message was not treated as an approval.",
        trace,
      );
      return;
    }

    if (this.config.bridge.requireApprovalForDangerous && looksDangerous(inbound)) {
      this.pendingApproval = {
        message: inbound,
        replyTarget,
        sessionId: this.adapter.getSessionId() ?? "",
      };
      await this.transport?.sendText(replyTarget, approvalHelpText(), trace);
      return;
    }

    const agentText =
      images.length > 0 && !backendCanInspectImages(this.adapter.kind)
        ? `${imagePresenceNoteForModel(images.length)}\n${inbound}`
        : inbound;

    await this.runAgentTurn(
      agentText,
      replyTarget,
      this.adapter.getSessionId() ?? "",
      trace,
      convId,
    );
  }

  /** Bridge-owned image search → SSRF-safe download → QQ sendImage(buffer). */
  private async handleImageSearchRequest(
    query: string,
    replyTarget: ReplyTarget,
    conversationId: string,
    trace: PipelineTrace,
    opts: {
      preferDifferent?: boolean;
      count?: number;
      provider?: ImageProviderId;
    } = {},
  ): Promise<void> {
    const service = getImageMediaService();
    if (!service.enabled) {
      recordBridgeAction({
        kind: "image_search_send",
        status: "disabled",
        conversationId,
        query,
        error: "images disabled",
      });
      await this.transport?.sendText(replyTarget, "图片搜索未启用。", trace);
      return;
    }
    // Mark pending so nudges like「发啊」can retry if delivery fails mid-flight.
    setPendingImageRequest(conversationId, query, {
      preferDifferent: opts.preferDifferent,
      count: opts.count,
    });
    const count = Math.max(1, opts.count ?? 1);
    const outcomes =
      count > 1
        ? await service.findAndDownloadMany(query, conversationId, {
            preferDifferent: opts.preferDifferent,
            count,
            provider: opts.provider,
          })
        : [
            await service.findAndDownload(query, conversationId, {
              preferDifferent: opts.preferDifferent,
              provider: opts.provider,
            }),
          ];

    let delivered = 0;
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        if (delivered === 0) {
          log.info("media:delivery", {
            status: "search_failed",
            queryLen: query.length,
            scope: replyTarget.scope,
          });
          recordBridgeAction({
            kind: "image_search_send",
            status: "search_failed",
            conversationId,
            query,
            error: outcome.error,
          });
          await this.transport?.sendText(replyTarget, outcome.error, trace);
        }
        // Keep pending so「发啊」can retry the same subject.
        break;
      }
      const ok = await this.deliverImageOutcome(
        outcome,
        replyTarget,
        conversationId,
        query,
        trace,
      );
      if (!ok) break;
      delivered += 1;
    }
  }

  private async deliverImageOutcome(
    outcome: Extract<
      import("../media/service.js").ImageFindOutcome,
      { ok: true }
    >,
    replyTarget: ReplyTarget,
    conversationId: string,
    query: string,
    trace: PipelineTrace,
  ): Promise<boolean> {
    const internalAttr =
      ("attribution" in outcome && outcome.attribution) ||
      outcome.caption ||
      outcome.hit.attribution;

    // Link-only delivery: text with source URL, no QQ redistrib.
    if (
      outcome.delivery === "link" ||
      !("downloaded" in outcome && outcome.downloaded)
    ) {
      const ok = await this.transport?.sendText(
        replyTarget,
        outcome.caption,
        trace,
      );
      if (!ok) {
        recordBridgeAction({
          kind: "image_search_send",
          status: "send_failed",
          conversationId,
          query,
          title: outcome.hit.title,
          provider: outcome.hit.provider,
          imageId: outcome.hit.id,
          attribution: internalAttr,
          error: "QQ sendText (link) failed",
        });
        return false;
      }
      log.info("media:delivery", {
        status: "sent_link",
        queryLen: query.length,
        scope: replyTarget.scope,
        provider: outcome.hit.provider,
      });
      recordBridgeAction({
        kind: "image_search_send",
        status: "sent",
        conversationId,
        query,
        title: outcome.hit.title,
        provider: outcome.hit.provider,
        imageId: outcome.hit.id,
        attribution: internalAttr,
        delivered: true,
      });
      rememberImageDelivered(conversationId, query);
      return true;
    }

    const transport = this.transport as
      | (QqTransport & {
          sendImageBuffer?: QqTransport["sendImageBuffer"];
        })
      | undefined;
    if (!transport?.sendImageBuffer) {
      recordBridgeAction({
        kind: "image_search_send",
        status: "send_failed",
        conversationId,
        query,
        title: outcome.hit.title,
        provider: outcome.hit.provider,
        imageId: outcome.hit.id,
        attribution: internalAttr,
        error: "transport cannot send images",
      });
      await this.transport?.sendText(
        replyTarget,
        "当前传输层无法发送图片。",
        trace,
      );
      return false;
    }

    const ok = await transport.sendImageBuffer(
      replyTarget,
      outcome.downloaded.buffer,
      { trace },
    );
    if (!ok) {
      log.info("media:delivery", {
        status: "send_failed",
        queryLen: query.length,
        scope: replyTarget.scope,
        provider: outcome.hit.provider,
      });
      recordBridgeAction({
        kind: "image_search_send",
        status: "send_failed",
        conversationId,
        query,
        title: outcome.hit.title,
        provider: outcome.hit.provider,
        imageId: outcome.hit.id,
        attribution: internalAttr,
        error: "QQ sendImage failed",
      });
      await this.transport?.sendText(
        replyTarget,
        "图片发送失败，请稍后再试。",
        trace,
      );
      return false;
    }

    // Prefer casual chatReply. Never fall back to internal attribution / tech disclaimers.
    const rawFollowUp =
      ("chatReply" in outcome && outcome.chatReply?.trim()) ||
      (outcome.caption?.trim() &&
      !containsTechnicalAttributionText(outcome.caption)
        ? outcome.caption.trim()
        : "");
    if (rawFollowUp && !containsTechnicalAttributionText(rawFollowUp)) {
      await this.transport?.sendText(replyTarget, rawFollowUp, trace);
    }

    log.info("media:delivery", {
      status: "sent",
      queryLen: query.length,
      scope: replyTarget.scope,
      provider: outcome.hit.provider,
      bytes: outcome.downloaded.byteLength,
    });
    recordBridgeAction({
      kind: "image_search_send",
      status: "sent",
      conversationId,
      query,
      title: outcome.hit.title,
      provider: outcome.hit.provider,
      imageId: outcome.hit.id,
      attribution: internalAttr,
      delivered: true,
    });
    rememberImageDelivered(conversationId, query);
    return true;
  }

  private async runAgentTurn(
    text: string,
    replyTarget: ReplyTarget,
    sessionId: string,
    trace: PipelineTrace,
    conversationId?: string,
  ): Promise<void> {
    if (!this.adapter || !this.transport) return;

    // Queue silently when busy — do not send an extra QQ status message
    // (that previously looked like a duplicate reply under concurrent delivery).
    if (globalTurnLock.isBusy()) {
      log.info("pipeline:turn_queued", {
        handlerId: trace.handlerId,
        messageId: trace.messageId,
      });
    }

    await globalTurnLock.run(async () => {
      const latency =
        (trace as PipelineTrace & { latency?: LatencyTrace }).latency ??
        new LatencyTrace("qq_message");
      latency.mark("queue_enter");

      const gate = new TurnReplyGate();
      trace.beginTurn(sessionId);
      // Do not block the agent turn on typing indicator RTT.
      void this.transport!.sendTyping(replyTarget).catch(() => undefined);
      const adapter = this.adapter!;

      const pref = conversationId
        ? getConversationModel(conversationId)
        : undefined;
      const modelId =
        pref && pref.backend === adapter.kind ? pref.modelId : undefined;

      latency.mark("prompt_sent");
      let sawFirst = false;
      const conv = conversationId ?? `${replyTarget.scope}:${replyTarget.targetId}`;
      // Bridge action awareness (image sends, etc.) — per-turn, not permanent Memory.
      const actionsNote = formatBridgeActionsTurnNote(conv);
      const promptForModel = actionsNote
        ? `${actionsNote}\n\n${text}`
        : text;
      // Note utterance before ensureClient so Culture retrieval can use this turn's text
      // at session start/rotation (still injected once — not every subsequent turn).
      try {
        const { getCultureManager } = await import("../culture/manager.js");
        getCultureManager().noteUserText(conv, stripBridgeActionsTurnNote(text));
      } catch {
        // Culture optional; never block the turn.
      }
      const reply = adapter.sendAndCollect
        ? await adapter.sendAndCollect(
            promptForModel,
            sessionId,
            {
              onSpawn: () => trace.markSpawn(),
              onFinal: () => {
                const n = gate.noteFinal();
                trace.markFinalOutput();
                latency.mark("final_result");
                return n;
              },
            },
            {
              modelId,
              conversationId: conv,
              qqMessageId: trace.messageId,
            },
          )
        : await (async () => {
            trace.markSpawn();
            await adapter.send(promptForModel, sessionId);
            gate.noteFinal();
            trace.markFinalOutput();
            latency.mark("final_result");
            return "(response emitted)";
          })();

      // Capture first-text approximately when partials aren't hooked at runtime level
      if (!sawFirst && reply) {
        latency.mark("first_text");
        sawFirst = true;
      }

      // Exactly one final QQ send per turn, even if multiple finals were emitted.
      if (reply && reply !== "(response emitted)") {
        if (gate.trySend()) {
          await this.transport!.sendText(replyTarget, reply, trace);
          latency.mark("qq_outbound");
          // Persist successful turn for Memory archive (Bridge-owned; not full Claude replay).
          try {
            const { getMemoryManager } = await import("../memory/manager.js");
            const mem = getMemoryManager();
            mem.commitTurn({
              conversationId: conv,
              // Do not archive Bridge action notes as user Memory.
              userText: stripBridgeActionsTurnNote(text),
              assistantText: reply,
              qqMessageId: trace.messageId,
            });
            try {
              const { getCultureManager } = await import("../culture/manager.js");
              getCultureManager().ingestUserUtterance({
                conversationId: conv,
                text: stripBridgeActionsTurnNote(text),
              });
            } catch (cerr) {
              log.warn("culture:ingest_failed", {
                error: (cerr as Error).message,
              });
            }
            const maybeRotate = (
              adapter as unknown as {
                maybeRotateSession?: (id: string) => Promise<boolean>;
              }
            ).maybeRotateSession;
            if (adapter.kind === "claude" && typeof maybeRotate === "function") {
              await maybeRotate.call(adapter, conv);
            }
          } catch (err) {
            log.warn("memory:commit_or_rotate_failed", {
              error: (err as Error).message,
            });
          }
        } else {
          trace.markOutbound("skipped");
          log.warn("pipeline:outbound_suppressed_extra_final", {
            handlerId: trace.handlerId,
            turnId: trace.turnId,
            finals: gate.finals,
          });
        }
      } else if (!adapter.sendAndCollect) {
        if (gate.trySend()) {
          await this.transport!.sendText(
            replyTarget,
            "(No textual response captured from agent)",
            trace,
          );
          latency.mark("qq_outbound");
        }
      }

      const transport = this.config.agents.agent?.transport ?? "oneshot";
      latency.summarize({
        handlerId: trace.handlerId,
        turnId: trace.turnId,
        transport,
      });

      // Oneshot: ACP adapter records its own usage; oneshot rarely exposes tokens.
      if (adapter.kind === "agent" && transport === "oneshot") {
        const finalAt = latency.marks.get("final_result");
        const promptAt = latency.marks.get("prompt_sent");
        recordTurnUsage(
          buildTurnUsageRecord({
            turnId: trace.turnId ?? randomUUID(),
            backend: adapter.displayName,
            transport: "oneshot",
            modelId,
            sessionId: adapter.getSessionId(),
            conversationId,
            latencyMs:
              finalAt != null && promptAt != null ? finalAt - promptAt : undefined,
            thresholds: this.config.bridge.usageWarnings,
          }),
        );
      }

      this.schedulePersistActive(
        adapter.kind,
        adapter.getSessionId(),
        this.config.active?.cwd ?? process.cwd(),
        this.config.active?.customName,
      );
    });
  }

  /** Debounce config/runtime writes so hot turns aren't blocked on sync FS. */
  private schedulePersistActive(
    agent: AgentKind,
    sessionId: string | undefined,
    cwd: string,
    customName?: string,
  ): void {
    this.pendingPersist = { agent, sessionId, cwd, customName };
    // Keep in-memory view fresh immediately
    this.config.active = { agent, sessionId, cwd, customName };
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.flushPersistActive();
    }, 750);
  }

  private flushPersistActive(): void {
    const pending = this.pendingPersist;
    if (!pending) return;
    this.pendingPersist = undefined;
    const cfg = loadConfig();
    cfg.active = {
      agent: pending.agent,
      sessionId: pending.sessionId,
      cwd: pending.cwd,
      customName: pending.customName,
    };
    saveConfig(cfg);
    this.config = getConfigWithSecrets();
    this.writeRuntimeState();
  }

  private persistActive(
    agent: AgentKind,
    sessionId: string | undefined,
    cwd: string,
    customName?: string,
  ): void {
    this.pendingPersist = { agent, sessionId, cwd, customName };
    this.flushPersistActive();
  }

  private writeRuntimeState(): void {
    ensureDataDirs();
    fs.writeFileSync(statePath(), JSON.stringify(this.getStatus(), null, 2), "utf8");
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.flushPersistActive();
    await this.adapter?.stop();
    this.adapter = undefined;
    await this.transport?.stop();
    this.transport = undefined;
    this.writeRuntimeState();
    log.info("Bridge stopped");
  }
}

let singleton: BridgeRuntime | undefined;

export function getRuntime(): BridgeRuntime {
  if (!singleton) singleton = new BridgeRuntime();
  return singleton;
}

/** Test-only reset */
export function resetRuntimeForTests(): void {
  singleton = undefined;
}

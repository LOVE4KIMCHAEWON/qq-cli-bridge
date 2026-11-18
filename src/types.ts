export type BridgeMode = "session" | "pty";

export type AgentKind = "gemini" | "codex" | "claude" | "agent" | "custom";

/** Cursor Agent execution transport. Default remains oneshot for safety. */
export type AgentTransport = "oneshot" | "acp";

/** Claude: oneshot (`claude -p --resume`) or persistent stream-json. */
export type ClaudeTransport = "oneshot" | "stream";

/** Codex: oneshot (`codex exec --json`) or persistent app-server. */
export type CodexTransport = "oneshot" | "app-server";

/** Gemini: oneshot (`gemini -p --resume`) or persistent ACP. */
export type GeminiTransport = "oneshot" | "acp";

export type AcpPermissionMode = "reject" | "allow-once";

/** ACP session mode (Cursor config option). Default remains agent. */
export type AcpSessionMode = "agent" | "ask" | "plan";

export interface AgentOptions {
  cwd: string;
  sessionId?: string;
  args?: string[];
  env?: Record<string, string>;
  /** When true, prefer interactive terminal attachment. */
  interactive?: boolean;
  command?: string;
  bridgeMode?: BridgeMode;
}

export interface AgentOutput {
  kind: "final" | "partial" | "status" | "error" | "approval_request";
  text: string;
  raw?: unknown;
  sessionId?: string;
}

/** Optional hooks for pipeline instrumentation (no message content). */
export interface AgentTurnHooks {
  onSpawn?: () => void;
  /** Called for each final/error emission; return ordinal count. */
  onFinal?: () => number;
}

/** Per-turn options (e.g. conversation-scoped model). */
export interface AgentTurnOptions {
  /** When set, pass this model to the CLI for this turn. Undefined = CLI default. */
  modelId?: string;
  /** QQ conversation id — used by ACP for per-conversation sessions. */
  conversationId?: string;
  /** QQ inbound message id for archival dedupe (never sent to the model as metadata). */
  qqMessageId?: string;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  readonly displayName: string;
  /** True when a verified session-resume API exists. */
  readonly supportsSessionResume: boolean;
  start(options: AgentOptions): Promise<void>;
  send(message: string, sessionId: string): Promise<void>;
  /** Preferred for QQ turns — returns final text and still emits onOutput. */
  sendAndCollect?(
    message: string,
    sessionId: string,
    hooks?: AgentTurnHooks,
    turn?: AgentTurnOptions,
  ): Promise<string>;
  onOutput(callback: (output: AgentOutput) => void): void;
  stop(): Promise<void>;
  getSessionId(): string | undefined;
  /** Launch interactive terminal for the current session when supported. */
  attachTerminal?(options: AgentOptions): Promise<number>;
  /** Discover models via the installed CLI when supported. */
  listModels?(): Promise<import("./models/types.js").ModelCatalog>;
  /**
   * Validate and describe a model switch. Does not persist conversation state —
   * the command layer writes the conversation store.
   */
  resolveModelSwitch?(
    modelId: string | "default",
  ): Promise<import("./models/types.js").ModelSwitchResult>;
}

export interface QqCredentials {
  appId: string;
  appSecret: string;
  userOpenid?: string;
}

export interface AppConfig {
  version: 1;
  qq?: QqCredentials;
  allowlist: {
    /** Default allowlist mode for C2C. */
    c2cMode: "allowlist" | "open" | "disabled";
    /** QQ openids allowed to talk to the bot. */
    users: string[];
    /** Group openids allowed (when group messaging is enabled). */
    groups: string[];
    groupMode: "allowlist" | "open" | "disabled";
  };
  bridge: {
    mode: BridgeMode;
    /** Require explicit QQ approval phrases for dangerous actions. */
    requireApprovalForDangerous: boolean;
    maxQqReplyChars: number;
    /** Soft usage warnings (diagnostics only — never hard-block on missing data). */
    usageWarnings?: {
      contextUsedWarn?: number;
      turnTotalWarn?: number;
      contextGrowthWarn?: number;
    };
    /** Long-term Memory Manager (Bridge-owned; separate from Persona). */
    memory?: {
      enabled?: boolean;
      contextBudgetTokens?: number;
      rotationThresholdTokens?: number;
      recentWindowTurns?: number;
      maxMemoryItems?: number;
      maxRetrievalSnippets?: number;
      maintenanceIdleMs?: number;
      maintenanceMinIntervalMs?: number;
      maintenanceBatchTurns?: number;
    };
    /** Culture KB (slang / community norms; separate from Persona + Memory). */
    culture?: {
      enabled?: boolean;
      contextBudgetTokens?: number;
      maxSnippets?: number;
      seedOnEmpty?: boolean;
    };
    /**
     * Bridge-owned image search + QQ send (no AI image generation).
     * Default: DDGS only (no silent Duitang/Openverse substitution).
     */
    images?: {
      enabled?: boolean;
      provider?: "ddgs" | "searxng" | "duitang" | "openverse" | "pexels";
      /** Ordinary-search order. Default: ["ddgs"]. */
      providerPriority?: Array<
        "ddgs" | "searxng" | "duitang" | "openverse" | "pexels"
      >;
      /**
       * Legacy multi-provider fill (append Openverse). Default false.
       * Explicit `/image --provider=…` still works regardless.
       */
      autoFallback?: boolean;
      maxDownloadBytes?: number;
      searchTimeoutMs?: number;
      downloadTimeoutMs?: number;
      maxDownloadAttempts?: number;
      totalTimeoutMs?: number;
      minWidth?: number;
      minHeight?: number;
      rateLimitPerMinute?: number;
      maxImagesPerRequest?: number;
      openverseClientId?: string;
      openverseClientSecret?: string;
      pexelsApiKey?: string;
      ddgs?: {
        enabled?: boolean;
        pythonPath?: string;
      };
      searxng?: {
        enabled?: boolean;
        /** Instance base URL with JSON enabled. Unset → skip SearXNG. */
        baseUrl?: string;
      };
      /**
       * Optional Duitang (堆糖). Off by default.
       * Default deliveryMode "link" — source URL only; set "image" to opt into QQ byte send.
       */
      duitang?: {
        enabled?: boolean;
        deliveryMode?: "link" | "image";
      };
    };
  };
  agents: {
    gemini: {
      command: string;
      extraArgs: string[];
      /**
       * oneshot = existing `gemini -p --resume` (default).
       * acp = persistent `gemini --acp` JSON-RPC process.
       */
      transport?: GeminiTransport;
      /** ACP tool permission policy. Default reject. */
      acpPermission?: AcpPermissionMode;
    };
    codex: {
      command: string;
      extraArgs: string[];
      /**
       * Pass `--skip-git-repo-check` to `codex exec` / `codex exec resume`
       * so non-Git working directories are allowed (Codex CLI v0.169+).
       * Does not apply to app-server (no equivalent flag).
       */
      skipGitRepoCheck?: boolean;
      /**
       * oneshot = existing `codex exec --json` (default).
       * app-server = persistent `codex app-server --stdio`.
       */
      transport?: CodexTransport;
    };
    claude: {
      command: string;
      extraArgs: string[];
      /**
       * oneshot = existing `claude -p --resume` (default).
       * stream = persistent `claude -p --input-format stream-json`.
       */
      transport?: ClaudeTransport;
    };
    agent: {
      command: string;
      extraArgs: string[];
      /**
       * oneshot = existing `agent -p` (default).
       * acp = persistent `agent acp` JSON-RPC process.
       */
      transport?: AgentTransport;
      /** ACP tool permission policy. Default reject (never silent approve). */
      acpPermission?: AcpPermissionMode;
      /**
       * ACP session mode via set_config_option.
       * ask = Q&A/read-oriented (fewer tool schemas); agent = full tools (default).
       */
      acpMode?: AcpSessionMode;
    };
    custom: Record<string, { command: string; args: string[]; bridgeMode?: BridgeMode; sessionResumeTemplate?: string }>;
  };
  active?: {
    agent: AgentKind;
    sessionId?: string;
    cwd?: string;
    customName?: string;
  };
}

export interface RuntimeStatus {
  qqConnected: boolean;
  activeAgent?: AgentKind;
  sessionId?: string;
  cwd?: string;
  bridgeMode: BridgeMode;
  busy: boolean;
  allowlistCount: number;
}

import fs from "node:fs";
import { z } from "zod";
import { configPath, ensureDataDirs } from "../paths.js";
import type { AppConfig } from "../types.js";
import { loadCredentials, saveCredentials } from "../security/secrets.js";

const ConfigSchema = z.object({
  version: z.literal(1),
  allowlist: z.object({
    c2cMode: z.enum(["allowlist", "open", "disabled"]).default("allowlist"),
    users: z.array(z.string()).default([]),
    groups: z.array(z.string()).default([]),
    groupMode: z.enum(["allowlist", "open", "disabled"]).default("allowlist"),
  }),
  bridge: z.object({
    mode: z.enum(["session", "pty"]).default("session"),
    requireApprovalForDangerous: z.boolean().default(true),
    maxQqReplyChars: z.number().int().positive().default(3500),
    usageWarnings: z
      .object({
        contextUsedWarn: z.number().int().positive().optional(),
        turnTotalWarn: z.number().int().positive().optional(),
        contextGrowthWarn: z.number().int().positive().optional(),
      })
      .optional(),
    memory: z
      .object({
        enabled: z.boolean().optional(),
        contextBudgetTokens: z.number().int().positive().optional(),
        rotationThresholdTokens: z.number().int().positive().optional(),
        recentWindowTurns: z.number().int().positive().optional(),
        maxMemoryItems: z.number().int().positive().optional(),
        maxRetrievalSnippets: z.number().int().positive().optional(),
        maintenanceIdleMs: z.number().int().positive().optional(),
        maintenanceMinIntervalMs: z.number().int().positive().optional(),
        maintenanceBatchTurns: z.number().int().positive().optional(),
      })
      .optional(),
    culture: z
      .object({
        enabled: z.boolean().optional(),
        contextBudgetTokens: z.number().int().positive().optional(),
        maxSnippets: z.number().int().positive().optional(),
        seedOnEmpty: z.boolean().optional(),
      })
      .optional(),
    images: z
      .object({
        enabled: z.boolean().optional(),
        provider: z
          .enum(["ddgs", "searxng", "duitang", "openverse", "pexels"])
          .optional(),
        providerPriority: z
          .array(z.enum(["ddgs", "searxng", "duitang", "openverse", "pexels"]))
          .optional(),
        /** Legacy multi-provider fill. Default false = DDGS-only ordinary search. */
        autoFallback: z.boolean().optional(),
        maxDownloadBytes: z.number().int().positive().optional(),
        searchTimeoutMs: z.number().int().positive().optional(),
        downloadTimeoutMs: z.number().int().positive().optional(),
        maxDownloadAttempts: z.number().int().positive().max(12).optional(),
        totalTimeoutMs: z.number().int().positive().max(120_000).optional(),
        minWidth: z.number().int().positive().optional(),
        minHeight: z.number().int().positive().optional(),
        rateLimitPerMinute: z.number().int().positive().optional(),
        maxImagesPerRequest: z.number().int().positive().max(5).optional(),
        openverseClientId: z.string().optional(),
        openverseClientSecret: z.string().optional(),
        pexelsApiKey: z.string().optional(),
        ddgs: z
          .object({
            enabled: z.boolean().optional(),
            pythonPath: z.string().optional(),
          })
          .optional(),
        searxng: z
          .object({
            enabled: z.boolean().optional(),
            baseUrl: z.string().optional(),
          })
          .optional(),
        duitang: z
          .object({
            enabled: z.boolean().optional(),
            deliveryMode: z.enum(["link", "image"]).optional(),
          })
          .optional(),
      })
      .optional(),
  }),
  agents: z.object({
    gemini: z.object({
      command: z.string().default("gemini"),
      extraArgs: z.array(z.string()).default([]),
      transport: z.enum(["oneshot", "acp"]).default("oneshot"),
      acpPermission: z.enum(["reject", "allow-once"]).default("reject"),
    }),
    codex: z.object({
      command: z.string().default("codex"),
      extraArgs: z.array(z.string()).default([]),
      skipGitRepoCheck: z.boolean().default(false),
      transport: z.enum(["oneshot", "app-server"]).default("oneshot"),
    }),
    claude: z.object({
      command: z.string().default("claude"),
      extraArgs: z.array(z.string()).default([]),
      transport: z.enum(["oneshot", "stream"]).default("oneshot"),
    }),
    agent: z.object({
      command: z.string().default("agent"),
      extraArgs: z.array(z.string()).default([]),
      transport: z.enum(["oneshot", "acp"]).default("oneshot"),
      acpPermission: z.enum(["reject", "allow-once"]).default("reject"),
      acpMode: z.enum(["agent", "ask", "plan"]).default("agent"),
    }),
    custom: z
      .record(
        z.string(),
        z.object({
          command: z.string(),
          args: z.array(z.string()).default([]),
          bridgeMode: z.enum(["session", "pty"]).optional(),
          sessionResumeTemplate: z.string().optional(),
        }),
      )
      .default({}),
  }),
  active: z
    .object({
      agent: z.enum(["gemini", "codex", "claude", "agent", "custom"]),
      sessionId: z.string().optional(),
      cwd: z.string().optional(),
      customName: z.string().optional(),
    })
    .optional(),
});

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    allowlist: {
      c2cMode: "allowlist",
      users: [],
      groups: [],
      groupMode: "allowlist",
    },
    bridge: {
      mode: "session",
      requireApprovalForDangerous: true,
      maxQqReplyChars: 3500,
      usageWarnings: {
        contextUsedWarn: 200_000,
        turnTotalWarn: 100_000,
        contextGrowthWarn: 50_000,
      },
      memory: {
        enabled: true,
        contextBudgetTokens: 6_000,
        rotationThresholdTokens: 80_000,
        recentWindowTurns: 12,
        maxMemoryItems: 40,
        maxRetrievalSnippets: 4,
        maintenanceIdleMs: 45_000,
        maintenanceMinIntervalMs: 120_000,
        maintenanceBatchTurns: 40,
      },
      culture: {
        enabled: true,
        contextBudgetTokens: 900,
        maxSnippets: 8,
        seedOnEmpty: true,
      },
      images: {
        enabled: true,
        provider: "ddgs",
        providerPriority: ["ddgs"],
        autoFallback: false,
        maxDownloadBytes: 5 * 1024 * 1024,
        searchTimeoutMs: 12_000,
        downloadTimeoutMs: 15_000,
        minWidth: 200,
        minHeight: 200,
        rateLimitPerMinute: 12,
        maxImagesPerRequest: 3,
        ddgs: {
          enabled: true,
        },
        searxng: {
          enabled: true,
          baseUrl: "",
        },
        duitang: {
          enabled: false,
          deliveryMode: "link",
        },
      },
    },
    agents: {
      gemini: {
        command: "gemini",
        extraArgs: [],
        transport: "oneshot",
        acpPermission: "reject",
      },
      codex: {
        command: "codex",
        extraArgs: [],
        skipGitRepoCheck: false,
        transport: "oneshot",
      },
      // Default stream for QQ: persistent process, tools disabled via --tools "".
      claude: { command: "claude", extraArgs: [], transport: "stream" },
      agent: {
        command: "agent",
        extraArgs: [],
        transport: "oneshot",
        acpPermission: "reject",
        acpMode: "agent",
      },
      custom: {},
    },
  };
}

/** In-memory config cache — avoid decrypting secrets on every QQ turn. */
let cachedConfig: AppConfig | undefined;
let cachedConfigAt = 0;
const CONFIG_CACHE_MS = 5_000;

export function invalidateConfigCache(): void {
  cachedConfig = undefined;
  cachedConfigAt = 0;
}

export function loadConfig(): AppConfig {
  ensureDataDirs();
  const p = configPath();
  if (!fs.existsSync(p)) {
    const cfg = defaultConfig();
    saveConfig(cfg);
    return cfg;
  }
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const parsed = ConfigSchema.parse(raw);
  return parsed as AppConfig;
}

export function saveConfig(config: AppConfig): void {
  ensureDataDirs();
  const { qq: _qq, ...rest } = config as AppConfig & { qq?: unknown };
  fs.writeFileSync(configPath(), JSON.stringify(rest, null, 2), "utf8");
  invalidateConfigCache();
}

export function getConfigWithSecrets(opts: { force?: boolean } = {}): AppConfig {
  const now = Date.now();
  if (
    !opts.force &&
    cachedConfig &&
    now - cachedConfigAt < CONFIG_CACHE_MS &&
    cachedConfig.qq
  ) {
    return cachedConfig;
  }
  const cfg = loadConfig();
  const qq = loadCredentials();
  if (qq) cfg.qq = qq;
  cachedConfig = cfg;
  cachedConfigAt = now;
  return cfg;
}

export function persistQqCredentials(appId: string, appSecret: string, userOpenid?: string): void {
  saveCredentials({ appId, appSecret, userOpenid });
  invalidateConfigCache();
  const cfg = loadConfig();
  if (userOpenid && !cfg.allowlist.users.includes(userOpenid)) {
    cfg.allowlist.users.push(userOpenid);
    saveConfig(cfg);
  }
}

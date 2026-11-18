#!/usr/bin/env node
import { Command } from "commander";
import { runSetup, printSetupStatus } from "./qq/setup.js";
import { getRuntime } from "./bridge/runtime.js";
import { loadConfig, saveConfig } from "./config/store.js";
import { loadCredentials } from "./security/secrets.js";
import { ensureDataDirs, dataRoot, projectRoot } from "./paths.js";
import { commandExists } from "./util/process.js";
import type { AgentKind } from "./types.js";
import {
  InstanceLockError,
  acquireInstanceLock,
  readInstanceOwner,
  refreshInstanceLockAgent,
  releaseInstanceLock,
  stopLockOwner,
} from "./lifecycle/instance-lock.js";
import {
  gracefulShutdown,
  installProcessLifecycleHandlers,
  setShutdownRuntimeStop,
} from "./lifecycle/shutdown.js";
import { isLockOwnerActive } from "./lifecycle/process-info.js";

ensureDataDirs();

const program = new Command();
program
  .name("qqbridge")
  .description("Bridge Tencent QQ Bot to AI CLI agents (Gemini, Codex, Claude, Cursor Agent, custom)")
  .version("0.1.0");

program
  .command("setup")
  .description("QR-bind official QQ Bot credentials and initialize allowlist")
  .action(async () => {
    await runSetup();
  });

async function launchAgent(kind: AgentKind, opts: { cwd?: string; noTerminal?: boolean; name?: string }) {
  const { isQqChatBackendAllowed, qqChatBackendBlockReason } = await import(
    "./security/chat-only.js"
  );
  if (!isQqChatBackendAllowed(kind)) {
    console.error(`[qqbridge] ${qqChatBackendBlockReason(kind)}`);
    process.exitCode = 1;
    return;
  }

  if (kind === "codex") {
    const cfg = loadConfig();
    const transport = cfg.agents.codex.transport ?? "oneshot";
    if (transport !== "app-server") {
      console.error(
        "[qqbridge] Codex QQ requires restricted App Server mode.\n" +
          "  1) qqbridge verify-codex-restricted\n" +
          "  2) qqbridge codex --transport app-server --no-terminal\n" +
          "Oneshot Codex remains disabled for QQ Chat-only.",
      );
      process.exitCode = 1;
      return;
    }
    try {
      const { assertCodexRestrictedReadyForQq } = await import(
        "./security/codex-restricted.js"
      );
      assertCodexRestrictedReadyForQq();
    } catch (err) {
      console.error(`[qqbridge] ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  const creds = loadCredentials();
  if (!creds) {
    console.error("[qqbridge] QQ is not configured. Run: qqbridge setup");
    process.exitCode = 1;
    return;
  }

  try {
    acquireInstanceLock({ appId: creds.appId, agent: kind });
  } catch (err) {
    if (err instanceof InstanceLockError) {
      console.error(`[qqbridge] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const runtime = getRuntime();
  setShutdownRuntimeStop(async () => {
    await runtime.stop();
  });
  installProcessLifecycleHandlers();

  const cwd = opts.cwd ? requirePath(opts.cwd) : process.cwd();

  const cmdMap: Record<string, string> = {
    gemini: loadConfig().agents.gemini.command,
    codex: loadConfig().agents.codex.command,
    claude: loadConfig().agents.claude.command,
    agent: loadConfig().agents.agent.command,
  };
  if (kind !== "custom") {
    const cmd = cmdMap[kind];
    if (!(await commandExists(cmd))) {
      console.error(`[qqbridge] Command not found: ${cmd}`);
      console.error(`Install the CLI or set agents.${kind}.command in ${dataRoot()}\\config.json`);
      await gracefulShutdown("missing_cli");
      process.exitCode = 1;
      return;
    }
  }

  refreshInstanceLockAgent(kind);

  try {
    await runtime.switchAgent(kind, {
      cwd,
      customName: opts.name,
      attachTerminal: !opts.noTerminal,
    });

    if (opts.noTerminal) {
      console.log("[qqbridge] QQ-only mode. Press Ctrl+C to stop.");
      await new Promise<void>(() => {
        /* kept alive by lifecycle handlers */
      });
    } else {
      await gracefulShutdown("terminal_exit");
    }
  } catch (err) {
    console.error(`[qqbridge] ${(err as Error).message}`);
    await gracefulShutdown("launch_error");
    process.exitCode = 1;
  }
}

function requirePath(p: string): string {
  return p;
}

for (const name of ["gemini", "codex", "claude", "agent"] as AgentKind[]) {
  const cmd = program
    .command(name)
    .description(`Start QQ bridge with ${name} CLI`)
    .option("--cwd <path>", "Working directory for the agent", process.cwd())
    .option("--no-terminal", "Do not attach interactive terminal; QQ-only mode");

  if (name === "agent") {
    cmd.option(
      "--transport <mode>",
      "Cursor transport: oneshot (default) or acp (persistent)",
      "oneshot",
    );
    cmd.option(
      "--acp-permission <mode>",
      "ACP tool permission: reject (default) or allow-once",
      "reject",
    );
  }

  if (name === "claude") {
    cmd.option(
      "--transport <mode>",
      "Claude transport: oneshot (default) or stream (persistent stream-json)",
      "oneshot",
    );
  }

  if (name === "codex") {
    cmd.option(
      "--transport <mode>",
      "Codex transport: oneshot (default) or app-server (persistent)",
      "oneshot",
    );
    cmd.option(
      "--skip-git-repo-check",
      "Pass --skip-git-repo-check to codex exec (allow non-Git cwd)",
    );
  }

  if (name === "gemini") {
    cmd.option(
      "--transport <mode>",
      "Gemini transport: oneshot (default) or acp (persistent)",
      "oneshot",
    );
    cmd.option(
      "--acp-permission <mode>",
      "Gemini ACP tool permission: reject (default) or allow-once",
      "reject",
    );
  }

  cmd.action(
    async (opts: {
      cwd?: string;
      terminal?: boolean;
      transport?: string;
      acpPermission?: string;
      skipGitRepoCheck?: boolean;
    }) => {
      if (name === "agent") {
        const cfg = loadConfig();
        const transport =
          opts.transport === "acp" || opts.transport === "oneshot"
            ? opts.transport
            : (cfg.agents.agent.transport ?? "oneshot");
        const acpPermission =
          opts.acpPermission === "allow-once" || opts.acpPermission === "reject"
            ? opts.acpPermission
            : (cfg.agents.agent.acpPermission ?? "reject");
        cfg.agents.agent.transport = transport;
        cfg.agents.agent.acpPermission = acpPermission;
        saveConfig(cfg);
        console.log(
          `[qqbridge] agents.agent.transport=${transport} acpPermission=${acpPermission}`,
        );
      }
      if (name === "claude") {
        const cfg = loadConfig();
        const transport =
          opts.transport === "stream" || opts.transport === "oneshot"
            ? opts.transport
            : (cfg.agents.claude.transport ?? "oneshot");
        cfg.agents.claude.transport = transport;
        saveConfig(cfg);
        console.log(`[qqbridge] agents.claude.transport=${transport}`);
      }
      if (name === "codex") {
        const cfg = loadConfig();
        let changed = false;
        if (opts.transport === "app-server" || opts.transport === "oneshot") {
          cfg.agents.codex.transport = opts.transport;
          changed = true;
        }
        if (opts.skipGitRepoCheck) {
          cfg.agents.codex.skipGitRepoCheck = true;
          changed = true;
          console.log("[qqbridge] agents.codex.skipGitRepoCheck=true");
        }
        if (changed) {
          saveConfig(cfg);
          console.log(
            `[qqbridge] agents.codex.transport=${cfg.agents.codex.transport ?? "oneshot"}`,
          );
        }
      }
      if (name === "gemini") {
        const cfg = loadConfig();
        const transport =
          opts.transport === "acp" || opts.transport === "oneshot"
            ? opts.transport
            : (cfg.agents.gemini.transport ?? "oneshot");
        const acpPermission =
          opts.acpPermission === "allow-once" || opts.acpPermission === "reject"
            ? opts.acpPermission
            : (cfg.agents.gemini.acpPermission ?? "reject");
        cfg.agents.gemini.transport = transport;
        cfg.agents.gemini.acpPermission = acpPermission;
        saveConfig(cfg);
        console.log(
          `[qqbridge] agents.gemini.transport=${transport} acpPermission=${acpPermission}`,
        );
      }
      await launchAgent(name, { cwd: opts.cwd, noTerminal: opts.terminal === false });
    },
  );
}

program
  .command("verify-codex-restricted")
  .description(
    "Run fail-closed static + execution probes for QQ-restricted Codex (required before qqbridge codex --transport app-server)",
  )
  .option("--static-only", "Only check isolated home/config (no model calls)")
  .action(async (opts: { staticOnly?: boolean }) => {
    const {
      verifyCodexRestrictedStatic,
      verifyCodexRestrictedExecution,
    } = await import("./security/codex-restricted.js");
    const staticResult = verifyCodexRestrictedStatic();
    if (!staticResult.ok) {
      console.error("[qqbridge] Codex restricted STATIC checks FAILED:");
      for (const e of staticResult.errors) console.error(`  - ${e}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[qqbridge] Codex restricted static OK (home=${staticResult.home.homeDir})`);
    if (opts.staticOnly) {
      console.log("[qqbridge] Skipped execution probes (--static-only).");
      return;
    }
    console.log("[qqbridge] Running execution probes (shell/write/web_search)...");
    const execResult = await verifyCodexRestrictedExecution({
      command: loadConfig().agents.codex.command,
    });
    for (const d of execResult.details) console.log(`  ${d}`);
    if (!execResult.ok) {
      console.error("[qqbridge] Codex restricted EXECUTION checks FAILED:");
      for (const e of execResult.errors) console.error(`  - ${e}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      "[qqbridge] Codex restricted mode VERIFIED. You may start:\n" +
        "  qqbridge codex --transport app-server --no-terminal",
    );
  });

program
  .command("set-transport")
  .description(
    "Set backend transport without starting the bridge. Usage: set-transport <backend> <mode>",
  )
  .argument("<backend>", "agent | claude | codex | gemini (legacy: oneshot|acp sets Cursor)")
  .argument("[mode]", "Transport mode for the backend")
  .option("--acp-permission <mode>", "reject | allow-once", "reject")
  .action((backend: string, mode: string | undefined, opts: { acpPermission?: string }) => {
    const cfg = loadConfig();

    // Legacy: qqbridge set-transport acp|oneshot
    if ((backend === "oneshot" || backend === "acp") && !mode) {
      cfg.agents.agent.transport = backend;
      if (opts.acpPermission === "allow-once" || opts.acpPermission === "reject") {
        cfg.agents.agent.acpPermission = opts.acpPermission;
      }
      saveConfig(cfg);
      console.log(
        `Saved agents.agent.transport=${backend} acpPermission=${cfg.agents.agent.acpPermission ?? "reject"}`,
      );
      return;
    }

    if (!mode) {
      console.error("Usage: qqbridge set-transport <agent|claude|codex|gemini> <mode>");
      process.exitCode = 1;
      return;
    }

    if (backend === "agent") {
      if (mode !== "oneshot" && mode !== "acp") {
        console.error("agent mode must be oneshot or acp");
        process.exitCode = 1;
        return;
      }
      cfg.agents.agent.transport = mode;
      if (opts.acpPermission === "allow-once" || opts.acpPermission === "reject") {
        cfg.agents.agent.acpPermission = opts.acpPermission;
      }
      saveConfig(cfg);
      console.log(`Saved agents.agent.transport=${mode}`);
      console.log(
        mode === "acp"
          ? "Enable: qqbridge agent --transport acp --no-terminal"
          : "Revert: qqbridge agent --transport oneshot --no-terminal",
      );
      return;
    }

    if (backend === "claude") {
      if (mode !== "oneshot" && mode !== "stream") {
        console.error("claude mode must be oneshot or stream");
        process.exitCode = 1;
        return;
      }
      cfg.agents.claude.transport = mode;
      saveConfig(cfg);
      console.log(`Saved agents.claude.transport=${mode}`);
      console.log(
        mode === "stream"
          ? "Enable: qqbridge claude --transport stream --no-terminal"
          : "Revert: qqbridge claude --transport oneshot --no-terminal",
      );
      return;
    }

    if (backend === "codex") {
      if (mode !== "oneshot" && mode !== "app-server") {
        console.error("codex mode must be oneshot or app-server");
        process.exitCode = 1;
        return;
      }
      cfg.agents.codex.transport = mode;
      saveConfig(cfg);
      console.log(`Saved agents.codex.transport=${mode}`);
      console.log(
        mode === "app-server"
          ? "Enable: qqbridge codex --transport app-server --no-terminal"
          : "Revert: qqbridge codex --transport oneshot --no-terminal",
      );
      return;
    }

    if (backend === "gemini") {
      if (mode !== "oneshot" && mode !== "acp") {
        console.error("gemini mode must be oneshot or acp");
        process.exitCode = 1;
        return;
      }
      cfg.agents.gemini.transport = mode;
      if (opts.acpPermission === "allow-once" || opts.acpPermission === "reject") {
        cfg.agents.gemini.acpPermission = opts.acpPermission;
      }
      saveConfig(cfg);
      console.log(`Saved agents.gemini.transport=${mode}`);
      console.log(
        mode === "acp"
          ? "Enable: qqbridge gemini --transport acp --no-terminal"
          : "Revert: qqbridge gemini --transport oneshot --no-terminal",
      );
      return;
    }

    console.error("Unknown backend. Use agent | claude | codex | gemini");
    process.exitCode = 1;
  });

program
  .command("custom <name>")
  .description("Start QQ bridge with a configured custom CLI")
  .option("--cwd <path>", "Working directory", process.cwd())
  .option("--no-terminal", "QQ-only mode")
  .action(async (name: string, opts: { cwd?: string; terminal?: boolean }) => {
    await launchAgent("custom", {
      cwd: opts.cwd,
      noTerminal: opts.terminal === false,
      name,
    });
  });

program
  .command("status")
  .description("Show QQ binding, allowlist, lock owner, and runtime status")
  .action(() => {
    printSetupStatus();
    const owner = readInstanceOwner();
    if (!owner) {
      console.log("Instance lock: (none — no running qqbridge holder)");
    } else {
      const active = isLockOwnerActive({
        pid: owner.pid,
        startedAtMs: owner.startedAtMs,
      });
      console.log("Instance lock:", {
        pid: owner.pid,
        appId: owner.appId,
        agent: owner.agent,
        startedAt: owner.startedAt,
        active: active.active,
        activeReason: active.reason,
        self: owner.pid === process.pid,
      });
    }
    const runtime = getRuntime();
    const st = runtime.getStatus();
    console.log("Runtime:", st);
    console.log("Project:", projectRoot());
    console.log("Data:", dataRoot());
  });

program
  .command("stop")
  .description("Stop the running qqbridge instance (including orphans) and release the lock")
  .action(async () => {
    const result = await stopLockOwner({
      stopSelf: async () => {
        await getRuntime().stop();
      },
      waitMs: 5000,
    });
    console.log(result.detail);
    if (!result.stopped) process.exitCode = 1;
  });

program
  .command("allowlist")
  .description("Manage QQ user/group allowlists")
  .addCommand(
    new Command("add")
      .argument("<openid>", "User openid to allow")
      .action((openid: string) => {
        const cfg = loadConfig();
        if (!cfg.allowlist.users.includes(openid)) cfg.allowlist.users.push(openid);
        saveConfig(cfg);
        console.log(`Added user ${openid}`);
      }),
  )
  .addCommand(
    new Command("add-group")
      .argument("<groupOpenid>", "Group openid to allow")
      .action((groupOpenid: string) => {
        const cfg = loadConfig();
        if (!cfg.allowlist.groups.includes(groupOpenid)) cfg.allowlist.groups.push(groupOpenid);
        saveConfig(cfg);
        console.log(`Added group ${groupOpenid}`);
      }),
  )
  .addCommand(
    new Command("list").action(() => {
      const cfg = loadConfig();
      console.log(JSON.stringify(cfg.allowlist, null, 2));
    }),
  );

program
  .command("compat")
  .description("Print CLI compatibility matrix")
  .action(() => {
    console.log(`
QQ CLI Bridge — compatibility matrix

CLI            Session resume API                         Structured output     Live dual TUI writers
-------------  -----------------------------------------  --------------------  ---------------------
gemini         --resume + -p / --prompt                   json / stream-json    Not officially supported
codex          codex exec resume --last|<id>              --json                Not officially supported
claude         claude -p --resume <session_id>            json / stream-json    Not officially supported
agent          agent -p --resume|--continue               json / stream-json    Not officially supported
custom         Only if sessionResumeTemplate configured   Unknown               Best-effort PTY inject

Default bridge mode: session (turn-locked resume). Terminal attaches via the same session id.
PTY inject mode is available for custom CLIs without a resume API.
`);
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error(`[qqbridge] ${(err as Error).message}`);
  try {
    releaseInstanceLock();
  } catch {
    // ignore
  }
  process.exitCode = 1;
}

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  DEFAULT_PERSONA_TEXT,
  PERSONA_SYSTEM_FRAMING,
} from "../src/persona/default.js";
import {
  buildPersonaSystemSection,
  composeClaudeSystemPrompt,
  ensurePersonaFile,
  hashPersonaText,
  loadPersona,
  normalizePersonaText,
  PERSONA_MAX_CHARS,
  claudePersonaSystemArgs,
} from "../src/persona/load.js";
import { ClaudeStreamClient } from "../src/claude/stream-client.js";
import { ClaudeStreamAdapter } from "../src/adapters/claude-stream.js";
import { createClaudeAdapter } from "../src/adapters/claude.js";
import {
  clearPersistentSession,
  getPersistentSession,
} from "../src/persistent/session-store.js";
import { sanitizeForQq } from "../src/util/output-filter.js";
import { routeSlashCommand } from "../src/commands/router.js";
import { MemoryManager, resetMemoryManagerForTests } from "../src/memory/manager.js";
import {
  CultureManager,
  resetCultureManagerForTests,
} from "../src/culture/manager.js";
import { MemoryStore } from "../src/memory/store.js";

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbridge-persona-"));
}

describe("Persona loader", () => {
  let prevData: string | undefined;
  let prevPersona: string | undefined;
  let dataDir: string;

  beforeEach(() => {
    prevData = process.env.QQBRIDGE_DATA_DIR;
    prevPersona = process.env.QQBRIDGE_PERSONA_PATH;
    dataDir = tempDataDir();
    process.env.QQBRIDGE_DATA_DIR = dataDir;
    delete process.env.QQBRIDGE_PERSONA_PATH;
  });

  afterEach(() => {
    if (prevData === undefined) delete process.env.QQBRIDGE_DATA_DIR;
    else process.env.QQBRIDGE_DATA_DIR = prevData;
    if (prevPersona === undefined) delete process.env.QQBRIDGE_PERSONA_PATH;
    else process.env.QQBRIDGE_PERSONA_PATH = prevPersona;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates default persona.md and loads it", () => {
    const p = ensurePersonaFile();
    assert.equal(fs.existsSync(p), true);
    const loaded = loadPersona();
    assert.equal(loaded.source, "file");
    assert.equal(normalizePersonaText(loaded.text), normalizePersonaText(DEFAULT_PERSONA_TEXT));
    assert.equal(loaded.hash, hashPersonaText(DEFAULT_PERSONA_TEXT));
    assert.match(fs.readFileSync(loaded.systemPromptFile, "utf8"), /--- Persona ---/);
    assert.ok(fs.readFileSync(loaded.systemPromptFile, "utf8").includes(PERSONA_SYSTEM_FRAMING.slice(0, 40)));
  });

  it("loads a custom UTF-8 persona file", () => {
    const custom = path.join(dataDir, "persona.md");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(custom, "轻松一点，像朋友聊天。\n多用口语。\n", "utf8");
    const loaded = loadPersona();
    assert.equal(loaded.source, "file");
    assert.match(loaded.text, /轻松一点/);
    assert.equal(loaded.hash, hashPersonaText("轻松一点，像朋友聊天。\n多用口语。"));
  });

  it("falls back when persona file is empty", () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "persona.md"), "   \n\t\n", "utf8");
    const loaded = loadPersona();
    assert.equal(loaded.source, "fallback-empty");
    assert.equal(loaded.hash, hashPersonaText(DEFAULT_PERSONA_TEXT));
  });

  it("falls back when persona path is unreadable / missing after delete", () => {
    process.env.QQBRIDGE_PERSONA_PATH = path.join(dataDir, "nope", "missing.md");
    const loaded = loadPersona();
    assert.ok(
      loaded.source === "default-created" || loaded.source === "fallback-missing",
    );
    assert.equal(loaded.hash, hashPersonaText(DEFAULT_PERSONA_TEXT));
  });

  it("truncates oversized persona safely", () => {
    const huge = "x".repeat(PERSONA_MAX_CHARS + 500);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "persona.md"), huge, "utf8");
    const loaded = loadPersona();
    assert.equal(loaded.source, "fallback-truncated");
    assert.equal(loaded.text.length, PERSONA_MAX_CHARS);
  });

  it("claudePersonaSystemArgs points at composed system-prompt-file", () => {
    const loaded = loadPersona();
    const args = claudePersonaSystemArgs(loaded);
    assert.deepEqual(args, ["--system-prompt-file", loaded.systemPromptFile]);
  });

  it("composes Persona as its own section; optional memory appends without rewriting Persona", () => {
    const persona = "be casual";
    const personaOnly = composeClaudeSystemPrompt({ personaBody: persona });
    assert.equal(personaOnly, buildPersonaSystemSection(persona));
    assert.match(personaOnly, /--- Persona ---/);
    assert.equal(personaOnly.includes("be casual"), true);

    const withMemory = composeClaudeSystemPrompt({
      personaBody: persona,
      memorySection: "--- Memory ---\nUser likes tea.\n",
    });
    assert.ok(withMemory.startsWith(buildPersonaSystemSection(persona).trimEnd()));
    assert.match(withMemory, /--- Memory ---/);
    assert.equal(withMemory.indexOf("be casual") < withMemory.indexOf("User likes tea"), true);
    // Persona body appears once (not duplicated when memory is added).
    assert.equal(withMemory.split("be casual").length - 1, 1);
  });
});

function fakeClaudeProcess(
  script: (stdinLine: string, write: (obj: unknown) => void) => void,
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const ee = new EventEmitter();
  let buf = "";
  stdin.on("data", (chunk: Buffer | string) => {
    buf += String(chunk);
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      script(line, (obj) => {
        stdout.write(JSON.stringify(obj) + "\n");
      });
    }
  });
  return {
    stdin,
    stdout,
    stderr,
    pid: 9001,
    killed: false,
    kill: () => {
      ee.emit("exit", 0, null);
      return true;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => ee.on(event, listener),
    once: (event: string, listener: (...args: unknown[]) => void) => ee.once(event, listener),
  };
}

describe("Persona applied to Claude stream sessions", () => {
  let prevData: string | undefined;
  let dataDir: string;

  beforeEach(() => {
    prevData = process.env.QQBRIDGE_DATA_DIR;
    dataDir = tempDataDir();
    process.env.QQBRIDGE_DATA_DIR = dataDir;
    delete process.env.QQBRIDGE_PERSONA_PATH;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "persona.md"), "be casual and brief\n", "utf8");
    // Keep Memory/Culture off-disk so temp QQBRIDGE_DATA_DIR can be deleted on Windows.
    resetMemoryManagerForTests(
      new MemoryManager({
        store: new MemoryStore({ dbPath: ":memory:" }),
        config: { enabled: true, maintenanceIdleMs: 60_000 },
      }),
    );
    resetCultureManagerForTests(
      new CultureManager({ dbPath: ":memory:", skipSeed: true, config: { enabled: true } }),
    );
  });

  afterEach(() => {
    resetMemoryManagerForTests(undefined);
    resetCultureManagerForTests(undefined);
    if (prevData === undefined) delete process.env.QQBRIDGE_DATA_DIR;
    else process.env.QQBRIDGE_DATA_DIR = prevData;
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows may briefly lock emptied temp dirs.
    }
  });

  it("injects --system-prompt-file at start, not into each user prompt", async () => {
    const persona = loadPersona();
    const stdinLines: string[] = [];
    const client = new ClaudeStreamClient({
      command: "claude",
      cwd: process.cwd(),
      spawnProcess: async () =>
        fakeClaudeProcess((line, write) => {
          stdinLines.push(line);
          write({ type: "system", subtype: "init", session_id: "sess-p1" });
          write({
            type: "assistant",
            session_id: "sess-p1",
            message: { role: "assistant", content: [{ type: "text", text: "hey" }] },
          });
          write({ type: "result", session_id: "sess-p1", result: "hey" });
        }),
    });

    await client.start({ systemPromptFile: persona.systemPromptFile });
    assert.ok(client.lastStartArgs.includes("--system-prompt-file"));
    assert.ok(client.lastStartArgs.includes(persona.systemPromptFile));
    assert.ok(client.lastStartArgs.includes("--tools"));
    assert.ok(client.lastStartArgs.includes("--restricted"));

    await client.prompt("你好呀");
    await client.prompt("再来一句");
    assert.equal(stdinLines.length, 2);
    for (const line of stdinLines) {
      const msg = JSON.parse(line) as { message?: { content?: string } };
      const content = msg.message?.content ?? line;
      assert.equal(content.includes("be casual"), false);
      assert.equal(content.includes("--- Persona ---"), false);
      assert.equal(content.includes(PERSONA_SYSTEM_FRAMING.slice(0, 20)), false);
    }
    await client.stop();
  });

  it("forks on persona change while preserving resume session id", async () => {
    clearPersistentSession("claude-stream", "conv-persona");
    const startArgsHistory: string[][] = [];

    const adapter = new ClaudeStreamAdapter({
      command: "claude",
      extraArgs: [],
      clientFactory: (opts) => {
        const client = new ClaudeStreamClient({
          ...opts,
          spawnProcess: async () => fakeClaudeProcess(() => undefined),
        });
        const origStart = client.start.bind(client);
        client.start = async (startOpts) => {
          const fakeSid = startOpts.forkSession
            ? "sess-forked"
            : startOpts.resume ?? "sess-new";
          (
            client as unknown as {
              options: { spawnProcess?: () => ReturnType<typeof fakeClaudeProcess> };
            }
          ).options.spawnProcess = async () =>
            fakeClaudeProcess((_line, write) => {
              write({ type: "system", subtype: "init", session_id: fakeSid });
              write({
                type: "assistant",
                session_id: fakeSid,
                message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
              });
              write({ type: "result", session_id: fakeSid, result: "ok" });
            });
          const result = await origStart(startOpts);
          startArgsHistory.push([...client.lastStartArgs]);
          return result;
        };
        return client;
      },
    });

    try {
      await adapter.start({ cwd: path.join(dataDir, "chat-runtime") });
      const r1 = await adapter.sendAndCollect("hi", "x", undefined, {
        conversationId: "conv-persona",
      });
      assert.equal(r1, "ok");
      assert.ok(startArgsHistory.length >= 1);
      const first = startArgsHistory[0]!;
      assert.ok(first.includes("--system-prompt-file"));
      assert.equal(first.includes("--fork-session"), false);

      const stored = getPersistentSession("claude-stream", "conv-persona");
      assert.ok(stored?.personaHash);
      const hash1 = stored!.personaHash!;

      fs.writeFileSync(path.join(dataDir, "persona.md"), "new vibe: witty\n", "utf8");
      const r2 = await adapter.sendAndCollect("again", "x", undefined, {
        conversationId: "conv-persona",
      });
      assert.equal(r2, "ok");
      assert.ok(startArgsHistory.length >= 2);
      const last = startArgsHistory[startArgsHistory.length - 1]!;
      assert.ok(last.includes("--resume"));
      assert.ok(last.includes("--fork-session"));
      assert.ok(last.includes("--system-prompt-file"));

      const stored2 = getPersistentSession("claude-stream", "conv-persona");
      assert.ok(stored2?.personaHash);
      assert.notEqual(stored2!.personaHash, hash1);
      assert.equal(stored2!.sessionId, "sess-forked");
    } finally {
      await adapter.stop();
      clearPersistentSession("claude-stream", "conv-persona");
    }
  });

  it("reuses process across turns without re-spawning (session continuity)", async () => {
    let spawnCount = 0;
    const client = new ClaudeStreamClient({
      command: "claude",
      cwd: process.cwd(),
      spawnProcess: async () => {
        spawnCount++;
        return fakeClaudeProcess((_line, write) => {
          write({ type: "system", subtype: "init", session_id: "sess-cont" });
          write({
            type: "assistant",
            session_id: "sess-cont",
            message: { role: "assistant", content: [{ type: "text", text: "yo" }] },
          });
          write({ type: "result", session_id: "sess-cont", result: "yo" });
        });
      },
    });
    const persona = loadPersona();
    await client.start({ systemPromptFile: persona.systemPromptFile });
    await client.prompt("a");
    await client.prompt("b");
    await client.prompt("c");
    assert.equal(spawnCount, 1);
    await client.stop();
  });
});

describe("Persona + Chat-only security", () => {
  let prevData: string | undefined;
  let dataDir: string;

  beforeEach(() => {
    prevData = process.env.QQBRIDGE_DATA_DIR;
    dataDir = tempDataDir();
    process.env.QQBRIDGE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (prevData === undefined) delete process.env.QQBRIDGE_DATA_DIR;
    else process.env.QQBRIDGE_DATA_DIR = prevData;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("oneshot bootstrap includes persona + chat-only; resume does not duplicate persona", () => {
    ensurePersonaFile();
    const adapter = createClaudeAdapter("claude", []);
    const boot = adapter.buildBootstrapArgvForTests();
    assert.ok(boot.includes("--system-prompt-file"));
    assert.ok(boot.includes("--tools"));
    assert.equal(boot[boot.indexOf("--tools")! + 1], "");
    assert.ok(boot.includes("--restricted"));

    const resume = adapter.buildResumeArgvForTests("hello", "sess-1");
    assert.equal(resume.includes("--system-prompt-file"), false);
    assert.ok(resume.includes("--tools"));
    assert.equal(resume[resume.indexOf("--tools")! + 1], "");
    assert.ok(resume.includes("--restricted"));
    assert.ok(resume.includes("--strict-mcp-config"));
  });

  it("filters Persona dumps from QQ replies", () => {
    const leaked = "Sure. --- Persona ---\nbe casual\n";
    assert.match(sanitizeForQq(leaked), /过滤/);
  });

  it("/persona never returns Persona body", async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "persona.md"), "SECRET_PERSONA_MARKER_XYZ\n", "utf8");
    const result = await routeSlashCommand("/persona", {
      conversationId: "c1",
      senderId: "u1",
    });
    assert.equal(result.handled, true);
    assert.ok(result.reply);
    assert.equal(result.reply!.includes("SECRET_PERSONA_MARKER_XYZ"), false);
    assert.match(result.reply!, /persona\.md/i);
  });
});

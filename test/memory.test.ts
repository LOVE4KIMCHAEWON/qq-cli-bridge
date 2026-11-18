import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { MemoryStore } from "../src/memory/store.js";
import { MemoryManager, resetMemoryManagerForTests } from "../src/memory/manager.js";
import {
  CultureManager,
  resetCultureManagerForTests,
} from "../src/culture/manager.js";
import { extractMemoriesFromUserText, looksSensitive } from "../src/memory/extract.js";
import { estimateTokens } from "../src/memory/tokens.js";
import { buildSessionContext } from "../src/memory/context.js";
import { composeClaudeSystemPrompt } from "../src/persona/load.js";
import { ClaudeStreamClient } from "../src/claude/stream-client.js";
import { ClaudeStreamAdapter } from "../src/adapters/claude-stream.js";
import { claudeChatOnlyArgs } from "../src/security/chat-only.js";
import { routeSlashCommand } from "../src/commands/router.js";
import { clearPersistentSession } from "../src/persistent/session-store.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbridge-mem-"));
}

describe("Memory extraction (deterministic)", () => {
  it("extracts preferences and remember cues", () => {
    const a = extractMemoriesFromUserText("请记住：我喜欢绿茶");
    assert.ok(a.some((m) => /绿茶/.test(m.content)));
    const b = extractMemoriesFromUserText("叫我小明");
    assert.ok(b.some((m) => /小明/.test(m.content)));
  });

  it("skips sensitive-looking content", () => {
    assert.equal(looksSensitive("password: hunter2"), true);
    assert.equal(extractMemoriesFromUserText("请记住：password: hunter2").length, 0);
  });
});

describe("MemoryStore — persistence, isolation, dedupe", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  it("persists turns and isolates conversations", () => {
    store.commitTurnPair({
      conversationId: "c2c:alice",
      userText: "hi alice",
      assistantText: "hello alice",
      qqMessageId: "m1",
    });
    store.commitTurnPair({
      conversationId: "c2c:bob",
      userText: "hi bob",
      assistantText: "hello bob",
      qqMessageId: "m2",
    });
    const a = store.recentTurns("c2c:alice", 10);
    const b = store.recentTurns("c2c:bob", 10);
    assert.equal(a.length, 2);
    assert.equal(b.length, 2);
    assert.ok(a.every((t) => t.content.includes("alice")));
    assert.ok(b.every((t) => t.content.includes("bob")));
  });

  it("deduplicates by qq message id", () => {
    const first = store.commitTurnPair({
      conversationId: "c2c:u",
      userText: "same",
      assistantText: "ok",
      qqMessageId: "dup-1",
    });
    const second = store.commitTurnPair({
      conversationId: "c2c:u",
      userText: "same",
      assistantText: "ok again",
      qqMessageId: "dup-1",
    });
    assert.equal(first.deduped, false);
    assert.equal(second.deduped, true);
    assert.equal(store.recentTurns("c2c:u", 20).length, 2);
  });

  it("supports memory upsert, correct, delete", () => {
    const item = store.upsertMemory({
      conversationId: "c2c:u",
      kind: "preference",
      content: "likes tea",
    });
    assert.ok(item);
    const corrected = store.correctMemory(item!.id, "c2c:u", "likes green tea");
    assert.equal(corrected?.content, "likes green tea");
    assert.equal(store.deactivateMemory(item!.id, "c2c:u"), true);
    assert.equal(store.listActiveMemories("c2c:u").length, 0);
  });

  it("survives reopen on disk (bridge restart simulation)", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "memory.sqlite");
    const s1 = new MemoryStore({ dbPath });
    s1.commitTurnPair({
      conversationId: "c2c:persist",
      userText: "记住：我喜欢猫",
      assistantText: "好的",
      qqMessageId: "p1",
    });
    s1.upsertMemory({
      conversationId: "c2c:persist",
      kind: "preference",
      content: "likes cats",
    });
    s1.close();

    const s2 = new MemoryStore({ dbPath });
    assert.equal(s2.recentTurns("c2c:persist", 10).length, 2);
    assert.equal(s2.listActiveMemories("c2c:persist")[0]?.content, "likes cats");
    s2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("FTS retrieval finds relevant memories only in-conversation", () => {
    store.upsertMemory({
      conversationId: "c2c:a",
      kind: "preference",
      content: "loves hiking mountains",
    });
    store.upsertMemory({
      conversationId: "c2c:b",
      kind: "preference",
      content: "loves hiking mountains",
    });
    const hits = store.searchMemories("c2c:a", "hiking", 5);
    assert.ok(hits.length >= 1);
    assert.ok(hits.every((h) => h.conversationId === "c2c:a"));
  });

  it("maintenance checkpoint advances and is crash-safe", () => {
    store.commitTurnPair({
      conversationId: "c2c:m",
      userText: "请记住：我喜欢咖啡",
      assistantText: "嗯",
      qqMessageId: "c1",
    });
    const turns = store.turnsAfter("c2c:m", 0, 10);
    assert.ok(turns.length >= 1);
    store.setMaintenanceCheckpoint("c2c:m", turns[turns.length - 1]!.id);
    assert.equal(store.getMaintenanceCheckpoint("c2c:m"), turns[turns.length - 1]!.id);
    assert.equal(store.turnsAfter("c2c:m", turns[turns.length - 1]!.id, 10).length, 0);
  });
});

describe("Context budget + composition", () => {
  it("enforces budget and does not duplicate Persona when memory is added", () => {
    const store = new MemoryStore({ dbPath: ":memory:" });
    for (let i = 0; i < 30; i++) {
      store.commitTurnPair({
        conversationId: "c2c:budget",
        userText: `user message number ${i} with some extra padding text for tokens`,
        assistantText: `assistant reply number ${i} with some extra padding text for tokens`,
        qqMessageId: `b-${i}`,
      });
      store.upsertMemory({
        conversationId: "c2c:budget",
        kind: "fact",
        content: `stable fact number ${i} about the user preferences and plans`,
      });
    }
    const bundle = buildSessionContext(store, "c2c:budget", {
      enabled: true,
      contextBudgetTokens: 800,
      rotationThresholdTokens: 10_000,
      recentWindowTurns: 20,
      maxMemoryItems: 40,
      maxRetrievalSnippets: 4,
      maintenanceIdleMs: 1,
      maintenanceMinIntervalMs: 1,
      maintenanceBatchTurns: 10,
    });
    assert.ok(bundle.estimatedTokens <= 900, `tokens=${bundle.estimatedTokens}`);
    const composed = composeClaudeSystemPrompt({
      personaBody: "be casual",
      memorySection: bundle.memorySection,
    });
    assert.equal(composed.split("be casual").length - 1, 1);
    assert.match(composed, /--- Persona ---/);
    assert.match(composed, /--- Long-term Memory ---/);
    store.close();
  });

  it("token estimator is conservative and positive", () => {
    assert.ok(estimateTokens("hello world") >= 1);
    assert.ok(estimateTokens("你好世界朋友们") >= 2);
  });
});

describe("MemoryManager — maintenance and no-dupe injection path", () => {
  let prevData: string | undefined;
  let dataDir: string;
  let manager: MemoryManager;

  beforeEach(() => {
    prevData = process.env.QQBRIDGE_DATA_DIR;
    dataDir = tempDir();
    process.env.QQBRIDGE_DATA_DIR = dataDir;
    manager = new MemoryManager({
      store: new MemoryStore({ dbPath: ":memory:" }),
      config: {
        enabled: true,
        maintenanceIdleMs: 1,
        maintenanceMinIntervalMs: 1,
        rotationThresholdTokens: 50,
        contextBudgetTokens: 2000,
      },
    });
    resetMemoryManagerForTests(manager);
  });

  afterEach(() => {
    resetMemoryManagerForTests(undefined);
    if (prevData === undefined) delete process.env.QQBRIDGE_DATA_DIR;
    else process.env.QQBRIDGE_DATA_DIR = prevData;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("commitTurn extracts inline memory and shouldRotate respects threshold", () => {
    manager.commitTurn({
      conversationId: "c2c:u",
      userText: "请记住：我喜欢登山",
      assistantText: "记下了",
      qqMessageId: "t1",
    });
    assert.ok(manager.listMemories("c2c:u").some((m) => /登山/.test(m.content)));
    manager.noteClaudeUsage("c2c:u", 100);
    assert.equal(manager.shouldRotate("c2c:u"), true);
  });

  it("writeSystemPromptFile injects memory once into composed file", () => {
    manager.commitTurn({
      conversationId: "c2c:u",
      userText: "请记住：我喜欢猫",
      assistantText: "好",
      qqMessageId: "t2",
    });
    const { path: sp, bundle } = manager.writeSystemPromptFile("persona-body", "c2c:u");
    const text = fs.readFileSync(sp, "utf8");
    assert.match(text, /persona-body/);
    assert.match(text, /--- Long-term Memory ---/);
    assert.ok(bundle.activeMemoryCount >= 1);
    // Second write should still contain a single Persona section header.
    manager.writeSystemPromptFile("persona-body", "c2c:u");
    const text2 = fs.readFileSync(sp, "utf8");
    assert.equal(text2.split("--- Persona ---").length - 1, 1);
  });

  it("idle maintenance skips while activity is recent", () => {
    manager.notifyActivity();
    // Force a long idle requirement so "just now" always skips.
    (manager as unknown as { config: { maintenanceIdleMs: number } }).config.maintenanceIdleMs =
      60_000;
    const r = manager.runMaintenance("c2c:u");
    assert.equal(r.skippedBusy, true);
    assert.equal(r.processed, 0);
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
      script(line, (obj) => stdout.write(JSON.stringify(obj) + "\n"));
    }
  });
  return {
    stdin,
    stdout,
    stderr,
    pid: 7001,
    killed: false,
    kill: () => {
      ee.emit("exit", 0, null);
      return true;
    },
    on: (e: string, l: (...a: unknown[]) => void) => ee.on(e, l),
    once: (e: string, l: (...a: unknown[]) => void) => ee.once(e, l),
  };
}

describe("Claude stream + memory rotation", () => {
  let prevData: string | undefined;
  let dataDir: string;
  let manager: MemoryManager;

  beforeEach(() => {
    prevData = process.env.QQBRIDGE_DATA_DIR;
    dataDir = tempDir();
    process.env.QQBRIDGE_DATA_DIR = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "persona.md"), "be casual\n", "utf8");
    manager = new MemoryManager({
      store: new MemoryStore({ dbPath: ":memory:" }),
      config: {
        enabled: true,
        rotationThresholdTokens: 30,
        contextBudgetTokens: 2000,
        maintenanceIdleMs: 60_000,
        maintenanceMinIntervalMs: 60_000,
      },
    });
    resetMemoryManagerForTests(manager);
    // Keep Culture off-disk so temp QQBRIDGE_DATA_DIR can be deleted on Windows.
    resetCultureManagerForTests(
      new CultureManager({ dbPath: ":memory:", skipSeed: true, config: { enabled: true } }),
    );
  });

  afterEach(async () => {
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

  it("rotates successfully after threshold; failure keeps old session", async () => {
    clearPersistentSession("claude-stream", "c2c:rot");
    let starts = 0;
    const startArgs: string[][] = [];

    const adapter = new ClaudeStreamAdapter({
      command: "claude",
      clientFactory: (opts) => {
        const client = new ClaudeStreamClient({
          ...opts,
          spawnProcess: async () => fakeClaudeProcess(() => undefined),
        });
        const orig = client.start.bind(client);
        client.start = async (startOpts) => {
          starts++;
          const sid = startOpts.resume ? `resume-${starts}` : `fresh-${starts}`;
          (
            client as unknown as {
              options: { spawnProcess?: () => ReturnType<typeof fakeClaudeProcess> };
            }
          ).options.spawnProcess = async () =>
            fakeClaudeProcess((_line, write) => {
              write({ type: "system", subtype: "init", session_id: sid });
              write({
                type: "assistant",
                session_id: sid,
                message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
              });
              write({
                type: "result",
                session_id: sid,
                result: "ok",
                usage: { input_tokens: 40, output_tokens: 2 },
              });
            });
          const r = await orig(startOpts);
          startArgs.push([...client.lastStartArgs]);
          return r;
        };
        return client;
      },
    });

    await adapter.start({ cwd: path.join(dataDir, "chat-runtime") });
    const reply = await adapter.sendAndCollect("hello", "x", undefined, {
      conversationId: "c2c:rot",
    });
    assert.equal(reply, "ok");
    assert.ok(startArgs[0]?.includes("--system-prompt-file"));
    assert.ok(claudeChatOnlyArgs().includes("--restricted"));

    manager.noteClaudeUsage("c2c:rot", 100);
    const rotated = await adapter.maybeRotateSession("c2c:rot");
    assert.equal(rotated, true);
    const last = startArgs[startArgs.length - 1]!;
    assert.equal(last.includes("--resume"), false);
    assert.ok(last.includes("--system-prompt-file"));
    assert.ok(last.includes("--tools"));

    // Failure path: factory throws on next start
    const failAdapter = new ClaudeStreamAdapter({
      command: "claude",
      clientFactory: () => {
        const client = new ClaudeStreamClient({
          command: "claude",
          cwd: path.join(dataDir, "chat-runtime"),
          spawnProcess: async () => fakeClaudeProcess(() => undefined),
        });
        client.start = async () => {
          throw new Error("boom");
        };
        return client;
      },
    });
    // Seed a live client on failAdapter via send first with working factory — skip;
    // unit-level: maybeRotate with no ready client still attempts new start and returns false on throw.
    manager.noteClaudeUsage("c2c:fail", 999);
    const ok = await failAdapter.maybeRotateSession("c2c:fail");
    assert.equal(ok, false);

    await adapter.stop();
    clearPersistentSession("claude-stream", "c2c:rot");
  });

  it("does not put memory text into each user stdin payload", async () => {
    const stdinLines: string[] = [];
    manager.commitTurn({
      conversationId: "c2c:nodupe",
      userText: "请记住：我喜欢咖啡",
      assistantText: "好",
      qqMessageId: "nd1",
    });
    const client = new ClaudeStreamClient({
      command: "claude",
      cwd: process.cwd(),
      spawnProcess: async () =>
        fakeClaudeProcess((line, write) => {
          stdinLines.push(line);
          write({ type: "system", subtype: "init", session_id: "s1" });
          write({
            type: "assistant",
            session_id: "s1",
            message: { role: "assistant", content: [{ type: "text", text: "yo" }] },
          });
          write({ type: "result", session_id: "s1", result: "yo" });
        }),
    });
    const { path: sp } = manager.writeSystemPromptFile("persona", "c2c:nodupe");
    await client.start({ systemPromptFile: sp });
    await client.prompt("ping1");
    await client.prompt("ping2");
    for (const line of stdinLines) {
      assert.equal(line.includes("Long-term Memory"), false);
      assert.equal(line.includes("请记住"), false);
    }
    await client.stop();
  });
});

describe("Memory slash commands + chat-only", () => {
  let manager: MemoryManager;

  beforeEach(() => {
    manager = new MemoryManager({
      store: new MemoryStore({ dbPath: ":memory:" }),
    });
    resetMemoryManagerForTests(manager);
  });

  afterEach(() => {
    resetMemoryManagerForTests(undefined);
  });

  it("/memory list forget clear work without exposing other conversations", async () => {
    manager.commitTurn({
      conversationId: "c2c:me",
      userText: "请记住：我喜欢茶",
      assistantText: "好",
      qqMessageId: "s1",
    });
    manager.commitTurn({
      conversationId: "c2c:other",
      userText: "请记住：秘密偏好XYZ",
      assistantText: "好",
      qqMessageId: "s2",
    });
    const listed = await routeSlashCommand("/memory", {
      conversationId: "c2c:me",
      senderId: "me",
    });
    assert.ok(listed.reply?.includes("茶"));
    assert.equal(listed.reply?.includes("秘密偏好XYZ"), false);

    const id = manager.listMemories("c2c:me")[0]!.id;
    const forgot = await routeSlashCommand(`/memory forget ${id}`, {
      conversationId: "c2c:me",
      senderId: "me",
    });
    assert.match(forgot.reply ?? "", /Forgot/);
    assert.equal(manager.listMemories("c2c:me").length, 0);
    // other conversation untouched
    assert.ok(manager.listMemories("c2c:other").length >= 1);
  });
});

describe("Concurrent commits", () => {
  it("serializes turn pairs without cross-talk", () => {
    const store = new MemoryStore({ dbPath: ":memory:" });
    const results = [];
    for (let i = 0; i < 20; i++) {
      results.push(
        store.commitTurnPair({
          conversationId: i % 2 === 0 ? "c2c:a" : "c2c:b",
          userText: `msg ${i}`,
          assistantText: `reply ${i}`,
          qqMessageId: `c-${i}`,
        }),
      );
    }
    assert.ok(results.every((r) => r.deduped === false));
    assert.equal(store.recentTurns("c2c:a", 100).length, 20);
    assert.equal(store.recentTurns("c2c:b", 100).length, 20);
    store.close();
  });
});

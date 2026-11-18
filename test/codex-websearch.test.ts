import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { assembleBridgeContext } from "../src/context/assemble.js";
import {
  PERSONA_SYSTEM_FRAMING_CLAUDE,
  PERSONA_SYSTEM_FRAMING_CODEX_RESTRICTED,
} from "../src/persona/default.js";
import {
  applyCodexWebSearchHonesty,
  classifyForbiddenCodexItem,
  isHostedWebSearchItem,
  CodexAppServerClient,
} from "../src/codex/app-server-client.js";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
import {
  assertCodexRestrictedReadyForQq,
  ensureCodexQqHome,
  CODEX_RESTRICTED_POLICY_VERSION,
  verifyCodexRestrictedExecution,
} from "../src/security/codex-restricted.js";
import { MemoryManager, resetMemoryManagerForTests } from "../src/memory/manager.js";
import {
  CultureManager,
  resetCultureManagerForTests,
} from "../src/culture/manager.js";
import { MemoryStore } from "../src/memory/store.js";

describe("Codex capability framing vs Claude", () => {
  it("Claude framing forbids local tools but acknowledges Bridge media", () => {
    const a = assembleBridgeContext({
      personaBody: "Be casual",
      capabilityProfile: "claude-chat",
    });
    assert.match(a.fullText, /No local tools/i);
    assert.match(a.fullText, /Bridge can search(?: and send)?(?: existing)? openly licensed images/i);
    assert.doesNotMatch(a.fullText, /Hosted web search \(web_search \/ live\): yes/i);
    assert.ok(a.fullText.includes(PERSONA_SYSTEM_FRAMING_CLAUDE.slice(0, 40)));
  });

  it("Codex restricted framing permits hosted web_search and Bridge media", () => {
    const a = assembleBridgeContext({
      personaBody: "Be casual",
      capabilityProfile: "codex-restricted",
    });
    assert.match(a.fullText, /Hosted web search/i);
    assert.match(a.fullText, /web_search/i);
    assert.match(a.fullText, /forbidden/i);
    assert.match(a.fullText, /Bridge can search(?: and send)?(?: existing)? openly licensed images/i);
    assert.doesNotMatch(a.fullText, /Chat-only mode\.\nCapabilities: text chat only\. No tools/i);
    assert.ok(
      a.fullText.includes(PERSONA_SYSTEM_FRAMING_CODEX_RESTRICTED.slice(0, 40)),
    );
    // Must not carry the old absolute Claude claim.
    assert.doesNotMatch(a.fullText, /No tools, no web browsing\/search/i);
  });
});

describe("Codex forbidden-item monitor", () => {
  it("allows hosted web_search variants", () => {
    assert.equal(isHostedWebSearchItem({ type: "web_search" }), true);
    assert.equal(isHostedWebSearchItem({ type: "webSearch" }), true);
    assert.equal(isHostedWebSearchItem({ type: "web_search_call" }), true);
    assert.equal(classifyForbiddenCodexItem({ type: "web_search" }), null);
    assert.equal(classifyForbiddenCodexItem({ type: "agentMessage", text: "hi" }), null);
  });

  it("denies shell/mcp/filesystem-style items", () => {
    assert.equal(classifyForbiddenCodexItem({ type: "command" }), "command");
    assert.equal(classifyForbiddenCodexItem({ type: "mcpToolCall" }), "mcpToolCall");
    assert.equal(classifyForbiddenCodexItem({ type: "fileChange" }), "fileChange");
    assert.equal(classifyForbiddenCodexItem({ type: "shell" }), "shell");
  });
});

describe("Codex App Server — web_search permitted, command denied", () => {
  function fakeServer(mode: "search" | "command") {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const ee = new EventEmitter();
    let buf = "";
    const write = (obj: unknown) => stdout.write(JSON.stringify(obj) + "\n");
    stdin.on("data", (chunk: Buffer | string) => {
      buf += String(chunk);
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (msg.method === "initialize") {
          write({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
        } else if (msg.method === "thread/start") {
          const cfg = msg.params?.config as { web_search?: string } | undefined;
          assert.equal(cfg?.web_search, "live");
          const di = String(msg.params?.developerInstructions ?? "");
          if (di) {
            assert.match(di, /Hosted web search/i);
            assert.doesNotMatch(di, /No tools, no web browsing\/search/i);
          }
          write({
            jsonrpc: "2.0",
            id: msg.id,
            result: { thread: { id: "t-ws" } },
          });
        } else if (msg.method === "turn/start") {
          write({
            jsonrpc: "2.0",
            id: msg.id,
            result: { turn: { id: "turn-1", status: "inProgress" } },
          });
          if (mode === "search") {
            write({
              jsonrpc: "2.0",
              method: "item/completed",
              params: {
                item: {
                  type: "web_search",
                  query: "capital of France",
                  action: { type: "search", query: "capital of France" },
                },
              },
            });
            write({
              jsonrpc: "2.0",
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  text: "Paris",
                  phase: "final_answer",
                },
              },
            });
          } else {
            write({
              jsonrpc: "2.0",
              method: "item/completed",
              params: { item: { type: "command", command: "dir" } },
            });
          }
          write({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: { turn: { id: "turn-1", status: "completed" } },
          });
        }
      }
    });
    return {
      stdin,
      stdout,
      stderr,
      pid: 4242,
      killed: false,
      kill: () => {
        ee.emit("exit", 0, null);
        return true;
      },
      on: (e: string, l: (...a: unknown[]) => void) => ee.on(e, l),
      once: (e: string, l: (...a: unknown[]) => void) => ee.once(e, l),
    };
  }

  it("permits web_search and records webSearchCompleted", async () => {
    const client = new CodexAppServerClient({
      command: "codex",
      cwd: process.cwd(),
      restricted: true,
      developerInstructions: assembleBridgeContext({
        personaBody: "casual",
        capabilityProfile: "codex-restricted",
      }).fullText,
      spawnProcess: async () => fakeServer("search"),
    });
    await client.start();
    const { threadId } = await client.threadStart({});
    const result = await client.turnStart(threadId, "Capital of France?");
    assert.equal(result.text, "Paris");
    assert.equal(result.webSearchCompleted, true);
    await client.stop();
  });

  it("fails closed on local command tool items", async () => {
    const client = new CodexAppServerClient({
      command: "codex",
      cwd: process.cwd(),
      restricted: true,
      spawnProcess: async () => fakeServer("command"),
    });
    await client.start();
    const { threadId } = await client.threadStart({});
    await assert.rejects(
      () => client.turnStart(threadId, "list files"),
      /blocked local tool activity \(command\)/i,
    );
    await client.stop();
  });

  it("rewrites false search-success claims when no web_search completed", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const ee = new EventEmitter();
    let buf = "";
    const write = (obj: unknown) => stdout.write(JSON.stringify(obj) + "\n");
    stdin.on("data", (chunk: Buffer | string) => {
      buf += String(chunk);
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as {
          id?: number;
          method?: string;
        };
        if (msg.method === "initialize") {
          write({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
        } else if (msg.method === "thread/start") {
          write({
            jsonrpc: "2.0",
            id: msg.id,
            result: { thread: { id: "t-lie" } },
          });
        } else if (msg.method === "turn/start") {
          write({
            jsonrpc: "2.0",
            id: msg.id,
            result: { turn: { id: "turn-lie", status: "inProgress" } },
          });
          write({
            jsonrpc: "2.0",
            method: "item/completed",
            params: {
              item: {
                type: "agentMessage",
                text: "I searched and found that Robert Pattinson is confirmed as the next 007.",
                phase: "final_answer",
              },
            },
          });
          write({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: { turn: { id: "turn-lie", status: "completed" } },
          });
        }
      }
    });
    const client = new CodexAppServerClient({
      command: "codex",
      cwd: process.cwd(),
      restricted: true,
      spawnProcess: async () => ({
        stdin,
        stdout,
        stderr,
        pid: 4243,
        killed: false,
        kill: () => {
          ee.emit("exit", 0, null);
          return true;
        },
        on: (e: string, l: (...a: unknown[]) => void) => ee.on(e, l),
        once: (e: string, l: (...a: unknown[]) => void) => ee.once(e, l),
      }),
    });
    await client.start();
    const { threadId } = await client.threadStart({});
    const result = await client.turnStart(threadId, "Who is the next 007?");
    assert.equal(result.webSearchCompleted, false);
    assert.match(result.text, /没有完成真实的网页搜索/);
    assert.doesNotMatch(result.text, /Pattinson/);
    await client.stop();
  });

  it("keeps honest search-failure admissions unchanged", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const ee = new EventEmitter();
    let buf = "";
    const write = (obj: unknown) => stdout.write(JSON.stringify(obj) + "\n");
    stdin.on("data", (chunk: Buffer | string) => {
      buf += String(chunk);
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: number; method?: string };
        if (msg.method === "initialize") {
          write({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
        } else if (msg.method === "thread/start") {
          write({
            jsonrpc: "2.0",
            id: msg.id,
            result: { thread: { id: "t-fail" } },
          });
        } else if (msg.method === "turn/start") {
          write({
            jsonrpc: "2.0",
            id: msg.id,
            result: { turn: { id: "turn-fail", status: "inProgress" } },
          });
          write({
            jsonrpc: "2.0",
            method: "item/completed",
            params: {
              item: {
                type: "agentMessage",
                text: "搜索工具不可用，没查成。",
                phase: "final_answer",
              },
            },
          });
          write({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: { turn: { id: "turn-fail", status: "completed" } },
          });
        }
      }
    });
    const client = new CodexAppServerClient({
      command: "codex",
      cwd: process.cwd(),
      restricted: true,
      spawnProcess: async () => ({
        stdin,
        stdout,
        stderr,
        pid: 4244,
        killed: false,
        kill: () => {
          ee.emit("exit", 0, null);
          return true;
        },
        on: (e: string, l: (...a: unknown[]) => void) => ee.on(e, l),
        once: (e: string, l: (...a: unknown[]) => void) => ee.once(e, l),
      }),
    });
    await client.start();
    const { threadId } = await client.threadStart({});
    const result = await client.turnStart(threadId, "查一下新闻");
    assert.equal(result.webSearchCompleted, false);
    assert.equal(result.text, "搜索工具不可用，没查成。");
    await client.stop();
  });
});

describe("Codex web_search honesty helper", () => {
  it("passes through when search completed", () => {
    assert.equal(
      applyCodexWebSearchHonesty("I searched: Paris is the capital.", true),
      "I searched: Paris is the capital.",
    );
  });

  it("replaces false success claims without a completed search", () => {
    const out = applyCodexWebSearchHonesty(
      "我查了，下一任007是帕丁森。",
      false,
    );
    assert.match(out, /没有完成真实的网页搜索/);
    assert.doesNotMatch(out, /帕丁森/);
  });

  it("leaves plain answers and honest failures alone", () => {
    assert.equal(
      applyCodexWebSearchHonesty("巴黎是法国首都。", false),
      "巴黎是法国首都。",
    );
    assert.equal(
      applyCodexWebSearchHonesty("搜索工具不可用，没查成。", false),
      "搜索工具不可用，没查成。",
    );
  });
});

describe("Codex adapter builds codex-restricted developerInstructions", () => {
  let prev: string | undefined;
  let dataDir: string;

  beforeEach(() => {
    prev = process.env.QQBRIDGE_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbridge-codex-ws-"));
    process.env.QQBRIDGE_DATA_DIR = dataDir;
    const home = ensureCodexQqHome({ model: "gpt-test" });
    fs.writeFileSync(home.authPath, "{}", "utf8");
    fs.mkdirSync(path.join(dataDir, "state"), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "state", "codex-restricted-verify.json"),
      JSON.stringify({
        ok: true,
        at: new Date().toISOString(),
        policyVersion: CODEX_RESTRICTED_POLICY_VERSION,
      }),
      "utf8",
    );
    resetMemoryManagerForTests(
      new MemoryManager({
        store: new MemoryStore({ dbPath: ":memory:" }),
        config: { enabled: true, maintenanceIdleMs: 60_000 },
      }),
    );
    resetCultureManagerForTests(
      new CultureManager({ dbPath: ":memory:", skipSeed: true }),
    );
  });

  afterEach(() => {
    resetMemoryManagerForTests(undefined);
    resetCultureManagerForTests(undefined);
    if (prev === undefined) delete process.env.QQBRIDGE_DATA_DIR;
    else process.env.QQBRIDGE_DATA_DIR = prev;
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("developerInstructions use codex-restricted profile", () => {
    assertCodexRestrictedReadyForQq();
    const adapter = new CodexAppServerAdapter({
      command: "codex",
      extraArgs: [],
    });
    const built = (
      adapter as unknown as {
        buildDeveloperInstructions: (id: string) => { text: string; capability: string };
      }
    ).buildDeveloperInstructions("c2c:test");
    assert.match(built.text, /Hosted web search/i);
    assert.doesNotMatch(built.text, /No tools, no web browsing\/search/i);
    assert.match(built.capability, /websearch/);
  });
});

describe("Codex restricted live App Server search smoke (optional)", () => {
  it("runs when QQBRIDGE_CODEX_LIVE_VERIFY=1", async () => {
    if (process.env.QQBRIDGE_CODEX_LIVE_VERIFY !== "1") return;
    // Reuse exec probe path which mirrors restricted flags + live search.
    const result = await verifyCodexRestrictedExecution({ timeoutMs: 120_000 });
    assert.equal(result.ok, true, result.errors.join("\n"));
  });
});

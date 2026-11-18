import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeCodexJsonl,
  parseCodexExecJsonl,
} from "../src/util/codex-jsonl.js";
import { createCodexAdapter } from "../src/adapters/codex.js";
import { sanitizeForQq } from "../src/util/output-filter.js";

/** Realistic Codex CLI v0.169.0 exec --json fixture (from local capture). */
const FIXTURE_SIMPLE = `
{"type":"thread.started","thread_id":"01a1e843-5390-77d1-bddb-664ba7e6a26b"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}
{"type":"turn.completed","usage":{"input_tokens":16555,"cached_input_tokens":8192,"cache_write_input_tokens":0,"output_tokens":6,"reasoning_output_tokens":0}}
`.trim();

const FIXTURE_MULTI = `
{"type":"thread.started","thread_id":"thread-multi"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"First part."}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls","exit_code":0}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Second part."}}
{"type":"turn.completed","usage":{"input_tokens":33136,"cached_input_tokens":20480,"output_tokens":165,"reasoning_output_tokens":131}}
`.trim();

const FIXTURE_TOOLS_ONLY = `
{"type":"thread.started","thread_id":"t-tools"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"echo hi"}}
{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":0}}
`.trim();

const FIXTURE_MALFORMED = `
{"type":"thread.started","thread_id":"t-bad"}
{not json
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Survived"}}
{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}
`.trim();

describe("parseCodexExecJsonl", () => {
  it("extracts a normal assistant reply and usage", () => {
    const r = parseCodexExecJsonl(FIXTURE_SIMPLE);
    assert.equal(r.text, "PONG");
    assert.equal(r.threadId, "01a1e843-5390-77d1-bddb-664ba7e6a26b");
    assert.equal(r.assistantMessageCount, 1);
    assert.equal(r.usage?.inputTokens, 16555);
    assert.equal(r.usage?.cachedInputTokens, 8192);
    assert.equal(r.usage?.outputTokens, 6);
    assert.doesNotMatch(r.text!, /thread\.started|turn\.completed|input_tokens/);
  });

  it("joins multiple agent_message items and ignores tool items", () => {
    const r = parseCodexExecJsonl(FIXTURE_MULTI);
    assert.equal(r.text, "First part.\n\nSecond part.");
    assert.equal(r.assistantMessageCount, 2);
    assert.equal(r.usage?.inputTokens, 33136);
    assert.equal(r.usage?.cachedInputTokens, 20480);
    assert.equal(r.usage?.outputTokens, 165);
    assert.equal(r.usage?.reasoningOutputTokens, 131);
    assert.doesNotMatch(r.text!, /command_execution|echo|ls/);
  });

  it("returns no text when only tool events exist", () => {
    const r = parseCodexExecJsonl(FIXTURE_TOOLS_ONLY);
    assert.equal(r.text, undefined);
    assert.equal(r.hadJsonlEvents, true);
    assert.equal(r.assistantMessageCount, 0);
  });

  it("tolerates malformed lines and still finds agent_message", () => {
    const r = parseCodexExecJsonl(FIXTURE_MALFORMED);
    assert.equal(r.text, "Survived");
    assert.ok(r.parseErrors >= 1);
  });

  it("detects Codex JSONL shape", () => {
    assert.equal(looksLikeCodexJsonl(FIXTURE_SIMPLE), true);
    assert.equal(looksLikeCodexJsonl("hello plain text"), false);
  });
});

describe("CodexAdapter extractReplyText — no raw JSON leakage", () => {
  it("returns only natural language from exec --json stdout", () => {
    const adapter = createCodexAdapter("codex", [], { skipGitRepoCheck: true });
    const text = (
      adapter as unknown as {
        extractReplyText: (o: string, e: string) => string | undefined;
      }
    ).extractReplyText(FIXTURE_MULTI, "");
    assert.equal(text, "First part.\n\nSecond part.");
    const qq = sanitizeForQq(text!);
    assert.doesNotMatch(qq, /\{"type":/);
    assert.doesNotMatch(qq, /thread\.started/);
    assert.doesNotMatch(qq, /turn\.completed/);
    assert.doesNotMatch(qq, /cached_input_tokens/);
    assert.doesNotMatch(qq, /item\.completed/);
  });

  it("does not fall back to dumping raw JSONL when agent_message is missing", () => {
    const adapter = createCodexAdapter("codex", []);
    const text = (
      adapter as unknown as {
        extractReplyText: (o: string, e: string) => string | undefined;
      }
    ).extractReplyText(FIXTURE_TOOLS_ONLY, "");
    assert.equal(text, undefined);
  });

  it("preserves skip-git argv while parsing independently", () => {
    const adapter = createCodexAdapter("codex", [], { skipGitRepoCheck: true });
    assert.ok(
      adapter.buildResumeArgvForTests("hi", "last").includes("--skip-git-repo-check"),
    );
    const text = (
      adapter as unknown as {
        extractReplyText: (o: string, e: string) => string | undefined;
      }
    ).extractReplyText(FIXTURE_SIMPLE, "");
    assert.equal(text, "PONG");
  });
});

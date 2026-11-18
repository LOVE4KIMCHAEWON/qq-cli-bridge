import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { NdjsonJsonRpcClient, JsonRpcError } from "../src/acp/jsonrpc-client.js";

describe("NdjsonJsonRpcClient framing + correlation", () => {
  it("correlates responses by id and ignores notifications for pending map", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new NdjsonJsonRpcClient(stdin, stdout, { defaultTimeoutMs: 5000 });

    const written: string[] = [];
    stdin.on("data", (b) => written.push(b.toString("utf8")));

    const p = client.request<{ ok: boolean }>("initialize", { protocolVersion: 1 });
    await new Promise((r) => setTimeout(r, 10));
    assert.match(written[0]!, /"method":"initialize"/);
    const req = JSON.parse(written[0]!.trim()) as { id: number };

    // Unrelated notification must not resolve the pending request
    stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } } },
      }) + "\n",
    );

    stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\n",
    );

    const result = await p;
    assert.deepEqual(result, { ok: true });
    client.close();
  });

  it("rejects JSON-RPC errors", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new NdjsonJsonRpcClient(stdin, stdout, { defaultTimeoutMs: 5000 });
    const written: string[] = [];
    stdin.on("data", (b) => written.push(b.toString("utf8")));

    const p = client.request("session/load", { sessionId: "x" });
    await new Promise((r) => setTimeout(r, 10));
    const req = JSON.parse(written[0]!.trim()) as { id: number };
    stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32002, message: "unknown session" },
      }) + "\n",
    );
    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof JsonRpcError);
      assert.equal(err.code, -32002);
      return true;
    });
    client.close();
  });

  it("responds to server requests (permission)", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new NdjsonJsonRpcClient(stdin, stdout, { defaultTimeoutMs: 5000 });
    const written: string[] = [];
    stdin.on("data", (b) => written.push(b.toString("utf8")));

    const note = new Promise<{ method: string; params: unknown; raw: unknown }>((resolve) => {
      client.on("notification", (method, params, raw) => {
        resolve({ method, params, raw });
      });
    });

    stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "session/request_permission",
        params: { toolCallId: "t1" },
      }) + "\n",
    );

    const n = await note;
    assert.equal(n.method, "session/request_permission");
    client.respond(99, { outcome: { outcome: "selected", optionId: "reject-once" } });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(written.some((w) => w.includes('"id":99') && w.includes("reject-once")));
    client.close();
  });

  it("times out hanging requests", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new NdjsonJsonRpcClient(stdin, stdout, { defaultTimeoutMs: 50 });
    await assert.rejects(client.request("session/prompt", { sessionId: "s" }), /timed out/);
    client.close();
  });
});

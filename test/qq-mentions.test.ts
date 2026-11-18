import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeInboundQqText,
  stripQqMentionMarkers,
} from "../src/qq/mentions.js";
import { parseSlashCommand } from "../src/commands/parse.js";

describe("QQ mention marker stripping", () => {
  it("strips hex openid and numeric mention markers", () => {
    assert.equal(
      stripQqMentionMarkers("<@0123456789ABCDEF0123456789ABCDEF> /model"),
      "/model",
    );
    assert.equal(stripQqMentionMarkers("<@!123456> hi"), "hi");
    assert.equal(stripQqMentionMarkers("/model"), "/model");
  });

  it("normalizes whitespace after markers", () => {
    assert.equal(
      normalizeInboundQqText("  <@abc> \n\t /help  "),
      "/help",
    );
    assert.equal(
      normalizeInboundQqText("<@a>   /model   composer-2.5"),
      "/model   composer-2.5",
    );
  });

  it("keeps mid-message slash text as non-commands after strip", () => {
    const text = normalizeInboundQqText(
      "<@0123456789ABCDEF0123456789ABCDEF> please use /model later",
    );
    assert.equal(text, "please use /model later");
    assert.equal(parseSlashCommand(text), undefined);
  });
});

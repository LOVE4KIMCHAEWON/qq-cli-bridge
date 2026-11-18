import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CodexAdapter, createCodexAdapter } from "../src/adapters/codex.js";
import { createAdapter } from "../src/adapters/registry.js";
import { defaultConfig } from "../src/config/store.js";

describe("CodexAdapter --skip-git-repo-check", () => {
  it("omits the flag by default (preserves prior behavior)", () => {
    const adapter = createCodexAdapter("codex", []);
    const boot = adapter.buildBootstrapArgvForTests("seed");
    assert.equal(boot.includes("--skip-git-repo-check"), false);
    assert.ok(boot.includes("exec"));
    assert.ok(boot.includes("-s"));
    assert.ok(boot.includes("read-only"));

    const resume = adapter.buildResumeArgvForTests("hi", "last");
    assert.equal(resume.includes("--skip-git-repo-check"), false);
    assert.ok(resume.includes("resume"));
  });

  it("injects --skip-git-repo-check on new exec sessions", () => {
    const adapter = createCodexAdapter("codex", [], { skipGitRepoCheck: true });
    const boot = adapter.buildBootstrapArgvForTests("seed");
    assert.ok(boot.includes("--skip-git-repo-check"));
    assert.ok(boot.includes("read-only"));
  });

  it("injects --skip-git-repo-check on exec resume (last and id)", () => {
    const adapter = createCodexAdapter("codex", [], { skipGitRepoCheck: true });
    assert.ok(adapter.buildResumeArgvForTests("hi", "last").includes("--skip-git-repo-check"));
    assert.ok(adapter.buildResumeArgvForTests("hi", "latest").includes("--skip-git-repo-check"));
    const sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const withId = adapter.buildResumeArgvForTests("hi", sid);
    assert.ok(withId.includes("--skip-git-repo-check"));
    assert.ok(withId.includes(sid));
  });

  it("keeps --model alongside --skip-git-repo-check on resume", () => {
    const adapter = createCodexAdapter("codex", [], { skipGitRepoCheck: true });
    const argv = adapter.buildResumeArgvForTests("hi", "last", "gpt-5.3-codex");
    assert.ok(argv.includes("--model"));
    assert.ok(argv.includes("gpt-5.3-codex"));
    assert.ok(argv.includes("--skip-git-repo-check"));
    assert.ok(argv.includes("read-only"));
  });

  it("preserves extraArgs before exec", () => {
    const adapter = createCodexAdapter("codex", ["--profile", "work"], {
      skipGitRepoCheck: true,
    });
    const boot = adapter.buildBootstrapArgvForTests("seed");
    assert.equal(boot[0], "--profile");
    assert.equal(boot[1], "work");
    assert.ok(boot.includes("exec"));
    assert.ok(boot.includes("--skip-git-repo-check"));
  });

  it("registry wires skipGitRepoCheck from config", () => {
    const cfg = defaultConfig();
    cfg.agents.codex.skipGitRepoCheck = true;
    const adapter = createAdapter("codex", cfg) as CodexAdapter;
    assert.ok(
      adapter.buildResumeArgvForTests("x", "last").includes("--skip-git-repo-check"),
    );
  });
});

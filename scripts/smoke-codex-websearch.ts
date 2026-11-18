/**
 * QQ-path smoke: restricted Codex App Server + developerInstructions (codex-restricted)
 * + web_search=live. Not a unit test — invoke manually after verify-codex-restricted.
 */
import { assembleBridgeContext } from "../src/context/assemble.js";
import { CodexAppServerClient } from "../src/codex/app-server-client.js";
import { ensureChatRuntimeDir } from "../src/security/chat-only.js";
import {
  assertCodexRestrictedReadyForQq,
  ensureCodexQqHome,
} from "../src/security/codex-restricted.js";

async function main(): Promise<void> {
  ensureCodexQqHome();
  const home = assertCodexRestrictedReadyForQq();
  const cwd = ensureChatRuntimeDir();
  const di = assembleBridgeContext({
    personaBody: "Be brief and factual.",
    capabilityProfile: "codex-restricted",
  }).fullText;
  if (/No tools, no web browsing\/search/i.test(di)) {
    throw new Error("SMOKE FAIL: Claude no-tools framing leaked into Codex instructions");
  }
  if (!/Hosted web search/i.test(di)) {
    throw new Error("SMOKE FAIL: missing hosted web search capability framing");
  }

  const client = new CodexAppServerClient({
    command: "codex",
    cwd,
    restricted: true,
    codexHome: home.homeDir,
    developerInstructions: di,
  });
  await client.start();
  try {
    const { threadId } = await client.threadStart({
      cwd,
      developerInstructions: di,
    });
    const r = await client.turnStart(
      threadId,
      "Use web_search. Who is the current Prime Minister of the United Kingdom? One short sentence.",
    );
    console.log("webSearchCompleted=", r.webSearchCompleted);
    console.log("text=", r.text.slice(0, 400));
    if (!r.webSearchCompleted) {
      throw new Error("SMOKE FAIL: no web_search event completed");
    }
    if (/不可用|不能搜索|没查成|search (is )?unavailable|cannot search/i.test(r.text)) {
      throw new Error("SMOKE FAIL: model claims search unavailable");
    }
    console.log("SMOKE OK");
  } finally {
    await client.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

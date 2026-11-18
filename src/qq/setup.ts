import { qrConnect } from "@tencent-connect/qqbot-connector";
import { persistQqCredentials, loadConfig, saveConfig } from "../config/store.js";
import { loadCredentials, redactCredentials } from "../security/secrets.js";
import { ensureDataDirs } from "../paths.js";
import { log } from "../util/logger.js";

export async function runSetup(options: { source?: string } = {}): Promise<void> {
  ensureDataDirs();
  console.log("QQ CLI Bridge setup");
  console.log("Scan the QR code with mobile QQ to bind the official QQ Bot credentials.");
  console.log("Credentials are stored encrypted under the project data directory.\n");

  const credentials = await qrConnect({
    source: options.source ?? "qq-cli-bridge",
  });

  if (!credentials.length) {
    throw new Error("QR connect returned no credentials");
  }

  const [{ appId, appSecret, userOpenid }] = credentials as Array<{
    appId: string;
    appSecret: string;
    userOpenid?: string;
  }>;

  persistQqCredentials(appId, appSecret, userOpenid);

  const cfg = loadConfig();
  if (userOpenid && !cfg.allowlist.users.includes(userOpenid)) {
    cfg.allowlist.users.push(userOpenid);
  }
  cfg.allowlist.c2cMode = "allowlist";
  saveConfig(cfg);

  log.info("QQ credentials saved", redactCredentials({ appId, appSecret, userOpenid }));
  console.log("\nBinding successful.");
  console.log(`AppID: ${appId}`);
  console.log(`AppSecret: [stored encrypted — not printed]`);
  if (userOpenid) {
    console.log(`Scanner openid added to allowlist: ${userOpenid}`);
  } else {
    console.log(
      "No openid returned by connector. After the first message, add the sender to allowlist with:",
    );
    console.log("  qqbridge allowlist add <openid>");
  }
  console.log("\nNext: qqbridge gemini   (or codex / claude / agent)");
}

export function printSetupStatus(): void {
  const creds = loadCredentials();
  const cfg = loadConfig();
  if (!creds) {
    console.log("QQ credentials: not configured (run qqbridge setup)");
  } else {
    console.log("QQ credentials:", redactCredentials(creds));
  }
  console.log("Allowlist users:", cfg.allowlist.users.length ? cfg.allowlist.users.join(", ") : "(empty)");
  console.log("Allowlist groups:", cfg.allowlist.groups.length ? cfg.allowlist.groups.join(", ") : "(empty)");
  console.log("C2C mode:", cfg.allowlist.c2cMode);
  console.log("Group mode:", cfg.allowlist.groupMode);
  if (cfg.allowlist.groupMode === "allowlist" && cfg.allowlist.groups.length === 0) {
    console.log(
      "Note: group @mentions stay blocked until you run: qqbridge allowlist add-group <group_openid>",
    );
    console.log("Platform: enable group @ messages in QQ Open Platform. See docs/QQ-GROUP-AT.md");
  }
  console.log("Bridge mode:", cfg.bridge.mode);
}

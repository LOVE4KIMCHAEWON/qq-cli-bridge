import crypto from "node:crypto";
import fs from "node:fs";
import { ensureDataDirs, secretsPath, dataRoot } from "../paths.js";
import type { QqCredentials } from "../types.js";

const ALGO = "aes-256-gcm";

function machineKey(): Buffer {
  const material = [
    process.env.COMPUTERNAME ?? "",
    process.env.USERNAME ?? "",
    dataRoot(),
    "qq-cli-bridge-v1",
  ].join("|");
  return crypto.createHash("sha256").update(material).digest();
}

export function saveCredentials(creds: QqCredentials): void {
  ensureDataDirs();
  const key = machineKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(creds), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };
  fs.writeFileSync(secretsPath(), JSON.stringify(payload, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function loadCredentials(): QqCredentials | undefined {
  ensureDataDirs();
  if (!fs.existsSync(secretsPath())) return undefined;
  const raw = JSON.parse(fs.readFileSync(secretsPath(), "utf8")) as {
    iv: string;
    tag: string;
    data: string;
  };
  const key = machineKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(raw.iv, "base64"));
  decipher.setAuthTag(Buffer.from(raw.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(raw.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8")) as QqCredentials;
}

export function clearCredentials(): void {
  if (fs.existsSync(secretsPath())) fs.unlinkSync(secretsPath());
}

/** Never log secrets. */
export function redactCredentials(creds: QqCredentials): { appId: string; hasSecret: boolean } {
  return { appId: creds.appId, hasSecret: Boolean(creds.appSecret) };
}

import dns from "node:dns/promises";
import net from "node:net";
import { URL } from "node:url";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
]);

/** True if IPv4/IPv6 address is loopback, private, link-local, or otherwise unsafe. */
export function isBlockedIp(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  // IPv4-mapped IPv6
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = mapped?.[1] ?? (net.isIPv4(normalized) ? normalized : null);
  if (!v4) {
    // Other IPv6: block unique-local / unspecified
    if (normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd")) {
      return true;
    }
    return false;
  }
  const parts = v4.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

export function assertPublicHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Invalid image URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) image URLs are allowed");
  }
  if (u.username || u.password) {
    throw new Error("Credentials in image URLs are not allowed");
  }
  const host = u.hostname.toLowerCase();
  if (!host || BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Blocked image host");
  }
  if (net.isIP(host) && isBlockedIp(host)) {
    throw new Error("Private or reserved IP addresses are not allowed");
  }
  return u;
}

/**
 * Resolve hostname and reject if any address is private/reserved.
 * Skips DNS when hostname is already an IP.
 */
export async function assertResolvedPublicHost(hostname: string): Promise<void> {
  const host = hostname.toLowerCase();
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error("Private or reserved IP addresses are not allowed");
    return;
  }
  let records: string[] = [];
  try {
    const result = await dns.lookup(host, { all: true, verbatim: true });
    records = result.map((r) => r.address);
  } catch {
    throw new Error("Could not resolve image host");
  }
  if (!records.length) throw new Error("Could not resolve image host");
  for (const addr of records) {
    if (isBlockedIp(addr)) {
      throw new Error("Image host resolves to a private or reserved address");
    }
  }
}

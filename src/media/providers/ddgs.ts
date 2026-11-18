import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../../util/logger.js";
import { formatInternalImageAttribution } from "../attribution.js";
import type { ImageSearchHit } from "../types.js";
import type { ImageSearchProvider } from "./types.js";

export interface DdgsRawResult {
  title?: string;
  image?: string;
  thumbnail?: string;
  url?: string;
  width?: string | number;
  height?: string | number;
  source?: string;
}

export interface DdgsScriptResponse {
  ok: boolean;
  results?: DdgsRawResult[];
  error?: string;
}

export interface DdgsProviderOpts {
  /** Python executable (default: python / PYTHON env). */
  pythonPath?: string;
  /** Override path to scripts/ddgs_images.py */
  scriptPath?: string;
  /** Injected for tests. */
  runScript?: (
    query: string,
    max: number,
    timeoutMs: number,
  ) => Promise<DdgsScriptResponse>;
}

function defaultScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/media/providers → ../../../scripts ; src/media/providers → ../../../scripts
  const candidates = [
    path.resolve(here, "../../../scripts/ddgs_images.py"),
    path.resolve(here, "../../../../scripts/ddgs_images.py"),
    path.resolve(process.cwd(), "scripts/ddgs_images.py"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]!;
}

/** Parse DDGS helper stdout; tolerate BOM / leading warnings. */
export function parseDdgsScriptOutput(
  stdout: string,
  stderr: string,
): DdgsScriptResponse {
  const raw = `${stdout}\n${stderr}`.replace(/^\uFEFF/, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return {
      ok: false,
      error: stdout.trim() || stderr.trim() || "ddgs empty output",
    };
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as DdgsScriptResponse;
    if (typeof parsed?.ok !== "boolean") {
      return { ok: false, error: "ddgs invalid JSON shape" };
    }
    return parsed;
  } catch {
    return { ok: false, error: "ddgs invalid JSON" };
  }
}

function toInt(v: string | number | undefined): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

export function mapDdgsResult(
  raw: DdgsRawResult,
  index: number,
): ImageSearchHit | undefined {
  const image = raw.image?.trim();
  if (!image || !/^https:\/\//i.test(image)) return undefined;
  const landing = raw.url?.trim();
  const idSeed = Buffer.from(image).toString("base64url").slice(0, 24);
  const hit: ImageSearchHit = {
    id: `ddgs:${idSeed}:${index}`,
    provider: "ddgs",
    title: raw.title?.trim().slice(0, 120) || undefined,
    url: image,
    thumbnailUrl: raw.thumbnail?.trim() || undefined,
    width: toInt(raw.width),
    height: toInt(raw.height),
    foreignLandingUrl: landing && /^https?:\/\//i.test(landing) ? landing : undefined,
    source: raw.source?.trim() || "ddgs",
    description: raw.title?.trim().slice(0, 200),
    // No verified redistribution license — do not invent a QQ-visible credit.
    // Unverified note lives only in formatInternalImageAttribution.
  };
  hit.attribution = formatInternalImageAttribution(hit);
  return hit;
}

async function runDdgsScript(
  pythonPath: string,
  scriptPath: string,
  query: string,
  max: number,
  timeoutMs: number,
): Promise<DdgsScriptResponse> {
  return new Promise((resolve) => {
    const child = spawn(
      pythonPath,
      [scriptPath, "--query", query, "--max", String(max)],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        // Force UTF-8 pipes on Windows so Hangul/kana/emoji titles never crash
        // the helper with UnicodeEncodeError(gbk) → Bridge provider_empty.
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: "ddgs timeout" });
    }, timeoutMs);
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseDdgsScriptOutput(stdout, stderr));
    });
  });
}

export class DdgsImageProvider implements ImageSearchProvider {
  readonly id = "ddgs";
  private readonly pythonPath: string;
  private readonly scriptPath: string;
  private readonly runScript: DdgsProviderOpts["runScript"];

  constructor(opts: DdgsProviderOpts = {}) {
    this.pythonPath =
      opts.pythonPath?.trim() ||
      process.env.QQBRIDGE_DDGS_PYTHON?.trim() ||
      process.env.PYTHON?.trim() ||
      "python";
    this.scriptPath = opts.scriptPath?.trim() || defaultScriptPath();
    this.runScript = opts.runScript;
  }

  async search(opts: {
    queries: string[];
    pageSize?: number;
    page?: number;
    timeoutMs?: number;
    stopAfterHits?: number;
    maxQueries?: number;
  }): Promise<ImageSearchHit[]> {
    const limit = Math.min(40, Math.max(1, opts.pageSize ?? 12));
    const stopAfter = opts.stopAfterHits ?? limit;
    const maxQueries = Math.min(opts.maxQueries ?? 2, 3);
    const timeoutMs = Math.max(1_000, opts.timeoutMs ?? 12_000);
    const out: ImageSearchHit[] = [];
    const seen = new Set<string>();

    for (const query of opts.queries.slice(0, maxQueries)) {
      const q = query.trim();
      if (!q) continue;
      // One retry on empty/error — transient DDGS empties + prior Windows
      // encoding crashes used to surface as a permanent provider_empty.
      let attempt = 1;
      let raw = await this.invoke(q, limit, timeoutMs);
      if (!raw.ok || !Array.isArray(raw.results) || raw.results.length === 0) {
        log.info("media:ddgs_search", {
          queryLen: q.length,
          ok: raw.ok,
          resultCount: Array.isArray(raw.results) ? raw.results.length : 0,
          error: raw.error ?? null,
          attempt,
          retrying: true,
        });
        await new Promise((r) => setTimeout(r, 350));
        attempt = 2;
        raw = await this.invoke(q, limit, timeoutMs);
      }
      const resultCount = Array.isArray(raw.results) ? raw.results.length : 0;
      log.info("media:ddgs_search", {
        queryLen: q.length,
        ok: raw.ok,
        resultCount,
        error: raw.error ?? null,
        attempt,
        mappedSoFar: out.length,
      });
      if (!raw.ok || !Array.isArray(raw.results)) continue;
      for (let i = 0; i < raw.results.length; i++) {
        const hit = mapDdgsResult(raw.results[i]!, i);
        if (!hit || seen.has(hit.url)) continue;
        seen.add(hit.url);
        out.push(hit);
        if (out.length >= stopAfter) return out;
      }
      if (out.length >= Math.min(4, stopAfter)) break;
    }
    return out;
  }

  private async invoke(
    query: string,
    max: number,
    timeoutMs: number,
  ): Promise<DdgsScriptResponse> {
    if (this.runScript) return this.runScript(query, max, timeoutMs);
    return runDdgsScript(this.pythonPath, this.scriptPath, query, max, timeoutMs);
  }
}

import { assertPublicHttpUrl, assertResolvedPublicHost } from "./ssrf.js";
import type { DownloadedImage } from "./types.js";

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export type ImageDownloadStage =
  | "http"
  | "timeout"
  | "network"
  | "validation"
  | "redirect"
  | "ssrf";

/** Structured download failure so callers can skip stale candidates. */
export class ImageDownloadError extends Error {
  readonly stage: ImageDownloadStage;
  readonly httpStatus?: number;

  constructor(
    message: string,
    stage: ImageDownloadStage,
    httpStatus?: number,
  ) {
    super(message);
    this.name = "ImageDownloadError";
    this.stage = stage;
    this.httpStatus = httpStatus;
  }
}

/** Stale / gone / rate-limited / transient host errors — try the next ranked hit. */
export function isRetryableImageDownloadError(err: unknown): boolean {
  if (!(err instanceof ImageDownloadError)) return false;
  if (err.stage === "timeout" || err.stage === "network") return true;
  if (err.stage === "validation" || err.stage === "redirect") return true;
  if (err.stage !== "http" || err.httpStatus == null) return false;
  const s = err.httpStatus;
  return s === 404 || s === 410 || s === 403 || s === 429 || s >= 500;
}

const MAGIC: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: "image/jpeg", test: (b) => b.length > 2 && b[0] === 0xff && b[1] === 0xd8 },
  {
    mime: "image/png",
    test: (b) =>
      b.length > 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47,
  },
  {
    mime: "image/gif",
    test: (b) =>
      b.length > 6 &&
      b[0] === 0x47 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x38,
  },
  {
    mime: "image/webp",
    test: (b) =>
      b.length > 12 &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP",
  },
];

export interface SafeDownloadOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Injected for tests — skip DNS when set. */
  resolveHost?: (hostname: string) => Promise<void>;
}

function sniffMime(buf: Buffer, headerMime: string | null): string | null {
  for (const m of MAGIC) {
    if (m.test(buf)) return m.mime;
  }
  if (headerMime) {
    const base = headerMime.split(";")[0]!.trim().toLowerCase();
    if (ALLOWED_MIME.has(base)) return base === "image/jpg" ? "image/jpeg" : base;
  }
  return null;
}

/**
 * Download a remote image with SSRF checks, size limits, and MIME validation.
 * Never follows file:// or private IPs. Does not accept local filesystem paths.
 */
export async function downloadImageSafely(
  url: string,
  opts: SafeDownloadOptions,
): Promise<DownloadedImage> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resolveHost = opts.resolveHost ?? assertResolvedPublicHost;
  const maxRedirects = opts.maxRedirects ?? 3;

  let current: URL;
  try {
    current = assertPublicHttpUrl(url);
  } catch (err) {
    throw new ImageDownloadError(
      (err as Error).message,
      "ssrf",
    );
  }
  try {
    await resolveHost(current.hostname);
  } catch (err) {
    throw new ImageDownloadError((err as Error).message, "ssrf");
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: ac.signal,
        headers: {
          Accept: "image/*,*/*;q=0.8",
          "User-Agent": "qq-cli-bridge/0.1 (image-fetch; +https://github.com/local)",
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") {
        throw new ImageDownloadError("Image download timed out", "timeout");
      }
      throw new ImageDownloadError(
        `Image download failed: ${(err as Error).message}`,
        "network",
      );
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) {
        throw new ImageDownloadError(
          "Image redirect missing Location",
          "redirect",
        );
      }
      let next: URL;
      try {
        next = assertPublicHttpUrl(new URL(loc, current).toString());
        await resolveHost(next.hostname);
      } catch (err) {
        throw new ImageDownloadError((err as Error).message, "ssrf");
      }
      current = next;
      continue;
    }

    if (!res.ok) {
      throw new ImageDownloadError(
        `Image download HTTP ${res.status}`,
        "http",
        res.status,
      );
    }

    const cl = res.headers.get("content-length");
    if (cl && Number(cl) > opts.maxBytes) {
      throw new ImageDownloadError("Image exceeds size limit", "validation");
    }

    const headerMime = res.headers.get("content-type");
    const reader = res.body?.getReader();
    if (!reader) {
      throw new ImageDownloadError("Empty image response body", "validation");
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        throw new ImageDownloadError("Image exceeds size limit", "validation");
      }
      chunks.push(Buffer.from(value));
    }
    const buffer = Buffer.concat(chunks);
    const mime = sniffMime(buffer, headerMime);
    if (!mime || !ALLOWED_MIME.has(mime)) {
      throw new ImageDownloadError(
        "Unsupported or non-image content type",
        "validation",
      );
    }
    return {
      buffer,
      contentType: mime,
      finalUrl: current.toString(),
      byteLength: buffer.length,
    };
  }

  throw new ImageDownloadError(
    "Too many redirects while downloading image",
    "redirect",
  );
}

/** Reject any attempt to treat a local path as a sendable image source. */
export function assertNotLocalPath(candidate: string): void {
  if (/^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\") || candidate.startsWith("/")) {
    if (!/^https?:\/\//i.test(candidate)) {
      throw new ImageDownloadError(
        "Local filesystem paths cannot be sent as QQ images",
        "ssrf",
      );
    }
  }
  if (candidate.startsWith("file:")) {
    throw new ImageDownloadError("file:// URLs are not allowed", "ssrf");
  }
}

export type ImageProviderId =
  | "ddgs"
  | "searxng"
  | "duitang"
  | "openverse"
  | "pexels";

/** How Duitang hits are delivered in QQ (default: link — no byte redistrib). */
export type DuitangDeliveryMode = "link" | "image";

export interface DuitangProviderConfig {
  /** Off by default — undocumented site JSON; enable only if access/use is permitted. */
  enabled?: boolean;
  /**
   * `link` (default): send blog/source URL text only.
   * `image`: download CDN bytes and QQ sendImage — operator accepts redistrib risk.
   */
  deliveryMode?: DuitangDeliveryMode;
}

export interface DdgsProviderConfig {
  /** Default true when listed in providerPriority. */
  enabled?: boolean;
  /** Python executable for scripts/ddgs_images.py */
  pythonPath?: string;
}

export interface SearxngProviderConfig {
  /**
   * SearXNG instance base URL with JSON format enabled.
   * Empty / unset → provider skipped (no hardcoded public instance).
   */
  baseUrl?: string;
  enabled?: boolean;
}

export interface ImageSearchHit {
  id: string;
  provider: ImageProviderId;
  title?: string;
  /** Full-size (or largest safe) download URL — never a 1px tracker. */
  url: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  license?: string;
  licenseUrl?: string;
  creator?: string;
  foreignLandingUrl?: string;
  /** Attribution line safe to show in QQ. */
  attribution?: string;
  tags?: string[];
  description?: string;
  source?: string;
  category?: string;
}

export interface ImageSearchOptions {
  query: string;
  pageSize?: number;
  page?: number;
  timeoutMs?: number;
  source?: string;
  openverseClientId?: string;
  openverseClientSecret?: string;
  pexelsApiKey?: string;
  duitang?: DuitangProviderConfig;
  ddgs?: DdgsProviderConfig;
  searxng?: SearxngProviderConfig;
}

export interface DownloadedImage {
  buffer: Buffer;
  contentType: string;
  finalUrl: string;
  byteLength: number;
}

export interface ImageMediaConfig {
  enabled?: boolean;
  /** Preferred / forced single provider when set (legacy + /image --provider). */
  provider?: ImageProviderId;
  /**
   * Ordinary-search provider order. Default: `["ddgs"]` only.
   * Providers not listed are never invoked automatically.
   */
  providerPriority?: ImageProviderId[];
  /**
   * When true, allow legacy Openverse fill after the priority list.
   * Default false — no silent substitution of Duitang/Openverse/SearXNG.
   */
  autoFallback?: boolean;
  maxDownloadBytes?: number;
  searchTimeoutMs?: number;
  downloadTimeoutMs?: number;
  maxDownloadAttempts?: number;
  totalTimeoutMs?: number;
  minWidth?: number;
  minHeight?: number;
  rateLimitPerMinute?: number;
  /** Max images delivered for one multi-image NL request (再来三张). */
  maxImagesPerRequest?: number;
  openverseClientId?: string;
  openverseClientSecret?: string;
  pexelsApiKey?: string;
  duitang?: DuitangProviderConfig;
  ddgs?: DdgsProviderConfig;
  searxng?: SearxngProviderConfig;
}

export interface InboundImageAttachment {
  contentType: string;
  url: string;
  filename?: string;
  width?: number;
  height?: number;
  size?: number;
}

export const DEFAULT_IMAGE_MEDIA_CONFIG: Required<
  Pick<
    ImageMediaConfig,
    | "enabled"
    | "provider"
    | "maxDownloadBytes"
    | "searchTimeoutMs"
    | "downloadTimeoutMs"
    | "maxDownloadAttempts"
    | "totalTimeoutMs"
    | "minWidth"
    | "minHeight"
    | "rateLimitPerMinute"
    | "maxImagesPerRequest"
  >
> = {
  enabled: true,
  provider: "ddgs",
  maxDownloadBytes: 5 * 1024 * 1024,
  searchTimeoutMs: 12_000,
  downloadTimeoutMs: 10_000,
  maxDownloadAttempts: 6,
  totalTimeoutMs: 45_000,
  minWidth: 200,
  minHeight: 200,
  rateLimitPerMinute: 12,
  maxImagesPerRequest: 3,
};

export interface ModelInfo {
  id: string;
  displayName: string;
  /** True when the CLI marks this as the active/current selection. */
  current?: boolean;
  /** True when the CLI marks this as its default. */
  isDefault?: boolean;
}

export type ModelDiscoveryMode =
  /** Listed from the live CLI / account. */
  | "dynamic"
  /** Official documented aliases only — account entitlement not verified. */
  | "documented-aliases"
  /** No list available. */
  | "unavailable";

export interface ModelCatalog {
  backend: string;
  discovery: ModelDiscoveryMode;
  /** Human-readable limitation when discovery is not dynamic. */
  note?: string;
  models: ModelInfo[];
  /** Effective model for subsequent turns (undefined = CLI default). */
  effectiveModelId?: string;
}

export interface ModelSwitchResult {
  ok: boolean;
  effectiveModelId?: string;
  message: string;
}

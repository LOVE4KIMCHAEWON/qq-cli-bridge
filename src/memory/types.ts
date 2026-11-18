/** Memory item kinds stored per QQ conversation. */
export type MemoryKind =
  | "preference"
  | "fact"
  | "plan"
  | "context"
  | "correction";

export interface MemoryConfig {
  enabled: boolean;
  /** Soft budget for Persona + memory + recent window + retrieval at session start. */
  contextBudgetTokens: number;
  /** Rotate Claude session when measured/estimated context reaches this. */
  rotationThresholdTokens: number;
  /** Recent user/assistant pairs included in carry-over / new-session context. */
  recentWindowTurns: number;
  /** Max active memory profile lines per conversation. */
  maxMemoryItems: number;
  /** Max FTS-retrieved historical snippets at session start. */
  maxRetrievalSnippets: number;
  /** Idle time before background maintenance may run. */
  maintenanceIdleMs: number;
  /** Minimum interval between maintenance runs (global). */
  maintenanceMinIntervalMs: number;
  /** Max history turns processed per maintenance pass. */
  maintenanceBatchTurns: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  contextBudgetTokens: 6_000,
  rotationThresholdTokens: 80_000,
  recentWindowTurns: 12,
  maxMemoryItems: 40,
  maxRetrievalSnippets: 4,
  maintenanceIdleMs: 45_000,
  maintenanceMinIntervalMs: 120_000,
  maintenanceBatchTurns: 40,
};

export interface StoredTurn {
  id: number;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  qqMessageId?: string;
  createdAt: string;
}

export interface MemoryItem {
  id: number;
  conversationId: string;
  kind: MemoryKind;
  content: string;
  source: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionContextBundle {
  memorySection: string;
  memoryHash: string;
  estimatedTokens: number;
  recentTurnCount: number;
  retrievalCount: number;
  activeMemoryCount: number;
}

export interface CarryOverBundle extends SessionContextBundle {
  summaryLine: string;
}

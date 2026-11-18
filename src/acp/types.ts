export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export interface AcpConfigOption {
  configId: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  currentValue?: unknown;
  options?: Array<{ value: string; name?: string } | string>;
}

export interface AcpSessionSetup {
  sessionId: string;
  configOptions?: AcpConfigOption[];
  models?: {
    currentModelId?: string;
    availableModels?: Array<{ id?: string; modelId?: string; name?: string } | string>;
  };
}

export interface AcpPromptResult {
  stopReason?: string;
  messageId?: string;
  usage?: unknown;
}

export interface AcpTurnMetrics {
  acpInitMs?: number;
  promptSentAt?: number;
  firstTextAt?: number;
  finalAt?: number;
  queueWaitMs?: number;
  /** Raw usage_update / result.usage payloads collected during the turn. */
  usageUpdates: unknown[];
  resultUsage?: unknown;
  /** Count of tool_call / tool_call_update notifications observed (not model requests). */
  toolCallNotifications: number;
  /** Count of agent_message_chunk notifications. */
  assistantChunkCount: number;
}

export type AcpPermissionMode = "reject" | "allow-once";

export type AcpSessionMode = "agent" | "ask" | "plan";

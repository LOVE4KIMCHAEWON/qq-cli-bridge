import type { AgentAdapter, AgentKind } from "../types.js";
import {
  getConversationModel,
  setConversationModel,
} from "../models/conversation-store.js";
import { formatModelStatus } from "../models/format.js";
import type { ModelCatalog } from "../models/types.js";

export async function handleModelCommand(
  args: string[],
  ctx: {
    adapter: AgentAdapter;
    conversationId: string;
  },
): Promise<string> {
  const { adapter, conversationId } = ctx;
  if (!adapter.listModels || !adapter.resolveModelSwitch) {
    return `Model commands are not supported for ${adapter.displayName}.`;
  }

  const pref = getConversationModel(conversationId);
  const effectiveFromStore =
    pref && pref.backend === adapter.kind ? pref.modelId : undefined;

  if (args.length === 0) {
    const catalog = await adapter.listModels();
    const withEffective: ModelCatalog = {
      ...catalog,
      effectiveModelId: effectiveFromStore ?? catalog.effectiveModelId,
    };
    // Mark current selection in the list when possible
    if (effectiveFromStore) {
      withEffective.models = catalog.models.map((m) => ({
        ...m,
        current: m.id.toLowerCase() === effectiveFromStore.toLowerCase(),
      }));
    }
    return formatModelStatus(withEffective);
  }

  const target = args.join(" ").trim();
  if (!target) {
    return "Usage: /model [model-id|default]";
  }

  const result = await adapter.resolveModelSwitch(
    target.toLowerCase() === "default" ? "default" : target,
  );
  if (!result.ok) {
    return result.message;
  }

  setConversationModel(
    conversationId,
    adapter.kind as AgentKind,
    result.effectiveModelId,
  );

  const shown = result.effectiveModelId ?? "(CLI default)";
  return `${result.message}\n\nEffective model: ${shown}`;
}

import type { AppConfig } from "../types.js";

export type ChatScopeKind = "c2c" | "group" | "dm" | "guild" | string;

/**
 * Decide whether the Bridge runtime should short-circuit for empty C2C allowlist.
 * Group traffic must NOT be gated by the C2C user list.
 */
export function shouldBlockForEmptyC2cAllowlist(
  config: AppConfig,
  scope: ChatScopeKind,
): boolean {
  if (scope !== "c2c" && scope !== "dm") return false;
  return (
    config.allowlist.c2cMode === "allowlist" &&
    config.allowlist.users.length === 0
  );
}

/** Operator-facing summary of group access config (no secrets). */
export function describeGroupAccessPolicy(config: AppConfig): {
  mode: string;
  allowedGroupCount: number;
  willReceiveGroupAt: boolean;
  startupWarning?: string;
} {
  const mode = config.allowlist.groupMode;
  const allowedGroupCount = config.allowlist.groups.length;
  if (mode === "disabled") {
    return {
      mode,
      allowedGroupCount,
      willReceiveGroupAt: false,
      startupWarning:
        "Group mode is disabled — GROUP_AT_MESSAGE_CREATE will be ignored by accessPolicy.",
    };
  }
  if (mode === "allowlist" && allowedGroupCount === 0) {
    return {
      mode,
      allowedGroupCount,
      willReceiveGroupAt: false,
      startupWarning:
        "Group allowlist is empty — @mentions in groups are blocked. After the bot joins a group, run: qqbridge allowlist add-group <group_openid>",
    };
  }
  return {
    mode,
    allowedGroupCount,
    willReceiveGroupAt: true,
  };
}

export function formatGroupAccessBlockHint(groupOpenid: string | undefined, reason: string): string {
  const id = groupOpenid?.trim() || "(unknown-group-openid)";
  if (/allowlist is empty|not in allowlist/i.test(reason)) {
    return `Group message blocked (${reason}). To authorize this group: qqbridge allowlist add-group ${id}`;
  }
  return `Group message blocked (${reason}). groupOpenid=${id}`;
}

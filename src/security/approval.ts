/**
 * Dangerous-action approval gate for QQ.
 * QQ free-text must never auto-approve tool/shell actions.
 */

const APPROVE_EXACT = new Set([
  "/approve once",
  "/approve",
  "approve once",
  "✅ allow once",
]);

const DENY_EXACT = new Set(["/deny", "deny", "❌ deny"]);

const DANGEROUS_HINT =
  /\b(rm\s+-rf|del\s+\/s|format\s+|shutdown|Remove-Item\s+-Recurse|drop\s+table|curl\s+[^\n]*\|\s*sh)\b/i;

export type ApprovalDecision = "approve_once" | "deny" | "not_approval";

export function parseApprovalMessage(text: string): ApprovalDecision {
  const normalized = text.trim().toLowerCase();
  if (APPROVE_EXACT.has(normalized)) return "approve_once";
  if (DENY_EXACT.has(normalized)) return "deny";
  // Never treat arbitrary chat as approval.
  return "not_approval";
}

export function looksDangerous(text: string): boolean {
  return DANGEROUS_HINT.test(text);
}

export function approvalHelpText(): string {
  return [
    "A potentially dangerous action is waiting.",
    "Reply exactly with /approve once to allow this turn, or /deny to reject.",
    "Any other message is treated as normal chat and will NOT approve the action.",
  ].join("\n");
}

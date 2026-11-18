import type { ModelCatalog } from "./types.js";

export function formatModelStatus(catalog: ModelCatalog): string {
  const current =
    catalog.effectiveModelId ??
    catalog.models.find((m) => m.current)?.id ??
    catalog.models.find((m) => m.isDefault)?.id ??
    "(CLI default)";

  const lines: string[] = [
    `Backend: ${catalog.backend}`,
    `Current model: ${current}`,
    "",
  ];

  if (catalog.discovery === "unavailable") {
    lines.push("Available models:");
    lines.push("(dynamic discovery unavailable for this CLI)");
    if (catalog.note) lines.push(catalog.note);
    lines.push("");
    lines.push("Use /model <model-id> to switch if you know a valid id.");
    lines.push("Use /model default to restore the CLI default.");
    return lines.join("\n");
  }

  if (catalog.discovery === "documented-aliases") {
    lines.push("Available models (documented aliases — account entitlement not verified):");
  } else {
    lines.push("Available models:");
  }

  if (catalog.models.length === 0) {
    lines.push("(none returned by CLI)");
  } else {
    catalog.models.forEach((m, i) => {
      const marks: string[] = [];
      if (m.current) marks.push("current");
      if (m.isDefault) marks.push("default");
      const suffix = marks.length ? ` (${marks.join(", ")})` : "";
      const label = m.displayName && m.displayName !== m.id ? ` — ${m.displayName}` : "";
      lines.push(`${i + 1}. ${m.id}${label}${suffix}`);
    });
  }

  if (catalog.note) {
    lines.push("");
    lines.push(catalog.note);
  }

  lines.push("");
  lines.push("Use /model <model-id> to switch.");
  lines.push("Use /model default to restore the CLI default.");
  return lines.join("\n");
}

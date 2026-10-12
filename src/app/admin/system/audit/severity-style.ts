/** Shared severity → French label + badge classes for the audit UI (client-safe). */

export const SEVERITY_LABEL: Record<string, string> = {
  error: "Erreur",
  warn: "Alerte",
  info: "Info",
  debug: "Debug",
};

export const SEVERITY_BADGE: Record<string, string> = {
  error: "bg-destructive/10 text-destructive",
  warn: "bg-[#fff4e0] text-[#b45309]",
  info: "bg-primary/10 text-primary",
  debug: "bg-muted text-muted-foreground",
};

export function severityBadge(severity: string): string {
  return SEVERITY_BADGE[severity] ?? "bg-surface text-foreground";
}

/** Solid fill for a small severity dot (the tint badges read as colorless at 2px). */
export const SEVERITY_DOT: Record<string, string> = {
  error: "bg-destructive",
  warn: "bg-[#b45309]",
  info: "bg-primary",
  debug: "bg-muted-foreground",
};

export function severityDot(severity: string): string {
  return SEVERITY_DOT[severity] ?? "bg-muted-foreground";
}

export function severityLabel(severity: string): string {
  return SEVERITY_LABEL[severity] ?? severity;
}

/** The order severities are shown in KPI strips / filters (most → least severe). */
export const SEVERITY_ORDER_UI: readonly string[] = ["error", "warn", "info", "debug"];

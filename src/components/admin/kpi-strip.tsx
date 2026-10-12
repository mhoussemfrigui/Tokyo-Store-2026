import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Shared admin KPI strip — a compact responsive row of stat tiles shown under
 * a page header to give operators an at-a-glance summary before they scan the
 * list below. Several admin panels were each hand-rolling a `StatCard` with
 * subtly different chrome; this is the one canonical version for the Contenu &
 * Design pages (and any list page that wants a summary).
 *
 * Pure/presentational: the caller computes the numbers server-side and passes
 * them in. Empty `items` renders nothing.
 */
export type KpiTone = "default" | "success" | "warning" | "info" | "muted";

export type KpiItem = {
  label: string;
  value: ReactNode;
  /** Colour accent for the tile (default = neutral card). */
  tone?: KpiTone;
  /** Optional sub-line under the value (e.g. "dont 2 programmées"). */
  hint?: string;
};

const TONE_CLASSES: Record<KpiTone, string> = {
  default: "border-border bg-card text-foreground",
  success: "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]",
  warning: "border-[#f3e3bd] bg-[#fff4e0] text-[#b45309]",
  info: "border-[#f6d3dc] bg-[var(--accent)] text-primary",
  muted: "border-border bg-surface text-muted-foreground",
};

export function AdminKpiStrip({
  items,
  className,
}: {
  items: KpiItem[];
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4",
        className,
      )}
    >
      {items.map((it, i) => (
        <div
          key={`${it.label}-${i}`}
          className={cn("rounded-[24px] border p-5", TONE_CLASSES[it.tone ?? "default"])}
        >
          <p className="text-[12px] font-bold opacity-80">{it.label}</p>
          <p className="mt-1.5 text-[28px] font-black leading-none tracking-[-0.02em]">{it.value}</p>
          {it.hint && <p className="mt-1.5 text-[12px] opacity-70">{it.hint}</p>}
        </div>
      ))}
    </div>
  );
}

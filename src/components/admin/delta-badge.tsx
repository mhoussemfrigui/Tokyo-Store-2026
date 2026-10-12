import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import type { Delta } from "@/lib/analytics/trend";

/**
 * Compact period-over-period trend chip (↑/↓/– + percent). Presentational +
 * server-safe (no hooks). Colour follows whether the move is GOOD: by default
 * "up" is good (green) and "down" is bad (red); pass `invertColor` for metrics
 * where a rise is bad (cancellations, refunds). A `null` pct (no prior-period
 * baseline) renders "nouveau" rather than ∞%.
 */
export function DeltaBadge({
  delta,
  invertColor = false,
  className = "",
}: {
  delta: Delta;
  invertColor?: boolean;
  className?: string;
}) {
  const { direction, pct, previous } = delta;
  const good = invertColor ? direction === "down" : direction === "up";
  const bad = invertColor ? direction === "up" : direction === "down";
  const tone =
    direction === "flat"
      ? "text-muted-foreground"
      : good
        ? "text-[#15803d]"
        : bad
          ? "text-destructive"
          : "text-muted-foreground";
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
  const label = pct === null ? "nouveau" : `${pct > 0 ? "+" : ""}${pct} %`;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-semibold ${tone} ${className}`}
      title={`Période précédente : ${previous.toLocaleString("fr-FR")}`}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
      {label}
      <span className="sr-only"> vs période précédente</span>
    </span>
  );
}

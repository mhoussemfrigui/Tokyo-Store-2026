import type { ReactNode } from "react";

import { AdminCallout } from "@/components/admin/_components/filter-bar";

/**
 * The read-only notice every Stock sub-panel shows when the operator lacks
 * `stock:update`. Single-sourced here so the permission wording lives in ONE
 * place — it was copy-pasted verbatim across the Inventaire / Alertes / ERP /
 * Réglages tabs (and a near-variant in Transferts). `className` matches the
 * `mb-4` spacing the settings cards used; `suffix` extends the sentence for a
 * surface that needs more context (e.g. Transferts), defaulting to a period.
 */
export function StockReadOnlyBanner({
  className,
  suffix = ".",
}: {
  className?: string;
  suffix?: ReactNode;
}) {
  return (
    <AdminCallout tone="warning" className={className}>
      Lecture seule — la permission « modifier le stock » est requise{suffix}
    </AdminCallout>
  );
}

import { minorToDinars } from "@/lib/price";
import type { CarePlanRow } from "@/modules/catalog/care/schema";

/**
 * Human price summary for a Tokyo Care plan — "X% du prix" for a percent plan, or
 * "X TND" for a flat one (dinars). Pure + client-safe (no DB, no "server-only"):
 * the single formatter shared by the Tokyo Care admin list and the product form's
 * care tab, so the two never drift.
 */
export function carePlanPriceSummary(
  p: Pick<CarePlanRow, "pricing_mode" | "price_bps" | "price_cents">,
): string {
  if (p.pricing_mode === "percent") {
    return `${(p.price_bps / 100).toLocaleString("fr-TN")}% du prix`;
  }
  return `${minorToDinars(p.price_cents).toLocaleString("fr-TN")} TND`;
}

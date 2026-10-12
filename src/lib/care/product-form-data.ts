import "server-only";

import { careService } from "@/modules/catalog/care/service";
import { minorToDinars } from "@/lib/price";
import { carePlanPriceSummary } from "@/lib/care/display";
import type { ProductFormCarePlan } from "@/components/admin/product-form";

/** Active Tokyo Care plans as the product form's picker options. */
export async function loadCarePlanOptions(): Promise<ProductFormCarePlan[]> {
  const plans = await careService.list({ activeOnly: true });
  return plans.map((p) => ({ id: p.id, name: p.name, priceSummary: carePlanPriceSummary(p) }));
}

/** A product's stored Tokyo Care overrides, shaped for the product form initial. */
export async function loadProductCareLinks(
  productId: string,
): Promise<{ carePlanId: string; mode: "include" | "exclude"; overrideDinars: string }[]> {
  const rows = await careService.getProductCare(productId);
  return rows.map((r) => ({
    carePlanId: r.care_plan_id,
    mode: r.mode as "include" | "exclude",
    overrideDinars: r.override_price_cents != null ? String(minorToDinars(r.override_price_cents)) : "",
  }));
}

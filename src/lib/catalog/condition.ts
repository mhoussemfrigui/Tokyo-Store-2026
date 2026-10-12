import type { ProductCondition } from "@/modules/catalog/product/schema";

/**
 * Pure mappings for the product condition (état) — the SINGLE source for both
 * the schema.org Offer.itemCondition URL (PDP JSON-LD) and the French label
 * (PDP "Détails" tab). Both default to NEW for an unset / unknown value (legacy
 * rows + forward-compat), matching the column default.
 */
const SCHEMA_URL: Record<ProductCondition, string> = {
  new: "https://schema.org/NewCondition",
  used: "https://schema.org/UsedCondition",
  refurbished: "https://schema.org/RefurbishedCondition",
};

const LABEL_FR: Record<ProductCondition, string> = {
  new: "Neuf",
  used: "Occasion",
  refurbished: "Reconditionné",
};

/** schema.org Offer.itemCondition URL — NewCondition for new / unknown / unset. */
export function conditionSchemaUrl(c: string | null | undefined): string {
  return (c && SCHEMA_URL[c as ProductCondition]) || SCHEMA_URL.new;
}

/** French état label — "Neuf" for new / unknown / unset. */
export function conditionLabelFr(c: string | null | undefined): string {
  return (c && LABEL_FR[c as ProductCondition]) || LABEL_FR.new;
}

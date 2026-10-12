/**
 * The storefront faceted-filter predicate — decides whether ONE product passes
 * the active attribute filters. Pure (no React / DOM deps) so it is unit-testable
 * and shared verbatim by the client grid (category-client.tsx) — the two can't
 * drift.
 *
 * Semantics (PrestaShop/Woo-style):
 *   - VALUE-LIST facets (select / multiselect / color / boolean): AND ACROSS
 *     attributes (a product must satisfy every active attribute), OR WITHIN an
 *     attribute (it satisfies one if it carries ANY of that attribute's wanted
 *     values). An attribute with no selected value is ignored.
 *   - NUMBER-range facets: AND across; the product must CARRY a numeric value for
 *     the attribute AND it must fall inside [min, max]. A product with no value
 *     for an active number filter is excluded (you can't range-match a missing
 *     spec).
 */
export type AttributeFilterInput = {
  /** The value ids this product is assigned (select/multiselect/color/boolean). */
  productValueIds: string[];
  /** attributeId → the product's numeric scalar (for number kinds). */
  productNumericValues: Record<string, number> | undefined;
  /** attributeId → the set of value ids the user ticked. */
  attrFilters: Record<string, Set<string>>;
  /** The attribute ids with at least one ticked value (drives the AND loop). */
  activeAttrIds: string[];
  /** attributeId → the chosen [min, max] range. */
  numericFilters: Record<string, { min: number; max: number }>;
  /** The number-attribute ids with an active (non-default) range. */
  activeNumericIds: string[];
};

export function productMatchesAttributeFilters(input: AttributeFilterInput): boolean {
  const {
    productValueIds,
    productNumericValues,
    attrFilters,
    activeAttrIds,
    numericFilters,
    activeNumericIds,
  } = input;

  // Value-list facets: AND across attributes, OR within.
  for (const attrId of activeAttrIds) {
    const wanted = attrFilters[attrId];
    if (!wanted || wanted.size === 0) continue;
    let matched = false;
    for (const v of productValueIds) {
      if (wanted.has(v)) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }

  // Number-range facets: AND across; must carry the value AND fall in range.
  for (const attrId of activeNumericIds) {
    const range = numericFilters[attrId];
    const pv = productNumericValues?.[attrId];
    if (pv == null || pv < range.min || pv > range.max) return false;
  }

  return true;
}

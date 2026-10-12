import { AVAILABILITY_FACET, AVAILABILITY_LABELS } from "@/lib/catalog/availability-labels";
import { dinarsToMinor } from "@/lib/price";

import { hasVisibleCompareAt, toDisplayMinor } from "./display-pricing";

/**
 * Storefront listing FILTER predicates + facet availability — shared by the
 * listing grid (`[slug]/category-client.tsx`) and its pure unit test, so the
 * options the filter panel offers are derived with the EXACT predicates the grid
 * filters with. Pure (no React, no server-only).
 *
 * Availability is derived from the UNFILTERED product set of the page: an
 * option is offered only when it can match at least one product, so no click
 * ever dead-ends on « Aucun produit ne correspond à vos filtres ».
 */

/** The product fields the listing filters read (a subset of the `Product` DTO). */
export type FacetProduct = {
  slug: string;
  priceCents: number;
  oldPriceCents?: number | null;
  rating: number;
  inStock: boolean;
  category: string;
  subcategory?: string;
};

type Availability = (typeof AVAILABILITY_FACET)[number];

/** « En promotion uniquement »: a compare-at the card actually strikes through. */
export function isPromoProduct(p: FacetProduct, decimals: number): boolean {
  return hasVisibleCompareAt(p, decimals);
}

/**
 * Price-slider exclusion, compared at the DISPLAYED precision: the slider label
 * and the card both show the price rounded to `decimals`, so a product whose
 * card reads « 179 TND » (179,100 millimes at whole-dinar display) must stay
 * visible at « Jusqu'à 179 TND ». `maxPrice` is the slider's major-unit value.
 */
export function exceedsMaxPrice(p: FacetProduct, maxPrice: number, decimals: number): boolean {
  return toDisplayMinor(p.priceCents, decimals) > dinarsToMinor(maxPrice);
}

/**
 * Lower-bound counterpart of {@link exceedsMaxPrice}, compared at the SAME
 * displayed precision: a product whose card reads « 203 TND » must stay visible
 * at « De 203 TND ». `minPrice` is the range's lower major-unit value.
 */
export function belowMinPrice(p: FacetProduct, minPrice: number, decimals: number): boolean {
  return toDisplayMinor(p.priceCents, decimals) < dinarsToMinor(minPrice);
}

/** The availability facet value a product falls under. */
export function availabilityOf(p: FacetProduct): Availability {
  return p.inStock ? AVAILABILITY_LABELS.inStock : AVAILABILITY_LABELS.outOfStock;
}

/**
 * The slug the sub-category TREE filter matches a product on: its sub-category,
 * or — when it has none (filed directly on a top node) — its primary category.
 */
export function subcategoryFilterKey(p: FacetProduct): string {
  return p.subcategory ? p.subcategory : p.category;
}

type TreeNode<N> = { slug: string; children?: N[] };

/**
 * The sub-category tree pruned to nodes whose SUBTREE matches at least one
 * product (the tree filter's own predicate — a node selection expands to the
 * node + all its descendants). A kept node's children are pruned the same way;
 * an empty result means the tree facet has nothing to offer.
 */
export function pruneSubcategoryTree<N extends TreeNode<N>>(
  tree: readonly N[],
  products: readonly FacetProduct[],
): N[] {
  const keys = new Set(products.map(subcategoryFilterKey));
  const prune = (nodes: readonly N[]): N[] => {
    const out: N[] = [];
    for (const node of nodes) {
      const children = prune(node.children ?? []);
      if (keys.has(node.slug) || children.length > 0) out.push({ ...node, children });
    }
    return out;
  };
  return prune(tree);
}

/**
 * Keep, per value-list attribute (select / multiselect / color / boolean), only
 * the values carried by at least one in-scope product. Number / text attributes
 * pass through (their range is already computed from the in-scope products).
 * An attribute left with no value renders no section (`hasFilterableContent`).
 */
export function filterAttributeValues<A extends { kind: string; values: Array<{ id: string }> }>(
  attributes: readonly A[],
  presentValueIds: ReadonlySet<string>,
): A[] {
  return attributes.map((a) =>
    a.kind === "number" || a.kind === "text"
      ? a
      : { ...a, values: a.values.filter((v) => presentValueIds.has(v.id)) },
  );
}

export type FacetAvailability<N> = {
  /** Offer « En promotion uniquement » — at least one product is on promotion. */
  promo: boolean;
  /** Offer « Note minimale » — at least one product carries a rating. */
  rating: boolean;
  /**
   * Availability values with at least one product. The panel shows the facet
   * only when BOTH are present: a lone value matches every product (no-op).
   */
  availability: Availability[];
  /** Sub-category tree pruned to non-empty subtrees. */
  subcategoryTree: N[];
  /** Every attribute value id carried by at least one product. */
  valueIds: Set<string>;
};

/** Which filter options can match at least one of `products` (see module doc). */
export function deriveFacetAvailability<N extends TreeNode<N>>(input: {
  products: readonly FacetProduct[];
  decimals: number;
  subcategoryTree: readonly N[];
  /** product slug → attribute value ids (the page's `productValueIds`). */
  productValueIds: ReadonlyMap<string, readonly string[]>;
}): FacetAvailability<N> {
  const { products, decimals } = input;
  const present = new Set<Availability>(products.map(availabilityOf));
  const valueIds = new Set<string>();
  for (const p of products) {
    for (const id of input.productValueIds.get(p.slug) ?? []) valueIds.add(id);
  }
  return {
    promo: products.some((p) => isPromoProduct(p, decimals)),
    rating: products.some((p) => p.rating > 0),
    availability: AVAILABILITY_FACET.filter((a) => present.has(a)),
    subcategoryTree: pruneSubcategoryTree(input.subcategoryTree, products),
    valueIds,
  };
}

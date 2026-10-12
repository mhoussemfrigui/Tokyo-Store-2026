/**
 * Single source of truth for the product AVAILABILITY copy used across the
 * storefront — the PDP buy actions + buy-bar, the cart line state, and the
 * category-page availability facet. These labels were previously duplicated as
 * inline literals in 4+ client components, so an edit had to be hunted down in
 * every file (and the cart said "Indisponible" while the PDP said "Rupture de
 * stock" for the same state). Importing from here keeps them in lockstep.
 *
 * Plain constants (no `server-only`) so client components can import them
 * directly — mirrors `sort-options.ts`. The strings are byte-identical to what
 * each surface rendered before, so nothing changes on screen.
 */
export const AVAILABILITY_LABELS = {
  /** In-stock badge / facet ("En stock"). */
  inStock: "En stock",
  /** Generic unavailable badge ("Indisponible"). */
  unavailable: "Indisponible",
  /** Abbreviated unavailable label for the cramped mobile buy-bar ("Indispo."). */
  unavailableShort: "Indispo.",
  /** PDP headline sold-out line ("Rupture de stock"). */
  outOfStock: "Rupture de stock",
} as const;

/**
 * Buy-action CTA copy keyed by the buyable state. The PDP "Ajouter au Panier"
 * button and the mobile buy-bar "Panier" button used the same in-stock /
 * unavailable ternary with slightly different wording, so each surface picks
 * the label set it needs from here.
 */
export const ADD_TO_CART_LABELS = {
  /** Primary add-to-cart CTA ("Ajouter au Panier"). */
  inStock: "Ajouter au Panier",
  /** Compact add-to-cart label on the mobile buy-bar ("Panier"). */
  inStockShort: "Panier",
} as const;

/**
 * The two-value availability facet shown on category / collection pages
 * ("En stock" / "Rupture de stock"). Derived from the shared labels so the
 * facet stays in sync with the badges.
 */
export const AVAILABILITY_FACET = [
  AVAILABILITY_LABELS.inStock,
  AVAILABILITY_LABELS.outOfStock,
] as const;

import type { Product } from "@/storefront/types/catalog";

/**
 * REAL backend rating. `products.rating` is the denormalized average of APPROVED
 * reviews and `reviews` is their count (maintained by reviewService.recompute*).
 * 0 reviews ⇒ `rating: null` ("pas encore d'avis"). Never fabricated — sourced
 * from the DB via the catalog export.
 */
export function productRating(
  product: Pick<Product, "rating" | "reviews">,
): { rating: string | null; reviews: number } {
  const reviews = product.reviews ?? 0;
  const rating = product.rating ?? 0;
  if (reviews <= 0 || rating <= 0) return { rating: null, reviews: 0 };
  return { rating: rating.toFixed(1), reviews };
}

export type StockState = "in_stock" | "backorder" | "out_of_stock";

/**
 * The catalogue carries three availability values, not two. `backorder` is a
 * pre-order — launch stock not yet landed — so it must never render as a
 * rupture: the product is orderable, it just ships later.
 */
export function stockState(product: Pick<Product, "availability">): StockState {
  if (product.availability === "in_stock") return "in_stock";
  if (product.availability === "backorder") return "backorder";
  return "out_of_stock";
}

/** True when the product can still be put in the cart. */
export function isOrderable(product: Pick<Product, "availability">): boolean {
  return stockState(product) !== "out_of_stock";
}

export const STOCK_LABEL: Record<StockState, string> = {
  in_stock: "En stock",
  backorder: "Précommande",
  out_of_stock: "Rupture",
};

export function conditionLabel(c: string) {
  const k = (c || "").toLowerCase();
  if (k.includes("refurb") || k === "used") return "Reconditionné";
  if (k === "new") return "Neuf";
  return c || "Neuf";
}

export function fmtPrice(n: number) {
  return n.toLocaleString("fr-TN");
}

/**
 * REAL "was" price + discount %. Renders a strike ONLY when the product carries
 * a genuine compare-at (`oldPrice` — a stored old price or a live promotion
 * folded in by the backend) STRICTLY above the current price. Never invented; a
 * product with no backend discount shows no badge.
 */
export function productStrike(
  product: Pick<Product, "price" | "oldPrice">,
): { strike: number; pct: number } | null {
  const strike = product.oldPrice ?? null;
  if (strike == null || strike <= product.price) return null;
  const pct = Math.round((1 - product.price / strike) * 100);
  if (pct < 1) return null;
  return { strike, pct };
}

/**
 * REAL warranty, backend-only. Resolved by the backend cascade (global → category →
 * product) and surfaced on the live PDP as `product.warranty` / `product.warrantyMonths`.
 * Returns `null` when the backend carries NO warranty for this product — callers then
 * render nothing (no fabricated "12 mois" guess). The same resolved value the order
 * line freezes at checkout, so the PDP never contradicts the invoice.
 */
export function productWarranty(product: Pick<Product, "warranty" | "warrantyMonths">): {
  title: string;
  text: string;
  full: string;
} | null {
  const months = product.warrantyMonths ?? 0;
  const display = (product.warranty ?? "").trim();
  if (!display && months <= 0) return null;

  const title = months > 0 ? `Garantie ${months} mois` : display;
  const full = display || `Garantie ${months} mois`;
  // Subtitle: echo the backend label when it adds detail beyond the month count;
  // otherwise just the full string — never an invented claim.
  const text = display && display !== title ? display : full;
  return { title, text, full };
}

/**
 * « Descriptif technique » base rows — REAL backend facts only. A row is included
 * ONLY when its datum exists: the reference shows only with a real SKU (never the
 * internal UUID), the brand only when set, the warranty only when the backend
 * resolved one. État / catégorie / disponibilité are always backend-derived.
 */
export function productSpecs(product: Product): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (product.sku) rows.push({ label: "Référence", value: product.sku });
  if (product.brand) rows.push({ label: "Marque", value: product.brand });
  rows.push({ label: "État", value: conditionLabel(product.condition) });
  if (product.product_type) rows.push({ label: "Catégorie", value: product.product_type });
  rows.push({
    label: "Disponibilité",
    value: { in_stock: "En stock", backorder: "Sur précommande", out_of_stock: "Rupture de stock" }[
      stockState(product)
    ],
  });
  const warranty = productWarranty(product);
  if (warranty) rows.push({ label: "Garantie", value: warranty.full });
  return rows;
}

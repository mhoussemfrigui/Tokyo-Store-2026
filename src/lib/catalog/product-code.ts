/**
 * Customer-facing product REFERENCE helper — PURE module (no server-only deps).
 *
 * (The former scannable product-code feature — QR/barcode config, payload
 * resolution, Caisse/manual-order scanning — was removed; only the storefront
 * reference string lives here now.)
 */

/**
 * The customer-facing product REFERENCE — the real SKU when set, else a stable
 * `TK-<SLUG>` fallback. The SINGLE source of truth shared by the PDP info pill,
 * the Détails tab row, and the JSON-LD `sku` / `productGroupID`, so the visible
 * reference and the structured-data / Merchant-feed value never diverge for a
 * SKU-less product.
 */
export function productReference(sku: string | null | undefined, slug: string): string {
  const s = sku?.trim();
  return s ? s : `TK-${slug.toUpperCase()}`;
}

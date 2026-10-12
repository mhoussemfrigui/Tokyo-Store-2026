/**
 * PURE money-row rules for the printed order documents (admin facture +
 * customer reçu) — NO "server-only", NO DB, so both renderers ask the same
 * question the same way (their totals cards used to drift) and it's
 * unit-testable directly.
 */

export type DocumentShippingRow = {
  /** « Livraison » for a home delivery, « Frais de retrait » for a paid pickup. */
  label: "Livraison" | "Frais de retrait";
  /** A home delivery with no fee prints « Gratuite » instead of an amount. */
  free: boolean;
} | null;

/**
 * The shipping row of a document's totals card — mirrors the web order pages
 * (`/order/[id]`, `/account/orders/[id]`): a home delivery always prints its
 * « Livraison » row (« Gratuite » when free), a pickup (drive / in-store)
 * ships nothing, so it prints only a « Frais de retrait » row when it carries a
 * fee — never « Livraison — Gratuite » on an order that was never delivered.
 */
export function documentShippingRow(deliveryMethod: string, shippingCents: number): DocumentShippingRow {
  if (deliveryMethod === "home_delivery") return { label: "Livraison", free: shippingCents <= 0 };
  return shippingCents > 0 ? { label: "Frais de retrait", free: false } : null;
}

/**
 * The TVA carried by the shipping fee (millimes) — the part of the order's
 * computed `tax_cents` that no line's TVA cell shows. `tax_cents` is Σ line
 * tax + the shipping-tax term (when `tax.on_shipping` is set) + the Tokyo Care
 * TVA (place-order / recomputeOrderTotals), so the shipping term is the remainder
 * once BOTH the line tax and the care tax are removed; printing it on the shipping
 * row lets the per-line TVA column reconcile with the TVA total. 0 when shipping
 * is free (nothing to tax) or the difference isn't positive. `careTaxCents` is the
 * order's care-TVA (Σ order_care_items.tax_cents); omit (0) for a care-free order.
 */
export function documentShippingTaxCents(
  order: { tax_cents: number; shipping_cents: number },
  lines: ReadonlyArray<{ tax_cents: number }>,
  careTaxCents = 0,
): number {
  if (order.shipping_cents <= 0) return 0;
  const linesTax = lines.reduce((acc, l) => acc + l.tax_cents, 0);
  return Math.max(0, order.tax_cents - linesTax - Math.max(0, careTaxCents));
}

/** Σ of the Tokyo Care snapshot rows' ex-TVA charge (millimes). */
export function sumCareCents(rows: ReadonlyArray<{ care_cents: number }>): number {
  return rows.reduce((acc, r) => acc + r.care_cents, 0);
}

/** Σ of the Tokyo Care snapshot rows' TVA (millimes) — the part of order.tax_cents
 *  that is care tax (excluded from the shipping-tax remainder). */
export function sumCareTaxCents(rows: ReadonlyArray<{ tax_cents: number }>): number {
  return rows.reduce((acc, r) => acc + r.tax_cents, 0);
}

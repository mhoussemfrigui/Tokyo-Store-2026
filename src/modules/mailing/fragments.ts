import { escapeHtml } from "./render";

/**
 * Shared builders for the trusted HTML fragments that callers pass into the
 * `order_confirmation` (`items_html`) template via
 * `dispatchEmail({ htmlVariables })`.
 *
 * Centralising them here keeps every line-item block on the same brand palette.
 * Cell values are escaped here, so the produced fragment is safe to pass through
 * `htmlVariables` (NOT re-escaped at dispatch).
 */

/** A single order-receipt line item: "Product ×qty …… price". */
export function orderLineItemRow(opts: {
  name: string;
  quantity: number;
  priceLabel: string;
}): string {
  return `<tr><td style="padding:7px 0;border-bottom:1px solid #e7e1da;color:#0e1218;">${escapeHtml(
    opts.name,
  )}<span style="color:#6b7280;"> ×${opts.quantity}</span></td><td style="padding:7px 0;border-bottom:1px solid #e7e1da;text-align:right;white-space:nowrap;color:#0e1218;">${escapeHtml(
    opts.priceLabel,
  )}</td></tr>`;
}

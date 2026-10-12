import "server-only";

import { dispatchEmail, isFlowEnabled, orderLineItemRow } from "@/modules/mailing";
import { escapeHtml } from "@/modules/mailing/render";
import { orderService } from "@/modules/order/service";
import { formatMoneyExact } from "@/lib/price";
import { firstNameOf } from "@/lib/email/util";
import { isOnlineMethod } from "@/lib/payments/shared";
import { formatTaxRate, getTaxConfig } from "@/lib/tax";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { bus } from "../bus";

/**
 * Order-receipt subscriber for `order.created`.
 *
 * Sends the shopper a RECEIPT (« Commande reçue ») with the order number, line
 * items, totals, and a deep link to the order page. It is not an acceptance
 * mail: a COD order is only accepted later (`order_confirmed`), and an ONLINE
 * order (ClicToPay/Flouci) is still pending + unpaid when this fires — for
 * those the copy says « en attente de paiement » (the `order_paid` mail follows
 * once the gateway settles). Best-effort — a provider outage logs and moves on
 * rather than crashing the order write transaction (which has already
 * committed by the time this subscriber runs; the bus emits AFTER commit).
 *
 * Inline HTML rather than a `react-email` template so the subscriber
 * stays self-contained and the bundle doesn't pay the React-on-server
 * cost for a transactional email. Move to `templates/order-receipt.tsx`
 * if/when a shared layout (header, footer, brand strip) is needed.
 */

// Exact money on the receipt — a discounted total must not misprint.
const TND = (cents: number) => formatMoneyExact(cents);

export function registerOrderReceiptSubscriber() {
  bus.on("order.created", async ({ payload }) => {
    try {
      // Honour the Workflows-tab toggle for this flow (default on).
      if (!(await isFlowEnabled("order_confirmation"))) return;
      const order = await orderService.findById(payload.orderId);
      if (!order || !order.contact_email) return;

      const items = await orderService.listItems(order.id);

      // Build the line-item rows + subtotal/discount/TVA as a trusted HTML
      // fragment (cells escaped in the shared helper); the template renders the
      // Livraison + Total rows around it. Passed via `htmlVariables` so dispatch
      // doesn't re-escape it.
      const itemRows = items
        .map((it) =>
          orderLineItemRow({
            name: it.product_name,
            quantity: it.quantity,
            priceLabel: TND(it.subtotal_cents),
          }),
        )
        .join("");
      const subtotalRow = `<tr><td style="padding:8px 0 2px 0;color:#6b7280;">Sous-total</td><td style="padding:8px 0 2px 0;text-align:right;">${TND(order.subtotal_cents)}</td></tr>`;
      const discountRow =
        order.discount_cents > 0
          ? `<tr><td style="padding:2px 0;color:#d40530;">Remise</td><td style="padding:2px 0;text-align:right;color:#d40530;">−${TND(order.discount_cents)}</td></tr>`
          : "";
      // ── TVA — same inference as the storefront order page (and so the invoice):
      // the printed tax is the manual override when set, else the snapshot; it was
      // ADDED on top ("ht" → a real row, so the rows sum to the total) unless the
      // other components already balance the total (tax-INCLUSIVE "ttc" → a muted
      // « dont TVA » note under the total). Stays correct if the mode later flips.
      const effectiveTaxCents = order.tax_manual_cents ?? order.tax_cents;
      const baseExclTax = order.subtotal_cents + order.shipping_cents - order.discount_cents;
      const taxIncludedInTotal = effectiveTaxCents > 0 && baseExclTax === order.total_cents;
      let taxRow = "";
      let taxNote = "";
      if (effectiveTaxCents > 0) {
        const taxConfig = await getTaxConfig().catch(() => null);
        const taxLabel = taxConfig?.label || "TVA";
        if (taxIncludedInTotal) {
          taxNote = `dont ${taxLabel} ${TND(effectiveTaxCents)}`;
        } else {
          // A single shared snapshotted rate annotates the label (« TVA (19 %) »).
          const rates = Array.from(
            new Set(items.map((it) => it.tax_rate_bps).filter((b): b is number => b != null && b > 0)),
          );
          const label = rates.length === 1 ? `${taxLabel} (${formatTaxRate(rates[0])})` : taxLabel;
          taxRow = `<tr><td style="padding:2px 0;color:#6b7280;">${escapeHtml(label)}</td><td style="padding:2px 0;text-align:right;">${TND(effectiveTaxCents)}</td></tr>`;
        }
      }

      // An online order is still unpaid at creation (the customer is on their way
      // to the gateway) — never tell them it's done.
      const awaitingPayment = order.status === "pending" && isOnlineMethod(order.payment_method);

      await dispatchEmail({
        key: "order_confirmation",
        to: order.contact_email,
        flowKey: "order_confirmation",
        variables: {
          customer_name: firstNameOf(order.ship_full_name),
          order_number: order.order_number,
          order_state: awaitingPayment ? "en attente de paiement" : "enregistrée",
          payment_note: awaitingPayment
            ? "Elle sera confirmée dès réception de votre paiement en ligne."
            : "",
          total: TND(order.total_cents),
          shipping: order.shipping_cents === 0 ? "Offerte" : TND(order.shipping_cents),
          tax_note: taxNote,
          order_url: `${await resolvePublicOrigin()}/order/${order.id}`,
        },
        htmlVariables: { items_html: itemRows + subtotalRow + discountRow + taxRow },
      });
    } catch (err) {
      console.error("[events] send-order-receipt failed", err);
    }
  });
}

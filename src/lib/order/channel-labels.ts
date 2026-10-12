import type { OrderChannel } from "@/modules/order/schema";

/**
 * Single source of truth for the sales-CHANNEL copy, keyed by the `channel` order
 * column (migration 0172). Plain constants (no `server-only`) so the admin orders
 * panel (client) AND the server-rendered order detail can both import them —
 * mirrors `delivery-method-labels.ts`.
 */
export const ORDER_CHANNEL_LABELS: Record<OrderChannel, string> = {
  storefront: "Boutique en ligne",
  operator: "Saisie opérateur",
  express: "Achat express",
  erp: "ERP",
};

/** The channel values, for searchParam validation (mirror ORDER_STATUSES). */
export const ORDER_CHANNELS: readonly OrderChannel[] = [
  "storefront",
  "operator",
  "express",
  "erp",
];

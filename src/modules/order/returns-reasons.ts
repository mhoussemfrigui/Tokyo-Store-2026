/**
 * Structured return-reason taxonomy — stored on `order_returns.reason_code` so the
 * Retours dashboard can group + chart returns by motive. `reason` stays as the
 * free-text customer-stated motive; `comment` is the operator's internal note.
 *
 * Isomorphic + client-safe: no drizzle / server-only imports, so the admin
 * returns panel ("use client") can value-import it without shipping the
 * `order_returns` table definitions to the browser. Re-exported from
 * `returns.schema.ts` for the server-side consumers.
 */
export const RETURN_REASON_CODES = [
  "defective",
  "wrong_item",
  "changed_mind",
  "damaged_in_transit",
  "not_as_described",
  "other",
] as const;
export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number];

/** FR labels for the taxonomy (admin select + dashboard breakdown). */
export const RETURN_REASON_LABELS: Record<ReturnReasonCode, string> = {
  defective: "Défectueux / DOA",
  wrong_item: "Mauvais article",
  changed_mind: "Changement d'avis",
  damaged_in_transit: "Endommagé à la livraison",
  not_as_described: "Non conforme",
  other: "Autre",
};

/**
 * Return KIND — distinguishes the two Retours flows (migration 0200):
 *   - `after_sale` : classic SAV / RMA — the customer RECEIVED the goods and
 *     sends them back (defective, changed mind…). The default.
 *   - `shipment`   : « Retour d'expédition » — a SHIPPED parcel that never
 *     reached the customer (unreachable, wrong address, refused at the door) and
 *     comes back to the store (RTO). Confirming its receipt restocks the goods
 *     AND cancels the order. Fed by an operator OR an external carrier's inbound
 *     « delivery outcome » hook.
 */
export const ORDER_RETURN_KINDS = ["after_sale", "shipment"] as const;
export type OrderReturnKind = (typeof ORDER_RETURN_KINDS)[number];

export const ORDER_RETURN_KIND_LABELS: Record<OrderReturnKind, string> = {
  after_sale: "Retour après vente",
  shipment: "Retour d'expédition",
};

/**
 * Failure-reason taxonomy for a « Retour d'expédition » (`kind='shipment'`),
 * stored on the SAME `order_returns.reason_code` column (a disjoint code set, so
 * the two flows never collide). Describes WHY a shipped parcel bounced back.
 */
export const SHIPMENT_RETURN_REASON_CODES = [
  "customer_unreachable",
  "address_incorrect",
  "customer_refused",
  "customer_absent",
  "undeliverable_zone",
  "lost_in_transit",
  "other",
] as const;
export type ShipmentReturnReasonCode = (typeof SHIPMENT_RETURN_REASON_CODES)[number];

export const SHIPMENT_RETURN_REASON_LABELS: Record<ShipmentReturnReasonCode, string> = {
  customer_unreachable: "Client injoignable (tél. sans réponse)",
  address_incorrect: "Adresse incorrecte / introuvable",
  customer_refused: "Colis refusé par le client",
  customer_absent: "Client absent (tentatives épuisées)",
  undeliverable_zone: "Zone non desservie",
  lost_in_transit: "Perdu en transit",
  other: "Autre",
};

/** Safe label lookup for a shipment-return failure code (arbitrary string). */
export function shipmentReturnReasonLabel(code: string | null): string {
  if (!code) return "Non précisé";
  return SHIPMENT_RETURN_REASON_LABELS[code as ShipmentReturnReasonCode] ?? code;
}

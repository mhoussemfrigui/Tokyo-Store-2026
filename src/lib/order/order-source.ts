/**
 * Order SOURCE — the marketing / acquisition origin an operator records on a
 * « Nouvelle commande »: where the sale came FROM (a Facebook DM, an Instagram
 * message, a phone call, a walk-in…). This is DISTINCT from the `channel`
 * column (migration 0172), which is the technical creation PATH
 * (storefront / operator / express / erp).
 *
 * Plain constants (no `server-only`) so the manual-order FORM (client), the
 * action + workflow (server) and the order-detail view all share ONE list.
 * Stored as free text on `orders.source` (migration 0198) — extend by adding a
 * row here, no migration needed. NULL for storefront / express / erp orders.
 */
export const ORDER_SOURCES = [
  { value: "facebook", label: "Facebook" },
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "phone", label: "Téléphone" },
  { value: "walk_in", label: "En boutique" },
  { value: "referral", label: "Recommandation" },
  { value: "other", label: "Autre" },
] as const;

export type OrderSource = (typeof ORDER_SOURCES)[number]["value"];

/** The source keys, for schema validation (z.enum) + searchParam checks. */
export const ORDER_SOURCE_VALUES = ORDER_SOURCES.map((s) => s.value) as readonly OrderSource[];

const SOURCE_LABEL = new Map<string, string>(ORDER_SOURCES.map((s) => [s.value, s.label]));

/**
 * Human label for a stored source value. Unknown / empty → null so callers can
 * hide the row rather than render a blank or a raw key.
 */
export function orderSourceLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return SOURCE_LABEL.get(value) ?? value;
}

import type { OrderStatus, PaymentMethod } from "@/modules/order/schema";

/**
 * Single source of truth for the order-status vocabulary — display labels,
 * badge colours, the allowed-transition graph and the admin action labels.
 *
 * Previously each of these was re-declared inline in 5+ files and had already
 * drifted: customer vs admin labels disagreed ("En attente" vs "En attente de
 * paiement"; plural-feminine "Payées" on the dashboard), and the customer
 * confirmation/verify pages were MISSING the `preparing` key entirely, so an
 * order in preparation rendered a blank badge to the customer. Keyed by the
 * canonical `OrderStatus` union so a new status can't be half-added.
 *
 * Isomorphic + client-safe: only a type import from the schema (erased at
 * build), no server-only deps — imported by both RSC pages and the client
 * status-controls component.
 */
export type { OrderStatus, PaymentMethod };

/**
 * Customer/rider-facing FR payment-method labels — the ONE canonical set,
 * keyed by the full `payment_method` enum so a new value can't be half-added.
 * `konnect` is kept (marked legacy) so a historical order still renders a name;
 * the provider itself was removed. Use `paymentMethodLabel()` for a safe lookup
 * against an arbitrary string (DB value). The admin order LIST intentionally
 * keeps its own shorter labels for the dense table — that's a layout choice, not
 * a second source of truth for the customer-facing vocabulary.
 */
export const ORDER_PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cod: "À la livraison",
  flouci: "Flouci",
  clictopay: "ClicToPay",
  card_stripe: "Carte bancaire",
  cash: "Espèces",
  bank_transfer: "Virement bancaire",
  konnect: "Konnect (obsolète)", // legacy rows only — provider removed
};

/** Safe payment-method label lookup for an arbitrary string (raw DB value). */
export function paymentMethodLabel(method: string | null | undefined): string {
  if (!method) return "—";
  return ORDER_PAYMENT_METHOD_LABELS[method as PaymentMethod] ?? method;
}

export const ORDER_STATUSES: readonly OrderStatus[] = [
  "pending",
  "paid",
  "preparing",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
];

/** Display badge label (singular — "la commande"). One canonical set everywhere. */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: "En attente de paiement",
  paid: "Payée",
  preparing: "En préparation",
  shipped: "Expédiée",
  delivered: "Livrée",
  cancelled: "Annulée",
  refunded: "Remboursée",
};

/** Badge tone classes (Tailwind) — STATUS TONES palette. */
export const ORDER_STATUS_COLORS: Record<OrderStatus, string> = {
  pending: "bg-[#f6f2ed] text-[#5b5d62]",
  paid: "bg-[#eaf7ee] text-[#15803d]",
  preparing: "bg-[#fff4e0] text-[#b45309]",
  shipped: "bg-[#eef2ff] text-[#3730a3]",
  delivered: "bg-[#eaf7ee] text-[#15803d]",
  cancelled: "bg-[#fdecef] text-[#d40530]",
  refunded: "bg-[#f6f2ed] text-[#5b5d62]",
};

/**
 * Allowed forward transitions for ONLINE-paid orders. Online gateways settle
 * via the return-page verify (`confirmPayment`), backed by the gateway's silent
 * webhook (Flouci and ClicToPay both post one) + the `/api/cron/payments`
 * reconcile sweep; `cash`/`bank_transfer` are recorded paid up front by an
 * operator. Either way
 * fulfilment is gated behind `paid`: pending → paid → preparing → shipped →
 * delivered. A pending online payment that never settles can be `cancelled`
 * (customer cancel, or the reconcile cron auto-cancels a definitive decline).
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["paid", "cancelled"],
  paid: ["preparing", "cancelled", "refunded"],
  preparing: ["shipped", "cancelled"],
  shipped: ["delivered", "refunded"],
  delivered: ["refunded"],
  cancelled: [],
  refunded: [],
};

/**
 * Allowed forward transitions for CASH-ON-DELIVERY (and any non-gateway) orders.
 * COD settles at DELIVERY, not up front — so there is NO `paid` gate before
 * fulfilment. The operator accepts and prepares the order directly
 * (pending → preparing → shipped → delivered), and delivery IS the payment
 * settlement point: the coins subscriber already treats `delivered` as the COD
 * settlement, and the order service stamps `paid_at` on
 * the COD `delivered` transition. (A COD order somehow already marked `paid` —
 * e.g. prepaid by hand — still flows forward normally.)
 */
export const ORDER_STATUS_TRANSITIONS_COD: Record<OrderStatus, OrderStatus[]> = {
  pending: ["preparing", "cancelled"],
  paid: ["preparing", "cancelled", "refunded"],
  preparing: ["shipped", "cancelled"],
  shipped: ["delivered", "refunded"],
  delivered: ["refunded"],
  cancelled: [],
  refunded: [],
};

/**
 * Payment methods that settle UP FRONT via an online gateway — these keep the
 * pending→paid gate. Cash-on-delivery (and an unset method) settle at delivery,
 * so they use the COD transition graph instead.
 */
// Live gateways (`flouci`, `clictopay`) settle up front; `cash` + `bank_transfer`
// are offline counter/wire settlements an OPERATOR records as already paid
// (manual orders), so they keep the pending→paid gate too. `konnect` +
// `card_stripe` are LEGACY/forward-compat enum values (no live provider) kept
// here so any historical order placed under them retains the upfront-paid graph
// (removing konnect would route a legacy konnect order through the COD graph and
// skip the paid gate — a real regression). Only COD (and an unset method) defer
// settlement to delivery.
// Exported (as a list) so SQL aggregates — the global « À traiter » count in
// `orderService.stats()` — build their IN-list from the SAME set and can't drift
// from `isUpfrontPaidMethod` / `isActionableOrder`.
export const UPFRONT_PAID_METHODS: readonly PaymentMethod[] = [
  "konnect", // legacy — provider removed, retained for historical rows
  "flouci",
  "clictopay",
  "card_stripe", // forward-compat — no live provider yet
  "cash",
  "bank_transfer",
];
const UPFRONT_PAID_METHOD_SET: ReadonlySet<string> = new Set(UPFRONT_PAID_METHODS);

export function isUpfrontPaidMethod(method: string | null | undefined): boolean {
  return method != null && UPFRONT_PAID_METHOD_SET.has(method);
}

/**
 * Delivery methods with NO shipping leg — the order is prepared then COLLECTED at
 * a counter/drive, never handed to a courier. A pickup order must skip the
 * `shipped` step (going preparing → delivered/collected) and read « Retirée » in
 * place of « Livrée » / « Marquer expédiée ». (`home_delivery` keeps the ship leg.)
 */
const PICKUP_DELIVERY_METHODS: ReadonlySet<string> = new Set(["drive_by_pickup", "in_store"]);

export function isPickupDelivery(method: string | null | undefined): boolean {
  return method != null && PICKUP_DELIVERY_METHODS.has(method);
}

/**
 * Does an order still need an OPERATOR to act on it — the ONE « À traiter »
 * rule shared by the dashboard queue, the Commandes KPI/quick-filter and the
 * SQL count in `orderService.stats()` (keep the three in sync):
 *   - `paid` / `preparing` → yes (owes preparation / shipping);
 *   - `pending` COD (or an unset method) → yes: COD settles at delivery, so a
 *     new COD order waits in `pending` for an operator to accept + prepare it
 *     (the COD graph has no `paid` gate) — and the abandoned-orders sweep
 *     cancels it if nobody does;
 *   - `pending` ONLINE (upfront method) with no `paid_at` → no: an unpaid /
 *     abandoned gateway checkout isn't a fulfilment task (it settles through
 *     the payment verify/reconcile path or gets swept). A pending upfront order
 *     that somehow already carries `paid_at` IS actionable (money received).
 * Every other status (shipped, delivered, cancelled, refunded) is done.
 *
 * A SPAM-flagged order is never a fulfilment task — `flaggedSpamAt` set (not null)
 * makes it non-actionable regardless of status, keeping this in lockstep with
 * `actionableOrderSql` (which excludes `flagged_spam_at IS NOT NULL`). Omit the arg
 * where the flag isn't in scope (defaults to not-spam).
 */
export function isActionableOrder(
  status: string,
  paymentMethod: string | null | undefined,
  paidAt: Date | string | null | undefined,
  flaggedSpamAt?: Date | string | null | undefined,
): boolean {
  if (flaggedSpamAt != null) return false;
  if (status === "paid" || status === "preparing") return true;
  if (status !== "pending") return false;
  return !isUpfrontPaidMethod(paymentMethod) || paidAt != null;
}

/**
 * Admin-facing status label that distinguishes a pending COD order (confirmed,
 * awaiting prep — settles at delivery) from a pending ONLINE order (genuinely
 * unpaid, abandoned-gateway — a chase candidate). Mirrors `isActionableOrder`:
 * an actionable pending order reads « À préparer », a non-actionable one reads
 * « Paiement en ligne en attente ». Every non-pending status keeps the canonical
 * label. Used by the Commandes list AND the dashboard's recent orders so the
 * same order never reads « à préparer » on one screen and « en attente de
 * paiement » on the other.
 */
export function adminStatusLabel(
  status: string,
  paymentMethod: string | null | undefined,
  paidAt: Date | string | null | undefined,
  deliveryMethod?: string | null,
): string {
  // Non-pending: use the delivery-method-aware label so a COLLECTED pickup order
  // reads « Retirée » on the list + dashboard exactly as it does on the order detail
  // (never « Livrée » on one screen and « Retirée » on another).
  if (status !== "pending") return orderStatusLabelFor(status, deliveryMethod);
  if (!isActionableOrder(status, paymentMethod, paidAt)) return "Paiement en ligne en attente";
  return paymentMethod === "cod" ? "À préparer (COD)" : "À préparer";
}

/**
 * The allowed forward transitions for an order, accounting for its payment
 * method. Online-gateway orders gate fulfilment behind `paid`; COD (and unset)
 * orders skip the upfront payment step and settle at delivery. Use this — not
 * the raw maps — wherever the order's payment method is known (status controls,
 * the transition workflow guard).
 */
export function orderTransitionsFor(
  status: OrderStatus,
  paymentMethod: string | null | undefined,
  deliveryMethod?: string | null,
): OrderStatus[] {
  const graph = isUpfrontPaidMethod(paymentMethod)
    ? ORDER_STATUS_TRANSITIONS
    : ORDER_STATUS_TRANSITIONS_COD;
  const next = graph[status] ?? [];
  // Pickup (in-store / drive) has NO shipping leg — collapse a `shipped` step into
  // `delivered` (collected) so the order goes preparing → delivered directly and
  // never offers « Marquer expédiée ». Dedupe in case both were already present.
  if (isPickupDelivery(deliveryMethod)) {
    return next.reduce<OrderStatus[]>((acc, s) => {
      const mapped = s === "shipped" ? "delivered" : s;
      if (!acc.includes(mapped)) acc.push(mapped);
      return acc;
    }, []);
  }
  return next;
}

/** Imperative button label for transitioning INTO a status (admin controls). */
export const ORDER_STATUS_ACTION_LABELS: Record<OrderStatus, string> = {
  pending: "En attente",
  paid: "Marquer payée",
  preparing: "Passer en préparation",
  shipped: "Marquer expédiée",
  delivered: "Marquer livrée",
  cancelled: "Annuler",
  refunded: "Rembourser",
};

/** Safe display-label lookup for an arbitrary string (e.g. a raw DB value). */
export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status as OrderStatus] ?? status;
}

/**
 * Delivery-method-aware status label: a PICKUP order that reached « delivered » was
 * COLLECTED, so it reads « Retirée » (never « Livrée »). Every other case falls back
 * to the canonical label. Use this on the admin order detail + documents where the
 * delivery method is known.
 */
export function orderStatusLabelFor(status: string, deliveryMethod?: string | null): string {
  if (isPickupDelivery(deliveryMethod) && status === "delivered") return "Retirée";
  return orderStatusLabel(status);
}

/**
 * Delivery-method-aware imperative button label. For a PICKUP order the « delivered »
 * step is a counter collection, so the button reads « Marquer retirée » (not « livrée »).
 */
export function orderStatusActionLabelFor(status: OrderStatus, deliveryMethod?: string | null): string {
  if (isPickupDelivery(deliveryMethod) && status === "delivered") return "Marquer retirée";
  return ORDER_STATUS_ACTION_LABELS[status];
}

/** Safe badge-tone lookup for an arbitrary string. */
export function orderStatusColor(status: string): string {
  return ORDER_STATUS_COLORS[status as OrderStatus] ?? "bg-muted text-muted-foreground";
}

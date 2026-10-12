/**
 * PURE gateway-lifecycle rules shared by the provider clients, the payment
 * workflows and the order page — dependency-free (no `db`, no `fetch`, no
 * `server-only`) so the money-adjacent timing + identifier rules are
 * unit-testable without the network or the DB (payments-hardening.test.ts).
 */

/**
 * Hard ceiling on every gateway HTTP call (register / generate_payment /
 * verify). Without it a hung SMT / Flouci endpoint blocks the customer's
 * `/order/[id]?pay=return` render, the checkout action, the admin cancel guards
 * and the SEQUENTIAL reconcile / sweep crons for undici's ~5-min defaults. An
 * abort surfaces as the provider's `ok:false` → `gateway_error`, which is
 * fail-CLOSED in the cancel guards and a retryable 503 in the webhooks.
 */
export const GATEWAY_HTTP_TIMEOUT_MS = 10_000;

/** Human (French) message for a thrown gateway fetch — a timeout reads as one. */
export function gatewayFetchErrorMessage(provider: string, e: unknown, fallback: string): string {
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return `${provider} : délai de réponse dépassé (${GATEWAY_HTTP_TIMEOUT_MS / 1000} s).`;
  }
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * How long after the LAST gateway session (re)initiation a gateway `pending`
 * verdict may still be a LIVE payment page — the customer on the Flouci /
 * ClicToPay form, or 3-D Secure in progress. Flouci sessions last
 * `session_timeout_secs` = 1200 s (providers/flouci.ts) and ClicToPay's
 * register.do session defaults to 20 min; +10 min margin for 3DS / clock skew.
 */
export const GATEWAY_SESSION_WINDOW_MS = 30 * 60_000;

/**
 * Could the order's gateway session still be open (payable) at `nowMs`?
 * `lastInitiatedAt` is the order's `updated_at`, which `updatePaymentReference`
 * bumps on every initiate / resume (other writes only bump it LATER, which just
 * widens the window — conservative). Unknown / unparseable → assume LIVE
 * (fail closed: a `pending` verdict then never licenses a destructive action).
 */
export function isGatewaySessionPossiblyLive(
  lastInitiatedAt: Date | string | null | undefined,
  nowMs: number,
): boolean {
  if (lastInitiatedAt == null) return true;
  const t =
    lastInitiatedAt instanceof Date ? lastInitiatedAt.getTime() : Date.parse(lastInitiatedAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t < GATEWAY_SESSION_WINDOW_MS;
}

/** ClicToPay register.do `orderNumber` limit (AN..32 per the Basic 1.0 manual). */
export const CLICTOPAY_ORDER_NUMBER_MAX = 32;

/**
 * The merchant `orderNumber` sent to ClicToPay register.do. It must be unique
 * per merchant (a re-init of the SAME order would otherwise hit the
 * duplicate-orderNumber error), hence the timestamp suffix, and ≤ 32 chars.
 * Today's readable `<order_number>-<ms>` is kept whenever it fits (the default
 * 2-char prefix gives exactly 32); a longer admin prefix (up to 5 chars) is
 * compacted instead — dashes stripped + base-36 timestamp, keeping the LAST 32
 * chars (the unique tail). Nothing reads it back: the webhook / confirm /
 * reconcile all key on the gateway's own `orderId`.
 */
export function clictopayOrderNumber(orderNumber: string, nowMs: number): string {
  const readable = `${orderNumber}-${nowMs}`;
  if (readable.length <= CLICTOPAY_ORDER_NUMBER_MAX) return readable;
  return `${orderNumber.replace(/-/g, "")}${nowMs.toString(36)}`.slice(-CLICTOPAY_ORDER_NUMBER_MAX);
}

/** Order statuses in which an online payment is captured (a sale to count). */
const CAPTURED_STATUSES: ReadonlySet<string> = new Set(["paid", "preparing", "shipped", "delivered"]);

/**
 * How recent a WEBHOOK-first settlement must be for the customer's gateway
 * return to still be "the" purchase moment (the return redirect lands seconds
 * after the capture; an old `?pay=return` URL replayed later must not count).
 */
export const PURCHASE_RETURN_WINDOW_MS = 30 * 60_000;

/**
 * Should the `/order/[id]?pay=return` render fire the `purchase` analytics
 * event? `settleStatus` is `confirmPayment`'s verdict for THIS return:
 *   - `paid`    → this very request settled the order (returned exactly once
 *                 server-side — replays get `already`) → count it.
 *   - `already` → the silent webhook beat the browser back: count it only when
 *                 the order is genuinely captured AND was settled moments ago
 *                 (a replayed old return URL doesn't re-count; the client-side
 *                 one-shot in PurchaseTrack dedupes a same-browser replay).
 *   - anything else (still pending / declined / mismatch / no return) → no.
 */
export function shouldTrackGatewayReturnPurchase(input: {
  settleStatus: string | null;
  orderStatus: string;
  paidAt: Date | string | null | undefined;
  /** Defaults to the current time (tests pin it). */
  nowMs?: number;
}): boolean {
  if (input.settleStatus === "paid") return true;
  if (input.settleStatus !== "already" || !CAPTURED_STATUSES.has(input.orderStatus)) return false;
  if (input.paidAt == null) return false;
  const t = input.paidAt instanceof Date ? input.paidAt.getTime() : Date.parse(input.paidAt);
  const nowMs = input.nowMs ?? Date.now();
  // (A paid_at slightly AHEAD of the app clock — DB `now()` skew — still counts.)
  return Number.isFinite(t) && nowMs - t < PURCHASE_RETURN_WINDOW_MS;
}

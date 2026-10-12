/**
 * Shared types + helpers for the Tunisian payment gateways (ClicToPay,
 * Flouci). Provider-agnostic and dependency-free so both the provider clients
 * and the dispatcher import it without a cycle — and so the pure helpers
 * (`isOnlineMethod`, `ONLINE_METHODS`) are safe to use in client components.
 *
 * MONEY UNITS — the one thing never to get wrong:
 *   Tokyo Store now stores TND as integer *millimes* (×1000, the real ISO-4217
 *   minor unit) — the SAME unit the Tunisian gateways (all TND-only) expect.
 *   So the gateway boundary is now IDENTITY. (Before the centimes→millimes
 *   migration we stored ×100 and this multiplied TND by 10; that ×10 is GONE —
 *   keeping it would charge 10× the order total.)
 */

// NOTE: `konnect` was removed as a supported gateway. The pg `payment_method`
// enum KEEPS the legacy `konnect` value for historical orders, but it is no
// longer an online method here (no provider client, config, or webhook).
export type GatewayMethod = "clictopay" | "flouci";

export const ONLINE_METHODS: readonly GatewayMethod[] = ["clictopay", "flouci"];

export function isOnlineMethod(method: string | null | undefined): method is GatewayMethod {
  return method === "clictopay" || method === "flouci";
}

/**
 * Whether a gateway's `test_mode` flag actually changes runtime behavior.
 *
 *  - ClicToPay: YES — it switches the API base URL between the SMT test host
 *    (`test.clictopay.com`) and production (`ipay.clictopay.com`).
 *  - Flouci: NO — the v2 API has no sandbox host; the environment is determined
 *    SOLELY by which app credentials (test vs live token/secret) you enter, so a
 *    `test_mode` toggle is a no-op (`providers/flouci.ts` never reads it).
 *
 * The admin UI hides the sandbox toggle + mode pill for providers that return
 * false here, so an operator can never believe they're in "test mode" while
 * Flouci is actually charging real cards. Pure + client-safe (no I/O), so both
 * the server save action and the client panels can import it. Keep in lock-step
 * with each provider client's actual use of `c.testMode`.
 */
const TEST_MODE_PROVIDERS: ReadonlySet<GatewayMethod> = new Set<GatewayMethod>(["clictopay"]);
export function providerSupportsTestMode(method: GatewayMethod): boolean {
  return TEST_MODE_PROVIDERS.has(method);
}

export type InitiateInput = {
  orderId: string;
  orderNumber: string;
  amountCents: number;
  currency: string;
  email: string;
  firstName?: string;
  lastName?: string;
  /** Where the gateway returns the customer after paying / cancelling. */
  returnUrl: string;
  /** Server-to-server callback (Flouci silent webhook). Optional. */
  webhookUrl?: string;
};

export type InitiateResult =
  | { ok: true; redirectUrl: string; reference: string }
  | { ok: false; error: string };

export type VerifyStatus = "paid" | "pending" | "failed" | "cancelled";

export type VerifyResult =
  | { ok: true; status: VerifyStatus; amountMinor: number | null; currency: string | null }
  | { ok: false; error: string };

/**
 * Tokyo integer minor units → gateway minor units. Identity: we store millimes
 * and the TND-only gateways expect millimes. `_currency` kept for signature
 * stability (was used for the old centimes→millimes ×10 conversion).
 */
export function toGatewayMinor(minor: number, _currency: string): number {
  return Math.round(minor);
}

/** Gateway minor units → Tokyo integer minor units (inverse of toGatewayMinor). */
export function fromGatewayMinor(minor: number, _currency: string): number {
  return Math.round(minor);
}

import "server-only";

import { checkRateLimit, peekRateLimit } from "@/lib/rate-limit";
import { normalizePhoneDigits } from "@/lib/format/phone";

/**
 * Abuse guards for the two PUBLIC order-placement actions (full-cart checkout +
 * express « Acheter maintenant »). Kept OUT of the `"use server"` action module
 * on purpose: every export of that file is a callable Server Action endpoint, so
 * a plain helper there would be publicly invokable.
 *
 * ONLY the storefront actions call these. The operator paths (caisse / manual
 * order) and the ERP order-push reach `placeOrderWorkflow` directly and are never
 * throttled.
 */

/**
 * Per-window caps. Generous for a genuine shopper (a luxury-watch order is rarely
 * repeated within minutes) while stopping a script from flooding the Commandes
 * queue, holding tracked stock, or mailing store-branded receipts to arbitrary
 * addresses.
 *
 * What counts: every attempt that passes validation counts against the caller's
 * IP (a refused order included). The phone / email buckets count only orders
 * that were actually PLACED (`recordOrderPlaced`) and are merely peeked before
 * the workflow — those keys are typed by the caller, so counting free, refused
 * attempts would let a third party lock a victim's number or inbox out of
 * ordering. A shopper's retries after e.g. a stock error therefore cost no
 * phone/email slot.
 */
export const ORDER_RATE_LIMITS = {
  /** Per client IP. Skipped when the IP is unknown (no proxy header: local dev)
   *  so a missing header never lumps every shopper into one shared bucket. */
  ip: { max: 6, windowSeconds: 600 },
  /** Per contact phone (last 8 digits — a Tunisian number with or without +216). */
  phone: { max: 4, windowSeconds: 600 },
  /** Per contact email, when one is given (caps receipts mailed to one inbox). */
  email: { max: 4, windowSeconds: 600 },
} as const;

/** French operator/shopper message returned on a limit trip (`rate_limited`). */
export const ORDER_RATE_LIMITED_MESSAGE =
  "Trop de commandes en peu de temps, réessayez dans quelques minutes.";

/**
 * Stable rate-limit key for a phone number: digits only, reduced to the last 8
 * digits so "+216 12 345 678", "0021612345678" and "12345678" share one bucket.
 * Null when the input carries no digit at all.
 */
export function orderPhoneKey(raw: string | null | undefined): string | null {
  const digits = normalizePhoneDigits(raw);
  if (!digits) return null;
  return digits.length > 8 ? digits.slice(-8) : digits;
}

/** The phone / email bucket keys of an order contact (null = not keyed). */
function contactBucketKeys(input: {
  phone?: string | null;
  email?: string | null;
}): { phone: string | null; email: string | null } {
  const phoneKey = orderPhoneKey(input.phone);
  const emailKey = (input.email ?? "").trim().toLowerCase();
  return {
    phone: phoneKey ? `order:phone:${phoneKey}` : null,
    email: emailKey ? `order:email:${emailKey}` : null,
  };
}

/**
 * Pre-workflow order-placement throttle (IP + phone, + email when present),
 * mirroring `applyCouponAction`. Returns true when the attempt is ALLOWED.
 *
 *   1. The IP bucket is checked (and COUNTED) first; a tripped IP is refused
 *      right there, so a blocked script can't also burn anyone's phone/email slot.
 *   2. The phone / email buckets are only PEEKED (never incremented): refused
 *      once `ORDER_RATE_LIMITS.phone/email.max` orders were already placed under
 *      that contact in the window. The caller records a placed order with
 *      {@link recordOrderPlaced}.
 *
 * Fails OPEN on a rate-limit DB error (same trade-off as every other call site):
 * a hiccup in the limiter must never block a genuine sale.
 */
export async function checkOrderPlacementRateLimit(input: {
  ip: string | null;
  phone?: string | null;
  email?: string | null;
}): Promise<boolean> {
  if (input.ip) {
    const ipCheck = await checkRateLimit({
      bucket: `order:ip:${input.ip}`,
      max: ORDER_RATE_LIMITS.ip.max,
      windowSeconds: ORDER_RATE_LIMITS.ip.windowSeconds,
    }).catch(() => ({ ok: true }));
    if (!ipCheck.ok) return false;
  }

  const keys = contactBucketKeys(input);
  const peek = (bucket: string | null, max: number) =>
    bucket
      ? peekRateLimit({ bucket, max }).then((r) => r.ok).catch(() => true)
      : Promise.resolve(true);
  const results = await Promise.all([
    peek(keys.phone, ORDER_RATE_LIMITS.phone.max),
    peek(keys.email, ORDER_RATE_LIMITS.email.max),
  ]);
  return results.every(Boolean);
}

/**
 * Count a SUCCESSFULLY placed storefront order against its contact phone / email
 * buckets (the counterpart of the peek in {@link checkOrderPlacementRateLimit}).
 * Called by both public order actions only after the workflow returned ok.
 * Best-effort: a limiter DB error never surfaces to the (already placed) order.
 */
export async function recordOrderPlaced(input: {
  phone?: string | null;
  email?: string | null;
}): Promise<void> {
  const keys = contactBucketKeys(input);
  const record = (bucket: string | null, cap: { max: number; windowSeconds: number }) =>
    bucket
      ? checkRateLimit({ bucket, max: cap.max, windowSeconds: cap.windowSeconds }).then(
          () => undefined,
          () => undefined,
        )
      : Promise.resolve();
  await Promise.all([
    record(keys.phone, ORDER_RATE_LIMITS.phone),
    record(keys.email, ORDER_RATE_LIMITS.email),
  ]);
}

/**
 * The contact email an order is stored with. A blank submission falls back to the
 * signed-in account's email, so an account holder always receives the receipt /
 * confirmation / status emails even when the checkout form collects no email
 * (the default config hides the field). `acceptSubmitted: false` discards the
 * submitted value outright — used when the form has no email field, so a
 * scripted submit can't aim store-branded receipts at an arbitrary inbox.
 */
export function resolveOrderContactEmail(input: {
  submitted: string | null | undefined;
  sessionEmail: string | null | undefined;
  acceptSubmitted?: boolean;
}): string {
  const submitted = input.acceptSubmitted === false ? "" : (input.submitted ?? "").trim();
  return submitted || (input.sessionEmail ?? "").trim();
}

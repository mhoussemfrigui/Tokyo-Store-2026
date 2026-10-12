"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { track } from "@/lib/tracking/funnel";

/** Per-order one-shot marker (per browser): the COD `?fresh=1` confirmation and
 *  the gateway `?pay=return` can both be replayed (back from the gateway page,
 *  a reload racing the URL strip) — the purchase must still count once. */
const firedKey = (orderId: string) => `purchase-tracked:${orderId}`;

/**
 * Fires the `purchase` funnel event exactly once on first mount of the
 * confirmation page (COD `?fresh=1`, or the gateway return that found the
 * payment captured), then strips `?fresh=1` / `?pay=return` from the URL so a
 * refresh / back-forward navigation neither double-counts nor re-verifies.
 *
 * Lives in its own tiny client component so the surrounding confirmation
 * page can stay a pure server component. Carries the canonical totals
 * (snapshotted at order time) — never reads from localStorage / cart so
 * a slow analytics fetch can't accidentally race a state change.
 */
export function PurchaseTrack({
  orderId,
  orderNumber,
  totalCents,
  currency,
  items,
  taxCents,
  shippingCents,
}: {
  orderId: string;
  orderNumber: string;
  totalCents: number;
  currency: string;
  items: {
    item_id: string;
    item_name: string;
    price_cents: number;
    quantity: number;
  }[];
  /** Tax + shipping in minor units — `value_cents` (the grand total) bakes both
   *  in, so GA4 needs them broken out to reconcile revenue with item revenue. */
  taxCents?: number;
  shippingCents?: number;
}) {
  const router = useRouter();
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;

    // Storage can be unavailable (private mode / blocked site data) — then only
    // the in-memory ref + the URL strip below guard against a double count.
    let alreadyFired = false;
    try {
      alreadyFired = window.localStorage.getItem(firedKey(orderId)) === "1";
    } catch {
      /* benign */
    }
    if (!alreadyFired) {
      // `transaction_id` (the order NUMBER) is the only order key sent: the order
      // UUID is a bearer capability (it opens the order summary / guest receipt)
      // and must never reach the dataLayer / third-party tags.
      track("purchase", {
        transaction_id: orderNumber,
        value_cents: totalCents,
        currency,
        tax_cents: taxCents,
        shipping_cents: shippingCents,
        items,
      });
      try {
        window.localStorage.setItem(firedKey(orderId), "1");
      } catch {
        /* benign */
      }
    }

    // Strip the query params so reloads don't refire (and a settled gateway
    // return isn't re-verified). We replace history so the user's "back"
    // button still works as expected.
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("fresh");
      url.searchParams.delete("pay");
      router.replace(url.pathname + (url.search ? url.search : ""));
    } catch {
      /* benign */
    }
  }, [orderId, orderNumber, totalCents, currency, items, taxCents, shippingCents, router]);

  return null;
}

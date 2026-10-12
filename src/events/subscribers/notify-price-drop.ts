import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { wishlists, wishlist_items } from "@/modules/wishlist/schema";
import { customer_profiles } from "@/modules/customer/schema";
import { customer_user_links } from "@/associations/customer-user";
import { users } from "@/modules/auth/schema";
import { dispatchEmail, isFlowEnabled, mailingSendsService } from "@/modules/mailing";
import { productService } from "@/modules/catalog/product/service";
import { formatMoneyExact } from "@/lib/price";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { bus } from "../bus";

const FLOW = "wishlist_price_drop";

/**
 * Wishlist price-drop alert for `product.price_changed`. On a DECREASE, emails the
 * signed-in customers who have the product in their favourites AND are
 * marketing-opted-in. Anti-spam: idempotent per (product, user, NEW price) — a
 * later, lower price is a new key (re-alerts); a bounce back to a prior price
 * reuses the key (suppressed). Guest (token-only) wishlists have no email → skipped.
 */
export function registerPriceDropSubscriber() {
  bus.on("product.price_changed", async ({ payload }) => {
    try {
      if (payload.newCents >= payload.oldCents) return; // alert on drops only
      if (!(await isFlowEnabled(FLOW))) return;

      const product = await productService.findById(payload.productId);
      if (!product || !product.is_published || product.deleted_at) return;

      const percentOff = Math.round((1 - payload.newCents / payload.oldCents) * 100);
      if (percentOff < 1) return;

      const watchers = await db
        .select({ userId: users.id, email: users.email, fn: customer_profiles.first_name })
        .from(wishlist_items)
        .innerJoin(wishlists, eq(wishlists.id, wishlist_items.wishlist_id))
        .innerJoin(users, eq(users.id, wishlists.user_id))
        .innerJoin(customer_user_links, eq(customer_user_links.user_id, users.id))
        .innerJoin(
          customer_profiles,
          and(
            eq(customer_profiles.id, customer_user_links.customer_profile_id),
            eq(customer_profiles.marketing_opt_in, true),
            isNull(customer_profiles.deleted_at),
          ),
        )
        .where(eq(wishlist_items.product_id, payload.productId))
        .limit(5000);

      const pdpUrl = `${await resolvePublicOrigin()}/${product.slug}`;
      for (const w of watchers) {
        const dedupKey = `${payload.productId}:${w.userId}:${payload.newCents}`;
        const first = await mailingSendsService.claimOnce(FLOW, dedupKey).catch(() => false);
        if (!first) continue;
        const res = await dispatchEmail({
          key: "wishlist_price_drop",
          to: w.email,
          flowKey: FLOW,
          bulk: true,
          variables: {
            product_name: product.name,
            old_price: formatMoneyExact(payload.oldCents),
            new_price: formatMoneyExact(payload.newCents),
            percent_off: String(percentOff),
            pdp_url: pdpUrl,
          },
        }).catch(() => null);
        // Release the dedup claim when nothing actually went out (marketing
        // kill-switch, template disabled, consent, or a transient error), so a
        // later drop to this price can still alert. Without this the natural key
        // is burned permanently on the first blocked attempt.
        if (!res?.sent && !res?.queued) {
          await mailingSendsService.release(FLOW, dedupKey).catch(() => {});
        }
      }
    } catch (err) {
      console.error("[events] notify-price-drop failed", err);
    }
  });
}

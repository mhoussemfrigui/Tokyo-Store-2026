import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { wishlists, wishlist_items } from "@/modules/wishlist/schema";
import { customer_profiles } from "@/modules/customer/schema";
import { customer_user_links } from "@/associations/customer-user";
import { users } from "@/modules/auth/schema";
import { dispatchEmail, isFlowEnabled, mailingSendsService } from "@/modules/mailing";
import { productService } from "@/modules/catalog/product/service";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { bus } from "../bus";

const FLOW = "back_in_stock";

/**
 * Back-in-stock alert for `product.restocked` (0 → positive). Emails signed-in,
 * opted-in customers who have the product in their favourites. Idempotent per
 * (product, user, store-day) — collapses an event double-fire / multiple
 * same-day restocks into one mail, but a future-day restock re-alerts. Guest
 * wishlists (token-only) are skipped.
 */
export function registerBackInStockSubscriber() {
  bus.on("product.restocked", async ({ payload }) => {
    try {
      if (!(await isFlowEnabled(FLOW))) return;
      const product = await productService.findById(payload.productId);
      if (!product || !product.is_published || product.deleted_at) return;

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

      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tunis" }).format(new Date());
      const pdpUrl = `${await resolvePublicOrigin()}/${product.slug}`;
      for (const w of watchers) {
        const dedupKey = `${payload.productId}:${w.userId}:${day}`;
        const first = await mailingSendsService.claimOnce(FLOW, dedupKey).catch(() => false);
        if (!first) continue;
        const res = await dispatchEmail({
          key: "back_in_stock",
          to: w.email,
          flowKey: FLOW,
          bulk: true,
          variables: { product_name: product.name, pdp_url: pdpUrl },
        }).catch(() => null);
        // Release the dedup claim when nothing went out (kill-switch, template
        // disabled, consent, or a transient error) so a later same-day restock
        // can still alert — otherwise the (product,user,day) key is burned.
        if (!res?.sent && !res?.queued) {
          await mailingSendsService.release(FLOW, dedupKey).catch(() => {});
        }
      }
    } catch (err) {
      console.error("[events] notify-back-in-stock failed", err);
    }
  });
}

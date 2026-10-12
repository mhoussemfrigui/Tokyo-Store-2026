import "server-only";

/**
 * Free-shipping-only coupons must honour max_uses / max_uses_per_user (migration
 * 0116). Such a coupon contributes discount_cents = 0, so the redemption ledger
 * previously skipped it entirely (`discount_cents > 0` gate) and its caps NEVER
 * bound — unbounded free shipping. The redemption row now carries
 * `free_shipping = true` so countRedemptionsByUser + statsForPromotion count it,
 * while the refund path (reverses only discount_cents > 0) leaves it consumed.
 *
 * Self-cleaning (__fscaptest rows). Run via `pnpm test` or:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/coupon-free-shipping-cap.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { promotionService } from "@/modules/promotion";
import type { NewPromotionRow } from "@/modules/promotion/schema";
import { authService } from "@/modules/auth/service";
import { orderService } from "@/modules/order/service";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

const U = "__fscaptest-u1";

async function cleanup() {
  await db.execute(
    sql`delete from promotion_redemptions where promotion_id in (select id from promotions where name like '__fscaptest%')`,
  );
  await db.execute(sql`delete from orders where order_number like '__fscaptest%'`);
  await db.execute(sql`delete from users where id like '__fscaptest%'`);
  await db.execute(sql`delete from promotions where name like '__fscaptest%'`);
}

async function mkOrder(n: number) {
  return orderService.insertOrder({
    order_number: `__fscaptest-ord-${n}`,
    contact_email: `${U}@example.test`,
    subtotal_cents: 50_000,
    total_cents: 50_000,
    ship_full_name: "T",
    ship_street_line1: "1",
    ship_city: "Tunis",
  } as never);
}

async function main() {
  await cleanup();
  await authService.insert({ id: U, email: `${U}@example.test`, name: "U1", role: "customer" } as never);

  // A FREE-SHIPPING-ONLY coupon: no line discount, grants free shipping. Capped
  // at 1 global and 1 per-user.
  const promo = await promotionService.insert({
    name: "__fscaptest-1",
    trigger_kind: "code",
    code: "__FSCAPTEST1",
    scope: "cart",
    discount_type: "fixed",
    discount_value: 0,
    grants_free_shipping: true,
    is_active: true,
    max_uses: 1,
    max_uses_per_user: 1,
  } as NewPromotionRow);

  const o1 = await mkOrder(1);

  // Before redemption, no uses.
  check("per-user count starts at 0", (await promotionService.countRedemptionsByUser(promo.id, U)) === 0);

  // Redeem once — mirrors the place-order block for a free-ship-only coupon.
  const bumped = await promotionService.incrementUsesCount(promo.id);
  check("global cap allows the first use", bumped === true);
  await promotionService.logRedemption({
    promotion_id: promo.id,
    order_id: o1.id,
    user_id: U,
    discount_cents: 0,
    free_shipping: true,
    code_used: promo.code ?? null,
  });

  // THE FIX: a discount_cents=0 free-ship redemption is now counted.
  check("per-user cap counts the free-ship redemption (was 0 before 0116)",
    (await promotionService.countRedemptionsByUser(promo.id, U)) === 1);
  const stats = await promotionService.statsForPromotion(promo.id);
  check("statsForPromotion counts the free-ship redemption", stats.redemptions === 1);

  // The global cap is now exhausted — a second bump is refused.
  check("global cap (max_uses=1) is now exhausted", (await promotionService.incrementUsesCount(promo.id)) === false);

  // Netting on refund: a DISCOUNT redemption + its balancing reversal row cancel
  // out (signed sum), so a refunded user is no longer blocked by the per-user
  // cap — mirrors how decrementUsesCount frees the global cap. A SEPARATE user
  // keeps this isolated from the free-ship row above.
  const U2 = "__fscaptest-u2";
  await authService.insert({ id: U2, email: `${U2}@example.test`, name: "U2", role: "customer" } as never);
  const o2 = await mkOrder(2);
  await promotionService.logRedemption({
    promotion_id: promo.id, order_id: o2.id, user_id: U2,
    discount_cents: 5_000, free_shipping: false, code_used: promo.code ?? null,
  });
  check("discount redemption counts before refund", (await promotionService.countRedemptionsByUser(promo.id, U2)) === 1);
  await promotionService.logRedemption({
    promotion_id: promo.id, order_id: o2.id, user_id: U2,
    discount_cents: -5_000, free_shipping: false, code_used: promo.code ?? null,
  });
  check("refund reversal nets the per-user count back to 0 (user can re-redeem)",
    (await promotionService.countRedemptionsByUser(promo.id, U2)) === 0);

  // reconcile NEVER reverses a free-ship-only redemption (it reverses only
  // discount_cents>0 rows), so U's free-ship row stays counted (consumed) —
  // unchanged by the netting fix.
  check("free-ship-only redemption stays counted (never reversed)",
    (await promotionService.countRedemptionsByUser(promo.id, U)) === 1);

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try { await cleanup(); } catch { /* best-effort */ }
    process.exit(1);
  })
  .then(() => process.exit(0));

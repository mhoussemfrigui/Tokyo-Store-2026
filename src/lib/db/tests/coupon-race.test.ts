import "server-only";

/**
 * Per-user coupon-cap concurrency regression (DB-RACE-1 / VULN-1).
 *
 * The pre-transaction eligibility read (evaluateCouponEligibility →
 * countRedemptionsByUser) is advisory only: two concurrent same-user checkouts
 * both read used=0 and would each insert a redemption, double-redeeming a
 * once-per-customer coupon. The fix makes the per-user cap race-safe INSIDE the
 * place-order transaction: lockForRedemption (SELECT … FOR UPDATE on the promo
 * row) serializes concurrent redemptions, then countRedemptionsByUser(…, tx)
 * re-counts under the lock so the loser sees the winner's committed row.
 *
 * This drives those exact primitives concurrently (two real txns on separate
 * pooled connections) and asserts exactly ONE redemption survives. Self-cleaning
 * (__racetest rows). Run via `pnpm test` or:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/coupon-race.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { promotionService } from "@/modules/promotion";
import type { NewPromotionRow, PromotionRow } from "@/modules/promotion/schema";
import { authService } from "@/modules/auth/service";
import { orderService } from "@/modules/order/service";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

const U = "__racetest-u1";

async function cleanup() {
  await db.execute(
    sql`delete from promotion_redemptions where promotion_id in (select id from promotions where name like '__racetest%')`,
  );
  await db.execute(sql`delete from orders where order_number like '__racetest%'`);
  await db.execute(sql`delete from users where id like '__racetest%'`);
  await db.execute(sql`delete from promotions where name like '__racetest%'`);
}

async function mkOrder(n: number) {
  return orderService.insertOrder({
    order_number: `__racetest-ord-${n}`,
    contact_email: `${U}@example.test`,
    subtotal_cents: 50_000,
    total_cents: 45_000,
    ship_full_name: "T",
    ship_street_line1: "1",
    ship_city: "Tunis",
  } as never);
}

/** Mirrors the place-order redemption tx: lock → re-count under lock → if under
 *  the per-user cap, bump + log. Returns whether this attempt redeemed. */
async function attempt(promo: PromotionRow, orderId: string): Promise<"redeemed" | "rejected"> {
  return db.transaction(async (tx) => {
    await promotionService.lockForRedemption(promo.id, tx);
    const used = await promotionService.countRedemptionsByUser(promo.id, U, tx);
    if (promo.max_uses_per_user && used >= promo.max_uses_per_user) return "rejected";
    await promotionService.incrementUsesCount(promo.id, tx);
    await promotionService.logRedemption(
      { promotion_id: promo.id, order_id: orderId, user_id: U, discount_cents: 5000, code_used: promo.code ?? null },
      tx,
    );
    return "redeemed";
  });
}

async function main() {
  await cleanup();
  await authService.insert({ id: U, email: `${U}@example.test`, name: "U1", role: "customer" } as never);

  const promo = await promotionService.insert({
    name: "__racetest-1",
    trigger_kind: "code",
    code: "__RACETEST1",
    scope: "cart",
    discount_type: "percent",
    discount_value: 10,
    is_active: true,
    max_uses: null, // unlimited global — only the per-user cap should bind
    max_uses_per_user: 1,
  } as NewPromotionRow);

  const [o1, o2] = await Promise.all([mkOrder(1), mkOrder(2)]);

  // Two concurrent same-user redemptions of a 1-per-user coupon.
  const results = await Promise.all([attempt(promo, o1.id), attempt(promo, o2.id)]);

  const redeemed = results.filter((r) => r === "redeemed").length;
  const rejected = results.filter((r) => r === "rejected").length;
  const n = await promotionService.countRedemptionsByUser(promo.id, U);
  const after = await promotionService.findById(promo.id);

  check("exactly one concurrent attempt redeemed", redeemed === 1);
  check("the other attempt was rejected (saw the lock-serialized count)", rejected === 1);
  check("DB holds exactly 1 redemption for the user (per-user cap held)", n === 1);
  check("uses_count bumped exactly once", after?.uses_count === 1);

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

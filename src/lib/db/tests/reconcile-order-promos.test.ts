import "server-only";

/**
 * Order-undo PROMOTION reconciliation regression test (the P2 fix). Covers
 * `reconcileOrderPromos`: on a full refund / cancellation it appends a balancing
 * NEGATIVE promotion redemption + decrements `uses_count` (the coupon slot frees
 * up), and is IDEMPOTENT — a second reconcile (re-reading the same order) does
 * NOT double-reverse (the reversed-set guard skips rows already balanced).
 *
 * Self-cleaning (all rows tagged `__recontest…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/reconcile-order-promos.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { authService } from "@/modules/auth/service";
import { promotionService } from "@/modules/promotion";
import { orderService } from "@/modules/order/service";
import { reconcileOrderPromos } from "@/workflows/order/reconcile-order-promos";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

const U = "__recontest-u1";

async function cleanup() {
  await db.execute(
    sql`delete from promotion_redemptions where promotion_id in (select id from promotions where name like '__recontest%')`,
  );
  await db.execute(sql`delete from orders where order_number like '__recontest%'`);
  await db.execute(sql`delete from promotions where name like '__recontest%'`);
  await db.execute(sql`delete from users where id like '__recontest%'`);
}

async function redemptionRows(promotionId: string, orderId: string) {
  const rows = await promotionService.listRedemptionsForOrder(orderId);
  return rows.filter((r) => r.promotion_id === promotionId);
}

async function main() {
  await cleanup();
  try {
    await authService.insert({ id: U, email: `${U}@example.test`, name: U, role: "customer" } as never);

    // A coupon redeemed on the order.
    const promo = await promotionService.insert({
      name: "__recontest-promo",
      trigger_kind: "code",
      code: "__RECONTEST1",
      scope: "cart",
      discount_type: "percent",
      discount_value: 10,
      is_active: true,
      uses_count: 1,
    } as never);

    const order = await orderService.insertOrder({
      order_number: "__recontest-ord-1",
      contact_email: `${U}@example.test`,
      user_id: U,
      subtotal_cents: 4_000_000,
      total_cents: 4_000_000,
      ship_full_name: "T",
      ship_street_line1: "1",
      ship_city: "Tunis",
    } as never);
    await promotionService.logRedemption({
      promotion_id: promo.id,
      order_id: order.id,
      user_id: U,
      discount_cents: 5_000,
      code_used: promo.code ?? null,
    });

    // ── reconcile (mirrors a full refund / cancellation) ──
    await reconcileOrderPromos(db, order);

    const after = await redemptionRows(promo.id, order.id);
    check("promo reversal: a balancing row was appended (2 rows)", after.length === 2);
    check("promo reversal: redemption rows net to 0", after.reduce((a, r) => a + r.discount_cents, 0) === 0);
    check("promo reversal: uses_count decremented to 0", (await promotionService.findById(promo.id))?.uses_count === 0);

    // ── idempotency: a second reconcile is a no-op (reversed-set guard) ──
    await reconcileOrderPromos(db, order);
    const after2 = await redemptionRows(promo.id, order.id);
    check("idempotent: still exactly 2 redemption rows (no double reversal)", after2.length === 2);
    check("idempotent: uses_count still 0 (no double decrement)", (await promotionService.findById(promo.id))?.uses_count === 0);
  } finally {
    await cleanup();
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* best-effort cleanup */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));

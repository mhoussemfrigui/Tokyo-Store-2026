import "server-only";

/**
 * Regression test for the auto cart-wide promotion fix.
 *
 * A promotion with trigger_kind='auto' + scope='cart' applies to the whole cart
 * with NO code and NO URL. Previously it was carried by no storefront cookie, so
 * `readCartPromotionCandidates` never listed it and it discounted NOTHING (shown
 * "Active" in admin but inert). The fix lists active auto cart promos via
 * `listActiveAutoCartPromotionIds` and feeds them as fallback candidates to the
 * shared resolver, where the full eligibility gate (window / caps / min-cart)
 * still runs.
 *
 * Self-cleaning (rows tagged `__actest…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/auto-cart-promo.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { promotionService, listActiveAutoCartPromotionIds } from "@/modules/promotion";
import type { NewPromotionRow, PromotionRow } from "@/modules/promotion/schema";
import { resolveCartPromotionFromCandidates } from "@/lib/cart/coupon";

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

let seq = 0;
async function mkPromo(over: Partial<NewPromotionRow>): Promise<PromotionRow> {
  seq += 1;
  return promotionService.insert({
    name: `__actest-${seq}`,
    trigger_kind: "auto",
    scope: "cart",
    discount_type: "percent",
    discount_value: 10,
    is_active: true,
    ...over,
  } as NewPromotionRow);
}

async function cleanup() {
  await db.execute(
    sql`delete from promotion_redemptions where promotion_id in (select id from promotions where name like '__actest%')`,
  );
  await db.execute(sql`delete from promotions where name like '__actest%'`);
}

async function main() {
  await cleanup();
  try {
    // An active auto cart-wide 10% promo.
    const auto = await mkPromo({});
    const autoIds = await listActiveAutoCartPromotionIds();
    check("listActiveAutoCartPromotionIds includes an active auto cart promo", autoIds.includes(auto.id));

    // It actually applies to the cart (the whole point of the fix).
    const applied = await resolveCartPromotionFromCandidates([{ id: auto.id, source: "auto" }], {
      subtotalCents: 50_000,
      userId: null,
    });
    check("auto cart promo is applied to the cart", applied?.promotionId === auto.id);
    check("auto cart promo discounts 10% of the subtotal", applied?.discountCents === 5_000);
    check("the applied source is 'auto'", applied?.source === "auto");

    // A code-trigger cart promo is NOT an auto candidate (it needs the code path).
    const coded = await mkPromo({ trigger_kind: "code", code: `__ACTEST${seq}` });
    const afterCode = await listActiveAutoCartPromotionIds();
    check("a code-trigger promo is NOT listed as an auto candidate", !afterCode.includes(coded.id));

    // An auto PRODUCT-scope promo is handled per-line, NOT as a cart candidate.
    const prod = await mkPromo({ scope: "product", scope_id: crypto.randomUUID() });
    const afterProd = await listActiveAutoCartPromotionIds();
    check("an auto product-scope promo is NOT listed as a cart candidate", !afterProd.includes(prod.id));

    // An INACTIVE auto cart promo is excluded.
    const off = await mkPromo({ is_active: false });
    const afterOff = await listActiveAutoCartPromotionIds();
    check("an inactive auto cart promo is excluded", !afterOff.includes(off.id));

    // An EXPIRED auto cart promo is excluded by the window pre-filter.
    const expired = await mkPromo({ ends_at: new Date(Date.now() - 60_000) });
    const afterExpired = await listActiveAutoCartPromotionIds();
    check("an expired auto cart promo is excluded", !afterExpired.includes(expired.id));

    // Min-cart gate still enforced via the shared eligibility (ISSUE-24 for autos).
    const minPromo = await mkPromo({ min_cart_cents: 100_000 });
    const underMin = await resolveCartPromotionFromCandidates([{ id: minPromo.id, source: "auto" }], {
      subtotalCents: 50_000,
      userId: null,
    });
    check("auto cart promo respects min_cart (dropped under the threshold)", underMin === null);
  } finally {
    await cleanup();
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

void main();

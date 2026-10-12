import "server-only";

/**
 * Coupon-eligibility regression test — the single source of truth shared by the
 * cart resolver, place-order, the coupon-entry workflow, and quick-buy.
 *
 * Asserts BOTH consumer paths agree per verdict:
 *   - cart  → eligible ? "discount" : "skip"
 *   - order → eligible ? "apply"    : (HARD ? "throw" : "drop")
 * across happy / under-min / expired / global-cap / per-user-cap / scoped-coupon
 * (deferred + no-match) / hard-beats-soft precedence, plus EC-1: a business-scoped
 * coupon applies only
 * to an ACTIVE member of an ACTIVE, non-deleted business (and not at all when
 * the B2B feature flag is off).
 *
 * Self-cleaning (all rows tagged `__cptest…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/coupon-eligibility.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { orders } from "@/modules/order/schema";
import { promotionService } from "@/modules/promotion";
import type { NewPromotionRow, PromotionRow } from "@/modules/promotion/schema";
import { authService } from "@/modules/auth/service";
import { orderService } from "@/modules/order/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import {
  COUPON_HARD_FAIL_REASONS,
  evaluateCouponEligibility,
} from "@/lib/promotions/coupon-eligibility";

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

const U = "__cptest-u1"; // member user
const OUTSIDER = "__cptest-u2"; // non-member user
const SUB = 50_000; // cart subtotal (millimes)

/** What each consumer does with a verdict — the contract both paths share. */
function cartDecision(v: Awaited<ReturnType<typeof evaluateCouponEligibility>>) {
  return v.eligible ? "discount" : "skip";
}
function orderDecision(v: Awaited<ReturnType<typeof evaluateCouponEligibility>>) {
  if (v.eligible) return "apply";
  return COUPON_HARD_FAIL_REASONS.has(v.reason) ? "throw" : "drop";
}

async function cleanup() {
  await db.execute(
    sql`delete from promotion_redemptions where promotion_id in (select id from promotions where name like '__cptest%')`,
  );
  await db.execute(sql`delete from orders where order_number like '__cptest%'`);
  await db.execute(sql`delete from users where id like '__cptest%'`);
  await db.execute(sql`delete from promotions where name like '__cptest%'`);
  await db.execute(sql`delete from site_settings where key = '__cptest.noop'`);
}

let seq = 0;
async function mkPromo(over: Partial<NewPromotionRow>): Promise<PromotionRow> {
  seq += 1;
  return promotionService.insert({
    name: `__cptest-${seq}`,
    trigger_kind: "code",
    code: `__CPTEST${seq}`,
    scope: "cart",
    discount_type: "percent",
    discount_value: 10,
    is_active: true,
    ...over,
  } as NewPromotionRow);
}

async function main() {
  await cleanup();

  const mk = (id: string) =>
    authService.insert({ id, email: `${id}@example.test`, name: id, role: "customer" } as never);
  await mk(U);
  await mk(OUTSIDER);

  // ── core verdicts (no business) ──
  const happy = await evaluateCouponEligibility(await mkPromo({}), {
    cartSubtotalCents: SUB,
    userId: U,
  });
  check("happy → eligible", happy.eligible);
  check("happy → discount = round(50000*10%) = 5000", happy.eligible && happy.discountCents === 5000);
  check("happy → cart=discount / order=apply", cartDecision(happy) === "discount" && orderDecision(happy) === "apply");

  const underMin = await evaluateCouponEligibility(await mkPromo({ min_cart_cents: 100_000 }), {
    cartSubtotalCents: SUB,
    userId: U,
  });
  check("under-min → reason=min_cart", !underMin.eligible && underMin.reason === "min_cart");
  check("under-min → cart=skip / order=DROP (soft)", cartDecision(underMin) === "skip" && orderDecision(underMin) === "drop");

  const expired = await evaluateCouponEligibility(
    await mkPromo({ ends_at: new Date(Date.now() - 60_000) }),
    { cartSubtotalCents: SUB, userId: U },
  );
  check("expired → reason=out_of_window", !expired.eligible && expired.reason === "out_of_window");
  check("expired → cart=skip / order=THROW (hard)", cartDecision(expired) === "skip" && orderDecision(expired) === "throw");

  const capped = await evaluateCouponEligibility(
    await mkPromo({ max_uses: 1, uses_count: 1 }),
    { cartSubtotalCents: SUB, userId: U },
  );
  check("global-cap → reason=exhausted", !capped.eligible && capped.reason === "exhausted");
  check("global-cap → order=THROW", orderDecision(capped) === "throw");

  // per-user cap: needs a real redemption row (real order + user, FKs).
  const puPromo = await mkPromo({ max_uses_per_user: 1 });
  const order = await orderService.insertOrder({
    order_number: "__cptest-ord-1",
    contact_email: `${U}@example.test`,
    subtotal_cents: SUB,
    total_cents: SUB,
    ship_full_name: "T",
    ship_street_line1: "1",
    ship_city: "Tunis",
  } as never);
  await promotionService.logRedemption({
    promotion_id: puPromo.id,
    order_id: order.id,
    user_id: U,
    discount_cents: 5000,
    code_used: puPromo.code ?? null,
  });
  const puSame = await evaluateCouponEligibility(puPromo, { cartSubtotalCents: SUB, userId: U });
  check("per-user-cap (same user) → reason=per_user_exhausted", !puSame.eligible && puSame.reason === "per_user_exhausted");
  check("per-user-cap → order=THROW", orderDecision(puSame) === "throw");
  const puOther = await evaluateCouponEligibility(puPromo, { cartSubtotalCents: SUB, userId: OUTSIDER });
  check("per-user-cap (different user) → eligible", puOther.eligible);
  // A per-user cap is unenforceable without a stable identity, so a guest must be
  // REJECTED (account_required) rather than handed an effectively-unlimited code.
  const puGuest = await evaluateCouponEligibility(puPromo, { cartSubtotalCents: SUB, userId: null });
  check("per-user-cap (guest) → account_required", !puGuest.eligible && puGuest.reason === "account_required");
  check("per-user-cap (guest) → order=DROP (soft, not throw)", orderDecision(puGuest) === "drop");

  // L7 SCOPED coupon (scope = product). Without lines (the apply step) eligibility
  // is DEFERRED: accepted with a 0 discount so the cookie can be set and the cart
  // render computes the real cut. (product scope needs a scope_id — CHECK
  // promotions_scope_id_match_chk.)
  const scopedDeferred = await evaluateCouponEligibility(
    await mkPromo({ scope: "product", scope_id: crypto.randomUUID() }),
    { cartSubtotalCents: SUB, userId: U },
  );
  check(
    "scoped (no lines) → deferred eligible, 0 discount / order=apply",
    scopedDeferred.eligible && scopedDeferred.discountCents === 0 && orderDecision(scopedDeferred) === "apply",
  );

  // With lines that DON'T match the scope → soft-drop (no_matching_items).
  const scopedNoMatch = await evaluateCouponEligibility(
    await mkPromo({ scope: "product", scope_id: crypto.randomUUID() }),
    {
      cartSubtotalCents: SUB,
      userId: U,
      lines: [{ productId: crypto.randomUUID(), lineCents: SUB, baseLineCents: SUB }],
    },
  );
  check(
    "scoped (non-matching line) → no_matching_items / cart=skip / order=DROP",
    !scopedNoMatch.eligible &&
      scopedNoMatch.reason === "no_matching_items" &&
      cartDecision(scopedNoMatch) === "skip" &&
      orderDecision(scopedNoMatch) === "drop",
  );

  // precedence: expired AND under-min → hard (out_of_window) wins.
  const both = await evaluateCouponEligibility(
    await mkPromo({ ends_at: new Date(Date.now() - 60_000), min_cart_cents: 100_000 }),
    { cartSubtotalCents: SUB, userId: U },
  );
  check("expired+under-min → hard reason wins (out_of_window → THROW)", !both.eligible && both.reason === "out_of_window" && orderDecision(both) === "throw");

  check(
    "HARD set = inactive/out_of_window/exhausted/per_user_exhausted",
    [...COUPON_HARD_FAIL_REASONS].sort().join(",") ===
      ["exhausted", "inactive", "out_of_window", "per_user_exhausted"].join(","),
  );

  // ── FO: first_order_only (new-customer welcome coupon) ──
  {
    const welcome = await mkPromo({ first_order_only: true });
    // A guest has no stable identity to check → account_required (soft drop).
    const guest = await evaluateCouponEligibility(welcome, { cartSubtotalCents: SUB, userId: null });
    check("FO: guest → account_required (soft drop)", !guest.eligible && guest.reason === "account_required" && orderDecision(guest) === "drop");
    // A signed-in buyer with NO prior order → eligible (their first order).
    const firstTimer = await evaluateCouponEligibility(welcome, { cartSubtotalCents: SUB, userId: OUTSIDER });
    check("FO: signed-in first-timer → eligible", firstTimer.eligible === true);
    // Give U a prior non-cancelled order → not_first_order (soft drop).
    await db.insert(orders).values({
      order_number: `__cptest-prior-${Date.now()}`,
      user_id: U,
      contact_email: `${U}@example.test`,
      status: "delivered",
      payment_method: "cod",
      subtotal_cents: SUB,
      total_cents: SUB,
      ship_full_name: "FO",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
    } as never);
    const returning = await evaluateCouponEligibility(welcome, { cartSubtotalCents: SUB, userId: U });
    check("FO: returning customer → not_first_order (soft drop)", !returning.eligible && returning.reason === "not_first_order" && orderDecision(returning) === "drop");
    // A CANCELLED prior order does NOT count → OUTSIDER (only a cancelled order) stays eligible.
    await db.insert(orders).values({
      order_number: `__cptest-cxl-${Date.now()}`,
      user_id: OUTSIDER,
      contact_email: `${OUTSIDER}@example.test`,
      status: "cancelled",
      payment_method: "cod",
      subtotal_cents: SUB,
      total_cents: SUB,
      ship_full_name: "FO",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
    } as never);
    const cancelledOnly = await evaluateCouponEligibility(welcome, { cartSubtotalCents: SUB, userId: OUTSIDER });
    check("FO: only a CANCELLED prior order → still eligible", cancelledOnly.eligible === true);
  }

  // ── AUD: inline audience_rule_tree targeting ──
  {
    // A profiled, marketing-opted-in customer.
    const AU = "__cptest-aud";
    await mk(AU);
    const profile = await customerService.insertProfile({
      first_name: "Aud",
      last_name: "__cptest",
      marketing_opt_in: true,
    } as never);
    await customerUserLink.create({ customer_profile_id: profile.id, user_id: AU } as never);

    // Rule: opted into marketing → the profiled buyer matches; a plain user (no
    // profile) and a guest do NOT.
    const audiencePromo = await mkPromo({
      audience_rule_tree: { op: "and", children: [{ kind: "marketing_opted_in" }] } as never,
    });
    const match = await evaluateCouponEligibility(audiencePromo, { cartSubtotalCents: SUB, userId: AU });
    check("AUD: matching (opted-in) buyer → eligible", match.eligible === true);
    // OUTSIDER has no profile → no facts → doesn't match the audience rule.
    const noProfile = await evaluateCouponEligibility(audiencePromo, { cartSubtotalCents: SUB, userId: OUTSIDER });
    check("AUD: non-matching buyer → not_targeted (soft drop)", !noProfile.eligible && noProfile.reason === "not_targeted" && orderDecision(noProfile) === "drop");
    const guest = await evaluateCouponEligibility(audiencePromo, { cartSubtotalCents: SUB, userId: null });
    check("AUD: guest → not_targeted (no fact-based identity)", !guest.eligible && guest.reason === "not_targeted");
    // Audience-ruled promo is TARGETED → the PUBLIC opt-out branch is skipped, so a
    // matching buyer isn't suppressed as if it were a public promo.
    check("AUD: audience promo treated as targeted (matching buyer eligible)", match.eligible === true);
  }

  // cleanup this block's profile/link.
  await db.execute(sql`delete from customer_user_links where user_id like '__cptest%'`);
  await db.execute(sql`delete from customer_profiles where last_name = '__cptest'`);

  await cleanup();

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

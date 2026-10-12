import "server-only";

/**
 * Promotion targeting + opt-outs + new params (migration 0042) regression test.
 * Drives the SINGLE eligibility source (evaluateCouponEligibility) end-to-end
 * against real targets, segments, opt-out flags, the percent cap, and free
 * shipping. Self-cleaning (all rows tagged `__pttest…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/promotion-targeting.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { segmentService } from "@/modules/customer/segment.service";
import { promotionService } from "@/modules/promotion";
import type { NewPromotionRow, PromotionRow } from "@/modules/promotion/schema";
import { orderService } from "@/modules/order/service";
import { resolveSegmentIdsForProfile, storeMonth } from "@/lib/promotions/segments";
import { evaluateCouponEligibility } from "@/lib/promotions/coupon-eligibility";
import { workflows } from "@/workflows";

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

const SUB = 50_000;

async function cleanup() {
  await db.execute(
    sql`delete from promotion_targets where promotion_id in (select id from promotions where name like '__pttest%')`,
  );
  await db.execute(
    sql`delete from customer_segment_members where segment_id in (select id from customer_segments where name like '__pttest%')`,
  );
  await db.execute(sql`delete from customer_segments where name like '__pttest%'`);
  // Section 10 inserts raw orders to exercise the has_orders/no_orders dynamic
  // rule; remove them before users (orders.user_id text-matches the user id).
  await db.execute(sql`delete from orders where order_number like '__pttest%'`);
  await db.execute(sql`delete from customer_user_links where user_id like '__pttest%'`);
  await db.execute(sql`delete from customer_profiles where first_name = '__pttest'`);
  await db.execute(sql`delete from promotions where name like '__pttest%'`);
  await db.execute(sql`delete from users where id like '__pttest%'`);
}

let seq = 0;
async function mkPromo(over: Partial<NewPromotionRow>): Promise<PromotionRow> {
  seq += 1;
  return promotionService.insert({
    name: `__pttest-${seq}`,
    trigger_kind: "code",
    code: `__PTTEST${seq}`,
    scope: "cart",
    discount_type: "percent",
    discount_value: 10,
    is_active: true,
    ...over,
  } as NewPromotionRow);
}

async function mkCustomer(id: string, over: Record<string, unknown> = {}): Promise<string> {
  await authService.insert({ id, email: `${id}@example.test`, name: id, role: "customer" } as never);
  const profile = await customerService.insertProfile({
    first_name: "__pttest",
    last_name: "x",
    ...over,
  } as never);
  await customerUserLink.create({ customer_profile_id: profile.id, user_id: id } as never);
  return profile.id;
}

const elig = (promo: PromotionRow, userId: string | null) =>
  evaluateCouponEligibility(promo, { cartSubtotalCents: SUB, userId });

async function main() {
  await cleanup();

  // Actors.
  const aliceProfile = await mkCustomer("__pttest-alice", { marketing_opt_in: true });
  const bobProfile = await mkCustomer("__pttest-bob", {});

  // ── 1) PUBLIC promo applies to everyone ──
  const pub = await mkPromo({});
  check("public → alice eligible", (await elig(pub, "__pttest-alice")).eligible);
  check("public → guest eligible", (await elig(pub, null)).eligible);

  // ── 2) CUSTOMER target ──
  const custPromo = await mkPromo({});
  await promotionService.setTargets(custPromo.id, [
    { target_type: "customer", target_id: aliceProfile },
  ]);
  check("customer-target → alice eligible", (await elig(custPromo, "__pttest-alice")).eligible);
  const bobOnCust = await elig(custPromo, "__pttest-bob");
  check("customer-target → bob not_targeted", !bobOnCust.eligible && bobOnCust.reason === "not_targeted");
  const guestOnCust = await elig(custPromo, null);
  check("customer-target → guest not_targeted", !guestOnCust.eligible && guestOnCust.reason === "not_targeted");

  // ── 4) MANUAL segment target ──
  const manualSeg = await segmentService.insert({ name: "__pttest-vip", kind: "manual" } as never);
  await segmentService.addMember(manualSeg.id, aliceProfile);
  const segPromo = await mkPromo({});
  await promotionService.setTargets(segPromo.id, [{ target_type: "segment", target_id: manualSeg.id }]);
  check("manual-segment → member alice eligible", (await elig(segPromo, "__pttest-alice")).eligible);
  const bobOnSeg = await elig(segPromo, "__pttest-bob");
  check("manual-segment → non-member bob not_targeted", !bobOnSeg.eligible && bobOnSeg.reason === "not_targeted");

  // ── 5b) MULTI-TARGET: any matching arm wins (customer OR segment) ──
  const multiPromo = await mkPromo({});
  await promotionService.setTargets(multiPromo.id, [
    { target_type: "customer", target_id: bobProfile }, // bob matches here
    { target_type: "segment", target_id: manualSeg.id }, // alice matches here
  ]);
  check("multi-target → bob eligible (customer arm)", (await elig(multiPromo, "__pttest-bob")).eligible);
  check("multi-target → alice eligible (segment arm)", (await elig(multiPromo, "__pttest-alice")).eligible);
  await mkCustomer("__pttest-carol", {});
  const carolMulti = await elig(multiPromo, "__pttest-carol");
  check("multi-target → unrelated customer not_targeted", !carolMulti.eligible && carolMulti.reason === "not_targeted");

  // ── 5c) DISABLING a manual segment stops it matching (was a silent no-op) ──
  await segmentService.update(manualSeg.id, { enabled: false } as never);
  const aliceDisabledSeg = await elig(segPromo, "__pttest-alice");
  check(
    "disabled manual segment → member not_targeted",
    !aliceDisabledSeg.eligible && aliceDisabledSeg.reason === "not_targeted",
  );
  await segmentService.update(manualSeg.id, { enabled: true } as never);

  // ── 6) CUSTOMER opt-out suppresses PUBLIC promos ──
  await customerService.updateProfile(bobProfile, { promo_opt_out: true } as never);
  const bobOptOut = await elig(pub, "__pttest-bob");
  check("public + customer opt-out → excluded", !bobOptOut.eligible && bobOptOut.reason === "excluded");
  // …but a TARGETED promo still applies to the opted-out customer
  const optOutTargeted = await mkPromo({});
  await promotionService.setTargets(optOutTargeted.id, [{ target_type: "customer", target_id: bobProfile }]);
  check("targeted promo still applies to opted-out customer", (await elig(optOutTargeted, "__pttest-bob")).eligible);

  // ── 8) Percent MAX-DISCOUNT cap ──
  const capped = await mkPromo({ discount_type: "percent", discount_value: 50, max_discount_cents: 3000 });
  const capVerdict = await elig(capped, "__pttest-alice");
  check("percent 50% of 50000 capped at 3000", capVerdict.eligible && capVerdict.discountCents === 3000);

  // ── 9) FREE-SHIPPING promo ──
  const freeShip = await mkPromo({ discount_type: "percent", discount_value: 0, grants_free_shipping: true });
  const fsVerdict = await elig(freeShip, "__pttest-alice");
  check("free-shipping-only → eligible, discount 0, grantsFreeShipping", fsVerdict.eligible && fsVerdict.discountCents === 0 && fsVerdict.grantsFreeShipping === true);
  const pubFs = await elig(pub, "__pttest-alice");
  check("normal promo → grantsFreeShipping false", pubFs.eligible && pubFs.grantsFreeShipping === false);

  // ── 10) Dynamic has_orders/no_orders count only PLACED orders (not pending/refunded) ──
  const daveProfileId = await mkCustomer("__pttest-dave", {});
  const daveFacts = { id: daveProfileId, marketing_opt_in: false, birthday: null, gender: null, created_at: new Date("2024-01-01T00:00:00Z") };
  const noOrdersSeg = await segmentService.insert({ name: "__pttest-newcomers", kind: "dynamic", rule: "no_orders" } as never);
  const hasOrdersSeg = await segmentService.insert({ name: "__pttest-returning", kind: "dynamic", rule: "has_orders" } as never);
  const segsOf = async () => resolveSegmentIdsForProfile(daveFacts, "__pttest-dave");
  let segs = await segsOf();
  check("0 orders → in no_orders, not has_orders", segs.includes(noOrdersSeg.id) && !segs.includes(hasOrdersSeg.id));

  const mkOrder = async (n: string, status: string) => {
    await orderService.insertOrder({
      order_number: `__pttest-ord-${n}`,
      contact_email: "__pttest-dave@example.test",
      user_id: "__pttest-dave",
      status,
      subtotal_cents: SUB,
      total_cents: SUB,
      ship_full_name: "T",
      ship_street_line1: "1",
      ship_city: "Tunis",
    } as never);
  };
  await mkOrder("pending", "pending");
  await mkOrder("refunded", "refunded");
  segs = await segsOf();
  check("pending + refunded orders → STILL no_orders (not placed)", segs.includes(noOrdersSeg.id) && !segs.includes(hasOrdersSeg.id));
  await mkOrder("paid", "paid");
  segs = await segsOf();
  check("a paid order → now has_orders, no longer no_orders", segs.includes(hasOrdersSeg.id) && !segs.includes(noOrdersSeg.id));

  // ── 12) BIRTHDAY-MONTH dynamic segment (birthday gift targeting) ──
  // Build fixtures in the SAME frame the resolver uses (storeMonth, store TZ) so
  // these end-to-end checks can't flake on a server/test-machine TZ split. They
  // still read the live clock via elig(), so a month boundary crossed within the
  // few ms of this block is a negligible theoretical flake; the deterministic
  // injected-now checks below nail the month logic clock-independently.
  const thisMonthNum = storeMonth();
  const thisMm = String(thisMonthNum).padStart(2, "0");
  const otherMm = String(((thisMonthNum - 1 + 6) % 12) + 1).padStart(2, "0"); // 6 months away, always ≠
  const eveProfileId = await mkCustomer("__pttest-eve", { birthday: `1990-${thisMm}-15` });
  await mkCustomer("__pttest-frank", { birthday: `1990-${otherMm}-15` });
  await mkCustomer("__pttest-nobday", {}); // birthday NULL
  const bdaySeg = await segmentService.insert({
    name: "__pttest-bday",
    kind: "dynamic",
    rule: "birthday_month",
  } as never);
  const bdayPromo = await mkPromo({});
  await promotionService.setTargets(bdayPromo.id, [{ target_type: "segment", target_id: bdaySeg.id }]);
  check("birthday_month → eve (birthday this month) eligible", (await elig(bdayPromo, "__pttest-eve")).eligible);
  const frankBday = await elig(bdayPromo, "__pttest-frank");
  check("birthday_month → frank (other month) not_targeted", !frankBday.eligible && frankBday.reason === "not_targeted");
  const noBday = await elig(bdayPromo, "__pttest-nobday");
  check("birthday_month → no birthday set → not_targeted", !noBday.eligible && noBday.reason === "not_targeted");
  // Deterministic month-boundary check via an injected reference date (CLOCK-
  // INDEPENDENT, unlike the live-clock elig() checks above): a June-15 birthday
  // matches in June, not in July.
  const juneFacts = { id: eveProfileId, marketing_opt_in: false, birthday: "1990-06-15", gender: null, created_at: new Date("2024-01-01T00:00:00Z") };
  const segsJune = await resolveSegmentIdsForProfile(juneFacts, "__pttest-eve", { now: new Date("2024-06-10T12:00:00") });
  check("birthday_month resolver → June birthday matches in June", segsJune.includes(bdaySeg.id));
  const segsJuly = await resolveSegmentIdsForProfile(juneFacts, "__pttest-eve", { now: new Date("2024-07-10T12:00:00") });
  check("birthday_month resolver → June birthday does NOT match in July", !segsJuly.includes(bdaySeg.id));

  // ── 13) FAIL-CLOSED targeting through the create/update WORKFLOWS ──
  // A targeted coupon must never silently become PUBLIC because every target
  // was dropped (unknown email, disabled/deleted segment).
  const wfBase = (name: string, code: string) => ({
    name,
    triggerKind: "code" as const,
    code,
    scope: "cart" as const,
    discountType: "percent" as const,
    discountValue: 10,
  });
  const actor = { actorUserId: "__pttest-alice" };
  const targetsOf = async (id: string) => promotionService.listTargets(id);

  // 13a) create with ONLY an unknown email → refused (would be public), field errors set.
  const onlyUnknown = await workflows.promotion.create(
    { ...wfBase("__pttest-wf-unknown", "__PTTESTWF1"), targetCustomerEmails: ["__pttest-nobody@example.test"] },
    actor,
  );
  check(
    "create: only an unknown email → validation fail (not saved public)",
    !onlyUnknown.ok &&
      onlyUnknown.error === "validation" &&
      !!onlyUnknown.fieldErrors?.targets &&
      (onlyUnknown.fieldErrors?.targetCustomerEmails ?? "").includes("__pttest-nobody@example.test"),
  );
  check(
    "create: refused promo row was NOT inserted",
    !(await promotionService.findLiveByCode("__PTTESTWF1")),
  );

  // 13b) create with a known + an unknown email → saved, targeted, with a warning.
  const partial = await workflows.promotion.create(
    {
      ...wfBase("__pttest-wf-partial", "__PTTESTWF2"),
      targetCustomerEmails: ["__pttest-alice@example.test", "__pttest-ghost@example.test"],
    },
    actor,
  );
  check("create: partial email drop → saved", partial.ok);
  if (partial.ok) {
    const t = await targetsOf(partial.data.promotionId);
    check("create: partial → 1 customer target (alice)", t.length === 1 && t[0].target_id === aliceProfile);
    check(
      "create: partial → warning names the dropped email",
      partial.data.warnings.some((w) => w.includes("__pttest-ghost@example.test")),
    );
  }

  // 13c) create with ONLY a disabled segment → refused.
  const offSeg = await segmentService.insert({ name: "__pttest-offseg", kind: "manual", enabled: false } as never);
  const onlyDisabledSeg = await workflows.promotion.create(
    { ...wfBase("__pttest-wf-offseg", "__PTTESTWF3"), targetSegmentIds: [offSeg.id] },
    actor,
  );
  check("create: only a disabled segment → validation fail", !onlyDisabledSeg.ok && onlyDisabledSeg.error === "validation");

  // 13d) ILIKE look-alike: `_` is a wildcard — a typo'd address must not target
  // a DIFFERENT account that happens to match the pattern.
  await mkCustomer("__pttest-axb", {});
  const lookAlike = await workflows.promotion.create(
    { ...wfBase("__pttest-wf-lookalike", "__PTTESTWF4"), targetCustomerEmails: ["__pttest-a_b@example.test"] },
    actor,
  );
  check("create: ILIKE look-alike email is NOT resolved to another account", !lookAlike.ok);

  // 13e) THE edit-save scenario: segment target later DISABLED, then a routine
  // edit re-submits it (the edit page re-renders disabled targeted segments) →
  // the target must be KEPT (fail closed), not wiped to public.
  const vipSeg = await segmentService.insert({ name: "__pttest-vip2", kind: "manual" } as never);
  await segmentService.addMember(vipSeg.id, aliceProfile);
  const vipPromo = await workflows.promotion.create(
    { ...wfBase("__pttest-wf-vip", "__PTTESTWF5"), targetSegmentIds: [vipSeg.id] },
    actor,
  );
  check("create: live segment target → saved", vipPromo.ok);
  if (vipPromo.ok) {
    const id = vipPromo.data.promotionId;
    await segmentService.update(vipSeg.id, { enabled: false } as never);
    const edit = await workflows.promotion.update(
      { ...wfBase("__pttest-wf-vip (edited)", "__PTTESTWF5"), promotionId: id, targetSegmentIds: [vipSeg.id] },
      actor,
    );
    check("update: re-submitted DISABLED segment → saved", edit.ok);
    const t = await targetsOf(id);
    check("update: disabled segment target KEPT", t.length === 1 && t[0].target_id === vipSeg.id);
    const row = await promotionService.findById(id);
    const guest = row ? await elig(row, null) : null;
    check(
      "update: coupon stays restricted (guest not_targeted, not public)",
      !!guest && !guest.eligible && guest.reason === "not_targeted",
    );

    // 13f) same promo — the segment is then DELETED (the form can no longer
    // render it, so nothing is submitted) → the orphan is kept, with a warning.
    await segmentService.softDelete(vipSeg.id);
    const edit2 = await workflows.promotion.update(
      { ...wfBase("__pttest-wf-vip (edited2)", "__PTTESTWF5"), promotionId: id },
      actor,
    );
    check("update: nothing submitted + only a DELETED segment target → saved", edit2.ok);
    const t2 = await targetsOf(id);
    check("update: deleted-segment orphan target KEPT (not widened to public)", t2.length === 1 && t2[0].target_id === vipSeg.id);
    check(
      "update: orphan preservation is reported as a warning",
      edit2.ok && edit2.data.warnings.some((w) => w.includes("Ciblage conservé")),
    );
    // …but a NEW, valid target replaces the orphan (pruning it only narrows).
    const edit3 = await workflows.promotion.update(
      { ...wfBase("__pttest-wf-vip (edited3)", "__PTTESTWF5"), promotionId: id, targetCustomerEmails: ["__pttest-bob@example.test"] },
      actor,
    );
    const t3 = await targetsOf(id);
    check(
      "update: new valid target replaces the dead orphan",
      edit3.ok && t3.length === 1 && t3[0].target_type === "customer" && t3[0].target_id === bobProfile,
    );
    // …and adding a NEW disabled segment next to it is dropped with a warning.
    const edit4 = await workflows.promotion.update(
      {
        ...wfBase("__pttest-wf-vip (edited4)", "__PTTESTWF5"),
        promotionId: id,
        targetCustomerEmails: ["__pttest-bob@example.test"],
        targetSegmentIds: [offSeg.id],
      },
      actor,
    );
    const t4 = await targetsOf(id);
    check(
      "update: NEW disabled segment dropped (warned), valid target kept",
      edit4.ok && t4.length === 1 && edit4.data.warnings.some((w) => w.includes("segment")),
    );
  }

  // 13g) positive control: an admin deliberately clearing a LIVE target → public.
  const liveSeg = await segmentService.insert({ name: "__pttest-live", kind: "manual" } as never);
  const clearPromo = await workflows.promotion.create(
    { ...wfBase("__pttest-wf-clear", "__PTTESTWF6"), targetSegmentIds: [liveSeg.id] },
    actor,
  );
  if (clearPromo.ok) {
    const cleared = await workflows.promotion.update(
      { ...wfBase("__pttest-wf-clear (public)", "__PTTESTWF6"), promotionId: clearPromo.data.promotionId },
      actor,
    );
    const t = await targetsOf(clearPromo.data.promotionId);
    check("update: deliberately clearing a LIVE target → public (no targets)", cleared.ok && t.length === 0);
  } else {
    check("create: live segment target (clear control) → saved", false);
  }

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
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));

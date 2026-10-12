import "server-only";

/**
 * Mailing — `resolvePromotionAudience` regression test. Covers the targeting
 * shapes the promo-announcement blast resolves against:
 *   • public (no targets)   → every opt-in customer, minus public-promo opt-outs
 *   • customer-only target  → the direct-lookup short-circuit (no full scan)
 *   • manual-segment target → opt-in members who match the segment
 *   • dynamic-segment target → opt-in customers whose facts match the rule tree
 * Also asserts a targeted promo reaches a customer who opted OUT of PUBLIC promos
 * (promo_opt_out only suppresses PUBLIC blasts), that an inline audience_rule_tree
 * narrows the blast, and that first_order_only mails only first-time buyers.
 * Self-cleaning (`__mailtest…`).
 * Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/mailing-promotion-audience.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { resolvePromotionAudience } from "@/lib/mailing/audience";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { segmentService } from "@/modules/customer/segment.service";
import { promotionService } from "@/modules/promotion";
import { orderService } from "@/modules/order/service";
import type { NewPromotionRow, PromotionRow } from "@/modules/promotion/schema";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function has(list: { email: string }[], email: string): boolean {
  return list.some((r) => r.email === email);
}

type Row = Record<string, unknown>;
function rowsOf(res: unknown): Row[] {
  const r = res as { rows?: Row[] };
  return r.rows ?? (res as Row[]);
}

async function cleanup() {
  await db.execute(
    sql`delete from promotion_targets where promotion_id in (select id from promotions where name like '__mailtest%')`,
  );
  await db.execute(sql`delete from promotions where name like '__mailtest%'`);
  await db.execute(
    sql`delete from customer_segment_members where segment_id in (select id from customer_segments where name like '__mailtest%')`,
  );
  await db.execute(sql`delete from customer_segments where name like '__mailtest%'`);
  await db.execute(sql`delete from orders where order_number like '__mailtest%'`);
  await db.execute(sql`delete from customer_user_links where user_id like '__mailtest%'`);
  await db.execute(sql`delete from customer_profiles where first_name = '__mailtest'`);
  await db.execute(sql`delete from users where id like '__mailtest%'`);
}

let seq = 0;
async function mkPromo(): Promise<PromotionRow> {
  seq += 1;
  return promotionService.insert({
    name: `__mailtest-promo-${seq}`,
    trigger_kind: "code",
    code: `__MAILTESTP${seq}`,
    scope: "cart",
    discount_type: "percent",
    discount_value: 10,
    is_active: true,
  } as NewPromotionRow);
}

async function mkCustomer(
  id: string,
  opts: { optIn: boolean; promoOptOut?: boolean; gender?: string | null },
): Promise<string> {
  await authService.insert({ id, email: `${id}@example.test`, name: id, role: "customer" } as never);
  const profile = await customerService.insertProfile({
    first_name: "__mailtest",
    last_name: "x",
    marketing_opt_in: opts.optIn,
    promo_opt_out: opts.promoOptOut ?? false,
    gender: opts.gender ?? null,
  } as never);
  await customerUserLink.create({ customer_profile_id: profile.id, user_id: id } as never);
  return profile.id;
}

async function main() {
  await cleanup();

  const alice = await mkCustomer("__mailtest-alice", { optIn: true });
  const bob = await mkCustomer("__mailtest-bob", { optIn: true, promoOptOut: true });
  await mkCustomer("__mailtest-carol", { optIn: false });

  // 1) Public (no targets): opt-in only, minus public-promo opt-outs.
  const pub = await mkPromo();
  const pubAud = (await resolvePromotionAudience(pub.id)).recipients;
  check("public → includes opt-in customer", has(pubAud, "__mailtest-alice@example.test"));
  check("public → excludes promo_opt_out customer", !has(pubAud, "__mailtest-bob@example.test"));
  check("public → excludes opted-out customer", !has(pubAud, "__mailtest-carol@example.test"));

  // 2) Customer-only target (the direct-lookup short-circuit): only the targeted
  //    profile, and a promo_opt_out customer IS reachable when explicitly targeted.
  const custPromo = await mkPromo();
  await promotionService.setTargets(custPromo.id, [
    { target_type: "customer", target_id: alice },
    { target_type: "customer", target_id: bob },
  ]);
  const custAud = (await resolvePromotionAudience(custPromo.id)).recipients;
  check("customer-target → includes targeted opt-in customer", has(custAud, "__mailtest-alice@example.test"));
  check(
    "customer-target → reaches a promo_opt_out customer (targeted ≠ public)",
    has(custAud, "__mailtest-bob@example.test"),
  );
  check("customer-target → excludes non-targeted opted-out customer", !has(custAud, "__mailtest-carol@example.test"));

  // 3) Manual-segment target: opt-in members who match.
  const seg = await segmentService.insert({ name: "__mailtest-seg", kind: "manual" } as never);
  await segmentService.addMember(seg.id, alice);
  const segPromo = await mkPromo();
  await promotionService.setTargets(segPromo.id, [{ target_type: "segment", target_id: seg.id }]);
  const segAud = (await resolvePromotionAudience(segPromo.id)).recipients;
  check("segment-target → includes opt-in member", has(segAud, "__mailtest-alice@example.test"));
  check("segment-target → excludes non-member", !has(segAud, "__mailtest-bob@example.test"));

  // 3b) DYNAMIC-segment target (compound rule_tree) — resolves through the shared
  //     SQL compiler, the gap the old rule-string-only path silently dropped (a
  //     tree-based segment used to match NOBODY). Give Alice a gender so a gender
  //     gate discriminates her from Bob (both opt-in).
  await db.execute(sql`update customer_profiles set gender = 'female' where id = ${alice}`);
  const dynSeg = await segmentService.insert({
    name: "__mailtest-dynseg",
    kind: "dynamic",
    rule_tree: { kind: "gender", value: "female" },
  } as never);
  const dynPromo = await mkPromo();
  await promotionService.setTargets(dynPromo.id, [{ target_type: "segment", target_id: dynSeg.id }]);
  const dynAud = (await resolvePromotionAudience(dynPromo.id)).recipients;
  check("dynamic-segment target → includes matching opt-in customer (tree resolved)", has(dynAud, "__mailtest-alice@example.test"));
  check("dynamic-segment target → excludes non-matching customer", !has(dynAud, "__mailtest-bob@example.test"));
  await db.execute(sql`update customer_profiles set gender = null where id = ${alice}`);

  // 6) INLINE audience_rule_tree (E2): the announce audience honors the promo's OWN
  //    compound rule (like a dynamic segment target), so a rule-restricted promo is
  //    NOT blasted to every opt-in customer — the gap this closes.
  {
    const eve = await mkCustomer("__mailtest-eve", { optIn: true, gender: "female" });
    await mkCustomer("__mailtest-frank", { optIn: true, gender: "male" });
    const rulePromo = await promotionService.insert({
      name: "__mailtest-rule",
      trigger_kind: "code",
      code: "__MAILTESTRULE",
      scope: "cart",
      discount_type: "percent",
      discount_value: 10,
      is_active: true,
      audience_rule_tree: { op: "and", children: [{ kind: "gender", value: "female" }] },
    } as NewPromotionRow);
    const ruleAud = (await resolvePromotionAudience(rulePromo.id)).recipients;
    check("audience rule: matching customer (female) included", has(ruleAud, "__mailtest-eve@example.test"));
    check("audience rule: non-matching customer (male) EXCLUDED (not a public blast)", !has(ruleAud, "__mailtest-frank@example.test"));
    check("audience rule: an opt-in customer with no matching fact is also excluded", !has(ruleAud, "__mailtest-alice@example.test"));

    // Rule AND explicit targets → the buyer must satisfy BOTH (each narrows).
    const bothPromo = await promotionService.insert({
      name: "__mailtest-rule-both",
      trigger_kind: "code",
      code: "__MAILTESTRULEBOTH",
      scope: "cart",
      discount_type: "percent",
      discount_value: 10,
      is_active: true,
      audience_rule_tree: { op: "and", children: [{ kind: "gender", value: "female" }] },
    } as NewPromotionRow);
    await promotionService.setTargets(bothPromo.id, [
      { target_type: "customer", target_id: eve },
      { target_type: "customer", target_id: await customerProfileId("__mailtest-frank") },
    ]);
    const bothAud = (await resolvePromotionAudience(bothPromo.id)).recipients;
    check(
      "rule + targets: only the target who ALSO matches the rule (eve, not frank)",
      has(bothAud, "__mailtest-eve@example.test") && !has(bothAud, "__mailtest-frank@example.test"),
    );
  }

  // 7) first_order_only (E1): mail ONLY first-time buyers. A customer with a placed
  //    (non-cancelled) order is excluded — they'd be refused the code at checkout.
  {
    await mkCustomer("__mailtest-grace", { optIn: true }); // 0 orders
    await mkCustomer("__mailtest-heidi", { optIn: true }); // has an order
    await orderService.insertOrder({
      order_number: "__mailtest-ord-fo",
      contact_email: "__mailtest-heidi@example.test",
      user_id: "__mailtest-heidi",
      subtotal_cents: 50000,
      total_cents: 50000,
      ship_full_name: "H",
      ship_street_line1: "1",
      ship_city: "Tunis",
    } as never);
    const foPromo = await promotionService.insert({
      name: "__mailtest-fo",
      trigger_kind: "code",
      code: "__MAILTESTFO",
      scope: "cart",
      discount_type: "percent",
      discount_value: 10,
      is_active: true,
      first_order_only: true,
    } as NewPromotionRow);
    const foAud = (await resolvePromotionAudience(foPromo.id)).recipients;
    check("first_order_only: a first-timer (0 orders) is included", has(foAud, "__mailtest-grace@example.test"));
    check("first_order_only: a returning customer (has an order) is EXCLUDED", !has(foAud, "__mailtest-heidi@example.test"));
  }

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

/** Resolve a test user's customer_profile id by their user id. */
async function customerProfileId(userId: string): Promise<string> {
  const rows = rowsOf(
    await db.execute(sql`select customer_profile_id from customer_user_links where user_id = ${userId} limit 1`),
  );
  return String(rows[0]?.customer_profile_id);
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

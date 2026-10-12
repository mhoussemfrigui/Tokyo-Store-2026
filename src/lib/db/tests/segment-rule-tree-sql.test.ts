import "server-only";

/**
 * PARITY test — the load-bearing invariant of the two-evaluator design. Seeds
 * profiles with known facts, then for a matrix of rule trees asserts the SET-BASED
 * SQL (ruleTreeToSql → segmentMemberIdsSql) selects EXACTLY the profiles the
 * in-memory predicate (ruleTreeMatches) matches. If the two ever drift, this fails.
 * Deterministic: a FIXED reference instant. Self-cleaning (__sgx). Run:
 *   tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/segment-rule-tree-sql.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { authService } from "@/modules/auth/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { ruleTreeMatches, type LeafNeed, type SegmentFacts } from "@/lib/promotions/rule-leaves";
import { buildSegmentSqlCtx, segmentCountSql, segmentMemberIdsSql, type SegmentSqlCtx } from "@/lib/promotions/rule-tree-sql";
import { loadSegmentFacts } from "@/lib/promotions/segment-facts";
import type { RuleNode } from "@/lib/promotions/rule-tree";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__sgx";
const NOW = new Date("2026-06-15T12:00:00Z");
const DAY = 86_400_000;

type Fx = {
  key: string;
  ordersPlaced: number; // live placed orders
  birthday: string;
  gender: "female" | "male" | "other";
  accountAgeDays: number;
  marketing: boolean;
  cart: { totalCents: number; units: number; lines: number; ageDays: number } | null;
  profileId?: string;
  userId?: string;
};

const FX: Fx[] = [
  { key: "P1", ordersPlaced: 1, birthday: "1990-06-15", gender: "female", accountAgeDays: 400, marketing: true,
    cart: { totalCents: 300_000, units: 4, lines: 2, ageDays: 10 } },
  { key: "P2", ordersPlaced: 0, birthday: "2000-12-25", gender: "male", accountAgeDays: 5, marketing: false,
    cart: null },
  { key: "P3", ordersPlaced: 1, birthday: "1985-06-18", gender: "female", accountAgeDays: 100, marketing: true,
    cart: { totalCents: 50_000, units: 1, lines: 1, ageDays: 30 } },
  { key: "P4", ordersPlaced: 1, birthday: "1970-06-15", gender: "male", accountAgeDays: 800, marketing: true,
    cart: null },
  { key: "P5", ordersPlaced: 1, birthday: "1996-02-29", gender: "other", accountAgeDays: 200, marketing: true,
    cart: null },
];

let ctx: SegmentSqlCtx;

function calendarAge(birthday: string, refYmd: string): number {
  const [by, bm, bd] = birthday.split("-").map(Number);
  const [ry, rm, rd] = refYmd.split("-").map(Number);
  let age = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) age -= 1;
  return age;
}

function factsFor(fx: Fx): SegmentFacts {
  return {
    orderCount: fx.ordersPlaced,
    marketingOptIn: fx.marketing,
    birthday: fx.birthday,
    ageYears: calendarAge(fx.birthday, ctx.refYmd),
    gender: fx.gender,
    accountAgeDays: fx.accountAgeDays,
    cart: fx.cart ? { totalCents: fx.cart.totalCents, ageDays: fx.cart.ageDays, itemUnits: fx.cart.units, itemLines: fx.cart.lines } : null,
    ref: { ymd: ctx.refYmd, year: ctx.refYear, month: ctx.refMonth, day: ctx.refDay },
  };
}

async function cleanup() {
  await db.execute(sql`delete from cart_items where cart_id in (select id from carts where user_id like ${TAG + "%"})`);
  await db.execute(sql`delete from carts where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from orders where contact_email like ${TAG + "%"}`);
  await db.execute(sql`delete from customer_user_links where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from customer_profiles where last_name like ${TAG + "%"}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
}

async function seed(fx: Fx) {
  const uid = `${TAG}-${fx.key}`;
  await authService.insert({ id: uid, email: `${uid}@x.test`, name: uid, role: "customer", emailVerified: true } as never);
  const created = new Date(NOW.getTime() - fx.accountAgeDays * DAY);
  const [p] = await db
    .insert((await import("@/modules/customer/schema")).customer_profiles)
    .values({ first_name: fx.key, last_name: `${TAG}-${fx.key}`, birthday: fx.birthday, gender: fx.gender, marketing_opt_in: fx.marketing, created_at: created } as never)
    .returning({ id: (await import("@/modules/customer/schema")).customer_profiles.id });
  await customerUserLink.create({ customer_profile_id: p.id, user_id: uid } as never);
  fx.profileId = p.id;
  fx.userId = uid;

  if (fx.cart) {
    const act = new Date(NOW.getTime() - fx.cart.ageDays * DAY);
    const [c] = await db.execute<{ id: string }>(sql`insert into carts (user_id, updated_at) values (${uid}, ${act.toISOString()}) returning id`).then((r) => (r as unknown as { rows: { id: string }[] }).rows);
    // Split into `lines` items with quantities summing to units and price*qty summing to total.
    const per = Math.floor(fx.cart.totalCents / fx.cart.units);
    let remUnits = fx.cart.units;
    let remTotal = fx.cart.totalCents;
    for (let i = 0; i < fx.cart.lines; i++) {
      const isLast = i === fx.cart.lines - 1;
      const q = isLast ? remUnits - (fx.cart.lines - 1 - i) : Math.max(1, Math.floor(remUnits / (fx.cart.lines - i)));
      const lineTotal = isLast ? remTotal : per * q;
      const unit = Math.round(lineTotal / q);
      await db.execute(sql`insert into cart_items (cart_id, product_id, variant_id, quantity, unit_price_cents, updated_at) values (${c.id}, gen_random_uuid(), '', ${q}, ${Math.round(lineTotal / q)}, ${act.toISOString()})`);
      void unit;
      remUnits -= q;
      remTotal -= unit * q;
    }
  }
  for (let i = 0; i < fx.ordersPlaced; i++) {
    await db.execute(sql`insert into orders (order_number, contact_email, status, subtotal_cents, total_cents, ship_full_name, ship_street_line1, ship_city, user_id) values (${`${TAG}-${fx.key}-${i}`}, ${`${TAG}-${fx.key}@x.test`}, 'paid', 1000, 1000, 'S', '1', 'Tunis', ${uid})`);
  }
}

async function main() {
  await cleanup();
  ctx = await buildSegmentSqlCtx(NOW);
  check("ctx has the store-TZ reference date", ctx.refYmd === "2026-06-15" && ctx.refYear === 2026 && ctx.refMonth === 6 && ctx.refDay === 15);
  for (const fx of FX) await seed(fx);
  const myIds = new Set(FX.map((f) => f.profileId!));
  const idToKey = new Map(FX.map((f) => [f.profileId!, f.key]));
  const keysOf = (ids: Iterable<string>) => [...ids].map((id) => idToKey.get(id)!).filter(Boolean).sort();

  // LOADER LAYER — the real per-checkout path: loadSegmentFacts reads the SAME rows
  // from the DB that the SQL compiler scans. Building each fixture's facts ONCE with
  // the union of all needs, so the matrix below can assert loadSegmentFacts→matches
  // agrees with segmentMemberIdsSql (proves production facts ≡ SQL facts, not just
  // the hand-built factsFor).
  const allNeeds = new Set<LeafNeed>(["orders", "cart"]);
  const loaded = new Map<string, SegmentFacts>();
  for (const fx of FX) {
    const prof = {
      id: fx.profileId!,
      marketing_opt_in: fx.marketing,
      birthday: fx.birthday,
      gender: fx.gender,
      created_at: new Date(NOW.getTime() - fx.accountAgeDays * DAY),
    };
    loaded.set(fx.key, await loadSegmentFacts(prof, fx.userId!, allNeeds, ctx));
  }

  const trees: Array<{ name: string; tree: RuleNode; expect?: string[] }> = [
    { name: "gender female", tree: { kind: "gender", value: "female" }, expect: ["P1", "P3"] },
    { name: "gender male", tree: { kind: "gender", value: "male" }, expect: ["P2", "P4"] },
    { name: "age_gte 40", tree: { kind: "age_gte", years: 40 }, expect: ["P3", "P4"] },
    { name: "age_lte 30", tree: { kind: "age_lte", years: 30 }, expect: ["P2", "P5"] },
    { name: "account_age_gte 365d", tree: { kind: "account_age_gte_days", days: 365 }, expect: ["P1", "P4"] },
    { name: "cart_has_items", tree: { kind: "cart_has_items" }, expect: ["P1", "P3"] },
    { name: "cart_total_gte 100k", tree: { kind: "cart_total_gte", cents: 100_000 }, expect: ["P1"] },
    { name: "cart_total_lte 100k", tree: { kind: "cart_total_lte", cents: 100_000 }, expect: ["P3"] },
    { name: "cart_age_gte 20d (abandoned)", tree: { kind: "cart_age_gte_days", days: 20 }, expect: ["P3"] },
    { name: "cart_item_count eq 2 lines", tree: { kind: "cart_item_count", op: "eq", count: 2, distinct: true }, expect: ["P1"] },
    { name: "cart_item_count gte 4 units", tree: { kind: "cart_item_count", op: "gte", count: 4 }, expect: ["P1"] },
    { name: "has_orders", tree: { kind: "has_orders" }, expect: ["P1", "P3", "P4", "P5"] },
    { name: "no_orders", tree: { kind: "no_orders" }, expect: ["P2"] },
    { name: "birthday_anniversary 5j", tree: { kind: "birthday_anniversary", daysBefore: 5 }, expect: ["P1", "P3", "P4"] },
    { name: "birthday_today", tree: { kind: "birthday_today" }, expect: ["P1", "P4"] },
    { name: "birthday_month", tree: { kind: "birthday_month" }, expect: ["P1", "P3", "P4"] },
    { name: "marketing_opted_in", tree: { kind: "marketing_opted_in" }, expect: ["P1", "P3", "P4", "P5"] },
    { name: "AND cart_total≥100k + female", tree: { op: "and", children: [{ kind: "cart_total_gte", cents: 100_000 }, { kind: "gender", value: "female" }] }, expect: ["P1"] },
    { name: "OR female | no_orders", tree: { op: "or", children: [{ kind: "gender", value: "female" }, { kind: "no_orders" }] }, expect: ["P1", "P2", "P3"] },
    { name: "NOT male (group negate)", tree: { op: "and", children: [{ kind: "gender", value: "male" }], negate: true }, expect: ["P1", "P3", "P5"] },
    { name: "leaf negate: not cart_has_items", tree: { kind: "cart_has_items", negate: true }, expect: ["P2", "P4", "P5"] },
  ];

  for (const { name, tree, expect } of trees) {
    const sqlIds = new Set((await segmentMemberIdsSql(tree, ctx)).filter((id) => myIds.has(id)));
    const matchIds = new Set(FX.filter((f) => ruleTreeMatches(tree, factsFor(f))).map((f) => f.profileId!));
    const sqlKeys = keysOf(sqlIds).join(",");
    const matchKeys = keysOf(matchIds).join(",");
    check(`PARITY [${name}] SQL==matches (${sqlKeys || "∅"})`, sqlKeys === matchKeys);
    if (expect) check(`  expected [${name}] = ${expect.join(",")}`, sqlKeys === [...expect].sort().join(","));
    // Loader layer: the DB-backed facts must select the SAME set as the SQL compiler.
    const loaderKeys = keysOf(new Set(FX.filter((f) => ruleTreeMatches(tree, loaded.get(f.key)!)).map((f) => f.profileId!))).join(",");
    check(`  LOADER [${name}] loadSegmentFacts→matches == SQL`, loaderKeys === sqlKeys);
  }

  // segmentCountSql shares the WHERE with segmentMemberIdsSql. Direct coverage via a
  // deterministic global anchor (`never` → false → 0 rows) + agreement with the id-set
  // length for a gate (count is global, so compare to the full id list, not myIds).
  check("segmentCountSql(never) == 0 globally", (await segmentCountSql({ kind: "never" }, ctx)) === 0);
  const optTree: RuleNode = { kind: "marketing_opted_in" };
  const cntOpt = await segmentCountSql(optTree, ctx);
  const idsOpt = await segmentMemberIdsSql(optTree, ctx);
  check(`segmentCountSql == segmentMemberIdsSql length (${cntOpt})`, cntOpt === idsOpt.length);

  await cleanup();
  console.log(`\n=== segment-rule-tree-sql: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch { /* best-effort */ }
  process.exit(1);
});

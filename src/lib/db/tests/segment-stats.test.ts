import "server-only";

/**
 * segmentStats — per-segment « Statistiques » (Phase 6h). Seeds profiles + a manual
 * and a dynamic segment, asserts the live demographic breakdown (total / opt-in /
 * gender) for BOTH kinds, that a dynamic segment's total matches segmentCountSql,
 * and that an ARCHIVED member is excluded. Self-cleaning (__sgs). Run:
 *   tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/segment-stats.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { authService } from "@/modules/auth/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { segmentService } from "@/modules/customer/segment.service";
import { segmentStats } from "@/lib/promotions/segment-stats";
import { buildSegmentSqlCtx, segmentCountSql } from "@/lib/promotions/rule-tree-sql";
import { customer_profiles } from "@/modules/customer/schema";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__sgs";

async function cleanup() {
  await db.execute(sql`delete from customer_segment_members where segment_id in (select id from customer_segments where name like ${TAG + "%"})`);
  await db.execute(sql`delete from customer_segments where name like ${TAG + "%"}`);
  await db.execute(sql`delete from customer_user_links where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from customer_profiles where last_name like ${TAG + "%"}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
}

async function mk(key: string, o: { optIn: boolean; gender: string | null; deleted?: boolean }): Promise<string> {
  const uid = `${TAG}-${key}`;
  await authService.insert({ id: uid, email: `${uid}@x.test`, name: uid, role: "customer", emailVerified: true } as never);
  const [p] = await db
    .insert(customer_profiles)
    .values({
      first_name: key,
      last_name: `${TAG}-${key}`,
      marketing_opt_in: o.optIn,
      gender: o.gender,
      deleted_at: o.deleted ? new Date() : null,
    } as never)
    .returning({ id: customer_profiles.id });
  await customerUserLink.create({ customer_profile_id: p.id, user_id: uid } as never);
  return p.id;
}

async function main() {
  await cleanup();

  const A = await mk("A", { optIn: true, gender: "female" });
  const B = await mk("B", { optIn: false, gender: "male" });
  await mk("C", { optIn: true, gender: "other" });
  const D = await mk("D", { optIn: true, gender: "female", deleted: true });

  // ── Manual segment: members A, B, and archived D (D must be excluded). ──
  const manual = await segmentService.insert({ name: `${TAG}-manual`, kind: "manual" } as never);
  await segmentService.addMember(manual.id, A);
  await segmentService.addMember(manual.id, B);
  await segmentService.addMember(manual.id, D);
  const ms = await segmentStats(manual);
  check("manual: total = 2 (archived D excluded)", ms.total === 2);
  check("manual: optedIn = 1 (A true, B false)", ms.optedIn === 1);
  check("manual: female 1 / male 1", ms.female === 1 && ms.male === 1);

  // ── Dynamic segment: marketing opt-in. The stats aggregate over ALL matching
  //    profiles (not just my fixtures), so assert isolation-ROBUST invariants:
  //    total === segmentCountSql (shared base/WHERE), gender buckets sum to total,
  //    and that my two opted-in fixtures are counted. Exact per-field logic is
  //    pinned by the (isolated) manual case above — both paths share
  //    SEGMENT_STATS_COLUMNS. ──
  const dyn = await segmentService.insert({
    name: `${TAG}-dyn`,
    kind: "dynamic",
    rule_tree: { kind: "marketing_opted_in" },
  } as never);
  const ds = await segmentStats(dyn);
  const ctx = await buildSegmentSqlCtx();
  const cnt = await segmentCountSql({ kind: "marketing_opted_in" }, ctx);
  check(`dynamic: stats.total === segmentCountSql (${ds.total} === ${cnt})`, ds.total === cnt);
  check(
    "dynamic: gender buckets sum to total",
    ds.female + ds.male + ds.otherGender + ds.genderUnset === ds.total,
  );
  check("dynamic: counts my two opted-in fixtures (A + C ≤ total)", ds.total >= 2);
  check("dynamic: optedIn ≤ total", ds.optedIn <= ds.total);

  // Empty dynamic segment → zeroed stats (never throws).
  const empty = await segmentStats({ id: dyn.id, kind: "dynamic", rule: null, rule_tree: { kind: "age_gte", years: 100000 } } as never);
  check("dynamic: impossible gate → total 0", empty.total === 0);

  await cleanup();
  console.log(`\n=== segment-stats: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch { /* best-effort */ }
  process.exit(1);
});

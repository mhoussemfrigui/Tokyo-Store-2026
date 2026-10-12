import "server-only";

/**
 * Clients-list FILTER + STATS (Clients → Clients tab). Seeds 3 tagged customers with
 * distinct attributes and asserts listFilteredCustomers / customerFilterStats /
 * listFilteredCustomerProfiles agree over the isolated set (isolated via a unique
 * last-name search tag, since stats are global). Covers the profile-column dimensions
 * (incl. gender=known, birthday month) and a keyset pagination round-trip (walk the
 * tagged set page-by-page via nextCursor, assert every id appears exactly once).
 * Self-cleaning (__cftest). Run:
 *   tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/customer-filter.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { authService } from "@/modules/auth/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { customer_profiles } from "@/modules/customer/schema";
import {
  listFilteredCustomers,
  listFilteredCustomerProfiles,
  customerFilterStats,
} from "@/lib/customers/filter";
import { EMPTY_CUSTOMER_FILTER, type CustomerFilter } from "@/lib/customers/filter-shared";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__cftest";
const f = (over: Partial<CustomerFilter>): CustomerFilter => ({ ...EMPTY_CUSTOMER_FILTER, search: TAG, ...over });

async function cleanup() {
  await db.execute(sql`delete from customer_user_links where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from customer_profiles where last_name = ${TAG}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
}

async function mk(key: string, o: { gender: string | null; marketing: boolean; birthday: string | null }): Promise<string> {
  const uid = `${TAG}-${key}`;
  await authService.insert({ id: uid, email: `${uid}@x.test`, name: uid, role: "customer", emailVerified: true } as never);
  const [p] = await db
    .insert(customer_profiles)
    .values({
      first_name: key,
      last_name: TAG,
      gender: o.gender,
      marketing_opt_in: o.marketing,
      birthday: o.birthday,
    } as never)
    .returning({ id: customer_profiles.id });
  await customerUserLink.create({ customer_profile_id: p.id, user_id: uid } as never);
  return uid;
}

async function main() {
  await cleanup();

  await mk("a", { gender: "female", marketing: true, birthday: "1990-06-15" });
  await mk("b", { gender: null, marketing: false, birthday: null });
  await mk("c", { gender: "male", marketing: false, birthday: "1985-11-02" });

  // ── Stats over the isolated set (search tag) ──
  const s = await customerFilterStats(f({}));
  check("stats total = 3", s.total === 3);
  check("stats genderKnown = 2, genderUnset = 1", s.genderKnown === 2 && s.genderUnset === 1);
  check("stats female 1 / male 1", s.female === 1 && s.male === 1);
  check("stats marketing = 1 (A)", s.marketing === 1);

  // ── List filters ──
  const count = async (filter: CustomerFilter) => (await listFilteredCustomers(filter, { limit: 50 })).rows.length;
  check("list search → 3", (await count(f({}))) === 3);
  check("list gender=unset → 1", (await count(f({ gender: "unset" }))) === 1);
  check("list gender=known → 2 (A,C)", (await count(f({ gender: "known" }))) === 2);
  check("list gender=female → 1", (await count(f({ gender: "female" }))) === 1);
  check("list marketing=yes → 1", (await count(f({ marketing: "yes" }))) === 1);
  check("list birthdayMonth=6 → 1 (A)", (await count(f({ birthdayMonth: "6" }))) === 1);
  check("list birthdayMonth=11 → 1 (C)", (await count(f({ birthdayMonth: "11" }))) === 1);
  // created_at ≈ now() for all seeds → exercises the store-zone (Africa/Tunis) date SQL.
  check("list createdFrom=2000-01-01 → 3 (all)", (await count(f({ createdFrom: "2000-01-01" }))) === 3);
  check("list createdTo=2000-01-01 → 0 (none before)", (await count(f({ createdTo: "2000-01-01" }))) === 0);
  check("list createdFrom=2999-01-01 → 0 (none after)", (await count(f({ createdFrom: "2999-01-01" }))) === 0);

  // ── Export profiles (raw rows for the CSV route) ──
  const prof = await listFilteredCustomerProfiles(f({ gender: "known" }), { limit: 50 });
  check("export profiles gender=known → 2 CustomerProfileRow", prof.items.length === 2 && typeof prof.items[0].first_name === "string");

  // ── Keyset pagination round-trip (Précédent/Suivant cursor). Seed 2 more so the
  //    tagged set is 5, then walk it with limit=2, feeding each nextCursor back in,
  //    and assert the pages cover every id EXACTLY once (no overlap, no gap) — the
  //    <iso>|<uuid> cursor emit + parse + DESC keyset predicate are otherwise untested. ──
  await mk("d", { gender: "female", marketing: false, birthday: null });
  await mk("e", { gender: "male", marketing: false, birthday: null });
  const seen: string[] = [];
  let cursor: string | undefined = undefined;
  let pages = 0;
  for (;;) {
    const pg = await listFilteredCustomers(f({}), { limit: 2, cursor });
    pages++;
    seen.push(...pg.rows.map((r) => r.profileId));
    if (!pg.nextCursor) break;
    cursor = pg.nextCursor;
    if (pages > 10) break; // runaway guard
  }
  check("pagination: 5 tagged rows walked over 3 pages of ≤2", pages === 3 && seen.length === 5);
  check("pagination: every id appears exactly once (no overlap / no gap)", new Set(seen).size === 5);

  await cleanup();
  console.log(`\n=== customer-filter: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch { /* best-effort */ }
  process.exit(1);
});

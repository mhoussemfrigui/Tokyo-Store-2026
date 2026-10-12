import "server-only";

/**
 * Guest-clients FILTER + STATS + keyset pagination (Clients → Invités tab). Seeds tagged
 * GUEST orders (user_id IS NULL) with distinct email/phone/order-count/spend + one guest
 * whose email matches a registered account, then asserts listFilteredGuests /
 * guestFilterStats agree over the isolated set (isolated via a unique email-domain search
 * tag, since stats are global). Covers hasEmail/hasPhone/hasAccount/order+spend ranges +
 * the account enrichment + a page-by-page cursor walk. Self-cleaning (__gftest). Run:
 *   export DATABASE_URL=$(grep ^DATABASE_URL= .env.development.local|cut -d= -f2-)
 *   tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/guest-filter.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { orders } from "@/modules/order/schema";
import { authService } from "@/modules/auth/service";
import { customer_profiles } from "@/modules/customer/schema";
import { customerUserLink } from "@/associations/customer-user.service";
import { listFilteredGuests, guestFilterStats } from "@/lib/customers/guest-filter";
import { EMPTY_GUEST_FILTER, type GuestFilter } from "@/lib/customers/guest-filter-shared";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "gftest";
const DOMAIN = `${TAG}.test`;
const f = (over: Partial<GuestFilter>): GuestFilter => ({ ...EMPTY_GUEST_FILTER, search: TAG, ...over });

async function cleanup() {
  await db.execute(sql`delete from orders where order_number like ${"GF-" + TAG + "%"}`);
  await db.execute(sql`delete from customer_user_links where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from customer_profiles where last_name = ${TAG}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
}

let seq = 0;
async function mkOrder(o: {
  email: string; // contact_email is NOT NULL — an email-less guest uses ""
  phone: string | null;
  name: string;
  totalCents: number;
  paid: boolean;
  createdAt: Date;
}) {
  await db.insert(orders).values({
    order_number: `GF-${TAG}-${seq++}-${Date.now()}`,
    user_id: null,
    contact_email: o.email,
    contact_phone: o.phone,
    status: o.paid ? "paid" : "pending",
    payment_method: "cod",
    paid_at: o.paid ? o.createdAt : null,
    subtotal_cents: o.totalCents,
    total_cents: o.totalCents,
    ship_full_name: o.name,
    ship_street_line1: "1 rue",
    ship_city: "Tunis",
    created_at: o.createdAt,
  } as never);
}

async function main() {
  await cleanup();

  const base = Date.UTC(2026, 0, 1, 12, 0, 0);
  const at = (mins: number) => new Date(base + mins * 60_000);

  // G1 alpha — 2 paid orders (repeat), email + phone.
  await mkOrder({ email: `alpha@${DOMAIN}`, phone: "+21611111111", name: "Alpha Guest", totalCents: 100_000, paid: true, createdAt: at(10) });
  await mkOrder({ email: `alpha@${DOMAIN}`, phone: "+21611111111", name: "Alpha Guest", totalCents: 50_000, paid: true, createdAt: at(20) });
  // G2 beta — 1 paid order, email, NO phone.
  await mkOrder({ email: `beta@${DOMAIN}`, phone: null, name: "Beta Guest", totalCents: 30_000, paid: true, createdAt: at(30) });
  // G3 gamma — 1 UNPAID order, NO email (""), phone only.
  await mkOrder({ email: "", phone: "+21633333333", name: `Gamma ${TAG}`, totalCents: 40_000, paid: false, createdAt: at(40) });
  // G4 delta — 1 paid order whose email matches a registered account (hasAccount).
  await mkOrder({ email: `delta@${DOMAIN}`, phone: "+21644444444", name: "Delta Guest", totalCents: 200_000, paid: true, createdAt: at(50) });

  // Registered account for delta@ (+ profile + link) → the retro-link candidate.
  const uid = `${TAG}-delta`;
  await authService.insert({ id: uid, email: `delta@${DOMAIN}`, name: uid, role: "customer", emailVerified: false } as never);
  const [p] = await db.insert(customer_profiles).values({ first_name: "Delta", last_name: TAG } as never).returning({ id: customer_profiles.id });
  await customerUserLink.create({ customer_profile_id: p.id, user_id: uid } as never);

  // ── Stats over the isolated set (search tag matches the gftest email domain / names) ──
  const s = await guestFilterStats(f({}));
  check("stats total = 4 identities", s.total === 4);
  check("stats totalOrders = 5", s.totalOrders === 5);
  check("stats paidRevenue = 380000 millimes", s.paidRevenueCents === 380_000);
  check("stats withEmail = 3", s.withEmail === 3);
  check("stats withoutEmail = 1 (gamma)", s.withoutEmail === 1);
  check("stats withPhone = 3 (beta has none)", s.withPhone === 3);
  check("stats withAccount = 1 (delta)", s.withAccount === 1);
  check("stats repeat = 1 (alpha, 2 orders)", s.repeat === 1);

  // ── List filters ──
  const count = async (filter: GuestFilter) => (await listFilteredGuests(filter, { limit: 50 })).items.length;
  check("list search → 4", (await count(f({}))) === 4);
  check("list hasEmail=yes → 3", (await count(f({ hasEmail: "yes" }))) === 3);
  check("list hasEmail=no → 1", (await count(f({ hasEmail: "no" }))) === 1);
  check("list hasPhone=yes → 3", (await count(f({ hasPhone: "yes" }))) === 3);
  check("list hasPhone=no → 1 (beta)", (await count(f({ hasPhone: "no" }))) === 1);
  check("list hasAccount=yes → 1 (delta)", (await count(f({ hasAccount: "yes" }))) === 1);
  check("list hasAccount=no → 3", (await count(f({ hasAccount: "no" }))) === 3);
  check("list ordersMin=2 → 1 (alpha)", (await count(f({ ordersMin: "2" }))) === 1);
  check("list spendMin=100DT → 2 (alpha,delta)", (await count(f({ spendMin: "100" }))) === 2);
  check("list search=alpha → 1", (await count(f({ search: `alpha@${DOMAIN}` }))) === 1);

  // ── Account enrichment ──
  const deltaRow = (await listFilteredGuests(f({ hasAccount: "yes" }), { limit: 50 })).items[0];
  check("delta row surfaces accountUserId + accountProfileId", deltaRow?.accountUserId === uid && deltaRow?.accountProfileId === p.id);
  check("delta row accountVerified = false", deltaRow?.accountVerified === false);

  // ── Store-zone last-order date range ──
  check("list lastFrom=2000-01-01 → 4", (await count(f({ lastFrom: "2000-01-01" }))) === 4);
  check("list lastTo=2000-01-01 → 0", (await count(f({ lastTo: "2000-01-01" }))) === 0);

  // ── Keyset pagination round-trip: walk the 4 tagged guests with limit=2 ──
  const seen: string[] = [];
  let cursor: string | undefined = undefined;
  let pages = 0;
  for (;;) {
    const pg = await listFilteredGuests(f({}), { limit: 2, cursor });
    pages++;
    seen.push(...pg.items.map((g) => `${g.emailKey ?? ""}|${g.phone ?? ""}`));
    if (!pg.nextCursor) break;
    cursor = pg.nextCursor;
    if (pages > 10) break;
  }
  check("pagination: 4 guests over 2 pages of ≤2", pages === 2 && seen.length === 4);
  check("pagination: every identity appears exactly once", new Set(seen).size === 4);

  // ── Keyset TIE-BREAK: 3 more guests sharing the EXACT same last_at (at(60)), walked
  //    with limit=2 so the tie group is split across a page boundary — this is the only
  //    path that exercises the (email_key, phone) tie-break branch of the cursor predicate. ──
  const tieAt = at(60);
  for (const k of ["tie1", "tie2", "tie3"]) {
    await mkOrder({ email: `${k}@${DOMAIN}`, phone: null, name: "Tie Guest", totalCents: 10_000, paid: true, createdAt: tieAt });
  }
  const seen2: string[] = [];
  let cursor2: string | undefined = undefined;
  let pages2 = 0;
  for (;;) {
    const pg = await listFilteredGuests(f({}), { limit: 2, cursor: cursor2 });
    pages2++;
    seen2.push(...pg.items.map((g) => `${g.emailKey ?? ""}|${g.phone ?? ""}`));
    if (!pg.nextCursor) break;
    cursor2 = pg.nextCursor;
    if (pages2 > 20) break;
  }
  check("tie-break: 7 guests (3 sharing last_at) each appear exactly once", seen2.length === 7 && new Set(seen2).size === 7);

  await cleanup();
  console.log(`\n=== guest-filter: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch { /* best-effort */ }
  process.exit(1);
});

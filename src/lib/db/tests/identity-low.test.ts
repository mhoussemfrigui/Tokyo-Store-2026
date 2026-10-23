import "server-only";

/**
 * Identity / wishlist low-severity invariants (A–Z audit 2026-09-23 —
 * identity-31, identity-32, wiring-24, gap-admin-silent-caps-07,
 * gap-account-lifecycle-fanout-01, account-list rounding). Asserts:
 *   - Clients search (`searchCustomersForAdmin`): a malformed / forged cursor
 *     (garbage, impossible calendar date, non-uuid id) falls back to the FIRST
 *     page instead of throwing (Invalid Date → RangeError / 22P02 → 500), and
 *     the keyset cursor is µs-faithful — paging one row at a time through
 *     profiles sharing ONE microsecond timestamp visits every row (the old
 *     `toISOString()` cursor truncated .123456 → .123 and skipped them);
 *   - guest-wishlist merge is replay-safe (a retry after a failed first attempt
 *     — the cookie is now kept on failure — can't duplicate or throw), and the
 *     action deletes the cookie only AFTER a successful merge (source check);
 *   - `favoritesPublicEnabled` lives in lib/wishlist/config, not as a callable
 *     export of the "use server" actions file;
 *   - Favoris admin: `globalStats().products` is the true distinct-product
 *     count; the public-profile moderation list is searchable (slug OR
 *     pseudonym, LIKE metacharacters literal) and paged with a matching count;
 *   - /account: the Tokyo account page renders for any signed-in user without
 *     requiring a customer profile, and shows exact order totals (source checks).
 *
 * Self-cleaning (`__iltest…`).
 *
 * Run: DATABASE_URL=… pnpm exec tsx --conditions=react-server \
 *        src/lib/db/tests/identity-low.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { products } from "@/modules/catalog/product/schema";
import { wishlists } from "@/modules/wishlist/schema";
import { wishlistService } from "@/modules/wishlist/service";
import { favoritesPublicEnabled } from "@/lib/wishlist/config";

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

const TAG = "__iltest";
const ROOT = process.cwd();
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

async function cleanup() {
  await db.execute(sql`
    delete from customer_user_links
    where user_id like ${TAG + "%"}
       or customer_profile_id in (select id from customer_profiles where first_name like ${TAG + "%"})`);
  await db.execute(sql`delete from customer_profiles where first_name like ${TAG + "%"}`);
  await db.execute(sql`delete from wishlist_items where wishlist_id in (select id from wishlists where user_id like ${TAG + "%"} or token like ${TAG + "%"})`);
  await db.execute(sql`delete from wishlists where user_id like ${TAG + "%"} or token like ${TAG + "%"}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
}

/** Resolves to the error instead of throwing (so a regression reads as ✗, not a crash). */
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, err };
  }
}

async function customersSearch() {
  // Three profiles sharing ONE µs-precise created_at (a bulk import's shared now()).
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const p = await customerService.insertProfile({ first_name: `${TAG}-same`, last_name: `n${i}` } as never);
    ids.push(p.id);
  }
  await db.execute(sql`
    update customer_profiles set created_at = '2020-01-01 00:00:00.123456+00'
    where first_name = ${`${TAG}-same`}`);

  const search = `${TAG}-same`;
  const first = await customerUserLink.searchCustomersForAdmin({ search, limit: 1 });
  check("search: first page has one row + a next cursor", first.items.length === 1 && first.nextCursor !== null);
  check(
    "search: next cursor keeps µs precision (.123456, not .123)",
    (first.nextCursor ?? "").startsWith("2020-01-01T00:00:00.123456Z|"),
  );

  // Walk the keyset one row at a time.
  const seen = new Set(first.items.map((r) => r.profile.id));
  let cursor = first.nextCursor;
  for (let guard = 0; cursor && guard < 10; guard++) {
    const page = await customerUserLink.searchCustomersForAdmin({ search, limit: 1, cursor });
    for (const r of page.items) seen.add(r.profile.id);
    cursor = page.nextCursor;
  }
  check(
    "search: paging through rows sharing one µs timestamp visits all 3",
    seen.size === 3 && ids.every((id) => seen.has(id)),
  );

  // Malformed / forged cursors → first page (never a throw).
  const firstId = first.items[0]?.profile.id;
  const forged = [
    "garbage",
    "2025-02-30T00:00:00Z|00000000-0000-4000-8000-000000000000", // impossible calendar day
    "2020-01-01T00:00:00.123456Z|not-a-uuid", // bad id (22P02 before the fix)
    "|",
    "not-a-date|also-not-a-uuid",
  ];
  for (const c of forged) {
    const res = await attempt(() => customerUserLink.searchCustomersForAdmin({ search, limit: 1, cursor: c }));
    check(
      `search: malformed cursor ${JSON.stringify(c)} → first page, no throw`,
      res.ok && res.value.items[0]?.profile.id === firstId,
    );
  }
}

async function wishlistMerge(productIds: string[]) {
  const user = `${TAG}-merge-user`;
  const token = `${TAG}-guest-token`;
  await authService.insert({ id: user, email: `${user}@example.test`, name: user, role: "customer" } as never);
  const own = await wishlistService.createForUser(user);
  await wishlistService.addItem(own.id, productIds[0]);
  const guest = await wishlistService.createForToken(token);
  for (const pid of productIds) await wishlistService.addItem(guest.id, pid);

  await wishlistService.mergeTokenIntoUser(token, user);
  const merged = await wishlistService.listProductIds(own.id);
  check(
    "merge: guest items land in the user's list without duplicates",
    merged.length === productIds.length && productIds.every((p) => merged.includes(p)),
  );
  check("merge: the guest list is deleted after a successful merge", (await wishlistService.findByToken(token)) === null);

  // A retry (the cookie is kept when a merge fails, so the next mount replays
  // it): replaying against an already-merged or overlapping guest list must be
  // a clean no-op, never a unique-violation.
  const replay1 = await attempt(() => wishlistService.mergeTokenIntoUser(token, user));
  check("merge: replay with a token whose list is gone is a no-op", replay1.ok);
  const again = await wishlistService.createForToken(token);
  await wishlistService.addItem(again.id, productIds[0]);
  const replay2 = await attempt(() => wishlistService.mergeTokenIntoUser(token, user));
  const afterReplay = await wishlistService.listProductIds(own.id);
  check(
    "merge: replay of an overlapping guest list neither throws nor duplicates",
    replay2.ok && afterReplay.length === productIds.length,
  );

  // Source: the action must NOT swallow the merge error and delete the cookie
  // anyway — the delete follows the awaited merge inside the try.
  const action = src("src/lib/actions/wishlist.ts");
  check(
    "merge action: no `.catch(() => {})` swallowing the merge before the cookie delete",
    !/mergeTokenIntoUser\([^)]*\)\s*\.catch\(/.test(action),
  );
  check(
    "merge action: cookie deleted only right after the awaited merge (inside try)",
    /try\s*\{\s*await wishlistService\.mergeTokenIntoUser\([^)]*\);\s*jar\.delete\(WISHLIST_COOKIE\);\s*\}\s*catch/.test(action),
  );
}

async function favoritesAdmin(productIds: string[]) {
  // globalStats().products = TRUE distinct count (the KPI once read a capped list length).
  const stats = await wishlistService.globalStats();
  const [direct] = (
    await db.execute<{ n: number }>(sql`select count(distinct product_id)::int as n from wishlist_items`)
  ).rows;
  check("stats: products = count(distinct product_id)", stats.products === Number(direct?.n ?? -1));
  check("stats: products ≥ the fixture's distinct products", stats.products >= productIds.length);

  // Three public profiles (owners must exist — the moderation list reads every public list).
  const handles = [
    { user: `${TAG}-pa`, slug: `${TAG}-alpha`, name: "Alpha" },
    { user: `${TAG}-pb`, slug: `${TAG}-beta`, name: "Beta" },
    { user: `${TAG}-pc`, slug: `${TAG}-gamma`, name: "Collection Qx9Wk" },
  ];
  for (const h of handles) {
    await authService.insert({ id: h.user, email: `${h.user}@example.test`, name: h.user, role: "customer" } as never);
    const r = await wishlistService.setPublicProfile(h.user, { isPublic: true, slug: h.slug, displayName: h.name });
    check(`public: ${h.slug} goes public`, r.ok);
  }

  const all = await wishlistService.listPublicProfiles({ q: TAG, limit: 50 });
  check("moderation: slug search finds exactly the 3 fixture profiles", all.length === 3);
  check("moderation: count(q) matches the list", (await wishlistService.publicProfileCount(TAG)) === 3);

  const byName = await wishlistService.listPublicProfiles({ q: "qx9wk" });
  check(
    "moderation: pseudonym search (case-insensitive) finds the profile",
    byName.length === 1 && byName[0]?.slug === `${TAG}-gamma`,
  );

  const p1 = await wishlistService.listPublicProfiles({ q: TAG, limit: 2, offset: 0 });
  const p2 = await wishlistService.listPublicProfiles({ q: TAG, limit: 2, offset: 2 });
  const pagedIds = new Set([...p1, ...p2].map((r) => r.id));
  check("moderation: offset paging covers every match once (2 + 1)", p1.length === 2 && p2.length === 1 && pagedIds.size === 3);

  // LIKE metacharacters are literal: "%" only matches a literal percent sign.
  const [pct] = (
    await db.execute<{ n: number }>(sql`
      select count(*)::int as n from wishlists
      where is_public and (strpos(coalesce(public_slug, ''), '%') > 0 or strpos(coalesce(public_display_name, ''), '%') > 0)`)
  ).rows;
  check(
    "moderation: a '%' search is matched literally (not a wildcard)",
    (await wishlistService.publicProfileCount("%")) === Number(pct?.n ?? -1) &&
      (await wishlistService.publicProfileCount()) >= 3,
  );

  // Force-private UNPUBLISHES + LOCKS the list. By design it STAYS on the
  // moderation board — locked lists remain moderatable so an admin can later lift
  // the lock (liftModerationLock) — so the moderatable count is unchanged, but the
  // profile is now is_public=false + public_locked=true (no longer reachable at
  // /u/<slug>). publicProfileFilter matches is_public OR public_locked.
  const target = all.find((r) => r.slug === `${TAG}-beta`);
  if (target) await wishlistService.forcePrivate(target.id);
  const afterForce = await wishlistService.listPublicProfiles({ q: TAG, limit: 50 });
  const beta = afterForce.find((r) => r.slug === `${TAG}-beta`);
  check(
    "moderation: force-private unpublishes + locks but keeps it moderatable (admin can unlock)",
    (await wishlistService.publicProfileCount(TAG)) === 3 &&
      beta?.isPublic === false &&
      beta?.locked === true,
  );
}

function sourceInvariants() {
  // wiring-24: not a callable "use server" export any more.
  const action = src("src/lib/actions/wishlist.ts");
  check(
    "wiring: favoritesPublicEnabled is not exported from the \"use server\" actions file",
    !/export\s+(?:async\s+)?function\s+favoritesPublicEnabled\b/.test(action),
  );
  check("wiring: lib/wishlist/config exports favoritesPublicEnabled", typeof favoritesPublicEnabled === "function");

  // /account: the Tokyo account page renders for ANY signed-in user — it gates on
  // getCurrentUser() and treats the customer_profile as OPTIONAL: a signed-in user
  // with no linked profile still renders (the profile read is `.catch(() => null)`
  // and the no-profile path passes `profile={null}` to AccountView). It shows EXACT
  // order totals via `minorToDinars` (millimes → dinars, no float rounding); the old
  // (shell) account-client.tsx (`money.exact`) was removed in the storefront swap.
  const account = src("src/app/(shop)/(tokyo)/account/page.tsx");
  check(
    "account: gates on getCurrentUser and the customer profile is OPTIONAL (renders for any signed-in user)",
    /getCurrentUser\(\)/.test(account) &&
      /\.catch\(\(\) => null\)/.test(account) &&
      /profile=\{null\}/.test(account),
  );
  check(
    "account: order totals use the exact millimes→dinars helper (no float rounding)",
    /minorToDinars\(/.test(account) && /o\.total_cents/.test(account) && !/Math\.round|toFixed/.test(account),
  );
}

async function main() {
  await cleanup();
  try {
    sourceInvariants();
    check("config: favoritesPublicEnabled resolves a boolean", typeof (await favoritesPublicEnabled()) === "boolean");

    await customersSearch();

    const productIds: string[] = [];
    for (const n of ["a", "b"]) {
      const [p] = await db
        .insert(products)
        .values({ slug: `${TAG}-${n}`, name: `${TAG} ${n}`, price_cents: 1000, is_published: true } as never)
        .returning({ id: products.id });
      productIds.push(p.id);
    }
    await wishlistMerge(productIds);
    await favoritesAdmin(productIds);

    // Guard against the fixture leaking a public GUEST list (0058 CHECK).
    const [guestPublic] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(wishlists)
      .where(sql`${wishlists.token} like ${TAG + "%"} and ${wishlists.is_public}`);
    check("fixture: no public guest list", Number(guestPublic?.n ?? 0) === 0);
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
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));

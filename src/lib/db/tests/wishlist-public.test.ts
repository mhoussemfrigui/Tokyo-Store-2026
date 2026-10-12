import "server-only";

/**
 * Public shareable favorites test. Verifies the slug validator + the wishlist
 * service public-profile ops: claim a slug + go public, resolve case-insensitively
 * by slug, reject a duplicate slug (slug_taken, not a 500), force-private
 * (which removes it from public resolution), and hide a DISABLED owner's list
 * (a banned owner can't sign in to hide it — identity-07; it comes back on
 * re-enable). Self-cleaning (`__wptest…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/wishlist-public.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { authService } from "@/modules/auth/service";
import { products } from "@/modules/catalog/product/schema";
import { wishlists } from "@/modules/wishlist/schema";
import { wishlistService } from "@/modules/wishlist/service";
import { validatePublicSlug } from "@/lib/wishlist/public-slug";
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

const TAG = "__wptest";

async function cleanup() {
  await db.execute(sql`delete from wishlist_items where wishlist_id in (select id from wishlists where user_id like ${TAG + "%"} or token like ${TAG + "%"})`);
  await db.execute(sql`delete from wishlists where user_id like ${TAG + "%"} or token like ${TAG + "%"}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
}

async function main() {
  await cleanup();

  // ── Slug validator (pure).
  check("slug: rejects too short", validatePublicSlug("ab").ok === false);
  check("slug: rejects reserved 'admin'", validatePublicSlug("admin").ok === false);
  check("slug: rejects spaces/caps", validatePublicSlug("Bad Slug").ok === false);
  check("slug: rejects leading hyphen", validatePublicSlug("-nope").ok === false);
  check("slug: accepts good handle", validatePublicSlug("ma-collec-2").ok === true);

  // ── Service ops.
  const [p] = await db.insert(products).values({ slug: `${TAG}-p`, name: `${TAG} P`, price_cents: 1000, is_published: true } as never).returning({ id: products.id });
  const userA = `${TAG}-userA`;
  const userB = `${TAG}-userB`;
  // Real owner accounts: a public list only resolves while its owner exists and
  // isn't disabled (findPublicBySlug joins users).
  for (const id of [userA, userB]) {
    await authService.insert({ id, email: `${id}@example.test`, name: id, role: "customer" } as never);
  }
  const wlA = await wishlistService.createForUser(userA);
  await wishlistService.addItem(wlA.id, p.id);

  const claim = await wishlistService.setPublicProfile(userA, { isPublic: true, slug: `${TAG}-handle`, displayName: "Collection A" });
  check("public: claim + go public ok", claim.ok === true);

  const found = await wishlistService.findPublicBySlug(`${TAG}-HANDLE`); // case-insensitive
  check("public: resolves by slug (case-insensitive)", found?.id === wlA.id);
  check("public: count ≥ 1", (await wishlistService.publicProfileCount()) >= 1);

  // Second user can't take the same slug.
  await wishlistService.createForUser(userB);
  const dup = await wishlistService.setPublicProfile(userB, { isPublic: true, slug: `${TAG}-handle`, displayName: "B" });
  check("public: duplicate slug rejected (slug_taken)", dup.ok === false && (dup as { reason?: string }).reason === "slug_taken");

  // A DISABLED owner's list stops resolving (flag untouched) and comes back on
  // re-enable.
  await authService.disable(userA);
  check("public: disabled owner's list no longer resolves", (await wishlistService.findPublicBySlug(`${TAG}-handle`)) === null);
  const stillFlagged = await wishlistService.getOwnPublicState(userA);
  check("public: disable leaves the owner's is_public flag untouched", stillFlagged?.isPublic === true);
  await authService.enable(userA);
  check("public: re-enabled owner's list resolves again", (await wishlistService.findPublicBySlug(`${TAG}-handle`))?.id === wlA.id);

  // Force private removes it from public resolution.
  await wishlistService.forcePrivate(wlA.id);
  const afterPrivate = await wishlistService.findPublicBySlug(`${TAG}-handle`);
  check("public: force-private removes from public resolution", afterPrivate === null);

  // ── Moderation LOCK (0159): force-private also LOCKS. The handle is kept for
  // admin review; the customer can't re-publish until an admin lifts the lock.
  const lockedState = await wishlistService.getOwnPublicState(userA);
  check("moderation: force-private sets the lock", lockedState?.locked === true);
  check("moderation: force-private keeps the handle for admin review", lockedState?.slug === `${TAG}-handle`);
  const modList = await wishlistService.listPublicProfiles({ q: `${TAG}-handle` });
  check(
    "moderation: locked list still appears on the moderation board (to unlock)",
    modList.some((r) => r.id === wlA.id && r.locked === true && r.isPublic === false),
  );
  // Lifting the lock clears it; the customer can then publish again.
  await wishlistService.liftModerationLock(wlA.id);
  check("moderation: lift clears the lock", (await wishlistService.getOwnPublicState(userA))?.locked === false);
  const republish = await wishlistService.setPublicProfile(userA, { isPublic: true, slug: `${TAG}-handle`, displayName: "A again" });
  check(
    "moderation: customer can re-publish after unlock",
    republish.ok === true && (await wishlistService.findPublicBySlug(`${TAG}-handle`))?.id === wlA.id,
  );
  await wishlistService.forcePrivate(wlA.id); // leave it private for cleanup

  // ── Global default (was fail-OPEN): an UNSET flag reads OFF (migr 0057 + « Désactivé
  // par défaut »). getSettingsMap re-reads per call in a tsx script, so a mid-run
  // delete/restore is observable.
  const savedFlag = ((await db.execute(sql`select value from site_settings where key='social.favorites_public_enabled'`)) as unknown as { rows: Array<{ value: string | null }> }).rows[0]?.value ?? null;
  await db.execute(sql`delete from site_settings where key='social.favorites_public_enabled'`);
  check("config: unset public-favorites flag reads OFF (fail-closed)", (await favoritesPublicEnabled()) === false);
  if (savedFlag !== null) {
    await db.execute(sql`insert into site_settings (key,value,type,group_key,label) values ('social.favorites_public_enabled',${savedFlag},'boolean','social','Partage public des favoris') on conflict (key) do update set value=${savedFlag}`);
  }

  // DB invariant (0058): a GUEST (token, no user_id) list can't be made public.
  const [guestWl] = await db.insert(wishlists).values({ token: `${TAG}-guest` } as never).returning({ id: wishlists.id });
  let checkRejected = false;
  try {
    await db.update(wishlists).set({ is_public: true }).where(sql`${wishlists.id} = ${guestWl.id}`);
  } catch (err) {
    let e: unknown = err;
    for (let d = 0; e && typeof e === "object" && d < 6; d++) {
      if ((e as { code?: string }).code === "23514") checkRejected = true; // check_violation
      e = (e as { cause?: unknown }).cause;
    }
  }
  check("DB: guest list can't be made public (CHECK constraint)", checkRejected);

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

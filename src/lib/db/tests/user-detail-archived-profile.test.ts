import "server-only";

/**
 * Admin user detail vs an ARCHIVED customer profile (A–Z audit 2026-09-23,
 * identity-22 / gap-account-lifecycle-fanout-02).
 *
 * /admin/users/[id] redirects to the customer 360 only when the linked profile
 * is LIVE — it resolves the target with `findProfileSummariesByUserIds` (live
 * join). « Supprimer le client » soft-deletes the profile but keeps the
 * customer_user_links row, and the 360 (`findProfileById`, deleted_at IS NULL)
 * 404s on it — so redirecting on the bare link (the old `findByUserId` check)
 * was a dead end for roles / 2FA reset / account controls. Asserts:
 *   - live profile → the redirect target resolves AND the 360 would render it;
 *   - archived profile → no redirect target (the staff detail renders), while
 *     the stale link still exists (the page's « profil archivé » note).
 *
 * Self-cleaning (`__udaptest…`).
 *
 * Run: DATABASE_URL=… pnpm exec tsx --conditions=react-server \
 *        src/lib/db/tests/user-detail-archived-profile.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";

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

const TAG = "__udaptest";
// A staff account owning a customer profile — the bootstrapped-admin shape
// (default-admin.ts links an "Admin Admin" profile to every bootstrapped admin).
const STAFF = `${TAG}-staff`;

async function cleanup() {
  await db.execute(sql`
    delete from customer_user_links
    where user_id like ${TAG + "%"}
       or customer_profile_id in (select id from customer_profiles where first_name like ${TAG + "%"})`);
  await db.execute(sql`delete from customer_profiles where first_name like ${TAG + "%"}`);
  await db.execute(sql`delete from sessions where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
}

/** The page's decision: the 360 id to redirect to, or null (render detail). */
async function redirectTarget(userId: string): Promise<string | null> {
  return (await customerUserLink.findProfileSummariesByUserIds([userId])).get(userId)?.profileId ?? null;
}

async function main() {
  await cleanup();
  try {
    await authService.insert({
      id: STAFF,
      email: `${STAFF}@example.test`,
      name: STAFF,
      role: "staff",
    } as never);
    const profile = await customerService.insertProfile({
      first_name: TAG,
      last_name: STAFF,
    } as never);
    await customerUserLink.create({ customer_profile_id: profile.id, user_id: STAFF } as never);

    // ── live profile → redirect to a 360 that renders ───────────────────────
    const liveTarget = await redirectTarget(STAFF);
    check("live profile → redirect target is the linked profile", liveTarget === profile.id);
    check(
      "live profile → the 360 would render it (findProfileById non-null)",
      liveTarget !== null && (await customerService.findProfileById(liveTarget)) !== null,
    );

    // ── « Supprimer le client » (soft-delete) → no redirect, detail renders ──
    await customerService.softDeleteProfile(profile.id);
    check(
      "archived profile → the 360 would 404 (findProfileById null)",
      (await customerService.findProfileById(profile.id)) === null,
    );
    check("archived profile → NO redirect target (staff detail renders)", (await redirectTarget(STAFF)) === null);
    check(
      "archived profile → the stale link survives (drives the « profil archivé » note)",
      (await customerUserLink.findByUserId(STAFF))?.customer_profile_id === profile.id,
    );
  } finally {
    await cleanup();
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

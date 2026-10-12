import "server-only";

/**
 * Identity & privacy regression test (A–Z audit 2026-09-23, phase 2).
 *
 *   - identity-07: « Supprimer le client » withdraws marketing consent (profile
 *     opt-in off + newsletter row unsubscribed, so the `newsletter` campaign
 *     audience no longer includes the archived customer) and forces the public
 *     favourites page private; disabling an account also withdraws marketing.
 *   - identity-06: the admin « set password » CREATES a credential account for a
 *     social-only user (it used to be a silent UPDATE of zero rows reported as
 *     success) and updates — never duplicates — an existing one.
 *   - identity-14: the Sécurité 2FA-adoption signal counts only enforced 2FA
 *     (`users.two_factor_enabled`), not an abandoned `two_factors` row
 *     (verified=false). Asserted as deltas: the counts are global.
 *   - identity-04: the customer CSV export walks the (created_at, id) keyset past
 *     the 200-row page clamp (µs-precise cursor — rows sharing the boundary
 *     row's millisecond aren't skipped) and reports truncation at the cap.
 *
 * Self-cleaning (`__idptest…`).
 *
 * Run: pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *        src/lib/db/tests/identity-privacy.test.ts
 */
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { getAuth } from "@/lib/auth/server";
import { collectKeysetPages } from "@/lib/csv/collect-pages";
import { resolveCampaignAudience } from "@/lib/mailing/audience";
import { getSecuritySignals } from "@/lib/security/signals";
import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import { accounts, twoFactors } from "@/modules/auth/schema";
import { customerService } from "@/modules/customer/service";
import { customer_profiles } from "@/modules/customer/schema";
import { customerUserLink } from "@/associations/customer-user.service";
import { newsletterService } from "@/modules/newsletter/service";
import { wishlistService } from "@/modules/wishlist/service";
import { deleteCustomerWorkflow } from "@/workflows/customer/delete-customer";
import { disableUserWorkflow } from "@/workflows/auth/disable-user";
import { setPasswordWorkflow } from "@/workflows/auth/set-password";

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

const TAG = "__idptest";
const ADMIN = `${TAG}-admin`; // enum admin — the wildcard actor
const CUST = `${TAG}-cust`; // customer archived via « Supprimer le client »
const BANNED = `${TAG}-banned`; // customer disabled from the users panel
const SOCIAL = `${TAG}-social`; // Google-only sign-up (no credential row)
const CRED = `${TAG}-cred`; // email/password user
const TFA = `${TAG}-2fa`; // admin with a half-finished 2FA enrolment

type Row = Record<string, unknown>;
function rowsOf(res: unknown): Row[] {
  const r = res as { rows?: Row[] };
  return r.rows ?? (res as Row[]);
}

async function cleanup() {
  await db.execute(sql`delete from newsletter_subscriptions where email like ${TAG + "%"}`);
  await db.execute(sql`delete from wishlists where user_id like ${TAG + "%"}`);
  await db.execute(sql`
    delete from addresses
    where customer_profile_id in (select id from customer_profiles where first_name like ${TAG + "%"})`);
  await db.execute(sql`
    delete from customer_user_links
    where user_id like ${TAG + "%"}
       or customer_profile_id in (select id from customer_profiles where first_name like ${TAG + "%"})`);
  await db.execute(sql`delete from customer_profiles where first_name like ${TAG + "%"}`);
  await db.execute(sql`delete from two_factors where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from accounts where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from sessions where user_id like ${TAG + "%"}`);
  // RBAC grants are soft text links (no FK) — delete them before the users or
  // they orphan and inflate the derived admin count (accountTypeCounts).
  await db.execute(sql`delete from user_permissions where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from user_roles where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
}

// Access is role-only: an "admin" is seeded by granting the super_admin role.
const mkUser = async (id: string, type: "admin" | "customer") => {
  await authService.insert({ id, email: `${id}@example.test`, name: id } as never);
  if (type === "admin") {
    const sa = await rbacService.findRoleByKey("super_admin");
    if (sa) await rbacService.assignRoleToUser(id, sa.id);
  }
};

async function mkOptedInCustomer(userId: string) {
  await mkUser(userId, "customer");
  const profile = await customerService.insertProfile({
    first_name: TAG,
    last_name: userId,
    marketing_opt_in: true,
  } as never);
  await customerUserLink.create({ customer_profile_id: profile.id, user_id: userId } as never);
  await newsletterService.insert({ email: `${userId}@example.test`, source: "test" } as never);
  return profile;
}

async function optInOf(pid: string): Promise<boolean | null> {
  const rows = rowsOf(await db.execute(sql`select marketing_opt_in from customer_profiles where id = ${pid}`));
  return rows.length ? (rows[0].marketing_opt_in as boolean) : null;
}

async function credentialRows(userId: string): Promise<Row[]> {
  return rowsOf(
    await db.execute(
      sql`select password from accounts where user_id = ${userId} and provider_id = 'credential'`,
    ),
  );
}

async function main() {
  await cleanup();
  await mkUser(ADMIN, "admin");

  // ── identity-07: archive a customer ──────────────────────────────────────
  console.log("identity-07 — « Supprimer le client » withdraws consent + public page:");
  const custProfile = await mkOptedInCustomer(CUST);
  const claim = await wishlistService.setPublicProfile(CUST, {
    isPublic: true,
    slug: `${TAG}-handle`,
    displayName: "Collection",
  });
  check("setup: public favourites page claimed", claim.ok === true);
  check("setup: public page resolves", (await wishlistService.findPublicBySlug(`${TAG}-handle`)) !== null);
  const before = await resolveCampaignAudience("newsletter", {});
  check("setup: newsletter audience includes the customer", before.recipients.some((r) => r.email === `${CUST}@example.test`));

  const del = await deleteCustomerWorkflow({ customerProfileId: custProfile.id }, { actorUserId: ADMIN });
  check("delete: workflow ok", del.ok === true);
  const nl = await newsletterService.findByEmail(`${CUST}@example.test`);
  check("delete: newsletter row unsubscribed", nl?.is_active === false);
  check("delete: profile marketing_opt_in withdrawn", (await optInOf(custProfile.id)) === false);
  const after = await resolveCampaignAudience("newsletter", {});
  check("delete: newsletter audience no longer includes the customer", !after.recipients.some((r) => r.email === `${CUST}@example.test`));
  const ownState = await wishlistService.getOwnPublicState(CUST);
  check("delete: wishlist forced private", ownState?.isPublic === false);
  check("delete: public page no longer resolves", (await wishlistService.findPublicBySlug(`${TAG}-handle`)) === null);
  check("delete: linked customer account disabled", !!(await authService.findById(CUST))?.disabledAt);

  // ── identity-07: disable (ban) an opted-in customer ─────────────────────
  console.log("identity-07 — disabling an account withdraws marketing:");
  const bannedProfile = await mkOptedInCustomer(BANNED);
  const dis = await disableUserWorkflow({ userId: BANNED }, { actorUserId: ADMIN });
  check("disable: workflow ok", dis.ok === true);
  check(
    "disable: newsletter row unsubscribed",
    (await newsletterService.findByEmail(`${BANNED}@example.test`))?.is_active === false,
  );
  check("disable: profile marketing_opt_in withdrawn", (await optInOf(bannedProfile.id)) === false);

  // ── identity-06: admin « set password » ─────────────────────────────────
  console.log("identity-06 — admin set-password creates / updates the credential account:");
  const ctx = await (await getAuth()).$context;
  await mkUser(SOCIAL, "customer");
  await db.insert(accounts).values({
    id: randomUUID(),
    userId: SOCIAL,
    accountId: `${TAG}-google-sub`,
    providerId: "google",
  });
  check("setup: social-only user has no credential", (await authService.userHasCredentialAccount(SOCIAL)) === false);
  const socialPwd = "Nouveau-Mot-De-Passe-2026!";
  const setSocial = await setPasswordWorkflow({ userId: SOCIAL, newPassword: socialPwd }, { actorUserId: ADMIN });
  check("social: workflow ok", setSocial.ok === true);
  check("social: credential account now exists", (await authService.userHasCredentialAccount(SOCIAL)) === true);
  const socialCreds = await credentialRows(SOCIAL);
  check("social: exactly one credential row", socialCreds.length === 1);
  check(
    "social: stored hash verifies the new password",
    socialCreds.length === 1 &&
      (await ctx.password.verify({ hash: String(socialCreds[0].password), password: socialPwd })),
  );
  const googleLeft = rowsOf(
    await db.execute(sql`select 1 from accounts where user_id = ${SOCIAL} and provider_id = 'google'`),
  );
  check("social: the Google link is kept", googleLeft.length === 1);

  await mkUser(CRED, "customer");
  await db.insert(accounts).values({
    id: randomUUID(),
    userId: CRED,
    accountId: CRED,
    providerId: "credential",
    password: await ctx.password.hash("Ancien-Mot-De-Passe-2025!"),
  });
  const credPwd = "Autre-Mot-De-Passe-2026!";
  const setCred = await setPasswordWorkflow({ userId: CRED, newPassword: credPwd }, { actorUserId: ADMIN });
  check("credential: workflow ok", setCred.ok === true);
  const credRows = await credentialRows(CRED);
  check("credential: still exactly one credential row (updated, not duplicated)", credRows.length === 1);
  check(
    "credential: stored hash verifies the new password",
    credRows.length === 1 &&
      (await ctx.password.verify({ hash: String(credRows[0].password), password: credPwd })),
  );

  // ── identity-14: 2FA adoption signal ────────────────────────────────────
  console.log("identity-14 — 2FA adoption counts only enforced 2FA:");
  const base = await getSecuritySignals();
  await mkUser(TFA, "admin");
  // /two-factor/enable wrote the row, the QR confirmation never happened.
  await db.insert(twoFactors).values({
    id: randomUUID(),
    userId: TFA,
    secret: "unverified-secret",
    backupCodes: "[]",
    verified: false,
  });
  const pending = await getSecuritySignals();
  check("pending: admin counted as active", pending.twoFactor.adminsActive - base.twoFactor.adminsActive === 1);
  check("pending: abandoned enrolment NOT counted as protected", pending.twoFactor.adminsWith2fa === base.twoFactor.adminsWith2fa);
  check("pending: admin surfaces as without 2FA", pending.twoFactor.adminsWithout2fa - base.twoFactor.adminsWithout2fa === 1);
  check("pending: abandoned enrolment not in the enrolment total", pending.twoFactor.enrolmentsTotal === base.twoFactor.enrolmentsTotal);

  await db.execute(sql`update two_factors set verified = true where user_id = ${TFA}`);
  await authService.update(TFA, { twoFactorEnabled: true } as never);
  const confirmed = await getSecuritySignals();
  check("confirmed: admin counted as protected", confirmed.twoFactor.adminsWith2fa - base.twoFactor.adminsWith2fa === 1);
  check("confirmed: without-2FA back to baseline", confirmed.twoFactor.adminsWithout2fa === base.twoFactor.adminsWithout2fa);
  check("confirmed: enrolment total +1", confirmed.twoFactor.enrolmentsTotal - base.twoFactor.enrolmentsTotal === 1);

  // ── identity-04: export keyset paging ───────────────────────────────────
  console.log("identity-04 — collectKeysetPages (pure):");
  const fakePager = (total: number, pageSize: number) => async (cursor: string | undefined) => {
    const start = cursor ? Number(cursor) : 0;
    const items = Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) }, (_, i) => start + i);
    const next = start + items.length;
    return { items, nextCursor: next < total ? String(next) : null };
  };
  const all = await collectKeysetPages(fakePager(450, 200), 10_000);
  check("pure: walks every page past the page clamp", all.items.length === 450 && !all.truncated);
  check("pure: no duplicates / order kept", all.items.every((v, i) => v === i));
  const exact = await collectKeysetPages(fakePager(400, 200), 400);
  check("pure: exactly the cap with nothing left → not truncated", exact.items.length === 400 && !exact.truncated);
  const over = await collectKeysetPages(fakePager(401, 200), 400);
  check("pure: more rows than the cap → truncated at the cap", over.items.length === 400 && over.truncated);
  const overflowPage = await collectKeysetPages(fakePager(1000, 300), 400);
  check("pure: a page overflowing the cap is trimmed + truncated", overflowPage.items.length === 400 && overflowPage.truncated);
  const empty = await collectKeysetPages(fakePager(0, 200), 10);
  check("pure: empty list", empty.items.length === 0 && !empty.truncated);
  let calls = 0;
  const stuck = await collectKeysetPages(async () => {
    calls++;
    return { items: [calls], nextCursor: "same" };
  }, 1000);
  check("pure: a non-advancing cursor stops instead of spinning", stuck.items.length <= 2 && calls <= 2);

  console.log("identity-04 — customer export pages past 200 profiles (µs created_at ties):");
  // A REAL microsecond stamp shared by every row (a bulk import's one `now()`).
  // A millisecond-aligned seed (`…00.000Z`) round-trips a JS-Date cursor exactly
  // and hid the bug: a `toISOString()` cursor truncated `.123456` → `.123`, so
  // every row still left in the boundary row's millisecond was skipped.
  const N = 205;
  await db.insert(customer_profiles).values(
    Array.from({ length: N }, (_, i) => ({
      first_name: `${TAG}-exp`,
      last_name: String(i),
      created_at: sql`'2001-01-01T00:00:00.123456Z'::timestamptz`,
    })) as never,
  );
  // Plus a pair that differs INSIDE one millisecond (newer than the tie block).
  const [pairA] = await db
    .insert(customer_profiles)
    .values({ first_name: `${TAG}-exp`, last_name: "pair-a", created_at: sql`'2001-01-01T00:00:00.456900Z'::timestamptz` } as never)
    .returning({ id: customer_profiles.id });
  const [pairB] = await db
    .insert(customer_profiles)
    .values({ first_name: `${TAG}-exp`, last_name: "pair-b", created_at: sql`'2001-01-01T00:00:00.456100Z'::timestamptz` } as never)
    .returning({ id: customer_profiles.id });
  const TOTAL = N + 2;
  const isTagged = (p: { first_name: string }) => p.first_name === `${TAG}-exp`;
  const full = await collectKeysetPages((cursor) => customerService.list({ limit: 200, cursor }), 10_000);
  const tagged = full.items.filter(isTagged);
  check(`export: all ${TOTAL} tagged profiles collected (was capped at 200)`, tagged.length === TOTAL);
  check("export: no profile emitted twice", new Set(full.items.map((p) => p.id)).size === full.items.length);
  check("export: not truncated under the cap", full.truncated === false);
  const small = await collectKeysetPages((cursor) => customerService.list({ limit: 7, cursor }), 10_000);
  check(
    "export: tiny pages across the µs timestamp tie still collect every row once",
    small.items.filter(isTagged).length === TOTAL &&
      new Set(small.items.map((p) => p.id)).size === small.items.length,
  );
  // Page boundary exactly BETWEEN the pair: a ts-only cursor just above A makes
  // A the whole first page, so its emitted cursor must lead straight to B (same
  // millisecond, 800 µs older).
  const pageA = await customerService.list({ limit: 1, cursor: "2001-01-01T00:00:00.457000Z" });
  check("export: boundary page holds pair A", pageA.items.length === 1 && pageA.items[0].id === pairA.id);
  check(
    "export: the emitted cursor is µs-precise (<created_at .ffffff>|<uuid>)",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f-]{36}$/.test(pageA.nextCursor ?? ""),
  );
  const pageB = await customerService.list({ limit: 1, cursor: pageA.nextCursor ?? undefined });
  check(
    "export: the next page starts at pair B (same millisecond, not skipped)",
    pageB.items.length === 1 && pageB.items[0].id === pairB.id,
  );
  // A malformed cursor falls back to the first page — never a 22007/22008/22P02 500.
  let malformedOk = true;
  for (const bad of ["2025-02-30T00:00:00Z|" + randomUUID(), "2001-01-01T00:00:00Z|not-a-uuid", "1", "garbage|x"]) {
    try {
      const r = await customerService.list({ limit: 1, cursor: bad });
      if (r.items.length !== 1) malformedOk = false;
    } catch {
      malformedOk = false;
    }
  }
  check("export: malformed cursors fall back to the first page (no throw)", malformedOk);
  const capped = await collectKeysetPages((cursor) => customerService.list({ limit: 200, cursor }), 150);
  check("export: cap hit → trimmed to the cap + truncated", capped.items.length === 150 && capped.truncated);

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

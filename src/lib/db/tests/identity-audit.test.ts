import "server-only";

/**
 * Identity audit regression test (A–Z audit 2026-09-23, phase 3 —
 * p3-identity-audit).
 *
 *   1. PURE — verification links land on the storefront result page
 *      (`withVerifyEmailCallback`) and a change-email token's OLD → NEW pair is
 *      read back (`readChangeEmailClaim`).
 *   2. identity-20 — a self-service password change (`auth.api.changePassword`,
 *      the /account path) emits `user.password_changed` server-side, the user as
 *      actor; a wrong current password emits nothing.
 *   3. identity-18 / fanout-12 — a COMPLETED email change (Better Auth's
 *      change-email-verification click) emits `user.email_changed` with MASKED
 *      addresses and re-keys the newsletter row to the new address;
 *      `newsletterService.followEmailChange` moves / deactivates / no-ops.
 *   4. identity-08 — self-service verification emits `user.email_verified`
 *      exactly once (the hook — the legacy workflow no longer doubles it).
 *   5. identity-17 — admin create / invite claim the email's guest orders with
 *      no phone typed; a non-staff (B2B partner) create never claims; a Google
 *      (provider-verified) sign-up claims, an unverified social email doesn't.
 *   6. wiring-05 / oauth-creds — OAuth client credentials save + clear go
 *      through the workflow and emit `auth.oauth_settings_updated` (field names
 *      only, the admin as actor); no-op saves / clears emit nothing.
 *   7. orders-14 — the order CSV export's dedicated keyset walks past the old
 *      100-row clamp, keeps µs timestamp ties, reports truncation at the cap.
 *   8. Source-level — the four admin export routes emit `data.exported`; the
 *      password-reset action has a per-email bucket + the `password_reset`
 *      rate-limit signal.
 *
 * Self-cleaning (`__idaudit…`; the facebook OAuth row is restored). Run against
 * the isolated test DB:
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… EMAIL_PROVIDER=console \
 *     pnpm exec tsx --conditions=react-server src/lib/db/tests/identity-audit.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { createEmailVerificationToken } from "better-auth/api";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import type { EventEnvelope } from "@/events/types";
import { getAuth } from "@/lib/auth/server";
import {
  VERIFY_EMAIL_RESULT_PATH,
  readChangeEmailClaim,
  withVerifyEmailCallback,
} from "@/lib/auth/verify-email-link";
import { collectKeysetPages } from "@/lib/csv/collect-pages";
import { maskEmail } from "@/lib/email/util";
import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import { accounts } from "@/modules/auth/schema";
import { newsletterService } from "@/modules/newsletter/service";
import { oauthSettingsService, oauth_provider_settings } from "@/modules/oauth";
import { orders } from "@/modules/order/schema";
import { listOrdersForExport } from "@/modules/order/export";
import { clearOAuthSettingsWorkflow, upsertOAuthSettingsWorkflow } from "@/workflows/auth/upsert-oauth-settings";
import { verifyEmailWorkflow } from "@/workflows/auth/verify-email";
import { createUserWorkflow } from "@/workflows/auth/create-user";
import { inviteUserWorkflow } from "@/workflows/auth/invite-user";

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

const TAG = "__idaudit";
const ADMIN = `${TAG}-admin`;
const PARTNER = `${TAG}-partner`; // a plain customer acting as a B2B partner
const email = (k: string) => `${TAG}-${k}@example.test`;

async function cleanup() {
  await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
  await db.execute(sql`delete from newsletter_subscriptions where email like ${TAG + "%"}`);
  await db.execute(sql`
    delete from customer_user_links
    where user_id in (select id from users where id like ${TAG + "%"} or email like ${TAG + "%"})`);
  await db.execute(sql`delete from customer_profiles where first_name like ${TAG + "%"}`);
  await db.execute(sql`delete from user_roles where user_id like ${TAG + "%"}`);
  // Invite reset tokens are keyed on Better Auth's generated user id.
  await db.execute(sql`
    delete from verifications
    where value like ${TAG + "%"}
       or value in (select id from users where id like ${TAG + "%"} or email like ${TAG + "%"})`);
  await db.execute(sql`
    delete from accounts
    where user_id in (select id from users where id like ${TAG + "%"} or email like ${TAG + "%"})`);
  await db.execute(sql`
    delete from sessions
    where user_id in (select id from users where id like ${TAG + "%"} or email like ${TAG + "%"})`);
  await db.execute(sql`delete from users where id like ${TAG + "%"} or email like ${TAG + "%"}`);
}

// Account TYPE is role-derived now (no enum): an "admin" gets the super_admin role.
const mkUser = async (
  id: string,
  type: "admin" | "customer",
  opts: { email?: string; verified?: boolean } = {},
) => {
  await authService.insert({
    id,
    email: opts.email ?? `${id}@example.test`,
    name: id,
    emailVerified: opts.verified ?? true,
  } as never);
  if (type === "admin") {
    const sa = await rbacService.findRoleByKey("super_admin");
    if (sa) await rbacService.assignRoleToUser(id, sa.id);
  }
};

let seq = 0;
async function mkGuestOrder(contactEmail: string, createdAt?: string) {
  seq += 1;
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}-${seq}-${Date.now()}`,
      contact_email: contactEmail,
      status: "pending",
      payment_method: "cod",
      subtotal_cents: 10_000,
      shipping_cents: 0,
      total_cents: 10_000,
      ship_full_name: TAG,
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
      ...(createdAt ? { created_at: sql`${createdAt}::timestamptz` } : {}),
    } as never)
    .returning({ id: orders.id });
  return o.id;
}

async function orderOwner(id: string): Promise<string | null> {
  const [r] = await db.select({ u: orders.user_id }).from(orders).where(eq(orders.id, id));
  return r?.u ?? null;
}

/** Tiny cookie jar over Better Auth's `returnHeaders` Set-Cookie output. */
function cookieHeaders(h: Headers | null | undefined): Headers {
  const pairs = (h?.getSetCookie() ?? []).map((c) => c.split(";")[0].trim()).filter((p) => !p.endsWith("="));
  return new Headers({ cookie: pairs.join("; ") });
}

async function throws(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

// Every emitted event of interest, filtered per section.
const events: EventEnvelope[] = [];
for (const name of [
  "user.password_changed",
  "user.email_changed",
  "user.email_verified",
  "auth.oauth_settings_updated",
] as const) {
  bus.on(name, ((env: EventEnvelope) => {
    events.push(env);
  }) as never);
}
const eventsFor = (name: string, userId?: string) =>
  events.filter(
    (e) => e.name === name && (userId === undefined || (e.payload as { userId?: string }).userId === userId),
  );

function pureLinks() {
  console.log("1. Verification-link helpers (pure):");
  const base = "https://shop.example/api/auth/verify-email?token=abc.def.ghi&callbackURL=%2F";
  const rewritten = new URL(withVerifyEmailCallback(base));
  check("default `/` callback → the result page", rewritten.searchParams.get("callbackURL") === VERIFY_EMAIL_RESULT_PATH);
  check("token kept intact", rewritten.searchParams.get("token") === "abc.def.ghi");
  const noCb = new URL(withVerifyEmailCallback("https://shop.example/api/auth/verify-email?token=t"));
  check("missing callback → the result page", noCb.searchParams.get("callbackURL") === VERIFY_EMAIL_RESULT_PATH);
  const explicit = "https://shop.example/api/auth/verify-email?token=t&callbackURL=%2Faccount";
  check("an explicit callback (change-email → /account) is kept", withVerifyEmailCallback(explicit) === explicit);
  check("unparseable input returned unchanged", withVerifyEmailCallback("not a url") === "not a url");

  const jwt = (payload: object) =>
    `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
  const claim = readChangeEmailClaim(jwt({ email: "Old@Example.test", updateTo: "new@example.test", requestType: "change-email-verification" }));
  check("change-email token → old/new pair (lowercased)", claim?.oldEmail === "old@example.test" && claim.newEmail === "new@example.test");
  check("signup token (no updateTo) → null", readChangeEmailClaim(jwt({ email: "a@example.test" })) === null);
  check("same address → null", readChangeEmailClaim(jwt({ email: "a@example.test", updateTo: "A@example.test" })) === null);
  check("garbage / non-string → null", readChangeEmailClaim("nope") === null && readChangeEmailClaim(undefined) === null);
}

async function passwordChange() {
  console.log("2. Self-service password change → user.password_changed:");
  const auth = await getAuth();
  const actx = await auth.$context;
  const U = `${TAG}-pw`;
  const PW = "Correct-horse-battery-9";
  await mkUser(U, "customer");
  await db.insert(accounts).values({
    id: `${U}-acc`,
    userId: U,
    accountId: U,
    providerId: "credential",
    password: await actx.password.hash(PW),
  });
  const signIn = await auth.api.signInEmail({ body: { email: `${U}@example.test`, password: PW }, returnHeaders: true });
  const hdrs = cookieHeaders(signIn.headers);

  const wrong = await throws(() =>
    auth.api.changePassword({
      headers: hdrs,
      body: { currentPassword: "Wrong-password-000", newPassword: "Another-horse-battery-7", revokeOtherSessions: true },
    }),
  );
  check("wrong current password is rejected", wrong);
  check("…and emits nothing", eventsFor("user.password_changed", U).length === 0);

  await auth.api.changePassword({
    headers: hdrs,
    body: { currentPassword: PW, newPassword: "Another-horse-battery-7", revokeOtherSessions: true },
  });
  const ev = eventsFor("user.password_changed", U);
  check("successful change → user.password_changed (once)", ev.length === 1);
  check("the user is the actor", ev[0]?.actorUserId === U);
  check("no password material in the payload", !JSON.stringify(ev[0]?.payload ?? {}).includes("horse"));
}

async function emailChange() {
  console.log("3. Completed email change → user.email_changed + newsletter follows:");
  const auth = await getAuth();
  const actx = await auth.$context;
  const U = `${TAG}-chg`;
  const oldEmail = email("chg-old");
  const newEmail = email("chg-new");
  await mkUser(U, "customer", { email: oldEmail });
  await newsletterService.insert({ email: oldEmail, source: "test" } as never);

  const token = await createEmailVerificationToken(actx.secret, oldEmail, newEmail, 3600, {
    requestType: "change-email-verification",
  });
  await auth.api.verifyEmail({ query: { token } });

  check("the sign-in email moved to the new address", (await authService.findById(U))?.email === newEmail);
  const ev = eventsFor("user.email_changed", U);
  check("user.email_changed emitted once", ev.length === 1);
  const p = ev[0]?.payload as { oldEmailMasked?: string; newEmailMasked?: string } | undefined;
  check("both addresses MASKED", p?.oldEmailMasked === maskEmail(oldEmail) && p?.newEmailMasked === maskEmail(newEmail));
  check(
    "no raw address in the payload",
    !JSON.stringify(ev[0]?.payload ?? {}).includes(oldEmail) && !JSON.stringify(ev[0]?.payload ?? {}).includes(newEmail),
  );
  check("the user is the actor", ev[0]?.actorUserId === U);
  const moved = await newsletterService.findByEmail(newEmail);
  check("newsletter row re-keyed to the new address (still active)", moved?.is_active === true);
  check("no row left on the old address", (await newsletterService.findByEmail(oldEmail)) === null);
  check(
    "the new address is reported verified (user.email_verified)",
    eventsFor("user.email_verified", U).some((e) => (e.payload as { email: string }).email === newEmail),
  );

  console.log("   followEmailChange edge cases:");
  const a = email("nl-a");
  const b = email("nl-b");
  await newsletterService.insert({ email: a, source: "test" } as never);
  await newsletterService.insert({ email: b, source: "test" } as never);
  check("both addresses have a row → the old one is switched off", (await newsletterService.followEmailChange(a, b)) === "deactivated");
  check("…old row inactive", (await newsletterService.findByEmail(a))?.is_active === false);
  check("…new row untouched", (await newsletterService.findByEmail(b))?.is_active === true);
  check("inactive old row + existing new row → no-op", (await newsletterService.followEmailChange(a, b)) === "none");
  check("no old row → no-op", (await newsletterService.followEmailChange(email("nl-none"), b)) === "none");
}

async function emailVerified() {
  console.log("4. Self-service verification → user.email_verified exactly once:");
  const auth = await getAuth();
  const actx = await auth.$context;
  const U = `${TAG}-ver`;
  const addr = email("ver");
  await mkUser(U, "customer", { email: addr, verified: false });
  const guest = await mkGuestOrder(addr);
  const token = await createEmailVerificationToken(actx.secret, addr, undefined, 3600);
  const res = await verifyEmailWorkflow({ token });
  check("legacy workflow verifies", res.ok === true);
  check("the user is now verified", (await authService.findById(U))?.emailVerified === true);
  check("user.email_verified emitted ONCE (hook, not doubled by the workflow)", eventsFor("user.email_verified", U).length === 1);
  check("a plain verification is not an email change", eventsFor("user.email_changed", U).length === 0);
  check("the guest order placed with the verified email is claimed", (await orderOwner(guest)) === U);
}

async function guestOrderClaims() {
  console.log("5. Guest-order claim across account-creation paths:");
  const PW = "Staff-created-pass-2026";

  const e1 = email("create-admin");
  const o1 = await mkGuestOrder(e1);
  const c1 = await createUserWorkflow(
    { email: e1, firstName: `${TAG}-c1`, lastName: "X", password: PW },
    { actorUserId: ADMIN },
  );
  check("admin create (no phone) ok", c1.ok === true);
  check("admin create claims the email's guest order", c1.ok && (await orderOwner(o1)) === c1.data.userId);

  const e2 = email("create-partner");
  const o2 = await mkGuestOrder(e2);
  const c2 = await createUserWorkflow(
    { email: e2, firstName: `${TAG}-c2`, lastName: "X", password: PW },
    { actorUserId: PARTNER },
  );
  check("partner create ok", c2.ok === true);
  check("partner (non-staff) create NEVER claims", (await orderOwner(o2)) === null);

  const e3 = email("invite");
  const o3 = await mkGuestOrder(e3);
  const i3 = await inviteUserWorkflow(
    { email: e3, firstName: `${TAG}-i3`, lastName: "X" },
    { actorUserId: ADMIN },
  );
  check("admin invite (no phone) ok", i3.ok === true);
  check("admin invite claims the email's guest order", i3.ok && (await orderOwner(o3)) === i3.data.userId);

  const actx = await (await getAuth()).$context;
  const e4 = email("google");
  const o4 = await mkGuestOrder(e4);
  const g = await actx.internalAdapter.createOAuthUser(
    { email: e4, name: `${TAG} Google`, emailVerified: true },
    { providerId: "google", accountId: `${TAG}-google-sub` },
  );
  check("Google (provider-verified) sign-up claims the guest order", (await orderOwner(o4)) === g.user.id);

  const e5 = email("facebook");
  const o5 = await mkGuestOrder(e5);
  await actx.internalAdapter.createOAuthUser(
    { email: e5, name: `${TAG} Facebook`, emailVerified: false },
    { providerId: "facebook", accountId: `${TAG}-facebook-sub` },
  );
  check("unverified social email does NOT claim (waits for the verify link)", (await orderOwner(o5)) === null);
}

async function oauthCredentials() {
  console.log("6. OAuth credentials save + clear → auth.oauth_settings_updated:");
  const prior = await oauthSettingsService.get("facebook");
  const hadKey = Boolean(process.env.PAYMENT_ENCRYPTION_KEY?.trim());
  if (!hadKey) process.env.PAYMENT_ENCRYPTION_KEY = "identity-audit-test-key";
  const oauthEvents = () => events.filter((e) => e.name === "auth.oauth_settings_updated");
  try {
    await db.delete(oauth_provider_settings).where(eq(oauth_provider_settings.provider, "facebook"));
    const base = oauthEvents().length;

    const noop = await upsertOAuthSettingsWorkflow({ provider: "facebook" }, { actorUserId: ADMIN });
    check("empty save ok + writes nothing", noop.ok && (await oauthSettingsService.get("facebook")) === null);
    check("…and emits nothing", oauthEvents().length === base);

    const saved = await upsertOAuthSettingsWorkflow(
      { provider: "facebook", clientId: "fb-client-id-123", clientSecret: "fb-secret-456" },
      { actorUserId: ADMIN },
    );
    check("save ok", saved.ok === true);
    const row = await oauthSettingsService.get("facebook");
    check("both fields stored encrypted", !!row?.client_id_enc && !!row?.client_secret_enc && row.client_id_enc !== "fb-client-id-123");
    const ev = oauthEvents().slice(base);
    check("one event per real save", ev.length === 1);
    check(
      "changedFields names both fields",
      JSON.stringify((ev[0]?.payload as { changedFields: string[] }).changedFields) === JSON.stringify(["client_id", "client_secret"]),
    );
    check("the admin is the actor", ev[0]?.actorUserId === ADMIN);
    check(
      "no credential value (plain or cipher) in the payload",
      !/fb-client-id-123|fb-secret-456/.test(JSON.stringify(ev[0]?.payload)) &&
        !JSON.stringify(ev[0]?.payload).includes(row?.client_secret_enc ?? "§"),
    );

    const secretOnly = await upsertOAuthSettingsWorkflow({ provider: "facebook", clientSecret: "rotated" }, { actorUserId: ADMIN });
    const after = await oauthSettingsService.get("facebook");
    check("secret-only save keeps the stored client id", secretOnly.ok && after?.client_id_enc === row?.client_id_enc);
    check(
      "…and reports only client_secret",
      JSON.stringify((oauthEvents().at(-1)?.payload as { changedFields: string[] }).changedFields) === JSON.stringify(["client_secret"]),
    );

    const cleared = await clearOAuthSettingsWorkflow({ provider: "facebook" }, { actorUserId: ADMIN });
    const gone = await oauthSettingsService.get("facebook");
    check("clear erases both fields", cleared.ok && !gone?.client_id_enc && !gone?.client_secret_enc);
    const last = oauthEvents().at(-1);
    check(
      "clear → changedFields [\"cleared\"] with the actor",
      JSON.stringify((last?.payload as { changedFields: string[] }).changedFields) === JSON.stringify(["cleared"]) &&
        last?.actorUserId === ADMIN,
    );
    const n = oauthEvents().length;
    const again = await clearOAuthSettingsWorkflow({ provider: "facebook" }, { actorUserId: ADMIN });
    check("clearing nothing is a no-op (no event)", again.ok && oauthEvents().length === n);
    check("unknown provider refused", (await clearOAuthSettingsWorkflow({ provider: "myspace" }, { actorUserId: ADMIN })).ok === false);
  } finally {
    await db.delete(oauth_provider_settings).where(eq(oauth_provider_settings.provider, "facebook"));
    if (prior) await db.insert(oauth_provider_settings).values(prior);
    if (!hadKey) delete process.env.PAYMENT_ENCRYPTION_KEY;
  }
}

async function orderExport() {
  console.log("7. Order CSV export keyset (µs ties, past the 100-row UI clamp):");
  // 105 rows sharing one REAL microsecond stamp + a pair inside one millisecond.
  const TIE = "2001-01-01T00:00:00.123456Z";
  const tied: string[] = [];
  for (let i = 0; i < 105; i++) tied.push(await mkGuestOrder(email(`exp-${i}`), TIE));
  const pairA = await mkGuestOrder(email("exp-pair-a"), "2001-01-01T00:00:00.456900Z");
  const pairB = await mkGuestOrder(email("exp-pair-b"), "2001-01-01T00:00:00.456100Z");
  const mine = new Set([...tied, pairA, pairB]);

  const full = await collectKeysetPages((cursor) => listOrdersForExport({ limit: 200, cursor }), 1_000_000);
  check(`all ${mine.size} tagged orders collected`, full.items.filter((o) => mine.has(o.id)).length === mine.size);
  check("no order emitted twice", new Set(full.items.map((o) => o.id)).size === full.items.length);
  const small = await collectKeysetPages((cursor) => listOrdersForExport({ limit: 7, cursor }), 1_000_000);
  check(
    "tiny pages across the µs tie still collect every row once",
    small.items.filter((o) => mine.has(o.id)).length === mine.size &&
      new Set(small.items.map((o) => o.id)).size === small.items.length,
  );
  const pageA = await listOrdersForExport({ limit: 1, cursor: "2001-01-01T00:00:00.457000Z" });
  check("boundary page holds pair A", pageA.items[0]?.id === pairA);
  check(
    "cursor is µs-precise (<ts .ffffff>|<uuid>)",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f-]{36}$/.test(pageA.nextCursor ?? ""),
  );
  const pageB = await listOrdersForExport({ limit: 1, cursor: pageA.nextCursor ?? undefined });
  check("next page starts at pair B (same millisecond, not skipped)", pageB.items[0]?.id === pairB);
  let malformedOk = true;
  for (const bad of ["2025-02-30T00:00:00Z|x", "2001-01-01T00:00:00Z|not-a-uuid", "garbage"]) {
    try {
      const r = await listOrdersForExport({ limit: 1, cursor: bad });
      if (r.items.length !== 1) malformedOk = false;
    } catch {
      malformedOk = false;
    }
  }
  check("malformed cursors fall back to the first page (no throw)", malformedOk);
  const capped = await collectKeysetPages((cursor) => listOrdersForExport({ limit: 200, cursor }), 50);
  check("cap hit → trimmed to the cap + truncated", capped.items.length === 50 && capped.truncated);
}

function sourceChecks() {
  console.log("8. Source-level — export audit + password-reset throttle:");
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
  for (const [route, resource] of [
    ["src/app/api/admin/customers/export/route.ts", "customers"],
    ["src/app/api/admin/customers/guests/export/route.ts", "guests"],
    ["src/app/admin/orders/export/route.ts", "orders"],
    ["src/app/admin/system/audit/export/route.ts", "audit"],
  ] as const) {
    const src = read(route);
    check(
      `${resource} export emits data.exported with the actor`,
      new RegExp(`emit\\("data\\.exported", \\{ resource: "${resource}"`).test(src) && src.includes("actorUserId: session.user.id"),
    );
  }
  const actions = read("src/lib/actions/auth.ts");
  const reset = actions.slice(actions.indexOf("export async function requestPasswordResetAction"));
  check("password reset has a per-email bucket", /pwreset:email:\$\{email\}/.test(reset));
  check("password reset records the password_reset rate-limit trip", /kind: "password_reset"/.test(reset));
  check("the throttled response stays neutral (single return)", (reset.slice(0, reset.indexOf("\n}\n")).match(/return \{/g) ?? []).length === 1);
}

async function main() {
  await cleanup();
  await mkUser(ADMIN, "admin");
  await mkUser(PARTNER, "customer");

  pureLinks();
  await passwordChange();
  await emailChange();
  await emailVerified();
  await guestOrderClaims();
  await oauthCredentials();
  await orderExport();
  sourceChecks();

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await cleanup();
  } catch {
    /* best-effort */
  }
  process.exit(1);
});

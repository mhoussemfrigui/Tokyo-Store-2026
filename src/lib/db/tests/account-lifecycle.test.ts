import "server-only";

/**
 * Account-lifecycle fan-out regression test (A–Z audit 2026-09-23, phase 7).
 * FORCES the console provider (DB `mail.provider` + EMAIL_PROVIDER) so NO real
 * email is ever sent. Covers:
 *   • « Supprimer le client » (delete-customer workflow):
 *       – self-action guard: the actor can't archive their OWN record (it would
 *         disable their own login) — refused before any write;
 *       – FAIL-SAFE order: a failure while archiving leaves the account already
 *         disabled / sessions + API keys revoked and the profile LIVE, so the
 *         retry finishes the job (it used to archive first, then die → « Client
 *         introuvable » on retry with the login still live);
 *       – user.disabled / user.sessions_revoked / api_key.revoked are emitted
 *         like disableUserWorkflow, once (a retry doesn't duplicate them);
 *       – idempotent: an ALREADY-archived profile (pre-fix half-run) is accepted
 *         and its offboarding completed; a fully-done re-run emits nothing;
 *       – a staff-linked profile is archived but its login stays active.
 *   • consent: an ARCHIVED profile's explicit opt-out keeps vetoing marketing
 *     (canSendMarketingTo + filterMarketableEmails), even with an active
 *     newsletter row.
 *   • review request: mailed to the consenting ACCOUNT only — an order whose
 *     contact email differs from the account email is skipped (no claim, not
 *     counted); a case-only difference still matches.
 *   • segments / promo targets: archived profiles are not listed as segment
 *     members, are refused by the add-member action, and are dropped + reported
 *     by promo targeting (an all-archived set is refused, never saved public).
 * Self-cleaning (`__altest…`; touched settings / overrides restored). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/account-lifecycle.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { canSendMarketingTo, filterMarketableEmails } from "@/lib/email/consent";
import { invalidateMailConfigCache } from "@/lib/email/config";
import { runReviewRequests } from "@/lib/mailing/review-request/run";
import { emailFlowService, invalidateFlowCache } from "@/modules/mailing";
import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import { sessions } from "@/modules/auth/schema";
import { apiKeyService } from "@/modules/api-key/service";
import { customerService } from "@/modules/customer/service";
import { segmentService } from "@/modules/customer/segment.service";
import { customerUserLink } from "@/associations/customer-user.service";
import { newsletterService } from "@/modules/newsletter/service";
import { promotionService } from "@/modules/promotion";
import { orders } from "@/modules/order/schema";
import { deleteCustomerWorkflow } from "@/workflows/customer/delete-customer";
import { createPromotionWorkflow } from "@/workflows/promotion/manage";

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

type Row = Record<string, unknown>;
function rowsOf(res: unknown): Row[] {
  const r = res as { rows?: Row[] };
  return r.rows ?? (res as Row[]);
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

const TAG = "__altest";
const ADMIN = `${TAG}-admin`; // enum admin — the wildcard actor
const emailOf = (id: string) => `${id}@example.test`;

// ── settings / overrides (snapshot → restore) ───────────────────────────────
const TOUCHED_SETTINGS = ["mail.provider", "mail.marketing_enabled", "mail.review_delay_days"];
const priorSettings = new Map<string, string | null | undefined>();
let priorFlow: boolean | null | undefined;
let priorTemplate: boolean | null | undefined;

async function readSetting(key: string): Promise<string | null | undefined> {
  const rows = rowsOf(await db.execute(sql`select value from site_settings where key = ${key}`));
  return rows.length ? (rows[0].value as string | null) : undefined;
}
async function setSetting(key: string, value: string) {
  await db.execute(
    sql`insert into site_settings (key, value, type, label) values (${key}, ${value}, 'text', 'test')
        on conflict (key) do update set value = ${value}`,
  );
}
async function restoreAll() {
  for (const [key, prior] of priorSettings) {
    if (prior === undefined) await db.execute(sql`delete from site_settings where key = ${key}`);
    else await db.execute(sql`update site_settings set value = ${prior} where key = ${key}`);
  }
  priorSettings.clear();
  if (priorFlow !== undefined) {
    if (priorFlow === null) await db.execute(sql`delete from email_flows where flow_key = 'review_request'`);
    else await emailFlowService.upsert("review_request", priorFlow);
    invalidateFlowCache();
    priorFlow = undefined;
  }
  if (priorTemplate !== undefined) {
    if (priorTemplate === null) {
      await db.execute(sql`delete from email_template_overrides where template_key = 'review_request'`);
    } else {
      await db.execute(
        sql`update email_template_overrides set is_enabled = ${priorTemplate} where template_key = 'review_request'`,
      );
    }
    priorTemplate = undefined;
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const orderIds: string[] = [];

async function cleanup() {
  await db.execute(sql`delete from email_logs where lower(to_email) like ${TAG + "%"}`);
  for (const id of orderIds) await db.execute(sql`delete from mailing_sends where dedup_key = ${id}`);
  await db.execute(sql`delete from order_items where order_id in (select id from orders where order_number like ${TAG.toUpperCase() + "%"})`);
  await db.execute(sql`delete from orders where order_number like ${TAG.toUpperCase() + "%"}`);
  await db.execute(
    sql`delete from promotion_targets where promotion_id in (select id from promotions where name like ${TAG + "%"})`,
  );
  await db.execute(sql`delete from promotions where name like ${TAG + "%"}`);
  await db.execute(
    sql`delete from customer_segment_members where segment_id in (select id from customer_segments where name like ${TAG + "%"})`,
  );
  await db.execute(sql`delete from customer_segments where name like ${TAG + "%"}`);
  await db.execute(sql`delete from api_keys where name like ${TAG + "%"}`);
  await db.execute(sql`delete from sessions where user_id like ${TAG + "%"}`);
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
  await db.execute(sql`delete from user_roles where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
  await db.execute(
    sql`delete from role_permissions where role_id in (select id from roles where key like ${TAG + "%"})`,
  );
  await db.execute(sql`delete from roles where key like ${TAG + "%"}`);
  _staffRoleId = null;
}

// Access is role-only (no enum). A fixture "staff" = holds a scoped RBAC role
// WITH a real grant (so `isInternalAccount` is true, which is what keeps its
// login alive when its customer profile is deleted); "admin" = super_admin ('*').
let _staffRoleId: string | null = null;
async function ensureStaffRole(): Promise<string> {
  if (_staffRoleId) return _staffRoleId;
  const key = `${TAG}-staff-role`;
  const existing = await rbacService.findRoleByKey(key);
  const role =
    existing ??
    (await rbacService.createRole({ key, name: `${TAG} staff`, description: null, is_system: false }));
  if (!existing) await rbacService.setRolePermissions(role.id, ["orders:view"]);
  _staffRoleId = role.id;
  return role.id;
}

async function mkCustomer(
  id: string,
  opts: { role?: "customer" | "staff" | "admin"; optIn?: boolean } = {},
): Promise<string> {
  await authService.insert({ id, email: emailOf(id), name: id } as never);
  const type = opts.role ?? "customer";
  if (type === "admin") {
    const sa = await rbacService.findRoleByKey("super_admin");
    if (sa) await rbacService.assignRoleToUser(id, sa.id);
  } else if (type === "staff") {
    await rbacService.assignRoleToUser(id, await ensureStaffRole());
  }
  const profile = await customerService.insertProfile({
    first_name: TAG,
    last_name: id,
    marketing_opt_in: opts.optIn ?? false,
  } as never);
  await customerUserLink.create({ customer_profile_id: profile.id, user_id: id } as never);
  return profile.id;
}

async function mkSessions(userId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await db.insert(sessions).values({
      id: `${userId}-s${i}`,
      userId,
      token: `${userId}-tok${i}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  }
}

async function sessionCount(userId: string): Promise<number> {
  return rowsOf(await db.execute(sql`select 1 from sessions where user_id = ${userId}`)).length;
}

async function profileDeletedAt(pid: string): Promise<Date | null> {
  const rows = rowsOf(await db.execute(sql`select deleted_at from customer_profiles where id = ${pid}`));
  const v = rows[0]?.deleted_at;
  return v ? new Date(v as string) : null;
}

async function liveAddressCount(pid: string): Promise<number> {
  return rowsOf(
    await db.execute(sql`select 1 from addresses where customer_profile_id = ${pid} and deleted_at is null`),
  ).length;
}

let seq = 0;
async function mkDeliveredOrder(userId: string, contactEmail: string): Promise<string> {
  seq += 1;
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `${TAG.toUpperCase()}-${seq}-${Date.now()}`,
      user_id: userId,
      contact_email: contactEmail,
      status: "delivered",
      payment_method: "cod",
      subtotal_cents: 100_000,
      shipping_cents: 7_000,
      tax_cents: 0,
      total_cents: 107_000,
      ship_full_name: "Mohamed Ben Salah",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
      // Inside the default J+4 window ([now-5d, now-4d)).
      updated_at: sql`now() - interval '4 days 12 hours'`,
    } as never)
    .returning({ id: orders.id });
  orderIds.push(o.id);
  return o.id;
}

async function claimExists(flowKey: string, dedupKey: string): Promise<boolean> {
  const rows = rowsOf(
    await db.execute(
      sql`select 1 from mailing_sends where flow_key = ${flowKey} and dedup_key = ${dedupKey} limit 1`,
    ),
  );
  return rows.length > 0;
}

async function logsFor(toEmail: string): Promise<Row[]> {
  return rowsOf(
    await db.execute(sql`select * from email_logs where lower(to_email) = ${toEmail.toLowerCase()} order by created_at`),
  );
}

/** Poll for the async, best-effort log write (not awaited by the chokepoint). */
async function waitForLogs(toEmail: string, min = 1, tries = 80): Promise<Row[]> {
  for (let i = 0; i < tries; i++) {
    const rows = await logsFor(toEmail);
    if (rows.length >= min) return rows;
    await sleep(50);
  }
  return logsFor(toEmail);
}

// ── event capture ────────────────────────────────────────────────────────────
type Captured = { name: string; payload: Record<string, unknown> };
const events: Captured[] = [];
bus.onAny((env) => {
  events.push({ name: env.name, payload: env.payload as Record<string, unknown> });
});
const eventsFor = (name: string, key: string, value: string) =>
  events.filter((e) => e.name === name && e.payload[key] === value);

async function main() {
  await cleanup();
  for (const k of TOUCHED_SETTINGS) priorSettings.set(k, await readSetting(k));
  // Force the console provider so the test never dispatches a real email.
  await setSetting("mail.provider", "console");
  process.env.EMAIL_PROVIDER = "console";
  invalidateMailConfigCache();

  // ADMIN is only an attribution actor here (its targets are plain customers it
  // already out-ranks) — no RBAC grant needed.
  await authService.insert({ id: ADMIN, email: emailOf(ADMIN), name: ADMIN } as never);

  // ── 1) self-action guard ─────────────────────────────────────────────────
  console.log("delete-customer — self-action guard:");
  const SELF = `${TAG}-self`;
  const selfPid = await mkCustomer(SELF);
  await mkSessions(SELF, 1);
  const selfRes = await deleteCustomerWorkflow({ customerProfileId: selfPid }, { actorUserId: SELF });
  check("self: refused with self_action", !selfRes.ok && selfRes.error === "self_action");
  check("self: own account NOT disabled", !(await authService.findById(SELF))?.disabledAt);
  check("self: own sessions kept", (await sessionCount(SELF)) === 1);
  check("self: profile still live", (await customerService.findProfileById(selfPid)) !== null);

  // ── 2) fail-safe order + retry ───────────────────────────────────────────
  console.log("delete-customer — fail-safe order (archive failure keeps the run retryable):");
  const CUST = `${TAG}-cust`;
  const custPid = await mkCustomer(CUST, { optIn: true });
  await newsletterService.insert({ email: emailOf(CUST), source: "test" } as never);
  await customerService.insertAddress({
    customer_profile_id: custPid,
    full_name: "Client Test",
    street_line1: "1 rue",
    city: "Tunis",
  } as never);
  await mkSessions(CUST, 2);
  const key = await apiKeyService.create({ name: `${TAG}-key`, scopes: [], expiresAt: null, createdBy: CUST });

  const origArchive = customerService.softDeleteAddressesByProfile;
  customerService.softDeleteAddressesByProfile = async () => {
    throw new Error("simulated statement timeout");
  };
  events.length = 0;
  let first: Awaited<ReturnType<typeof deleteCustomerWorkflow>> | undefined;
  try {
    first = await deleteCustomerWorkflow({ customerProfileId: custPid }, { actorUserId: ADMIN });
  } finally {
    customerService.softDeleteAddressesByProfile = origArchive;
  }
  check("fault: the run reports a failure", first?.ok === false);
  check("fault: account ALREADY disabled (offboarded first)", !!(await authService.findById(CUST))?.disabledAt);
  check("fault: sessions ALREADY revoked", (await sessionCount(CUST)) === 0);
  check(
    "fault: API key ALREADY revoked",
    !!(await apiKeyService.list()).find((k) => k.id === key.row.id)?.revoked_at,
  );
  check("fault: profile still LIVE → retry possible", (await customerService.findProfileById(custPid)) !== null);
  check("fault: user.disabled emitted once", eventsFor("user.disabled", "userId", CUST).length === 1);
  const sr = eventsFor("user.sessions_revoked", "userId", CUST);
  check("fault: user.sessions_revoked emitted with the count", sr.length === 1 && sr[0].payload.revokedCount === 2);
  check("fault: api_key.revoked emitted", eventsFor("api_key.revoked", "keyId", key.row.id).length === 1);
  check("fault: NO customer.deleted yet", eventsFor("customer.deleted", "customerProfileId", custPid).length === 0);

  events.length = 0;
  const retry = await deleteCustomerWorkflow({ customerProfileId: custPid }, { actorUserId: ADMIN });
  check("retry: ok (not « Client introuvable »)", retry.ok);
  check("retry: profile archived", (await profileDeletedAt(custPid)) !== null);
  check("retry: addresses archived", (await liveAddressCount(custPid)) === 0);
  check("retry: customer.deleted emitted once", eventsFor("customer.deleted", "customerProfileId", custPid).length === 1);
  check("retry: user.disabled NOT re-emitted", eventsFor("user.disabled", "userId", CUST).length === 0);
  check("retry: no empty user.sessions_revoked row", eventsFor("user.sessions_revoked", "userId", CUST).length === 0);
  check(
    "retry: marketing still withdrawn (newsletter row unsubscribed)",
    (await newsletterService.findByEmail(emailOf(CUST)))?.is_active === false,
  );

  // A fully-done re-run is a silent no-op.
  const stamp = await profileDeletedAt(custPid);
  events.length = 0;
  const again = await deleteCustomerWorkflow({ customerProfileId: custPid }, { actorUserId: ADMIN });
  check("re-run: ok", again.ok);
  check("re-run: no event emitted", events.filter((e) => e.name !== "newsletter.unsubscribed").length === 0);
  check("re-run: deleted_at stamp unchanged", (await profileDeletedAt(custPid))?.getTime() === stamp?.getTime());

  // ── 3) pre-fix half-run: profile archived, login still live ──────────────
  console.log("delete-customer — idempotent over an already-archived profile:");
  const HALF = `${TAG}-half`;
  const halfPid = await mkCustomer(HALF);
  await mkSessions(HALF, 1);
  await customerService.softDeleteProfile(halfPid); // what the old order left behind
  const halfStamp = await profileDeletedAt(halfPid);
  events.length = 0;
  const half = await deleteCustomerWorkflow({ customerProfileId: halfPid }, { actorUserId: ADMIN });
  check("half-run: accepted (ok)", half.ok);
  check("half-run: account now disabled", !!(await authService.findById(HALF))?.disabledAt);
  check("half-run: sessions revoked", (await sessionCount(HALF)) === 0);
  check("half-run: user.disabled emitted", eventsFor("user.disabled", "userId", HALF).length === 1);
  check("half-run: customer.deleted emitted (finally)", eventsFor("customer.deleted", "customerProfileId", halfPid).length === 1);
  check("half-run: original deleted_at kept", (await profileDeletedAt(halfPid))?.getTime() === halfStamp?.getTime());

  // ── 4) staff-linked profile: archived, login untouched ───────────────────
  console.log("delete-customer — staff-linked profile keeps its login:");
  const STAFF = `${TAG}-staff`;
  const staffPid = await mkCustomer(STAFF, { role: "staff" });
  await mkSessions(STAFF, 1);
  events.length = 0;
  const staff = await deleteCustomerWorkflow({ customerProfileId: staffPid }, { actorUserId: ADMIN });
  check("staff: ok", staff.ok);
  check("staff: profile archived", (await profileDeletedAt(staffPid)) !== null);
  check("staff: account stays active", !(await authService.findById(STAFF))?.disabledAt);
  check("staff: sessions kept", (await sessionCount(STAFF)) === 1);
  check("staff: no user.disabled", eventsFor("user.disabled", "userId", STAFF).length === 0);
  check("staff: customer.deleted emitted", eventsFor("customer.deleted", "customerProfileId", staffPid).length === 1);

  // ── 5) consent: an archived profile's opt-out keeps vetoing ──────────────
  console.log("consent — explicit opt-out survives the archive:");
  const OPTOUT = `${TAG}-optout`;
  const optoutPid = await mkCustomer(OPTOUT, { optIn: false });
  // An anonymous footer re-subscribe re-activated the newsletter row while the
  // profile opt-out is meant to keep winning.
  await newsletterService.insert({ email: emailOf(OPTOUT), source: "test" } as never);
  await customerService.softDeleteProfile(optoutPid);
  check("consent: archived + opted-out → canSendMarketingTo false", (await canSendMarketingTo(emailOf(OPTOUT))) === false);
  check(
    "consent: archived + opted-out → filtered out of a blast",
    !(await filterMarketableEmails([emailOf(OPTOUT)])).has(emailOf(OPTOUT)),
  );
  const OPTIN = `${TAG}-optin`;
  await mkCustomer(OPTIN, { optIn: true });
  check("consent: live opted-in customer still passes", (await canSendMarketingTo(emailOf(OPTIN))) === true);
  check("consent: live opted-in customer kept in a blast", (await filterMarketableEmails([emailOf(OPTIN)])).has(emailOf(OPTIN)));

  // ── 6) review request → the consenting account only ─────────────────────
  console.log("review request — recipient is the consenting account:");
  await setSetting("mail.marketing_enabled", "true");
  await setSetting("mail.review_delay_days", "4");
  const flowRow = rowsOf(await db.execute(sql`select is_enabled from email_flows where flow_key = 'review_request'`))[0];
  priorFlow = flowRow ? (flowRow.is_enabled as boolean) : null;
  await emailFlowService.upsert("review_request", true);
  invalidateFlowCache();
  const tplRow = rowsOf(
    await db.execute(sql`select is_enabled from email_template_overrides where template_key = 'review_request'`),
  )[0];
  priorTemplate = tplRow ? (tplRow.is_enabled as boolean) : null;
  if (tplRow) {
    await db.execute(sql`update email_template_overrides set is_enabled = true where template_key = 'review_request'`);
  }

  const RRM = `${TAG}-rrmatch`;
  const RRX = `${TAG}-rrmismatch`;
  await mkCustomer(RRM, { optIn: true });
  await mkCustomer(RRX, { optIn: true });
  const THIRD = `${TAG}-third-party@example.test`;
  // Same address, different case → still the account's address.
  const matchOrder = await mkDeliveredOrder(RRM, emailOf(RRM).toUpperCase());
  const mismatchOrder = await mkDeliveredOrder(RRX, THIRD);

  const run = await runReviewRequests();
  check("review: run ok", run.ok && run.status !== "skipped");
  const mLogs = await waitForLogs(emailOf(RRM));
  check("review: matching order → queued to the ACCOUNT email", mLogs.length === 1 && mLogs[0].status === "queued");
  check("review: matching order claimed", await claimExists("review_request", matchOrder));
  check("review: mismatched order NOT claimed", !(await claimExists("review_request", mismatchOrder)));
  check("review: third-party contact address never mailed", (await logsFor(THIRD)).length === 0);
  check("review: account of the mismatched order not mailed either", (await logsFor(emailOf(RRX))).length === 0);
  const skipped = /(\d+) ignorée\(s\)/.exec(run.summary);
  check("review: summary reports the skipped order", skipped != null && Number(skipped[1]) >= 1);
  const sentM = /: (\d+) email/.exec(run.summary);
  check("review: skipped order not counted as sent", sentM != null && Number(sentM[1]) >= 1);
  await restoreAll();

  // ── 7) segments / promo targets ignore archived profiles ─────────────────
  console.log("segments + promo targets — archived profiles:");
  const LIVE = `${TAG}-live`;
  const livePid = await mkCustomer(LIVE);
  const seg = await segmentService.insert({ name: `${TAG}-seg`, kind: "manual", enabled: true } as never);
  await segmentService.addMember(seg.id, livePid);
  await segmentService.addMember(seg.id, optoutPid); // archived above
  const members = await segmentService.listMembers(seg.id);
  check(
    "segment: listMembers shows only the live profile",
    members.length === 1 && members[0].profileId === livePid,
  );
  // The add-member action (session-gated server action — asserted statically)
  // checks the profile is live BEFORE inserting the membership.
  const actionSrc = readFileSync(join(process.cwd(), "src", "lib", "actions", "segments.ts"), "utf8");
  const addFn = actionSrc.slice(actionSrc.indexOf("export async function addSegmentMemberByEmailAction"));
  check(
    "segment: add-by-email refuses an archived profile before addMember",
    addFn.includes("findProfileById(link.customer_profile_id)") &&
      addFn.indexOf("findProfileById(link.customer_profile_id)") < addFn.indexOf("segmentService.addMember(") &&
      addFn.includes("Client archivé"),
  );

  const actor = { actorUserId: ADMIN };
  const wfBase = (name: string, code: string) => ({
    name,
    triggerKind: "code" as const,
    code,
    scope: "cart" as const,
    discountType: "percent" as const,
    discountValue: 10,
  });
  const onlyArchived = await createPromotionWorkflow(
    { ...wfBase(`${TAG}-promo-archived`, "__ALTESTWF1"), targetCustomerEmails: [emailOf(OPTOUT)] },
    actor,
  );
  check(
    "promo: only an archived customer → validation fail (never saved public)",
    !onlyArchived.ok &&
      onlyArchived.error === "validation" &&
      !!onlyArchived.fieldErrors?.targets &&
      (onlyArchived.fieldErrors?.targetCustomerEmails ?? "").includes("archivé"),
  );
  check("promo: refused promo row was NOT inserted", !(await promotionService.findLiveByCode("__ALTESTWF1")));
  const mixed = await createPromotionWorkflow(
    { ...wfBase(`${TAG}-promo-mixed`, "__ALTESTWF2"), targetCustomerEmails: [emailOf(LIVE), emailOf(OPTOUT)] },
    actor,
  );
  check("promo: live + archived → saved", mixed.ok);
  if (mixed.ok) {
    const t = await promotionService.listTargets(mixed.data.promotionId);
    check("promo: only the live profile is targeted", t.length === 1 && t[0].target_id === livePid);
    check(
      "promo: warning names the archived email",
      mixed.data.warnings.some((w) => w.includes("client archivé") && w.includes(emailOf(OPTOUT))),
    );
  }

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await restoreAll();
      await cleanup();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));

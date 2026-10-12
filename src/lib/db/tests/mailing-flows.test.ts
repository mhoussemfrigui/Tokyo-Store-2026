import "server-only";

/**
 * Mailing — automation-flow correctness regression test (A–Z audit 2026-09-23).
 * FORCES the console provider (DB `mail.provider` + EMAIL_PROVIDER) so NO real
 * email is ever sent. Covers:
 *   • describePromoDiscount — « −10 % » / « −5 TND » / « Livraison offerte » /
 *     « … + livraison offerte » (never « 0% » for a free-delivery code).
 *   • flow_key is recorded for the welcome, newsletter-coupon and order-receipt sends.
 *   • order receipt: « enregistrée » (not « confirmée »), « en attente de paiement »
 *     for a pending online order, a TVA row in "ht" mode, « dont TVA » in "ttc";
 *     status mails greet with the FIRST name.
 *   • sync-marketing-optin emits newsletter.subscribed/unsubscribed (source
 *     "account", with the actor), and the welcome coupon ignores source "account".
 *   • birthday run: the marketing kill-switch / disabled template skip the run
 *     WITHOUT burning claims; a per-recipient skip releases its claim; only queued
 *     mails are counted; a re-run never double-queues.
 *   • promotion announcement: detached fan-out enqueues once per recipient
 *     (idempotent), skips a scheduled promo, and a kill-switch-off run burns no claim.
 * Self-cleaning (`__mailtest…`; touched settings restored). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/mailing-flows.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { registerOrderReceiptSubscriber } from "@/events/subscribers/send-order-receipt";
import { registerOrderConfirmedEmailSubscriber } from "@/events/subscribers/send-order-confirmed";
import { registerWelcomeEmailSubscriber } from "@/events/subscribers/send-welcome-email";
import { registerWelcomeCouponSubscriber } from "@/events/subscribers/send-welcome-coupon";
import { registerMarketingOptInSyncSubscriber } from "@/events/subscribers/sync-marketing-optin";
import { registerPromotionAnnouncementSubscriber } from "@/events/subscribers/send-promotion-announcement";
import { runBirthdayEmails } from "@/lib/mailing/birthday/run";
import { describePromoDiscount } from "@/lib/mailing/promo-describe";
import { storeDay, storeMonth, storeYear } from "@/lib/promotions/segments";
import { invalidateMailConfigCache } from "@/lib/email/config";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { promotionService } from "@/modules/promotion";
import { runPromotionAnnounceSweep } from "@/lib/mailing/promotion-announce/run";
import { workflows } from "@/workflows";
import { orders } from "@/modules/order/schema";
import type { NewPromotionRow, PromotionRow } from "@/modules/promotion/schema";

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

// ── settings (snapshot → restore) ───────────────────────────────────────────
const TOUCHED_SETTINGS = [
  "mail.provider",
  "mail.marketing_enabled",
  "mail.birthday_code",
  "newsletter.welcome_code",
];
const priorSettings = new Map<string, string | null | undefined>();

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
async function restoreSettings() {
  for (const [key, prior] of priorSettings) {
    if (prior === undefined) await db.execute(sql`delete from site_settings where key = ${key}`);
    else await db.execute(sql`update site_settings set value = ${prior} where key = ${key}`);
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const orderIds: string[] = [];
const profileIds: string[] = [];
let priorBirthdayOverride: { is_enabled: boolean } | null | undefined;

async function cleanup() {
  await db.execute(sql`delete from email_logs where to_email like '__mailtest%'`);
  await db.execute(sql`delete from mailing_sends where dedup_key like '%__mailtest%'`);
  for (const id of orderIds) await db.execute(sql`delete from mailing_sends where dedup_key = ${id}`);
  for (const id of profileIds) await db.execute(sql`delete from mailing_sends where dedup_key like ${`${id}:%`}`);
  await db.execute(sql`delete from order_items where order_id in (select id from orders where order_number like '__MAILTEST%')`);
  await db.execute(sql`delete from orders where order_number like '__MAILTEST%'`);
  await db.execute(
    sql`delete from promotion_targets where promotion_id in (select id from promotions where name like '__mailtest%')`,
  );
  await db.execute(sql`delete from promotions where name like '__mailtest%'`);
  await db.execute(sql`delete from newsletter_subscriptions where email like '__mailtest%'`);
  await db.execute(sql`delete from email_suppressions where email like '__mailtest%'`);
  await db.execute(sql`delete from customer_user_links where user_id like '__mailtest%'`);
  await db.execute(sql`delete from customer_profiles where first_name like '__mailtest%'`);
  await db.execute(sql`delete from users where id like '__mailtest%'`);
}

async function mkCustomer(
  id: string,
  opts: { optIn: boolean; firstName?: string; birthday?: string | null },
): Promise<string> {
  await authService.insert({ id, email: `${id}@example.test`, name: id, role: "customer" } as never);
  const profile = await customerService.insertProfile({
    first_name: opts.firstName ?? "__mailtest",
    last_name: "x",
    marketing_opt_in: opts.optIn,
    birthday: opts.birthday ?? null,
  } as never);
  await customerUserLink.create({ customer_profile_id: profile.id, user_id: id } as never);
  profileIds.push(profile.id);
  return profile.id;
}

let seq = 0;
async function mkPromo(over: Partial<NewPromotionRow> = {}): Promise<PromotionRow> {
  seq += 1;
  return promotionService.insert({
    name: `__mailtest-flow-${seq}`,
    trigger_kind: "code",
    code: `__MAILTESTF${seq}`,
    scope: "cart",
    discount_type: "percent",
    discount_value: 10,
    is_active: true,
    ...over,
  } as NewPromotionRow);
}

async function mkOrder(over: Record<string, unknown>): Promise<string> {
  seq += 1;
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `__MAILTEST-${seq}-${Date.now()}`,
      contact_email: `__mailtest-order-${seq}@example.test`,
      status: "pending",
      payment_method: "cod",
      subtotal_cents: 100_000,
      shipping_cents: 7_000,
      tax_cents: 0,
      total_cents: 107_000,
      ship_full_name: "Mohamed Ben Salah",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
      ...over,
    } as never)
    .returning({ id: orders.id, order_number: orders.order_number, contact_email: orders.contact_email });
  orderIds.push(o.id);
  return o.id;
}

async function orderEmail(id: string): Promise<{ email: string; number: string }> {
  const rows = rowsOf(await db.execute(sql`select contact_email, order_number from orders where id = ${id}`));
  return { email: rows[0].contact_email as string, number: rows[0].order_number as string };
}

async function logsFor(toEmail: string): Promise<Row[]> {
  return rowsOf(
    await db.execute(sql`select * from email_logs where to_email = ${toEmail} order by created_at`),
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

async function claimExists(flowKey: string, dedupKey: string): Promise<boolean> {
  const rows = rowsOf(
    await db.execute(
      sql`select 1 from mailing_sends where flow_key = ${flowKey} and dedup_key = ${dedupKey} limit 1`,
    ),
  );
  return rows.length > 0;
}

// Detached subscribers report their skips via console.warn — capture them so the
// negative checks wait for the background work to FINISH instead of sleeping.
const warnings: string[] = [];
const origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(" "));
  origWarn(...args);
};
async function waitForWarning(fragment: string, tries = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (warnings.some((w) => w.includes(fragment))) return true;
    await sleep(50);
  }
  return false;
}

async function main() {
  await cleanup();
  for (const k of TOUCHED_SETTINGS) priorSettings.set(k, await readSetting(k));
  // Force the console provider so the test never dispatches a real email.
  await setSetting("mail.provider", "console");
  process.env.EMAIL_PROVIDER = "console";
  invalidateMailConfigCache();

  // Drop any subscribers that ran at import time (subscribers/index.ts calls
  // registerAllSubscribers() on load) so the explicit set below is registered
  // EXACTLY ONCE. Without this, sync-marketing-optin is double-registered and the
  // newsletter reactivation path races to emit `newsletter.subscribed` twice, which
  // flakes the `seen.length === 1` reactivation assertion. Production is unaffected
  // (registerAllSubscribers is one-shot guarded); this makes the test match it.
  bus.__reset();
  registerOrderReceiptSubscriber();
  registerOrderConfirmedEmailSubscriber();
  registerWelcomeEmailSubscriber();
  registerWelcomeCouponSubscriber();
  registerMarketingOptInSyncSubscriber();
  registerPromotionAnnouncementSubscriber();

  // ── 1) describePromoDiscount (pure) ──────────────────────────────────────
  check(
    "percent → « −10 % »",
    describePromoDiscount({ discount_type: "percent", discount_value: 10, grants_free_shipping: false }) === "−10 %",
  );
  check(
    "fixed 5000 millimes → « −5 TND »",
    describePromoDiscount({ discount_type: "fixed", discount_value: 5000, grants_free_shipping: false }) === "−5 TND",
  );
  check(
    "free-shipping only (value 0) → « Livraison offerte »",
    describePromoDiscount({ discount_type: "percent", discount_value: 0, grants_free_shipping: true }) ===
      "Livraison offerte",
  );
  check(
    "discount + free shipping → « −15 % + livraison offerte »",
    describePromoDiscount({ discount_type: "percent", discount_value: 15, grants_free_shipping: true }) ===
      "−15 % + livraison offerte",
  );

  // ── 2) welcome email carries flow_key ────────────────────────────────────
  await bus.emit("user.created", {
    userId: "__mailtest-nouser",
    email: "__mailtest-welcome-flow@example.test",
    name: "Mohamed Frigui",
  });
  const welcome = (await waitForLogs("__mailtest-welcome-flow@example.test"))[0];
  check("welcome → logged with flow_key = welcome", welcome?.flow_key === "welcome");

  // ── 3) order receipt ─────────────────────────────────────────────────────
  // "ht": total = subtotal + shipping + tax → a real TVA row.
  const htId = await mkOrder({ tax_cents: 19_000, total_cents: 126_000 });
  const ht = await orderEmail(htId);
  await bus.emit("order.created", { orderId: htId, orderNumber: ht.number, totalCents: 126_000 });
  const htLog = (await waitForLogs(ht.email))[0];
  const htBody = String(htLog?.body ?? "");
  check("receipt → flow_key = order_confirmation", htLog?.flow_key === "order_confirmation");
  check("receipt (COD) → subject says « enregistrée », not « confirmée »", /est enregistrée/.test(String(htLog?.subject)) && !/confirmée/.test(String(htLog?.subject)));
  check("receipt (ht) → a TVA row with the tax amount", htBody.includes(">TVA<") && htBody.includes("19 TND"));
  check("receipt → greets with the first name", htBody.includes("Merci Mohamed !"));

  // "ttc": the other components already equal the total → « dont TVA » note, no row.
  const ttcId = await mkOrder({ tax_cents: 17_084, total_cents: 107_000 });
  const ttc = await orderEmail(ttcId);
  await bus.emit("order.created", { orderId: ttcId, orderNumber: ttc.number, totalCents: 107_000 });
  const ttcBody = String((await waitForLogs(ttc.email))[0]?.body ?? "");
  check("receipt (ttc) → « dont TVA » note", ttcBody.includes("dont TVA"));
  check("receipt (ttc) → no added TVA row", !ttcBody.includes(">TVA<"));

  // Pending ONLINE order → « en attente de paiement ».
  const onlineId = await mkOrder({ payment_method: "clictopay" });
  const online = await orderEmail(onlineId);
  await bus.emit("order.created", { orderId: onlineId, orderNumber: online.number, totalCents: 107_000 });
  const onlineLog = (await waitForLogs(online.email))[0];
  check(
    "receipt (pending online) → « en attente de paiement »",
    /en attente de paiement/.test(String(onlineLog?.subject)) &&
      String(onlineLog?.body).includes("dès réception de votre paiement en ligne"),
  );

  // order_confirmed greets with the FIRST name (was the full ship name).
  const confId = await mkOrder({});
  const conf = await orderEmail(confId);
  await bus.emit("order.confirmed", { orderId: confId, orderNumber: conf.number });
  const confBody = String((await waitForLogs(conf.email))[0]?.body ?? "");
  check("order_confirmed → « Merci, Mohamed ! » (first name only)", confBody.includes("Merci, Mohamed !") && !confBody.includes("Ben Salah"));

  // ── 4) sync-marketing-optin emits newsletter events; coupon ignores "account" ─
  const welcomePromo = await mkPromo({
    code: "__MAILTESTWELCOME",
    discount_type: "percent",
    discount_value: 0,
    grants_free_shipping: true,
  });
  await setSetting("newsletter.welcome_code", welcomePromo.code as string);

  const seen: Array<{ name: string; source: unknown; reactivated?: unknown; actor: string | null }> = [];
  bus.on("newsletter.subscribed", (env) => {
    seen.push({ name: env.name, source: env.payload.source, reactivated: env.payload.reactivated, actor: env.actorUserId ?? null });
  });
  bus.on("newsletter.unsubscribed", (env) => {
    seen.push({ name: env.name, source: env.payload.source, actor: env.actorUserId ?? null });
  });

  const optPid = await mkCustomer("__mailtest-optin", { optIn: false });
  const optEmail = "__mailtest-optin@example.test";
  const flip = async (on: boolean) => {
    await db.execute(sql`update customer_profiles set marketing_opt_in = ${on} where id = ${optPid}`);
    seen.length = 0;
    await bus.emit(
      "customer.profile_updated",
      { userId: "__mailtest-optin", customerProfileId: optPid, changedFields: ["marketing_opt_in"] },
      { actorUserId: "__mailtest-optin" },
    );
  };
  const nlRow = async () =>
    rowsOf(await db.execute(sql`select is_active from newsletter_subscriptions where email = ${optEmail}`))[0];

  await flip(true);
  check("opt-in ON → newsletter row created + active", (await nlRow())?.is_active === true);
  check(
    "opt-in ON → newsletter.subscribed {source account, reactivated false} with the actor",
    seen.length === 1 &&
      seen[0].name === "newsletter.subscribed" &&
      seen[0].source === "account" &&
      seen[0].reactivated === false &&
      seen[0].actor === "__mailtest-optin",
  );
  await sleep(300);
  check(
    "account opt-in → NO newsletter welcome coupon",
    !(await logsFor(optEmail)).some((r) => r.flow_key === "newsletter_coupon"),
  );

  await flip(false);
  check("opt-in OFF → newsletter row unsubscribed", (await nlRow())?.is_active === false);
  check(
    "opt-in OFF → newsletter.unsubscribed {source account} with the actor",
    seen.length === 1 && seen[0].name === "newsletter.unsubscribed" && seen[0].source === "account" && seen[0].actor === "__mailtest-optin",
  );

  await flip(true);
  check(
    "opt-in ON again → newsletter.subscribed {reactivated true}",
    seen.length === 1 && seen[0].reactivated === true && (await nlRow())?.is_active === true,
  );

  // A FOOTER signup still gets the coupon — with flow_key + a free-delivery label.
  const footerEmail = "__mailtest-footer@example.test";
  await bus.emit("newsletter.subscribed", { email: footerEmail, source: "footer", reactivated: false });
  const coupon = (await waitForLogs(footerEmail))[0];
  check("footer signup → coupon logged with flow_key = newsletter_coupon", coupon?.flow_key === "newsletter_coupon");
  check(
    "free-delivery welcome code → « Livraison offerte », never « 0% »",
    String(coupon?.subject).includes("Livraison offerte") &&
      !/0 ?%/.test(String(coupon?.subject)) &&
      String(coupon?.body).includes("Livraison offerte sur votre 1ʳᵉ commande"),
  );

  // ── 5) birthday run ──────────────────────────────────────────────────────
  const now = new Date();
  const year = storeYear(now);
  const bday = `2000-${String(storeMonth(now)).padStart(2, "0")}-${String(storeDay(now)).padStart(2, "0")}`;
  const bdayPromo = await mkPromo({ code: "__MAILTESTBDAY", discount_type: "fixed", discount_value: 5000 });
  await setSetting("mail.birthday_code", bdayPromo.code as string);
  const bPid = await mkCustomer("__mailtest-bday", { optIn: true, firstName: "__mailtestSami", birthday: bday });
  const sPid = await mkCustomer("__mailtest-bday-supp", { optIn: true, birthday: bday });
  await db.execute(
    sql`insert into email_suppressions (email, reason, source) values ('__mailtest-bday-supp@example.test', 'manual', 'test')`,
  );

  await setSetting("mail.marketing_enabled", "false");
  const off = await runBirthdayEmails();
  check("birthday, kill-switch OFF → run skipped", off.status === "skipped" && /mail\.marketing_enabled/.test(off.summary));
  check("birthday, kill-switch OFF → NO claim burned", !(await claimExists("birthday_coupon", `${bPid}:${year}`)));

  // Disabled template → skipped, no claim either.
  await setSetting("mail.marketing_enabled", "true");
  const prior = rowsOf(
    await db.execute(sql`select is_enabled from email_template_overrides where template_key = 'birthday_coupon'`),
  )[0];
  priorBirthdayOverride = prior ? { is_enabled: prior.is_enabled as boolean } : null;
  await db.execute(
    sql`insert into email_template_overrides (template_key, is_enabled) values ('birthday_coupon', false)
        on conflict (template_key) do update set is_enabled = false`,
  );
  const tplOff = await runBirthdayEmails();
  check("birthday, template disabled → run skipped", tplOff.status === "skipped" && /désactivé/.test(tplOff.summary));
  check("birthday, template disabled → NO claim burned", !(await claimExists("birthday_coupon", `${bPid}:${year}`)));
  await restoreBirthdayOverride();

  const on = await runBirthdayEmails();
  const bLogs = await waitForLogs("__mailtest-bday@example.test");
  check("birthday, enabled → queued for the customer", bLogs.length === 1 && bLogs[0].status === "queued");
  check("birthday → flow_key recorded", bLogs[0]?.flow_key === "birthday_coupon");
  check("birthday → discount label « −5 TND »", String(bLogs[0]?.body).includes("−5 TND"));
  check("birthday → claim kept for the queued customer", await claimExists("birthday_coupon", `${bPid}:${year}`));
  check(
    "birthday → suppressed customer skipped AND its claim released",
    (await logsFor("__mailtest-bday-supp@example.test")).length === 0 &&
      !(await claimExists("birthday_coupon", `${sPid}:${year}`)),
  );
  const m = /: (\d+) email/.exec(on.summary);
  check("birthday summary counts only queued mails (suppressed one excluded)", m != null && Number(m[1]) >= 1);
  await runBirthdayEmails();
  check("birthday re-run → no double-queue", (await logsFor("__mailtest-bday@example.test")).length === 1);

  // ── 6) promotion announcement (detached fan-out) ──────────────────────────
  const aPid = await mkCustomer("__mailtest-announce", { optIn: true });
  const annPromo = await mkPromo({ discount_value: 10, grants_free_shipping: true });
  await promotionService.setTargets(annPromo.id, [{ target_type: "customer", target_id: aPid }]);
  const aEmail = "__mailtest-announce@example.test";

  await bus.emit("promotion.announce_requested", { promotionId: annPromo.id });
  const aLogs = await waitForLogs(aEmail);
  check("announcement → one queued email for the targeted customer", aLogs.length === 1 && aLogs[0].status === "queued");
  check("announcement → flow_key recorded", aLogs[0]?.flow_key === "promotion_announcement");
  check(
    "announcement → « −10 % + livraison offerte » + brand name in the subject",
    String(aLogs[0]?.subject).includes("−10 % + livraison offerte") && !String(aLogs[0]?.subject).includes("{{"),
  );
  await bus.emit("promotion.announce_requested", { promotionId: annPromo.id });
  await sleep(1000);
  check("announcement re-emit → idempotent (still one email)", (await logsFor(aEmail)).length === 1);

  // Scheduled (starts tomorrow) → skipped, logged, nothing claimed.
  const sched = await mkPromo({ starts_at: new Date(Date.now() + 86_400_000) } as Partial<NewPromotionRow>);
  await promotionService.setTargets(sched.id, [{ target_type: "customer", target_id: aPid }]);
  await bus.emit("promotion.announce_requested", { promotionId: sched.id });
  check("scheduled promo → skip reported", await waitForWarning(`annonce promo ${sched.id} ignorée`));
  check("scheduled promo → nothing claimed", !(await claimExists("promo_announce", `${sched.id}:${aEmail}`)));

  // Kill-switch OFF → skip reported, no claim burned; ON again → sent.
  const ks = await mkPromo({});
  await promotionService.setTargets(ks.id, [{ target_type: "customer", target_id: aPid }]);
  await setSetting("mail.marketing_enabled", "false");
  await bus.emit("promotion.announce_requested", { promotionId: ks.id });
  check("kill-switch OFF → announcement skip reported", await waitForWarning(`annonce promo ${ks.id} non envoyée`));
  check("kill-switch OFF → no claim burned", !(await claimExists("promo_announce", `${ks.id}:${aEmail}`)));
  await setSetting("mail.marketing_enabled", "true");
  await bus.emit("promotion.announce_requested", { promotionId: ks.id });
  const ksLogs = await waitForLogs(aEmail, 2);
  check("kill-switch back ON → announcement now queued", ksLogs.length === 2);

  // ── 7) SCHEDULED announce SWEEP (G4) ──────────────────────────────────────
  {
    const sid = await mkCustomer("__mailtest-sweep", { optIn: true });
    const sEmail = "__mailtest-sweep@example.test";
    await setSetting("mail.marketing_enabled", "true");
    invalidateMailConfigCache();

    // Due (announce_at in the past) + live + targeted opt-in customer.
    const due = await mkPromo({ discount_value: 15, announce_at: new Date(Date.now() - 60_000) } as Partial<NewPromotionRow>);
    await promotionService.setTargets(due.id, [{ target_type: "customer", target_id: sid }]);
    // Future announce → not due.
    const future = await mkPromo({ discount_value: 15, announce_at: new Date(Date.now() + 86_400_000) } as Partial<NewPromotionRow>);

    const dueIds = await promotionService.listDueForAnnounce();
    check("sweep: listDueForAnnounce includes the past-due promo", dueIds.includes(due.id));
    check("sweep: listDueForAnnounce excludes the future promo", !dueIds.includes(future.id));

    const res = await runPromotionAnnounceSweep();
    check("sweep: ran (not skipped) with a due promo", res.ok && res.status !== "skipped");
    check("sweep: due promo announced_at stamped", (await promotionService.findById(due.id))?.announced_at != null);
    check("sweep: future promo NOT announced", (await promotionService.findById(future.id))?.announced_at == null);
    const sLogs = await waitForLogs(sEmail);
    check(
      "sweep: one queued email for the targeted customer (flow promotion_announcement)",
      sLogs.length >= 1 && sLogs.some((l) => l.flow_key === "promotion_announcement"),
    );

    // Re-run → nothing due (announced_at set excludes it) → skipped.
    check("sweep: re-scan excludes the already-announced promo", !(await promotionService.listDueForAnnounce()).includes(due.id));
    check("sweep: re-run finds nothing due → skipped", (await runPromotionAnnounceSweep()).status === "skipped");

    // Inactive due promo → claimAnnounce refuses (live re-check).
    const inactive = await mkPromo({ is_active: false, announce_at: new Date(Date.now() - 60_000) } as Partial<NewPromotionRow>);
    check("sweep: claimAnnounce refuses an inactive promo", !(await promotionService.claimAnnounce(inactive.id)));
    check("sweep: inactive promo stays un-announced", (await promotionService.findById(inactive.id))?.announced_at == null);

    // claimAnnounce race: exactly one caller wins.
    const race = await mkPromo({ announce_at: new Date(Date.now() - 60_000) } as Partial<NewPromotionRow>);
    const [w1, w2] = await Promise.all([promotionService.claimAnnounce(race.id), promotionService.claimAnnounce(race.id)]);
    check("sweep: claimAnnounce is race-safe (exactly one wins)", (w1 ? 1 : 0) + (w2 ? 1 : 0) === 1);

    // Kill-switch OFF → sweep skips WITHOUT burning announced_at on a due promo.
    const burn = await mkPromo({ announce_at: new Date(Date.now() - 60_000) } as Partial<NewPromotionRow>);
    await promotionService.setTargets(burn.id, [{ target_type: "customer", target_id: sid }]);
    await setSetting("mail.marketing_enabled", "false");
    invalidateMailConfigCache();
    check("sweep: marketing OFF → skipped", (await runPromotionAnnounceSweep()).status === "skipped");
    check("sweep: marketing OFF → due promo NOT stamped (no burn)", (await promotionService.findById(burn.id))?.announced_at == null);
    await setSetting("mail.marketing_enabled", "true");
    invalidateMailConfigCache();

    // Fix A (review): create-time immediate announce with marketing OFF must NOT stamp
    // announced_at (a false « Annoncée le … ») — it warns instead.
    await setSetting("mail.marketing_enabled", "false");
    invalidateMailConfigCache();
    const createdOff = await workflows.promotion.create(
      {
        name: "__mailtest-createoff", triggerKind: "code", code: "__MAILTESTCREATEOFF",
        scope: "cart", scopeId: null, scopeTargets: [], discountType: "percent", discountValue: 10,
        minCartCents: 0, isActive: true, isStackable: false, excludeDiscountedItems: false,
        grantsFreeShipping: false, displayPriority: 0, announceByEmail: true,
      } as never,
      { actorUserId: "__mailtest-actor" },
    );
    check("create+announce, marketing OFF → ok with a warning", createdOff.ok === true && (createdOff.ok && createdOff.data.warnings.some((w: string) => w.includes("n'a pas été envoyée"))));
    if (createdOff.ok) {
      check("create+announce, marketing OFF → announced_at NOT stamped", (await promotionService.findById(createdOff.data.promotionId))?.announced_at == null);
    }
    await setSetting("mail.marketing_enabled", "true");
    invalidateMailConfigCache();

    // Fix B (review): re-scheduling an ALREADY-announced promo clears announced_at so the
    // sweep fires the new schedule (else the `announced_at IS NULL` gate drops it forever).
    const rearm = await mkPromo({ code: "__MAILTESTREARM" } as Partial<NewPromotionRow>);
    await promotionService.markAnnounced(rearm.id); // simulate an earlier announce
    check("re-arm setup: announced_at stamped", (await promotionService.findById(rearm.id))?.announced_at != null);
    const pastLocal = "2020-01-01T00:00"; // store-local, safely in the past
    const rearmRes = await workflows.promotion.update(
      {
        promotionId: rearm.id, name: "__mailtest-rearm", triggerKind: "code", code: "__MAILTESTREARM",
        scope: "cart", scopeId: null, scopeTargets: [], discountType: "percent", discountValue: 10,
        minCartCents: 0, isActive: true, isStackable: false, excludeDiscountedItems: false,
        grantsFreeShipping: false, displayPriority: 0, announceAt: pastLocal,
      } as never,
      { actorUserId: "__mailtest-actor" },
    );
    check("re-arm: update ok", rearmRes.ok === true);
    check("re-arm: setting a new announce_at cleared announced_at", (await promotionService.findById(rearm.id))?.announced_at == null);
    check("re-arm: the promo is due again", (await promotionService.listDueForAnnounce()).includes(rearm.id));
    // A routine edit that leaves announce_at unchanged must NOT re-arm.
    await promotionService.markAnnounced(rearm.id);
    await workflows.promotion.update(
      {
        promotionId: rearm.id, name: "__mailtest-rearm2", triggerKind: "code", code: "__MAILTESTREARM",
        scope: "cart", scopeId: null, scopeTargets: [], discountType: "percent", discountValue: 10,
        minCartCents: 0, isActive: true, isStackable: false, excludeDiscountedItems: false,
        grantsFreeShipping: false, displayPriority: 0, announceAt: pastLocal,
      } as never,
      { actorUserId: "__mailtest-actor" },
    );
    check("re-arm: a routine edit (same announce_at) does NOT clear announced_at", (await promotionService.findById(rearm.id))?.announced_at != null);
  }

  await restoreSettings();
  invalidateMailConfigCache();
  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

async function restoreBirthdayOverride() {
  if (priorBirthdayOverride === undefined) return;
  if (priorBirthdayOverride === null) {
    await db.execute(sql`delete from email_template_overrides where template_key = 'birthday_coupon'`);
  } else {
    await db.execute(
      sql`update email_template_overrides set is_enabled = ${priorBirthdayOverride.is_enabled} where template_key = 'birthday_coupon'`,
    );
  }
  priorBirthdayOverride = undefined;
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await restoreBirthdayOverride();
      await restoreSettings();
      await cleanup();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));

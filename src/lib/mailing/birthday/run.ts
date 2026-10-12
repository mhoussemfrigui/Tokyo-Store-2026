import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { storeMonth, storeDay } from "@/lib/promotions/segments";
import { dispatchEmail, isFlowEnabled, mailingSendsService } from "@/modules/mailing";
import { promotionService } from "@/modules/promotion";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { marketingGateSummary, marketingSendBlocked } from "@/lib/mailing/automation-gate";
import { describePromoDiscount } from "@/lib/mailing/promo-describe";
import { resolvePublicOrigin } from "@/lib/url/public-origin";

const FLOW = "birthday_coupon";
/** Setting key → the admin-managed birthday promo code. Recommended: a promo
 *  targeted at a `birthday_today` segment so it ONLY redeems on the birthday. */
const CODE_SETTING = "mail.birthday_code";

export type BirthdayRunResult = { ok: boolean; summary: string; status?: "skipped" };

function storeYear(ref: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tunis", year: "numeric" }).format(ref),
  );
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Daily birthday-email run (shared by the cron + a future admin "Run now").
 * Emails every marketing-opted-in customer whose birthday is TODAY (store TZ) a
 * gift code (the live promo behind `mail.birthday_code`). Idempotent per customer
 * per year via `mailing_sends`, so double cron runs / retries never double-send.
 * Enqueues (bulk) — the mailing drain paces delivery.
 *
 * The marketing kill-switch + template on/off are checked BEFORE any claim, and a
 * claim whose dispatch was NOT enqueued (skipped / failed) is released — so a run
 * while marketing is off doesn't burn everyone's birthday for the year, and the
 * summary counts only emails actually queued.
 */
export async function runBirthdayEmails(): Promise<BirthdayRunResult> {
  if (!(await isFlowEnabled(FLOW))) {
    return { ok: true, summary: "flux anniversaire désactivé", status: "skipped" };
  }
  const blocked = await marketingSendBlocked(FLOW);
  if (blocked) {
    return { ok: true, summary: marketingGateSummary(blocked, FLOW), status: "skipped" };
  }

  const settings = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
  const code = settings[CODE_SETTING]?.trim();
  if (!code) {
    return { ok: true, summary: "aucun code anniversaire configuré (mail.birthday_code)", status: "skipped" };
  }
  const promo = await promotionService.findLiveByCode(code);
  if (!promo || !promo.code) {
    return { ok: true, summary: `code anniversaire « ${code} » introuvable / inactif`, status: "skipped" };
  }
  // « −20 % » / « −5 TND » / « Livraison offerte » (never « 0% »).
  const discount = describePromoDiscount(promo);

  const now = new Date();
  const mmdd = `${String(storeMonth(now)).padStart(2, "0")}-${String(storeDay(now)).padStart(2, "0")}`;
  const year = storeYear(now);

  // Feb-29 birthdays don't exist as a calendar day in common years — fold them
  // onto Feb-28 so a leap-day customer still gets exactly one email per year
  // (the dedup key is per-year, so no double-send in leap years either).
  const targets = mmdd === "02-28" && !isLeapYear(year) ? ["02-28", "02-29"] : [mmdd];
  const pairs = targets.map((t) => {
    const [mm, dd] = t.split("-");
    return { m: Number(mm), d: Number(dd) };
  });

  // Match on extract(month/day) rather than to_char(...,'MM-DD'): extract on a
  // `date` is IMMUTABLE, so it's served by the partial index
  // `customer_profiles_birthday_md_idx` (migration 0047) — an index lookup for
  // today's date instead of a daily full seq-scan.
  const dayMatch = sql.join(
    pairs.map(
      (p) => sql`(extract(month from cp.birthday) = ${p.m} and extract(day from cp.birthday) = ${p.d})`,
    ),
    sql` or `,
  );

  const rows = await db.execute<{ id: string; first_name: string; email: string }>(sql`
    select cp.id, cp.first_name, u.email
    from customer_profiles cp
    join customer_user_links l on l.customer_profile_id = cp.id
    join users u on u.id = l.user_id
    where cp.marketing_opt_in = true
      and cp.deleted_at is null
      and cp.birthday is not null
      and (${dayMatch})
    limit 5000
  `);

  const origin = await resolvePublicOrigin();
  let sent = 0;
  for (const r of rows.rows) {
    // One birthday email per customer per year — claim FIRST so a cron re-run
    // or crash-retry can't double-send.
    const dedupKey = `${r.id}:${year}`;
    const first = await mailingSendsService.claimOnce(FLOW, dedupKey).catch(() => false);
    if (!first) continue;
    const res = await dispatchEmail({
      key: "birthday_coupon",
      to: r.email,
      flowKey: FLOW,
      bulk: true,
      variables: {
        first_name: r.first_name,
        code: promo.code.toUpperCase(),
        discount,
        shop_url: origin,
      },
    }).catch(() => null);
    if (res?.queued) sent++;
    // Not enqueued (e.g. opted out since the scan) → give the claim back.
    else await mailingSendsService.release(FLOW, dedupKey).catch(() => {});
  }

  return { ok: true, summary: `anniversaires ${mmdd}: ${sent} email(s) mis en file` };
}

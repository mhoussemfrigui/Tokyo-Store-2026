import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { dispatchEmail, isFlowEnabled, mailingSendsService } from "@/modules/mailing";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { marketingGateSummary, marketingSendBlocked } from "@/lib/mailing/automation-gate";
import { resolvePublicOrigin } from "@/lib/url/public-origin";

const FLOW = "review_request";
const DELAY_SETTING = "mail.review_delay_days";
const DEFAULT_DELAY = 4;

export type ReviewRequestRunResult = { ok: boolean; summary: string; status?: "skipped" };

/**
 * Daily post-delivery review-request run. Emails marketing-opted-in customers
 * whose order was DELIVERED ~N days ago (mail.review_delay_days, default 4),
 * once per order (mailing_sends idempotency). Enqueued (bulk) — the drain paces it.
 * Like the birthday run: global marketing gates are checked before any claim, a
 * claim whose dispatch wasn't enqueued is released, and only queued mails count.
 *
 * RECIPIENT = the CONSENTING account. Consent is the linked account's profile
 * opt-in, so the mail goes only where that consent applies: an order whose
 * `contact_email` differs from the account's `users.email` (a third party typed
 * at checkout, or the pre-change address after an email change) is SKIPPED —
 * never claimed, never counted — instead of mailing someone who never opted in.
 * Guest orders (no account) get no review request, as before.
 */
export async function runReviewRequests(): Promise<ReviewRequestRunResult> {
  if (!(await isFlowEnabled(FLOW))) {
    return { ok: true, summary: "flux demande d'avis désactivé", status: "skipped" };
  }
  const blocked = await marketingSendBlocked(FLOW);
  if (blocked) {
    return { ok: true, summary: marketingGateSummary(blocked, FLOW), status: "skipped" };
  }

  const settings = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
  const n = Math.max(1, Number(settings[DELAY_SETTING]) || DEFAULT_DELAY);

  // Orders delivered in the [N+1, N) day window, with an opted-in linked customer.
  // `contact_matches`: the order's contact address IS the account's address.
  const rows = await db.execute<{
    id: string;
    order_number: string;
    email: string;
    first_name: string;
    contact_matches: boolean;
  }>(sql`
    select o.id, o.order_number, u.email as email, cp.first_name,
      (lower(o.contact_email) = lower(u.email)) as contact_matches
    from orders o
    join users u on u.id = o.user_id
    join customer_user_links l on l.user_id = o.user_id
    join customer_profiles cp on cp.id = l.customer_profile_id
      and cp.marketing_opt_in = true and cp.deleted_at is null
    -- Actual DELIVERY time (the latest transition to 'delivered'), NOT
    -- orders.updated_at — which any later edit (a note, a payment ref) bumps, so
    -- a delivered order could belatedly get, or entirely miss, its J+N request.
    -- Every real delivered order carries a status-history row (transitions write
    -- one), so COALESCE falls back to updated_at only for a history-less order.
    join lateral (
      select max(h.created_at) as delivered_at
      from order_status_history h
      where h.order_id = o.id and h.to_status = 'delivered'
    ) d on true
    where o.status = 'delivered'
      and o.contact_email is not null
      and coalesce(d.delivered_at, o.updated_at) >= now() - make_interval(days => ${n + 1})
      and coalesce(d.delivered_at, o.updated_at) <  now() - make_interval(days => ${n})
    limit 2000
  `);

  const origin = await resolvePublicOrigin();
  let sent = 0;
  let mismatched = 0;
  for (const o of rows.rows) {
    // Contact ≠ account address → the consent holder isn't the recipient: skip
    // BEFORE the claim (nothing burned, nothing counted).
    if (!o.contact_matches) {
      mismatched++;
      continue;
    }
    const first = await mailingSendsService.claimOnce(FLOW, o.id).catch(() => false);
    if (!first) continue;
    const res = await dispatchEmail({
      key: "review_request",
      to: o.email,
      flowKey: FLOW,
      bulk: true,
      variables: {
        first_name: o.first_name ?? "",
        order_number: o.order_number,
        order_url: `${origin}/order/${o.id}`,
      },
    }).catch(() => null);
    if (res?.queued) sent++;
    // Not enqueued (e.g. opted out since the scan) → give the claim back.
    else await mailingSendsService.release(FLOW, o.id).catch(() => {});
  }

  const skippedNote =
    mismatched > 0 ? `, ${mismatched} ignorée(s) (email de commande ≠ email du compte)` : "";
  return { ok: true, summary: `demandes d'avis (J+${n}): ${sent} email(s) mis en file${skippedNote}` };
}

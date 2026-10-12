import { NextResponse } from "next/server";

import { guardCron } from "@/lib/cron/guard";
import { runScheduledJob } from "@/lib/jobs/run-job";

/**
 * Daily « campagne liste d'envies » run (job_key "wishlist_campaign_email").
 *
 *   POST /api/cron/wishlist-campaign   Authorization: Bearer <CRON_SECRET>
 *
 * Emails every marketing-opted-in member of the configured audience segment who has
 * a non-empty wishlist a promo code personalized with THEIR favorite products — the
 * owner's cross-data auto-campaign (e.g. a promo on a customer's wishlist items as
 * their anniversary approaches, when the segment carries an anniversary rule).
 * Idempotent per customer per calendar month. Runs through the SHARED
 * `runScheduledJob` center (kill-switch + throw-safe logging + dashboard run-now
 * parity); the unified /api/cron/dispatch heartbeat also fires it when due.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = await guardCron(request);
  if (denied) return denied;

  const res = await runScheduledJob("wishlist_campaign_email", "cron");
  return NextResponse.json(
    { ok: res.ok, status: res.status, summary: res.summary },
    { status: res.httpStatus },
  );
}

import { NextResponse } from "next/server";

import { guardCron } from "@/lib/cron/guard";
import { runScheduledJob } from "@/lib/jobs/run-job";

/**
 * Scheduled promotion-announcement sweep (job_key "promotion_announce_sweep").
 *
 *   POST /api/cron/promotion-announce   Authorization: Bearer <CRON_SECRET>
 *
 * Fires the email announcement of every promotion whose « Annoncer par email le »
 * time has been reached but that hasn't been announced yet and is still live — once
 * each (race-safe `announced_at` claim + per-recipient `mailing_sends` dedup). Runs
 * through the SHARED `runScheduledJob` center (kill-switch + throw-safe logging +
 * dashboard run-now parity); the unified /api/cron/dispatch heartbeat also fires it
 * when due, so this route is manual-curl / run-now parity.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = await guardCron(request);
  if (denied) return denied;

  const res = await runScheduledJob("promotion_announce_sweep", "cron");
  return NextResponse.json(
    { ok: res.ok, status: res.status, summary: res.summary },
    { status: res.httpStatus },
  );
}

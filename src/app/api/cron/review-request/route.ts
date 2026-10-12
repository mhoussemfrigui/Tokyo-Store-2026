import { NextResponse } from "next/server";

import { guardCron } from "@/lib/cron/guard";
import { runScheduledJob } from "@/lib/jobs/run-job";

/**
 * Daily post-delivery review-request run (job_key "review_request").
 *
 *   POST /api/cron/review-request   Authorization: Bearer <CRON_SECRET>
 *
 * Invites customers to review a product some days after delivery. Runs through
 * the SHARED `runScheduledJob` center (kill-switch + throw-safe logging +
 * dashboard run-now parity). Wire to a daily Coolify job — see docs/deployment-coolify.md.
 */
// Default Node runtime (an explicit `runtime` export is incompatible with
// experimental.useCache, and nodejs is already the default).
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = await guardCron(request);
  if (denied) return denied;

  const res = await runScheduledJob("review_request", "cron");
  return NextResponse.json(
    { ok: res.ok, status: res.status, summary: res.summary },
    { status: res.httpStatus },
  );
}

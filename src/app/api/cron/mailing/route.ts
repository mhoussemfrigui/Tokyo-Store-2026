import { NextResponse } from "next/server";

import { guardCron } from "@/lib/cron/guard";
import { runScheduledJob } from "@/lib/jobs/run-job";

/**
 * Scheduled email-queue drain (job_key "mailing_queue").
 *
 *   POST /api/cron/mailing      Authorization: Bearer <CRON_SECRET>
 *
 * Sends a batch of queued emails (campaigns + large automation fan-outs) with
 * throttle + retry. Auth: guardCron (per-IP rate-limit + constant-time secret).
 * The work + per-job kill-switch + run logging all live in the SHARED
 * `runScheduledJob` center — so a THROW is recorded as "failed" (not lost), the
 * job can be paused from the dashboard, and the dashboard "run now" takes the
 * exact same path. Wire to a Coolify job every ~2 min — see docs/deployment-coolify.md.
 */
// Default Node runtime (an explicit `runtime` export is incompatible with
// experimental.useCache, and nodejs is already the default).
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = await guardCron(request);
  if (denied) return denied;

  const res = await runScheduledJob("mailing_queue", "cron");
  return NextResponse.json(
    { ok: res.ok, status: res.status, ...res.payload },
    { status: res.httpStatus },
  );
}

import { NextResponse } from "next/server";

import { guardCron } from "@/lib/cron/guard";
import { runScheduledJob } from "@/lib/jobs/run-job";

/**
 * Scheduled outbound-webhook drain (job_key "webhook_dispatch").
 *
 *   POST /api/cron/webhooks      Authorization: Bearer <CRON_SECRET>
 *
 * POSTs a batch of queued webhook deliveries (signed HMAC) to the subscribed ERP
 * endpoints, with retry + back-off. Auth: guardCron (per-IP rate-limit +
 * constant-time secret). Work + kill-switch + run-logging live in the shared
 * `runScheduledJob` center (a THROW is logged "failed", the job is pausable, and
 * "run now" takes the same path). Wire to a Coolify job every ~2 min.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = await guardCron(request);
  if (denied) return denied;

  const res = await runScheduledJob("webhook_dispatch", "cron");
  return NextResponse.json(
    { ok: res.ok, status: res.status, ...res.payload },
    { status: res.httpStatus },
  );
}

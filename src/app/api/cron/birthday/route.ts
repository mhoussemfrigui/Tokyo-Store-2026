import { NextResponse } from "next/server";

import { guardCron } from "@/lib/cron/guard";
import { runScheduledJob } from "@/lib/jobs/run-job";

/**
 * Daily birthday-email run (job_key "birthday_email").
 *
 *   POST /api/cron/birthday     Authorization: Bearer <CRON_SECRET>
 *
 * Emails today's birthday customers their gift code (idempotent per year). Runs
 * through the SHARED `runScheduledJob` center (kill-switch + throw-safe logging +
 * dashboard run-now parity). Wire to a Coolify job ~00:10 Africa/Tunis — see
 * docs/deployment-coolify.md.
 */
// Default Node runtime (an explicit `runtime` export is incompatible with
// experimental.useCache, and nodejs is already the default).
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = await guardCron(request);
  if (denied) return denied;

  const res = await runScheduledJob("birthday_email", "cron");
  return NextResponse.json(
    { ok: res.ok, status: res.status, summary: res.summary },
    { status: res.httpStatus },
  );
}

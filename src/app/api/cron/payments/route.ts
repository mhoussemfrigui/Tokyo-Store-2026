import { NextResponse } from "next/server";

import { guardCron } from "@/lib/cron/guard";
import { runScheduledJob } from "@/lib/jobs/run-job";

/**
 * Scheduled payment reconciliation — the async-settlement rescue (job_key
 * "payment_reconcile").
 *
 *   POST /api/cron/payments     Authorization: Bearer <CRON_SECRET>
 *
 * Re-verifies ONLINE-payment orders stuck `pending` against the gateway API and
 * settles the genuinely-paid ones (covers a closed return tab / missed webhook /
 * a crash between the webhook claim and the status transition). Idempotent. Runs
 * through the SHARED `runScheduledJob` center (kill-switch + throw-safe logging +
 * dashboard run-now parity). Wire to a Coolify job every ~12 min — see
 * docs/deployment-coolify.md §12.
 */
// Default Node runtime (an explicit `runtime` export is incompatible with
// experimental.useCache, and nodejs is already the default).
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = await guardCron(request);
  if (denied) return denied;

  const res = await runScheduledJob("payment_reconcile", "cron");
  return NextResponse.json(
    { ok: res.ok, status: res.status, ...res.payload },
    { status: res.httpStatus },
  );
}

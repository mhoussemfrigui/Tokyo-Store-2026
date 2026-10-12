import { NextResponse } from "next/server";

import { guardCron } from "@/lib/cron/guard";
import { runScheduledJob } from "@/lib/jobs/run-job";

/**
 * Abandoned-order sweep — the reserved-stock backstop (job_key "abandoned_orders").
 *
 *   POST /api/cron/abandoned-orders   Authorization: Bearer <CRON_SECRET>
 *
 * Cancels orders stuck `pending` past the abandon window (default 48h,
 * `ABANDONED_ORDER_HOURS`), releasing the stock reserved at placement. Covers the
 * cases the payment-reconcile cron does NOT (COD, online orders with no gateway
 * reference, anything aged out of the reconcile window). Idempotent. Runs through
 * the SHARED `runScheduledJob` center (kill-switch + throw-safe logging +
 * dashboard run-now parity). Wire to a Coolify job ~hourly — see
 * docs/deployment-coolify.md §12.
 */
// Default Node runtime (an explicit `runtime` export is incompatible with
// experimental.useCache, and nodejs is already the default).
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = await guardCron(request);
  if (denied) return denied;

  const res = await runScheduledJob("abandoned_orders", "cron");
  return NextResponse.json(
    { ok: res.ok, status: res.status, ...res.payload },
    { status: res.httpStatus },
  );
}

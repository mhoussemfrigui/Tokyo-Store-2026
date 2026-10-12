import { NextResponse } from "next/server";

import { guardCron } from "@/lib/cron/guard";
import { runScheduledJob } from "@/lib/jobs/run-job";

/**
 * Scheduled data-retention purge (job_key "retention_purge").
 *
 *   POST /api/cron/retention    Authorization: Bearer <CRON_SECRET>
 *
 * Hard-deletes PII-bearing / unbounded tables past their retention window
 * (search_log, webhook_events, audit_log, ephemeral carts, job_run_log,
 * email_logs, mailing_sends, cart_events, expired sessions/verifications). Runs
 * through the SHARED `runScheduledJob` center (kill-switch + throw-safe logging +
 * dashboard run-now parity). Wire to a daily Coolify job — see docs/deployment-coolify.md §12.
 *
 * Auth: guardCron — per-IP rate-limit + constant-time CRON_SECRET bearer (429
 * throttled, 503 if the secret is unset, 401 on mismatch).
 */

// DB-touching + secret-gated: never cache. Runs on the default Node runtime
// (node:crypto + node-postgres need it) — the default is already nodejs, and an
// explicit `runtime` export is incompatible with experimental.useCache.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = await guardCron(request);
  if (denied) return denied;

  const res = await runScheduledJob("retention_purge", "cron");
  return NextResponse.json(
    { ok: res.ok, status: res.status, ...res.payload },
    { status: res.httpStatus },
  );
}

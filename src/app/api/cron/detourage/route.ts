import { NextResponse } from "next/server";

import { guardCron } from "@/lib/cron/guard";
import { runScheduledJob } from "@/lib/jobs/run-job";

/**
 * Scheduled product détourage back-fill (job_key "product_detourage").
 *
 *   POST /api/cron/detourage    Authorization: Bearer <CRON_SECRET>
 *
 * Removes the uniform studio backdrop (→ transparent) from EXISTING product
 * images not yet détouré — a rattrapage of imports / older uploads. Runs the SAME
 * reprocess as the manual button (Médiathèque → Réglages) through the SHARED
 * `runScheduledJob` center (per-job kill-switch `jobs.product_detourage.enabled`,
 * throw-safe run logging, dashboard "run now" parity). No-op `skipped` when the
 * `product_white_bg` feature is off or another media job is active. Idempotent
 * (images already on a `-nobg` key are skipped), so a daily cadence only touches
 * newly-added product images. Wire to a daily Coolify job — see
 * docs/deployment-coolify.md §12.
 *
 * Auth: guardCron — per-IP rate-limit + constant-time CRON_SECRET bearer (429
 * throttled, 503 if the secret is unset, 401 on mismatch).
 */

// DB + S3 touching + secret-gated: never cache. Default Node runtime (sharp +
// node-postgres need it); an explicit `runtime` export is incompatible with
// experimental.useCache.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = await guardCron(request);
  if (denied) return denied;

  const res = await runScheduledJob("product_detourage", "cron");
  return NextResponse.json(
    { ok: res.ok, status: res.status, ...res.payload },
    { status: res.httpStatus },
  );
}

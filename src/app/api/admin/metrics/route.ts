import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/session";
import { snapshot } from "@/lib/telemetry/metrics-store";
import { getRuntimeSnapshot } from "@/lib/telemetry/runtime-metrics";

/**
 * Admin live-metrics snapshot — powers the Performance tab's auto-refreshing
 * overview (client poll) without re-rendering the whole force-dynamic page.
 *
 *   GET /api/admin/metrics
 *
 * Returns:
 *   {
 *     events:  { counts, totalEvents, uniqueEvents, startedAt, uptimeMs },  // bus event counters
 *     runtime: { ramPct, cpuPct, eventLoopLagMs, db:{latencyMs,ok}, memory, pool, … }
 *   }
 *
 * Both halves are PROCESS-LOCAL — they reflect THIS Node instance only and reset
 * on every restart / replica boot. Gated on `system_performance:view` (matches
 * the Performance PAGE) and 404s for anyone without it, so the endpoint's
 * existence isn't leaked. Never cached (live process + DB probe). Runs on the
 * default Node runtime — declaring it explicitly is incompatible with
 * experimental.useCache and the default is already nodejs.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  await requirePermission("system_performance", "view");
  const runtime = await getRuntimeSnapshot();
  return NextResponse.json(
    { events: snapshot(), runtime },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

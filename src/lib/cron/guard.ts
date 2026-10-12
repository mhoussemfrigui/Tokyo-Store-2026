import "server-only";

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";

/**
 * Shared gate for every `/api/cron/*` endpoint.
 *
 * Returns a `NextResponse` to send back (and STOP) when the request must be
 * refused; returns `null` when it passed all checks and the handler may run.
 *
 * Check order is deliberate:
 *   1. Per-IP rate limit FIRST — before any secret comparison or config read.
 *      Without it an attacker could hammer these endpoints to brute-force the
 *      bearer token or to repeatedly trigger their (expensive) work. 10/60s is
 *      far above the once-per-few-minutes a real scheduler needs.
 *   2. 503 when `CRON_SECRET` is unset — an operator who hasn't configured it
 *      should see "not enabled", and the job must never run unguarded.
 *   3. Constant-time bearer compare — `===` would leak the secret byte-by-byte
 *      via response timing; `timingSafeEqual` (length-guarded) does not.
 *
 * Centralising this also kills the four near-identical `authorized()` copies the
 * cron routes used to carry.
 */
/**
 * Optional CRON_ALLOWED_IPS allowlist (comma-separated). When set, a request
 * whose client IP is not listed is refused BEFORE the secret compare — a
 * defence-in-depth layer so a leaked CRON_SECRET alone can't trigger the
 * (expensive / destructive) jobs from an arbitrary host. Default (unset) =
 * allow all, so existing deployments are unaffected. Parsed once at module load.
 */
const CRON_ALLOWED_IPS: ReadonlySet<string> = new Set(
  (process.env.CRON_ALLOWED_IPS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

export async function guardCron(request: Request): Promise<NextResponse | null> {
  const ip = getClientIp(request.headers) || "anon";
  const rl = await checkRateLimit({ bucket: `cron:ip:${ip}`, max: 10, windowSeconds: 60 });
  if (!rl.ok) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  // Optional IP allowlist (defence-in-depth; no-op when CRON_ALLOWED_IPS unset).
  if (CRON_ALLOWED_IPS.size > 0 && !CRON_ALLOWED_IPS.has(ip)) {
    return NextResponse.json({ ok: false, error: "ip_not_allowed" }, { status: 403 });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "cron_not_configured" }, { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  return null;
}

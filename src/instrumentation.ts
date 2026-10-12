/**
 * Next.js `instrumentation.ts` — runs once per server boot, before any
 * route is handled. Used here for one-shot bootstrap tasks that need the
 * full server runtime loaded (Better Auth, DB pool, etc).
 *
 * Skips the Edge runtime explicitly (can't reach the DB pool). The
 * standalone server doesn't reliably set NEXT_RUNTIME=nodejs, so we
 * check for the inverse (Edge) instead of asserting equality with
 * "nodejs" — that early-return killed the hook in 16.x standalone.
 *
 * See: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;

  // Lazy import so the Edge runtime never tries to evaluate server-only
  // code at compile time (the import itself triggers `server-only` checks).
  const { ensureDefaultAdmin } = await import("./lib/bootstrap/default-admin");

  try {
    await ensureDefaultAdmin();
  } catch (err) {
    // Don't crash the server if the bootstrap fails. The operator can still
    // promote a manually-registered user via /api/admin/bootstrap.
    console.error("[instrumentation] ensureDefaultAdmin failed", err);
  }

  // Auto-deploy the storefront's system content pages (Maison + policy pages +
  // CGV) and the Tokyo contact defaults. Idempotent insert-if-missing/pristine
  // (never clobbers admin edits) — safe to run on every boot. See the module.
  try {
    const { ensureSystemContentPages } = await import("./lib/bootstrap/system-content-pages");
    await ensureSystemContentPages();
  } catch (err) {
    console.error("[instrumentation] ensureSystemContentPages failed", err);
  }

  // Seed the system nav menus that ship with built-in links (the « Explorer la
  // maison » index at the foot of the Maison & legal pages). Insert-if-missing
  // only — never refills a menu an admin edited or emptied. See the module.
  try {
    const { ensureSystemNavMenus } = await import("./lib/bootstrap/system-nav-menus");
    await ensureSystemNavMenus();
  } catch (err) {
    console.error("[instrumentation] ensureSystemNavMenus failed", err);
  }

  // Materialize the 5 hardcoded mega-menu roots into the editable `main` menu
  // (one-time, idempotent via the nav.header.materialized flag). After this the
  // storefront header reads the composable nav from the DB. Never clobbers edits.
  try {
    const { ensureHeaderNavRoots } = await import("./lib/bootstrap/header-nav-roots");
    await ensureHeaderNavRoots();
  } catch (err) {
    console.error("[instrumentation] ensureHeaderNavRoots failed", err);
  }

  // Eager-register event subscribers (telemetry + cache invalidators).
  // The auth module also imports `@/events/subscribers` as a side effect,
  // but its load order depends on which route handler the runtime hits
  // first. Loading here guarantees the bus has listeners attached before
  // the first request fans out events.
  try {
    const { registerAllSubscribers } = await import("./events/subscribers");
    registerAllSubscribers();
  } catch (err) {
    console.error("[instrumentation] subscriber registration failed", err);
  }

  // Runtime-metrics sampler — a self-contained timer (no external cron) that
  // samples RAM/CPU/event-loop/DB-latency, evaluates admin-tunable warn
  // thresholds into alerts, and writes a periodic heartbeat (uptime/downtime).
  // Node runtime only; idempotent + stopped on drain below.
  try {
    const { startRuntimeSampler } = await import("./lib/telemetry/runtime-metrics");
    startRuntimeSampler();
  } catch (err) {
    console.error("[instrumentation] runtime sampler start failed", err);
  }

  // Graceful shutdown — drain the pg pool so Postgres connections close
  // cleanly when Coolify (or any orchestrator) sends SIGTERM on redeploy.
  // Without this, the standalone server stops accepting requests but the
  // pool's connections (up to DB_POOL_MAX) linger until the idle timeout
  // reaps them — slows redeploy handover and pressures max_connections
  // when scaling past 1 app instance.
  // Guard against a second signal (e.g. SIGINT during a slow SIGTERM drain)
  // racing a second drain against an already-closing pool.
  let draining = false;
  const drain = async (signal: string) => {
    if (draining) return;
    draining = true;
    console.log(`[shutdown] received ${signal}, closing pool…`);
    try {
      // Stop the runtime sampler + mark this instance cleanly stopped so the
      // uptime/downtime view doesn't count a graceful redeploy as an outage.
      const { stopRuntimeSampler } = await import("./lib/telemetry/runtime-metrics");
      await stopRuntimeSampler();
    } catch {
      // best-effort — never block shutdown on the sampler.
    }
    try {
      const { closePool } = await import("./lib/db/client");
      await closePool();
    } catch (err) {
      console.error("[shutdown] pool close failed", err);
    }
    process.exit(0);
  };
  process.once("SIGTERM", () => drain("SIGTERM"));
  process.once("SIGINT", () => drain("SIGINT"));
}

/**
 * Next.js `onRequestError` — fires server-side for EVERY uncaught error (RSC
 * render, route handlers, server actions, middleware). The `error.digest` it
 * receives is the SAME value Next passes to the client error boundary and prints
 * to the server console, so recording it here gives the error UI, the container
 * logs, and the admin audit journal one IDENTICAL reference.
 *
 * We record an append-only `audit_log` row (severity "error") with the formatted
 * reference in `target_id` (exact-searchable in « Journal d'audit ») and the
 * diagnostic context in `metadata`. The error page then deep-links the operator
 * straight to that row by the same reference.
 *
 * PRIVACY: the request path is query-stripped and request HEADERS are never
 * persisted (they carry cookies / auth). The stack lives in `metadata` — admin
 * (system_audit) only — and is NEVER sent to the browser.
 *
 * Node runtime only (Edge can't reach the DB pool) and NEVER throws — an error
 * in the error handler must not cascade.
 */
export async function onRequestError(
  error: unknown,
  request: { path?: string; method?: string },
  context?: {
    routerKind?: string;
    routePath?: string;
    routeType?: string;
    renderSource?: string;
  },
): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") return;
  try {
    const { formatErrorRef, ERROR_TARGET_TYPE } = await import("./lib/errors/error-ref");
    const err = (error ?? {}) as Error & { digest?: string };
    const digest = typeof err.digest === "string" ? err.digest : null;
    const message = typeof err.message === "string" ? err.message : String(error);
    // Next assigns `digest` only to RSC/HTML RENDER errors; route handlers +
    // server actions reach this hook WITHOUT one. Derive a STABLE seed from the
    // error signature so each distinct incident still gets its own grouping
    // reference instead of collapsing to a single literal. Render errors keep the
    // digest, so their reference still matches the one the UI card shows.
    const topFrame = (typeof err.stack === "string" ? err.stack.split("\n")[1] ?? "" : "").trim();
    const ref = formatErrorRef(digest ?? `${message}::${topFrame}`) ?? "ERR-UNKNOWN";
    const path = (request?.path ?? "").split("?")[0] || null;
    const summary = `[${ref}] ${message}`.slice(0, 200);

    // Structured, greppable container-log line carrying BOTH the human reference
    // and the raw Next digest (so it also correlates with Next's default log).
    console.error(
      `[app.error] ref=${ref} digest=${digest ?? "-"} ${context?.routeType ?? "render"} ${request?.method ?? ""} ${path ?? "?"} :: ${message}`,
    );

    const { auditService } = await import("./modules/audit/service");
    await auditService.record({
      event_name: "app.error",
      // Pass severity EXPLICITLY — "app.error" is not in the severity map, so the
      // derivation would otherwise mislabel it "info".
      severity: "error",
      target_type: ERROR_TARGET_TYPE,
      target_id: ref,
      summary,
      metadata: {
        ref,
        digest,
        message: message.slice(0, 1000),
        // Server-only diagnostic — admin-visible, never returned to the client.
        stack: typeof err.stack === "string" ? err.stack.slice(0, 6000) : null,
        url: path,
        method: request?.method ?? null,
        routePath: context?.routePath ?? null,
        routeType: context?.routeType ?? null,
        renderSource: context?.renderSource ?? null,
        env: process.env.NODE_ENV ?? null,
        buildSha: process.env.NEXT_PUBLIC_BUILD_SHA?.trim() || null,
      },
    });
  } catch {
    // The error handler must never throw.
  }
}

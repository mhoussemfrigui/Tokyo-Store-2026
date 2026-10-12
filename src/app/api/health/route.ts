import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

// Cheap to import: validation is deferred until a field is read.
import { serverEnv } from "@/lib/env";

/**
 * GET /api/health
 * Liveness probe — point Coolify / monitoring here. Static 200: it never touches
 * env or the DB, so the Docker/compose HEALTHCHECK keeps meaning "the Node
 * process is up".
 *
 * GET /api/health?ready=1
 * Opt-in READINESS probe for monitoring: also validates the server env (e.g. a
 * missing BETTER_AUTH_SECRET that would 500 every page) and runs `SELECT 1` with
 * a short timeout. 503 + `status: "not-ready"` when either fails; only booleans
 * are returned (no error details — the route is public). The result is cached
 * for a few seconds and concurrent probes share one in-flight check, so a flood
 * of `?ready=1` requests can't drain the DB pool.
 */

const READY_TIMEOUT_MS = 2_000;
const READY_CACHE_MS = 5_000;

type Readiness = { env: boolean; db: boolean };

let readyCache: { at: number; result: Readiness } | null = null;
let readyInflight: Promise<Readiness> | null = null;

async function checkReadiness(): Promise<Readiness> {
  let env = false;
  try {
    // Any field access runs the full lazy schema validation (+ prod secret guard).
    env = Boolean(serverEnv.DATABASE_URL);
  } catch {
    env = false;
  }

  let db = false;
  if (env) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The DB client builds its pool at import time — imported lazily so a
      // broken env/DB module can never fail the plain liveness path.
      const { db: client } = await import("@/lib/db/client");
      await Promise.race([
        client.execute(sql`SELECT 1`),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("readiness timeout")), READY_TIMEOUT_MS);
        }),
      ]);
      db = true;
    } catch {
      db = false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { env, db };
}

async function readiness(): Promise<Readiness> {
  if (readyCache && Date.now() - readyCache.at < READY_CACHE_MS) return readyCache.result;
  readyInflight ??= checkReadiness()
    .then((result) => {
      readyCache = { at: Date.now(), result };
      return result;
    })
    .finally(() => {
      readyInflight = null;
    });
  return readyInflight;
}

export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store, max-age=0" };
  const base = {
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };

  const wantsReady = new URL(request.url).searchParams.has("ready");
  if (!wantsReady) {
    return NextResponse.json({ status: "ok", ...base }, { status: 200, headers });
  }

  const checks = await readiness();
  const ready = checks.env && checks.db;
  return NextResponse.json(
    { status: ready ? "ok" : "not-ready", ...base, checks },
    { status: ready ? 200 : 503, headers },
  );
}

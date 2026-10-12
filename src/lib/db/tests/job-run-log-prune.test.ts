import "server-only";

/**
 * Scheduled-job history bounds (jobRunLogService) — the « Tâches planifiées »
 * dashboard must keep showing real runs and failures even when a ~2-min drain
 * records a « file vide » skipped row on every cron hit:
 *
 *  • prune keeps the latest 100 REAL (ok/failed) runs + the latest 20 SKIPPED
 *    heartbeat rows per job_key, and ALWAYS the latest failure (even when 100
 *    newer ok runs push it out of the real-run window).
 *  • lastRunByJob / lastFailureByJob return DECODED rows (Date timestamps — a
 *    raw db.execute returned strings and broke toJobRunView's toISOString()).
 *  • listForJob({ hideSkipped }) drops the no-op rows.
 *
 * Self-cleaning (`__p6jobtest…` job keys). Run ONLY against a throwaway DB:
 *   DATABASE_URL=postgresql://…:5440/tokyo BETTER_AUTH_SECRET=… EMAIL_PROVIDER=console \
 *     pnpm exec tsx --conditions=react-server src/lib/db/tests/job-run-log-prune.test.ts
 */
import { and, eq, like, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { jobRunLogService } from "@/modules/jobs";
import { job_run_log, type JobRunStatus } from "@/modules/jobs/schema";
import { toJobRunView } from "@/lib/jobs/views";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const KEY = `__p6jobtest_${Date.now()}`;
const OTHER = `${KEY}_other`;

async function cleanup() {
  await db.delete(job_run_log).where(like(job_run_log.job_key, "__p6jobtest%"));
}

async function countBy(jobKey: string, status: JobRunStatus): Promise<number> {
  const res = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from job_run_log where job_key = ${jobKey} and status = ${status}`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

function row(jobKey: string, status: JobRunStatus, minutesAgo: number, summary: string) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  return {
    job_key: jobKey,
    status,
    trigger: "cron" as const,
    started_at: at,
    finished_at: at,
    duration_ms: 0,
    summary,
    error: status === "failed" ? `erreur ${summary}` : null,
    created_at: at,
  };
}

async function main() {
  await cleanup();

  // Oldest → newest: 2 failures, then 105 ok runs, then 30 no-op skips.
  const rows = [
    row(KEY, "failed", 600, "F1"),
    row(KEY, "failed", 500, "F2"),
    ...Array.from({ length: 105 }, (_, i) => row(KEY, "ok", 400 - i, `ok-${i}`)),
    ...Array.from({ length: 30 }, (_, i) => row(KEY, "skipped", 100 - i, `skip-${i}`)),
  ];
  await db.insert(job_run_log).values(rows);
  // A second key must be untouched by KEY's prune.
  await db.insert(job_run_log).values(
    Array.from({ length: 25 }, (_, i) => row(OTHER, "skipped", 50 - i, `o-${i}`)),
  );

  console.log("prune — per-class budgets + latest failure:");
  await jobRunLogService.prune(KEY);
  check("keeps exactly 100 ok runs (the newest)", (await countBy(KEY, "ok")) === 100);
  check("keeps exactly 20 skipped heartbeat rows", (await countBy(KEY, "skipped")) === 20);
  check("keeps ONLY the latest failure (outside the 100-run window)", (await countBy(KEY, "failed")) === 1);
  const kept = await db
    .select({ summary: job_run_log.summary })
    .from(job_run_log)
    .where(and(eq(job_run_log.job_key, KEY), eq(job_run_log.status, "failed")));
  check("the kept failure is the newest one (F2)", kept.length === 1 && kept[0].summary === "F2");
  const oldestOk = await db
    .select({ summary: job_run_log.summary })
    .from(job_run_log)
    .where(and(eq(job_run_log.job_key, KEY), eq(job_run_log.summary, "ok-4")));
  check("the 5 oldest ok runs were pruned", oldestOk.length === 0);
  check("another job_key is untouched", (await countBy(OTHER, "skipped")) === 25);

  console.log("record() prunes on its own budget:");
  await jobRunLogService.record({
    jobKey: KEY,
    status: "skipped",
    trigger: "cron",
    startedAt: new Date(),
    summary: "file vide",
  });
  check("a new skipped row does not evict real runs", (await countBy(KEY, "ok")) === 100);
  check("skipped budget stays at 20", (await countBy(KEY, "skipped")) === 20);
  check("the latest failure survives", (await countBy(KEY, "failed")) === 1);

  console.log("lastRunByJob / lastFailureByJob — decoded rows:");
  const last = (await jobRunLogService.lastRunByJob([KEY, OTHER])).get(KEY);
  check("latest run is the just-recorded skipped row", last?.status === "skipped" && last?.summary === "file vide");
  check("started_at / created_at are Dates", last?.started_at instanceof Date && last?.created_at instanceof Date);
  let viewOk = false;
  try {
    viewOk = Boolean(last && toJobRunView(last).startedAt);
  } catch {
    viewOk = false;
  }
  check("toJobRunView(lastRun) does not throw", viewOk);
  const lastFail = await jobRunLogService.lastFailureByJob([KEY, OTHER]);
  const f = lastFail.get(KEY);
  check("lastFailureByJob → F2 with its error", f?.summary === "F2" && f?.error === "erreur F2");
  check("lastFailure timestamps are Dates", f?.started_at instanceof Date);
  check("no failure recorded for the other key", !lastFail.has(OTHER));
  check("empty key list → empty map", (await jobRunLogService.lastFailureByJob([])).size === 0);

  console.log("listForJob — hideSkipped:");
  const all = await jobRunLogService.listForJob(KEY, 20);
  check("default history = the newest rows (all skipped heartbeats here)", all.length === 20 && all.every((r) => r.status === "skipped"));
  const real = await jobRunLogService.listForJob(KEY, 20, { hideSkipped: true });
  check("hideSkipped → 20 real runs, no skipped", real.length === 20 && real.every((r) => r.status !== "skipped"));
  check("hideSkipped → newest real run first", real[0]?.summary === "ok-104");

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    await cleanup().catch(() => {});
    process.exit(1);
  })
  .then(() => process.exit(0));

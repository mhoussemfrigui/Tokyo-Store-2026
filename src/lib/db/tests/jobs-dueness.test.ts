/**
 * Dispatcher due-ness ANCHOR (DB test). Locks the two scheduling-semantics fixes:
 *   1. `lastExecutedRunByJob` returns the latest NON-failed run (ok / no-op skipped),
 *      so a transient `failed` run does not count as "ran this period" (daily retry).
 *   2. A kill-switch-DISABLED cron tick records NO job_run_log row, so re-enabling a
 *      daily job runs it the same day (no disabled-skip consuming the slot).
 *
 * Run (dev DB):
 *   DATABASE_URL=<dev> npx tsx --conditions=react-server \
 *     --env-file-if-exists=.env.local --env-file-if-exists=.env.development.local \
 *     src/lib/db/tests/jobs-dueness.test.ts
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { jobRunLogService } from "@/modules/jobs";
import { job_run_log } from "@/modules/jobs/schema";
import { isJobEnabled, runScheduledJob, setJobEnabled } from "@/lib/jobs/run-job";
import { settingService } from "@/modules/cms/setting/service";

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

const KEY = "__test_dueness";

async function countRows(k: string): Promise<number> {
  const r = await db.$client.query<{ c: number }>(
    "select count(*)::int as c from job_run_log where job_key = $1",
    [k],
  );
  return r.rows[0]?.c ?? 0;
}

async function main(): Promise<void> {
  // ── A. lastExecutedRunByJob excludes the latest FAILED run ──
  await db.delete(job_run_log).where(eq(job_run_log.job_key, KEY));
  const t = new Date();
  await jobRunLogService.record({ jobKey: KEY, status: "ok", trigger: "cron", startedAt: t, summary: "ok1" });
  await jobRunLogService.record({ jobKey: KEY, status: "skipped", trigger: "cron", startedAt: t, summary: "noop" });
  await jobRunLogService.record({ jobKey: KEY, status: "failed", trigger: "cron", startedAt: t, error: "boom" }); // latest overall

  const exec = (await jobRunLogService.lastExecutedRunByJob([KEY])).get(KEY);
  const any = (await jobRunLogService.lastRunByJob([KEY])).get(KEY);
  check("lastExecutedRunByJob ignores the latest FAILED → returns the no-op skipped", exec?.status === "skipped");
  check("lastRunByJob still returns the latest (failed) for the dashboard", any?.status === "failed");
  await db.delete(job_run_log).where(eq(job_run_log.job_key, KEY));

  // ── B. a kill-switch-disabled cron tick records NO row ──
  // mailing_queue's disabled path returns BEFORE any drain work, so this never sends.
  const MKEY = "mailing_queue";
  const original = (await settingService.findByKey(`jobs.${MKEY}.enabled`))?.value ?? null;
  try {
    await setJobEnabled(MKEY, false);
    check("isJobEnabled false after disable", (await isJobEnabled(MKEY)) === false);
    const before = await countRows(MKEY);
    const res = await runScheduledJob(MKEY, "cron");
    const after = await countRows(MKEY);
    check("disabled cron run returns disabled:true / skipped", res.disabled === true && res.status === "skipped");
    check("disabled cron run writes NO job_run_log row", after === before);
  } finally {
    if (original === null) await settingService.deleteByKeys([`jobs.${MKEY}.enabled`]).catch(() => {});
    else await setJobEnabled(MKEY, original !== "false");
  }

  console.log(`\n=== jobs-dueness: ${passed} passed, ${failed} failed ===`);
  await db.$client.end?.().catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

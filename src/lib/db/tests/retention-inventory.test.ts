/**
 * Retention inventory agreement — every surface that lists what the retention
 * purge deletes derives from ONE list (RETENTION_TARGETS in
 * src/lib/retention/windows.ts), and this pins that they agree:
 *
 *  • RETENTION_TARGETS ↔ RETENTION_WINDOWS: every day-windowed target has a
 *    window and every window has a target (no orphan / unpurged window).
 *  • the purge's `deleted` counter + run summary cover every target
 *    (runRetentionPurge's executors are Records over the target keys, so a
 *    target without a purge is a compile error — not re-checkable here without
 *    the DB).
 *  • live-window resolution FAILS CLOSED: an unreadable settings map makes the
 *    admin-configurable search/audit windows `unavailable` (the purge skips
 *    them) — never the shorter defaults — while static/expiry targets still run.
 *  • the storage « Journaux » subtotal (LOG_TABLES), the job registry
 *    description and the destructive-confirm copy (RETENTION_TARGETS_TEXT) name
 *    every target.
 *  • runLimited (the purge's concurrency bound) preserves order and never
 *    exceeds its limit.
 *
 * Pure — no DB. Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/retention-inventory.test.ts
 */
import {
  RETENTION_TARGETS,
  RETENTION_TARGETS_TEXT,
  RETENTION_WINDOWS,
} from "@/lib/retention/windows";
import {
  SETTINGS_UNAVAILABLE,
  emptyRetentionCounts,
  formatRetentionSummary,
  resolveRetentionWindow,
  retentionWindowText,
} from "@/lib/retention/resolve";
import { LOG_TABLES, groupForTable } from "@/lib/telemetry/storage";
import { getScheduledJob } from "@/lib/jobs/registry";
import { runLimited } from "@/lib/utils/run-limited";

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

const target = (id: string) => RETENTION_TARGETS.find((t) => t.id === id)!;

async function main() {
  console.log("RETENTION_TARGETS shape:");
  const keys = RETENTION_TARGETS.map((t) => t.key);
  const ids = RETENTION_TARGETS.map((t) => t.id);
  check("result keys are unique", new Set(keys).size === keys.length);
  check("ids are unique", new Set(ids).size === ids.length);
  check("labels + short labels are non-empty", RETENTION_TARGETS.every((t) => t.label && t.shortLabel));
  const dayIds = RETENTION_TARGETS.filter((t) => t.window !== "expiry").map((t) => t.id as string);
  const windowKeys = Object.keys(RETENTION_WINDOWS);
  check(
    "every day-windowed target has a RETENTION_WINDOWS entry",
    dayIds.every((id) => windowKeys.includes(id)),
  );
  check(
    "every RETENTION_WINDOWS entry is a purge target (no orphan window)",
    windowKeys.every((k) => dayIds.includes(k)),
  );
  check(
    "the two admin-configurable windows are search_log + audit_log",
    RETENTION_TARGETS.filter((t) => t.window === "setting")
      .map((t) => t.id)
      .sort()
      .join(",") === "audit_log,search_log",
  );
  check(
    "previously-missing targets are in the inventory (webhook_deliveries, ai_call_logs, guest carts/wishlists)",
    ["webhook_deliveries", "ai_call_logs", "guest_carts", "guest_wishlists"].every((id) => ids.includes(id as never)),
  );

  console.log("deleted counter + summary cover every target:");
  const counts = emptyRetentionCounts();
  check(
    "emptyRetentionCounts has exactly the target keys, all 0",
    Object.keys(counts).sort().join(",") === [...keys].sort().join(",") &&
      Object.values(counts).every((n) => n === 0),
  );
  const numbered = Object.fromEntries(keys.map((k, i) => [k, 1000 + i])) as typeof counts;
  const summary = formatRetentionSummary(numbered, {});
  check(
    "summary names every target with its count (incl. webhook deliveries)",
    RETENTION_TARGETS.every((t, i) => summary.includes(`${t.shortLabel} ${1000 + i}`)),
  );
  check("clean run → no « erreurs » suffix", !summary.includes("erreurs"));
  const failedSummary = formatRetentionSummary(counts, {
    searchLog: SETTINGS_UNAVAILABLE,
    auditLog: SETTINGS_UNAVAILABLE,
    emailLogs: "boom",
  });
  check(
    "settings-skipped purges are flagged as such in the summary",
    failedSummary.includes("journal de recherche (réglages indisponibles)") &&
      failedSummary.includes("journal d'audit (réglages indisponibles)"),
  );
  check(
    "a plain failure is listed by its label",
    failedSummary.includes("erreurs:") && failedSummary.includes("journal des emails (hors épinglés)"),
  );

  console.log("resolveRetentionWindow — static / expiry:");
  const email = resolveRetentionWindow(target("email_logs"), null);
  check(
    "static window = RETENTION_WINDOWS, even without settings",
    email.kind === "days" && email.days === RETENTION_WINDOWS.email_logs && !email.live,
  );
  const deliveries = resolveRetentionWindow(target("webhook_deliveries"), {});
  check(
    "webhook_deliveries resolves to its static window",
    deliveries.kind === "days" && deliveries.days === RETENTION_WINDOWS.webhook_deliveries,
  );
  check("sessions → expiry", resolveRetentionWindow(target("sessions"), null).kind === "expiry");
  check("verifications → expiry", resolveRetentionWindow(target("verifications"), {}).kind === "expiry");

  console.log("resolveRetentionWindow — admin-configurable, fail closed:");
  const searchDefault = resolveRetentionWindow(target("search_log"), {});
  check(
    "search_log, no setting → 3-month default (90 j), live",
    searchDefault.kind === "days" && searchDefault.days === 90 && searchDefault.live,
  );
  const auditDefault = resolveRetentionWindow(target("audit_log"), {});
  check(
    "audit_log, no setting → 12-month default (360 j) = RETENTION_WINDOWS.audit_log",
    auditDefault.kind === "days" && auditDefault.days === 360 && auditDefault.days === RETENTION_WINDOWS.audit_log,
  );
  check(
    "search_log default = RETENTION_WINDOWS.search_log",
    searchDefault.kind === "days" && searchDefault.days === RETENTION_WINDOWS.search_log,
  );
  const searchLong = resolveRetentionWindow(target("search_log"), { "search.purge_months": "24" });
  check("search.purge_months = 24 → 720 j", searchLong.kind === "days" && searchLong.days === 720);
  const auditLong = resolveRetentionWindow(target("audit_log"), { "audit.retention_months": "60" });
  check("audit.retention_months = 60 → 1800 j", auditLong.kind === "days" && auditLong.days === 1800);
  check(
    "settings unreadable (null) → search_log UNAVAILABLE (never the 90-day default)",
    resolveRetentionWindow(target("search_log"), null).kind === "unavailable",
  );
  check(
    "settings unreadable (null) → audit_log UNAVAILABLE (never the 360-day default)",
    resolveRetentionWindow(target("audit_log"), null).kind === "unavailable",
  );
  check(
    "settings unreadable → only the 2 configurable targets are skipped",
    RETENTION_TARGETS.filter((t) => resolveRetentionWindow(t, null).kind === "unavailable").length === 2,
  );

  console.log("retentionWindowText:");
  check("days (short unit)", retentionWindowText({ kind: "days", days: 90, live: false }) === "90 j");
  check("days (long unit)", retentionWindowText({ kind: "days", days: 90, live: true }, "jours") === "90 jours");
  check("expiry", retentionWindowText({ kind: "expiry" }) === "à l'expiration");
  check("unavailable", retentionWindowText({ kind: "unavailable" }).startsWith("indisponible"));

  console.log("LOG_TABLES (storage « Journaux » subtotal):");
  for (const t of RETENTION_TARGETS.filter((x) => x.log)) {
    check(`${t.table} is a log table → logs group`, LOG_TABLES.includes(t.table) && groupForTable(t.table).key === "logs");
  }
  check("webhook_deliveries + ai_call_logs now counted as logs", LOG_TABLES.includes("webhook_deliveries") && LOG_TABLES.includes("ai_call_logs"));
  check(
    "carts / wishlists / auth tables are NOT logs",
    !LOG_TABLES.includes("carts") && !LOG_TABLES.includes("wishlists") && !LOG_TABLES.includes("sessions") && !LOG_TABLES.includes("verifications"),
  );

  console.log("job registry + destructive confirm copy:");
  const def = getScheduledJob("retention_purge");
  check(
    "registry description names every purge target",
    Boolean(def) && RETENTION_TARGETS.every((t) => def!.description.includes(t.shortLabel)),
  );
  check(
    "RETENTION_TARGETS_TEXT (confirm dialog) names every purge target",
    RETENTION_TARGETS.every((t) => RETENTION_TARGETS_TEXT.includes(t.shortLabel)),
  );

  console.log("runLimited:");
  let inFlight = 0;
  let peak = 0;
  const started: number[] = [];
  const out = await runLimited(
    Array.from({ length: 9 }, (_, i) => async () => {
      started.push(i);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5 + ((i * 7) % 11)));
      inFlight--;
      return i * 10;
    }),
    2,
  );
  check("never more than `limit` in flight", peak === 2);
  check("results keep input order", out.join(",") === "0,10,20,30,40,50,60,70,80");
  check("thunks start in array order", started.join(",") === "0,1,2,3,4,5,6,7,8");
  check("empty list → []", (await runLimited([], 3)).length === 0);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

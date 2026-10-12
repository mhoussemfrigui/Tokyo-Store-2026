import "server-only";

import { auditService } from "@/modules/audit/service";
import { authService } from "@/modules/auth/service";
import { cartService } from "@/modules/cart/service";
import { cartEventService } from "@/modules/cart-event";
import { wishlistService } from "@/modules/wishlist";
import { jobRunLogService } from "@/modules/jobs";
import { emailLogService, mailingSendsService } from "@/modules/mailing";
import { searchService } from "@/modules/search";
import { aiCallLogService } from "@/modules/ai";
import { webhookEventService } from "@/modules/webhook";
import { webhookEndpointService } from "@/modules/webhook-endpoints";
import { instanceHeartbeatService } from "@/modules/instance";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { bus } from "@/events/bus";
import { runLimited } from "@/lib/utils/run-limited";
import {
  RETENTION_TARGETS,
  type RetentionResultKey,
  type RetentionTarget,
} from "@/lib/retention/windows";
import {
  SETTINGS_UNAVAILABLE,
  emptyRetentionCounts,
  formatRetentionSummary,
  resolveRetentionWindow,
} from "@/lib/retention/resolve";

export type RetentionPurgeResult = {
  ok: boolean;
  /** Rows deleted per target — exactly the RETENTION_TARGETS keys. */
  deleted: Record<RetentionResultKey, number>;
  /** Per-target failure (`settings_unavailable` = configurable purge skipped). */
  errors: Record<string, string>;
  /** Short human summary for the job-run log / admin banner. */
  summary: string;
};

type DayTargetKey = Extract<RetentionTarget, { window: "static" | "setting" }>["key"];
type ExpiryTargetKey = Extract<RetentionTarget, { window: "expiry" }>["key"];

type DayPurge = {
  /** Delete rows older than `days`; resolves to the deleted count. */
  run: (days: number) => Promise<number>;
  /** Post-delete hook (audit event), run AFTER the count is recorded. */
  after?: (days: number, deletedCount: number) => Promise<unknown>;
};

/**
 * One executor per RETENTION_TARGETS entry. Typed as Records over the target
 * keys (split by window kind), so adding a target without its purge — or a purge
 * without its target — is a compile error, and an expiry purge can never be fed
 * a day count (nor a day purge a missing one).
 */
const DAY_PURGES: Record<DayTargetKey, DayPurge> = {
  searchLog: {
    run: (days) => searchService.purgeOlderThan(days),
    after: (days, n) =>
      bus.emit("search_log.purged", { olderThanDays: days, deletedCount: n }, { actorUserId: null }),
  },
  webhookEvents: { run: (days) => webhookEventService.purgeOlderThan(days) },
  webhookDeliveries: { run: (days) => webhookEndpointService.purgeOlderThan(days) },
  auditLog: {
    run: (days) => auditService.purgeOlderThan(days),
    after: (days, n) =>
      bus.emit("audit.purged", { olderThanDays: days, deletedCount: n }, { actorUserId: null }),
  },
  ephemeralCarts: { run: (days) => cartService.purgeEphemeralOlderThan(days) },
  // Guest artefacts nobody can reach any more (their cookie expired): emptied /
  // abandoned guest carts and guest wishlists, keyed on last activity.
  guestCarts: { run: (days) => cartService.purgeStaleGuestCarts(days) },
  guestWishlists: { run: (days) => wishlistService.purgeStaleGuestLists(days) },
  jobRunLog: { run: (days) => jobRunLogService.purgeOlderThan(days) },
  emailLogs: { run: (days) => emailLogService.purgeOlderThan(days) },
  mailingSends: { run: (days) => mailingSendsService.purgeOlderThan(days) },
  cartEvents: { run: (days) => cartEventService.purgeOlderThan(days) },
  instanceHeartbeats: { run: (days) => instanceHeartbeatService.purgeOlderThan(days) },
  aiCallLogs: { run: (days) => aiCallLogService.purgeOlderThan(days) },
};

// Auth tables — purged by EXPIRY (expires_at < now()), not a days TTL, since
// Better Auth only evicts these lazily on token re-presentation.
const EXPIRY_PURGES: Record<ExpiryTargetKey, () => Promise<number>> = {
  expiredSessions: () => authService.purgeExpiredSessions(),
  expiredVerifications: () => authService.purgeExpiredVerifications(),
};

/**
 * Tables expected to hold the most rows — purged LAST so the cheap sweeps finish
 * first and a backlog on a big table only ever holds PURGE_CONCURRENCY
 * connections at a time.
 */
const HIGH_VOLUME: ReadonlySet<RetentionResultKey> = new Set<RetentionResultKey>([
  "searchLog",
  "auditLog",
  "emailLogs",
  "cartEvents",
  "webhookDeliveries",
  "aiCallLogs",
]);

/**
 * At most this many purge loops in flight. Each loop holds a pool connection per
 * DELETE batch (up to 5000 rows on a backlog); 13+ concurrent loops would take
 * every connection of the app pool (POOL_MAX 12 in prod, 5 in dev) and push
 * storefront requests past the pool-acquire timeout.
 */
const PURGE_CONCURRENCY = 2;

/**
 * The data-retention purge body, shared by the cron endpoint
 * (`/api/cron/retention`) and the admin "Run now" action so they can't drift.
 * Hard-deletes PII-bearing / unbounded tables past their retention window (the
 * RETENTION_TARGETS inventory); each target is purged independently so one
 * failure doesn't strand the others. Emits `search_log.purged` /
 * `audit.purged` with `actorUserId: null` (système) for audit parity with the
 * manual purge buttons.
 *
 * The search-log and audit-log windows are admin-configurable
 * (`search.purge_months`, `audit.retention_months`) and resolved HERE at purge
 * time so the cron, the dashboard "Run now" and the manual purges all honour the
 * live setting. If the settings read FAILS, those two purges are SKIPPED
 * (errors.searchLog / errors.auditLog = `settings_unavailable`, the run is
 * recorded failed) — never run with the shorter defaults; the next run catches up.
 */
export async function runRetentionPurge(): Promise<RetentionPurgeResult> {
  const deleted = emptyRetentionCounts();
  const errors: Record<string, string> = {};

  let settings: Record<string, string | null> | null = null;
  try {
    settings = await getSettingsMap();
  } catch (err) {
    console.error(
      "[retention] settings read failed — skipping the admin-configurable purges (search log, audit log)",
      err,
    );
  }

  // Stable sort: inventory order, high-volume tables last.
  const ordered = [...RETENTION_TARGETS].sort(
    (a, b) => Number(HIGH_VOLUME.has(a.key)) - Number(HIGH_VOLUME.has(b.key)),
  );

  await runLimited(
    ordered.map((target) => async () => {
      try {
        if (target.window === "expiry") {
          deleted[target.key] = await EXPIRY_PURGES[target.key]();
          return;
        }
        const w = resolveRetentionWindow(target, settings);
        if (w.kind !== "days") {
          errors[target.key] = SETTINGS_UNAVAILABLE;
          return;
        }
        const purge = DAY_PURGES[target.key];
        const n = await purge.run(w.days);
        deleted[target.key] = n;
        if (purge.after) await purge.after(w.days, n);
      } catch (err) {
        errors[target.key] = err instanceof Error ? err.message : String(err);
      }
    }),
    PURGE_CONCURRENCY,
  );

  const ok = Object.keys(errors).length === 0;
  return { ok, deleted, errors, summary: formatRetentionSummary(deleted, errors) };
}

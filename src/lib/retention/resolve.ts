/**
 * PURE retention-window resolution — no "server-only", no DB, so it is unit
 * tested directly (src/lib/db/tests/retention-inventory.test.ts). Shared by the
 * purge itself (`runRetentionPurge`) and every surface that DISPLAYS the windows
 * (Database tab, API page), so what an operator reads is exactly what the purge
 * deletes.
 *
 * FAIL CLOSED: the admin-configurable windows (search log, audit log) resolve
 * to `unavailable` when the settings map could not be read (`settings === null`)
 * — never to the shorter built-in defaults, which would irreversibly delete rows
 * an operator chose to keep (e.g. 24 months of search telemetry, 60 of audit).
 */
import { resolveAuditConfig } from "@/lib/audit/parse-config";
import { resolveSearchConfig } from "@/modules/search/parse-config";
import {
  RETENTION_TARGETS,
  RETENTION_WINDOWS,
  type RetentionResultKey,
  type RetentionTarget,
} from "./windows";

/** `errors[key]` recorded for a configurable purge skipped because the settings read failed. */
export const SETTINGS_UNAVAILABLE = "settings_unavailable";

export type ResolvedRetentionWindow =
  /** Delete rows older than `days`; `live` = resolved from an admin setting. */
  | { kind: "days"; days: number; live: boolean }
  /** Delete rows past their own `expires_at` (auth tables). */
  | { kind: "expiry" }
  /** Configurable window whose setting could not be read — do NOT purge. */
  | { kind: "unavailable" };

export function resolveRetentionWindow(
  target: RetentionTarget,
  settings: Record<string, string | null> | null,
): ResolvedRetentionWindow {
  switch (target.window) {
    case "expiry":
      return { kind: "expiry" };
    case "static":
      return { kind: "days", days: RETENTION_WINDOWS[target.id], live: false };
    case "setting": {
      if (settings === null) return { kind: "unavailable" };
      // Months → days, exactly like the manual purge buttons (Recherche → Purge,
      // Journal d'audit → Réglages); both resolvers clamp to their admin ranges.
      switch (target.id) {
        case "search_log":
          return { kind: "days", days: resolveSearchConfig(settings).purgeMonths * 30, live: true };
        case "audit_log":
          return { kind: "days", days: resolveAuditConfig(settings).retentionMonths * 30, live: true };
        default: {
          const unhandled: never = target;
          throw new Error(`fenêtre de rétention non gérée: ${JSON.stringify(unhandled)}`);
        }
      }
    }
    default: {
      const unhandled: never = target;
      throw new Error(`fenêtre de rétention non gérée: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** French display of a resolved window (Database tab « 90 j », API page « 90 jours »). */
export function retentionWindowText(w: ResolvedRetentionWindow, dayUnit = "j"): string {
  if (w.kind === "days") return `${w.days} ${dayUnit}`;
  if (w.kind === "expiry") return "à l'expiration";
  return "indisponible (réglages)";
}

/** A zeroed `deleted` counter with exactly one key per target. */
export function emptyRetentionCounts(): Record<RetentionResultKey, number> {
  return Object.fromEntries(RETENTION_TARGETS.map((t) => [t.key, 0])) as Record<
    RetentionResultKey,
    number
  >;
}

/**
 * Short human summary for the job-run log / admin banner — one « label count »
 * per target (so a newly added target can't be silently left out), then the
 * failed/skipped ones.
 */
export function formatRetentionSummary(
  deleted: Record<RetentionResultKey, number>,
  errors: Record<string, string>,
): string {
  const counts = RETENTION_TARGETS.map((t) => `${t.shortLabel} ${deleted[t.key]}`).join(", ");
  const failed = RETENTION_TARGETS.filter((t) => errors[t.key] !== undefined).map((t) =>
    errors[t.key] === SETTINGS_UNAVAILABLE ? `${t.shortLabel} (réglages indisponibles)` : t.shortLabel,
  );
  return failed.length === 0 ? counts : `${counts} — erreurs: ${failed.join(", ")}`;
}

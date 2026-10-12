import { storeDailyInstantMs } from "@/lib/jobs/dispatch-schedule";

/**
 * Pure helpers for the DAILY marketing send cap (Réglages → « Limite d'envoi
 * quotidienne »). The cap governs MARKETING + CAMPAIGN sends only — transactional
 * email (order receipts, password resets…) is never throttled by it. The drain
 * counts marketing rows sent since the current window's boundary; once the cap is
 * reached it DEFERS the remaining marketing rows to the next reset (a campaign
 * pauses and resumes the next day). Store timezone is a fixed +01:00 (no DST), so
 * these are deterministic + unit-testable. No DB, no "server-only".
 */

const DAY_MS = 86_400_000;

/**
 * Parse a store-local reset time "HH:MM" → {hour, minute}, clamped to a real
 * time. Anything malformed (incl. empty) falls back to midnight 00:00.
 */
export function parseResetTime(raw: string | null | undefined): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec((raw ?? "").trim());
  if (!m) return { hour: 0, minute: 0 };
  return {
    hour: Math.min(23, Math.max(0, Number(m[1]))),
    minute: Math.min(59, Math.max(0, Number(m[2]))),
  };
}

/** Normalise a reset time back to a canonical "HH:MM" for storage/display. */
export function formatResetTime(raw: string | null | undefined): string {
  const { hour, minute } = parseResetTime(raw);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * The current daily-cap window for a given store-local reset time:
 *   - `boundaryMs` — the most recent reset instant ≤ now (count marketing sends
 *     from here);
 *   - `nextResetMs` — the next reset instant (when a paused campaign resumes;
 *     deferred rows are re-queued with next_attempt_at = this).
 * Pure + DST-free (store TZ = fixed +01:00).
 */
export function dailyMarketingWindow(
  nowMs: number,
  resetHHMM: string | null | undefined,
): { boundaryMs: number; nextResetMs: number } {
  const { hour, minute } = parseResetTime(resetHHMM);
  const today = storeDailyInstantMs(nowMs, hour, minute);
  return nowMs >= today
    ? { boundaryMs: today, nextResetMs: today + DAY_MS }
    : { boundaryMs: today - DAY_MS, nextResetMs: today };
}

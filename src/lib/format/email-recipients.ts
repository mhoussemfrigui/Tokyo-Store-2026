/**
 * Shared parser for an admin "recipient list" CSV field (alert/notification
 * emails). One implementation so every settings surface validates + caps the
 * same way — previously perf-config and the low-stock alert each had their own
 * copy and they DIVERGED (the low-stock one skipped validation + the cap). Pure,
 * no deps, unit-testable.
 */

/** Loose-but-safe email shape for a display/send recipient list. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Default fan-out cap so a paste accident can't blast an alert to a huge list. */
export const DEFAULT_RECIPIENT_CAP = 20;

/**
 * Split a CSV/whitespace recipient string into a deduped, lowercased, validated
 * email list (split on comma / semicolon / whitespace), capped at `cap`.
 */
export function parseEmailRecipients(
  raw: string | null | undefined,
  cap: number = DEFAULT_RECIPIENT_CAP,
): string[] {
  if (!raw) return [];
  const out = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => EMAIL_RE.test(s));
  return Array.from(new Set(out)).slice(0, Math.max(0, cap));
}

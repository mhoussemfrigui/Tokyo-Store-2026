/**
 * Parse a numeric settings-form field. A missing, blank or whitespace-only field
 * returns `null` = "unset → use the default", as does anything non-numeric.
 *
 * `Number("")` is 0 (not NaN), so a bare `Number(String(v ?? "").trim())` turns
 * a CLEARED input into a real 0 — which the readers then honour (0 points per
 * TND, a 1-day session after clamping to the minimum…). The search / audit /
 * perf resolvers already guard this; save actions use this helper to match.
 *
 * Pure (no server-only import) so it can be unit-tested.
 */
export function parseFormNumber(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Validate a submitted `consent.revision` against the stored one.
 *
 * The storefront keeps a visitor's stored decision while `record.v >= revision`
 * (state.ts `isConsentRecordCurrent`), so the revision must only ever go UP: lowering it
 * (typo, or a save built from a failed settings read that showed « 1 ») means a
 * later "bump" to a value still below the old one re-prompts nobody, and a new
 * tracker then runs under stale consent. A blank / invalid submission keeps the
 * stored revision (never silently resets it to 1).
 *
 * Both values are parsed like `parseConsentConfig` (positive integer, else the
 * fallback: 1 for the stored value). Pure — unit-tested.
 */
export type ConsentRevisionCheck =
  | { ok: true; revision: number }
  | { ok: false; current: number };

function positiveInt(raw: unknown): number | null {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function checkConsentRevision(
  submitted: unknown,
  stored: string | null | undefined,
): ConsentRevisionCheck {
  const current = positiveInt(stored) ?? 1;
  const next = positiveInt(submitted);
  if (next === null) return { ok: true, revision: current };
  if (next < current) return { ok: false, current };
  return { ok: true, revision: next };
}

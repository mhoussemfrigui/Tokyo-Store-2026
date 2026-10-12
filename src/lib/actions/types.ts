/**
 * Shared discriminated-union shape every server action in `src/lib/actions/*`
 * returns. Keeping the type in one place stops the per-file copies from
 * drifting (some had `error`, some didn't; some had `fieldErrors`, some
 * didn't), so consumers can branch on `res.ok` once and always get the same
 * keys regardless of which action they called.
 *
 * - `ok: true` carries an optional human-readable confirmation `message` and
 *   an optional `id` (used by `create*` actions that return the new row id).
 * - `ok: false` always carries a machine `error` code (e.g. `validation`,
 *   `not_found`) and a French-language `message` ready to render. Form-level
 *   actions can attach per-field validation errors via `fieldErrors`.
 *
 * Actions that need to return additional payload fields (orderId, counts,
 * totals…) extend this via intersection: `ActionState & { orderId?: string }`.
 */
export type ActionState =
  | { ok: true; message?: string; id?: string }
  | { ok: false; error: string; message: string; fieldErrors?: Record<string, string> };

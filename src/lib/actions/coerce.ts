/**
 * FormData / JSON numeric coercion helpers — ONE audited path for turning
 * client-supplied values into integers, so NaN / empty-string / clamp handling
 * is uniform. Server actions previously each re-implemented this with slightly
 * different guards; the `oldPriceCents` variant-mapper bug (a missing
 * `Number.isFinite` guard its sibling fields had) is the bug class these
 * eliminate by construction.
 */

/** Parse to a finite integer, else null. Optional min/max clamp. */
export function toIntOrNull(
  v: unknown,
  opts: { min?: number; max?: number } = {},
): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  let r = Math.round(n);
  if (opts.min != null) r = Math.max(opts.min, r);
  if (opts.max != null) r = Math.min(opts.max, r);
  return r;
}

/** Parse to a finite integer, else `fallback`. Optional min/max clamp. */
export function toIntOr(
  v: unknown,
  fallback: number,
  opts: { min?: number; max?: number } = {},
): number {
  return toIntOrNull(v, opts) ?? fallback;
}

/** Non-negative integer (floored at 0); 0 when blank/invalid. */
export function toNonNegInt(v: unknown): number {
  return toIntOr(v, 0, { min: 0 });
}

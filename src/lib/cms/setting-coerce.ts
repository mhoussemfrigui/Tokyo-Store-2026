/**
 * Coercion helpers for raw CMS setting values (always stored as nullable text).
 *
 * Copied verbatim from `@/lib/pages/home-page-config` so any settings-backed
 * config loader can share the same parsing rules instead of re-declaring them.
 *
 * Isomorphic + client-safe: pure string logic, no deps.
 */

/** Parse a textual boolean ("true/1/yes/on" → true, "false/0/no/off" → false), else fallback. */
export const asBool = (v: string | null | undefined, d: boolean): boolean => {
  if (v == null) return d;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return d;
};

/** Trimmed non-empty string, else fallback. */
export const asStr = (v: string | null | undefined, d: string): string => {
  const t = v?.trim();
  return t ? t : d;
};

/**
 * One of an allow-list of literal strings (case-insensitive match), else
 * fallback. Used by config resolvers for enum-typed settings (log levels,
 * strategies, …) so an operator typo / hand-edited row can never select an
 * unknown value.
 */
export const asEnum = <T extends string>(
  v: string | null | undefined,
  allowed: readonly T[],
  d: T,
): T => {
  const t = v?.trim().toLowerCase();
  if (!t) return d;
  const hit = allowed.find((a) => a.toLowerCase() === t);
  return hit ?? d;
};

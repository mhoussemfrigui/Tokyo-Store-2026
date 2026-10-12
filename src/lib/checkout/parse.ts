/**
 * PURE checkout-setting parsers — no "server-only" — extracted from copy.ts so
 * they can be unit-tested directly (copy.ts re-imports them). Used for the
 * `checkout.delivery.*` / returns / warranty settings.
 */

/**
 * Parse a non-negative integer-string (cents OR plain day counts). Empty /
 * non-numeric → null so callers can choose between "use the default" and "0".
 */
export function parseCents(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

export function trimOrNull(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = raw.trim();
  return t === "" ? null : t;
}

/** Boolean setting parse with an explicit default for unset/blank. */
export function parseBool(raw: string | null | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === "") return fallback;
  return raw.trim().toLowerCase() === "true";
}

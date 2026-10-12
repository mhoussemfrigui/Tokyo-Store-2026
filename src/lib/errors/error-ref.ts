/**
 * Error reference — the single traceable identifier shown in the error UI AND
 * written to the logs, so an operator can paste the reference and find the exact
 * incident.
 *
 * PURE + isomorphic (no "server-only", no imports) so the SAME function runs in
 * the client error boundaries and in the server `onRequestError` hook — the
 * reference is therefore byte-identical on both sides.
 *
 * It is derived from Next.js's `error.digest` (a deterministic hash of the error
 * the framework stamps onto the error object before any handler fires, and which
 * it also prints to the server console). `digest` itself is a short opaque
 * decimal string (e.g. "3837587188"); we reformat it into the human-friendly
 * `ERR-XXXX-XXXX` shape for display + for the audit-log `target_id`, while the
 * raw digest is also logged alongside so it still correlates with Next's own
 * default error line.
 */

const PREFIX = "ERR";

/** FNV-1a 32-bit hash → 8 uppercase hex chars. Deterministic across runtimes. */
function hash8(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

/**
 * Format a Next.js error digest into the canonical `ERR-XXXX-XXXX` reference.
 * Returns `null` when there is no digest (a client-only render error that never
 * reached the server has none) — callers show an "unavailable" state rather than
 * fabricating an untraceable reference.
 */
export function formatErrorRef(digest: string | null | undefined): string | null {
  const d = (digest ?? "").trim();
  if (!d) return null;
  const hex = hash8(d);
  return `${PREFIX}-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

/** The audit-log `target_type` under which runtime error references are stored. */
export const ERROR_TARGET_TYPE = "error";

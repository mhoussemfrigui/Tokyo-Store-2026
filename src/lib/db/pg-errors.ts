/**
 * Postgres error-code helpers. Drizzle wraps the driver error in a
 * `DrizzleQueryError`, so the real `code` (e.g. 23505 unique_violation, 23514
 * check_violation) lives on `.cause` (sometimes nested) — these unwrap the
 * chain rather than reading `err.code` at the top level (which is undefined).
 */
export function pgErrorCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let depth = 0; e && depth < 8; depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Unique-constraint violation (23505). */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23505";
}

/** The violated constraint name (e.g. "products_sku_unique"), unwrapping the
 *  Drizzle `.cause` chain like {@link pgErrorCode}. Undefined if unavailable. */
export function pgErrorConstraint(err: unknown): string | undefined {
  let e: unknown = err;
  for (let depth = 0; e && depth < 8; depth += 1) {
    const c = (e as { constraint?: unknown }).constraint;
    if (typeof c === "string") return c;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

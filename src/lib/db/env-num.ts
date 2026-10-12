/**
 * PURE env-number parsing — NO "server-only", NO pg/DB import, so it can be unit-
 * tested directly (the pool sizing in ./client.ts is otherwise un-testable, being
 * gated behind `import "server-only"` + a real Pool).
 *
 * CRITICAL invariant this guards: a Coolify env tab left EMPTY ("") is not null,
 * so the naive `Number(process.env.X ?? default)` yields `Number("") === 0` —
 * which silently set pool max = 0 and, worse, `statement_timeout = 0` (= NO query
 * timeout in production). Treat anything that isn't a real positive number as
 * "unset → default" so an empty/typo'd env can never disable a safety bound.
 */
export function posIntEnv(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const t = raw.trim();
  if (t === "") return fallback;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Pure pgvector literal helpers — NO "server-only" / db imports, so the guard can be
 * unit-tested under `test:pure`. Kept apart from queries.ts (which is server-only) for
 * exactly that reason.
 */

/**
 * Render a query embedding as a pgvector text literal (`[0.1,0.2,…]`) for a bound
 * `::vector` param. Returns null when the vector is unusable (empty, or any
 * non-finite component) so the caller falls back to the keyword-only query rather
 * than emitting a malformed cast such as `[NaN]::vector` — which Postgres REJECTS,
 * throwing inside the product reader and making every product hit silently vanish.
 * Numbers only ⇒ no injection surface.
 */
export function toVectorLiteral(embedding: number[]): string | null {
  if (!Array.isArray(embedding) || embedding.length === 0) return null;
  if (!embedding.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return `[${embedding.join(",")}]`;
}

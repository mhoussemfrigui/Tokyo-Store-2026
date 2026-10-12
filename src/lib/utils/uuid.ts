/**
 * Strict v4/v7 UUID shape check. Cheap regex — does NOT verify the variant
 * bits, but it's enough to reject typos and accidental literals like "new"
 * before they reach a `WHERE id = $1::uuid` cast that would otherwise 500.
 *
 * Use this at the top of every dynamic admin/[id] page so unknown / malformed
 * routes return 404 instead of throwing in the DB driver.
 */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

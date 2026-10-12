/**
 * PURE keyset-page collector for the admin CSV exports. Service `list()`
 * methods clamp a page (e.g. customers at 200), so an export that asks for one
 * big page silently gets only the first slice. This walks the service's own
 * `nextCursor` until the list ends or the export ceiling is reached, and says
 * whether it stopped early — so the route can mark the file as truncated
 * instead of shipping a silent partial. No deps — unit-testable.
 */
export async function collectKeysetPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
  cap: number,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (;;) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (items.length >= cap) {
      // More rows exist beyond the ceiling (this page overflowed it, or the
      // service has another page).
      truncated = items.length > cap || Boolean(page.nextCursor);
      break;
    }
    // An empty page or a cursor that doesn't advance can't make progress —
    // stop rather than spin.
    if (!page.nextCursor || page.items.length === 0 || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  if (items.length > cap) items.length = cap;
  return { items, truncated };
}

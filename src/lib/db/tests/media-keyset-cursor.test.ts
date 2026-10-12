import "server-only";

/**
 * mediaService.list() keyset cursor (modules/media/service.ts).
 *
 * The Médiathèque "Charger plus" pages by a COMPOSITE (created_at, id) cursor.
 * created_at alone isn't unique — a bulk import writes many rows sharing the
 * transaction timestamp — so a bare `lt(created_at)` would SKIP or DUPLICATE
 * rows at the page seam. This pins that paging over N rows that SHARE a
 * created_at returns each exactly once, no gaps, across every seam; a
 * regression to a plain created_at cursor would fail here.
 *
 * Scoped by a filename tag via the server-side search so it pages only its own
 * rows regardless of the rest of the library. Self-cleaning (`zztest-cursor-`).
 *
 * Run (isolated DB only):
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… pnpm exec tsx --conditions=react-server \
 *     --env-file-if-exists=.env.local src/lib/db/tests/media-keyset-cursor.test.ts
 */
import { randomUUID } from "node:crypto";

import { like } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { media } from "@/modules/media/schema";
import { mediaService, MEDIA_TS_RE } from "@/modules/media/service";

const TAG = "zztest-cursor-";
let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

async function cleanup() {
  await db.delete(media).where(like(media.filename, `${TAG}%`));
}

async function main() {
  await cleanup();
  // Cursor timestamp regex back-compat: it must accept BOTH a legacy millisecond
  // cursor (`.458Z`, minted before the µs fix, still parsing mid-deploy) and the
  // new microsecond form (`.458413Z`) — a tightening to `\.\d{6}Z` would silently
  // break in-flight cross-deploy pagination with no failing test.
  check("cursor regex accepts a legacy 3-digit (ms) timestamp", MEDIA_TS_RE.test("2026-01-01T00:00:00.458Z"));
  check("cursor regex accepts a 6-digit (µs) timestamp", MEDIA_TS_RE.test("2026-01-01T00:00:00.458413Z"));
  check("cursor regex rejects 7 fractional digits", !MEDIA_TS_RE.test("2026-01-01T00:00:00.4584139Z"));
  check("cursor regex rejects a non-UTC (no Z) timestamp", !MEDIA_TS_RE.test("2026-01-01T00:00:00.458+00:00"));

  try {
    const N = 7;
    // ONE insert → every row shares created_at (the tx `now()`); ids are uuid v7.
    const inserted = await db
      .insert(media)
      .values(
        Array.from({ length: N }, (_, i) => {
          const key = `uploads/${randomUUID()}-${TAG}${i}.jpg`;
          return {
            storage_key: key,
            url: `/cdn/${key}`,
            filename: `${TAG}${randomUUID().slice(0, 8)}.jpg`,
            mime_type: "image/jpeg",
            size_bytes: 100 + i,
          };
        }),
      )
      .returning({ id: media.id, created_at: media.created_at });
    const insertedIds = new Set(inserted.map((r) => r.id));
    check(
      "fixture rows share one created_at (seam condition)",
      new Set(inserted.map((r) => r.created_at.getTime())).size === 1,
    );

    // Page with a limit SMALLER than N so at least one seam falls between
    // same-timestamp rows.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: { items: { id: string }[]; nextCursor: string | null } = await mediaService.list({
        search: TAG,
        limit: 2,
        cursor: cursor ?? undefined,
      });
      seen.push(...res.items.map((it) => it.id));
      cursor = res.nextCursor;
      if (++pages > 20) break; // runaway guard
    } while (cursor);

    const seenSet = new Set(seen);
    check("every fixture row returned", insertedIds.size === N && [...insertedIds].every((id) => seenSet.has(id)));
    check("no duplicate across the page seams", seen.length === seenSet.size);
    check("exactly N rows seen (no gaps, no extras from the tag)", seen.filter((id) => insertedIds.has(id)).length === N);
    check("paged in more than one page (the seam was actually exercised)", pages > 1);
  } finally {
    await cleanup();
  }
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});

/**
 * Media-reference coverage for pages.blocks (the "media in a JSON column" data-loss class).
 * A média referenced ONLY inside a page's block-composer JSON (a block/card/gallery image)
 * must be seen by ALL THREE media-reference seams — listReferencedMediaIds (the destructive-
 * sweep guard), countMediaReferences (the delete-confirm), and NOT flagged by listOrphans —
 * or the orphan sweep / reclaim would hard-delete an in-use page image. Regression for
 * pageBlocksMediaMatch across the 3 seams. Creates + cleans up its own rows.
 *
 * Run: tsx --conditions=react-server --env-file-if-exists=.env.local src/lib/db/tests/page-blocks-media-coverage.test.ts
 */
import { db } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { listReferencedMediaIds, countMediaReferences, listOrphans } from "@/modules/media/queries";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

async function newMedia(tag: string): Promise<string> {
  const r = await db.execute<{ id: string }>(sql`
    INSERT INTO media (storage_key,url,filename,mime_type,size_bytes,kind)
    VALUES (${"probe/" + tag + "-"}||gen_random_uuid()::text,'/cdn/p.jpg','p.jpg','image/jpeg',10,'image')
    RETURNING id`);
  return r.rows[0].id;
}

async function main() {
  const blockImg = await newMedia("pg-img");
  const galleryImg = await newMedia("pg-gal");
  const orphanCtl = await newMedia("pg-orphan");
  let pageId: string | null = null;

  try {
    const blocks = JSON.stringify([
      { id: "b1", type: "hero", visible: true, config: { image: { mediaId: blockImg, alt: "" } } },
      { id: "b2", type: "gallery", visible: true, config: { images: [{ mediaId: galleryImg, alt: "" }] } },
    ]);
    const p = await db.execute<{ id: string }>(sql`
      INSERT INTO pages (slug, title, is_published, blocks)
      VALUES ('probe-blocks-page','Probe',false,${blocks}) RETURNING id`);
    pageId = p.rows[0].id;

    const refs = await listReferencedMediaIds([blockImg, galleryImg, orphanCtl]);
    const orphans = new Set((await listOrphans(2000)).map((o) => o.id));

    check("block image protected by listReferencedMediaIds", refs.has(blockImg));
    check("gallery image protected by listReferencedMediaIds", refs.has(galleryImg));
    check("unreferenced control NOT protected", !refs.has(orphanCtl));

    check("block image countMediaReferences >= 1", (await countMediaReferences(blockImg)) >= 1);
    check("gallery image countMediaReferences >= 1", (await countMediaReferences(galleryImg)) >= 1);
    check("control countMediaReferences === 0", (await countMediaReferences(orphanCtl)) === 0);

    check("block image NOT in listOrphans", !orphans.has(blockImg));
    check("gallery image NOT in listOrphans", !orphans.has(galleryImg));
    check("control IS in listOrphans (seam still sees real orphans)", orphans.has(orphanCtl));
  } finally {
    if (pageId) await db.execute(sql`DELETE FROM pages WHERE id=${pageId}`);
    await db.execute(sql`DELETE FROM media WHERE id IN (${blockImg}, ${galleryImg}, ${orphanCtl})`);
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

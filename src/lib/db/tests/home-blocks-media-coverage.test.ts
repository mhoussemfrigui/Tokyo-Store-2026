/**
 * Media-reference coverage for the "media in a JSON/side column" data-loss class.
 * A média referenced ONLY inside the home.blocks composer JSON (a block image or a
 * banner_duo slot) or ONLY via banners.image_mobile_media_id must be seen by ALL THREE
 * media-reference seams — listReferencedMediaIds (the destructive-sweep guard),
 * countMediaReferences (the delete-confirm), and NOT flagged by listOrphans — or the
 * orphan sweep / reclaim would hard-delete an in-use homepage/banner image. Regression
 * for homeBlocksMediaMatch + the banners.image_mobile_media_id OR across the 3 seams.
 *
 * Needs a DB. Restores home.blocks and deletes its own rows. Run:
 *   tsx --conditions=react-server --env-file-if-exists=.env.local src/lib/db/tests/home-blocks-media-coverage.test.ts
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
  const snap = await db.execute<{ value: string }>(sql`SELECT value FROM site_settings WHERE key='home.blocks'`);
  const originalHome = snap.rows[0]?.value ?? null;

  const blockImg = await newMedia("hb-img");
  const blockImgMobile = await newMedia("hb-mob"); // a block's imageMobile crop
  const cardImg = await newMedia("hb-card"); // a card's image (fifty_fifty / feature_cards)
  const duoSlot = await newMedia("hb-duo");
  const duoSlot2 = await newMedia("hb-duo2"); // banner_duo bannerId2
  const testimonialAvatar = await newMedia("hb-testi"); // a testimonials[].image avatar (newest shape)
  const bannerMobile = await newMedia("ba-mob");
  const orphanCtl = await newMedia("orphan"); // referenced nowhere → must stay an orphan
  let bannerId: string | null = null;

  try {
    // home.blocks referencing every media-bearing shape: a block image + its mobile crop,
    // a CARD image, BOTH banner_duo slots, and a TESTIMONIAL avatar — the full surface
    // homeBlocksMediaMatch guards (the substring match covers any UUID in the blob).
    const hb = JSON.stringify([
      { id: "p1", type: "banner", visible: true, config: { image: { mediaId: blockImg, alt: "" }, imageMobile: { mediaId: blockImgMobile, alt: "" } } },
      { id: "p2", type: "banner_duo", visible: true, config: { bannerId: duoSlot, bannerId2: duoSlot2 } },
      { id: "p3", type: "fifty_fifty", visible: true, config: { cards: [{ title: "c", image: { mediaId: cardImg, alt: "" } }] } },
      { id: "p4", type: "testimonials", visible: true, config: { testimonials: [{ quote: "q", author: "a", meta: "", image: { mediaId: testimonialAvatar, alt: "" } }] } },
    ]);
    // UPSERT, not a bare UPDATE: a fresh/demo DB may have no home.blocks row yet,
    // and an UPDATE would silently no-op — leaving the fixture unwritten so every
    // home.blocks assertion below fails. `label` is NOT NULL with no default, so it
    // must be supplied on insert; ON CONFLICT updates only value. The finally block
    // already removes the row when it didn't pre-exist (originalHome === null).
    await db.execute(sql`
      INSERT INTO site_settings (key, value, label)
      VALUES ('home.blocks', ${hb}, 'home.blocks')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

    // a banner whose ONLY media is the mobile column
    const b = await db.execute<{ id: string }>(sql`
      INSERT INTO banners (placement,name,title,image_mobile_media_id)
      VALUES ('home_hero','coverage-probe','Probe',${bannerMobile}) RETURNING id`);
    bannerId = b.rows[0].id;

    const inUse = [blockImg, blockImgMobile, cardImg, duoSlot, duoSlot2, testimonialAvatar, bannerMobile];
    const refs = await listReferencedMediaIds([...inUse, orphanCtl]);
    const orphans = new Set((await listOrphans(2000)).map((o) => o.id));

    check("block image protected by listReferencedMediaIds", refs.has(blockImg));
    check("block imageMobile protected by listReferencedMediaIds", refs.has(blockImgMobile));
    check("card image protected by listReferencedMediaIds", refs.has(cardImg));
    check("banner_duo slot 1 protected by listReferencedMediaIds", refs.has(duoSlot));
    check("banner_duo slot 2 protected by listReferencedMediaIds", refs.has(duoSlot2));
    check("testimonial avatar protected by listReferencedMediaIds", refs.has(testimonialAvatar));
    check("banner mobile image protected by listReferencedMediaIds", refs.has(bannerMobile));
    check("unreferenced control is NOT protected", !refs.has(orphanCtl));

    for (const [id, name] of [[blockImg, "block image"], [blockImgMobile, "block imageMobile"], [cardImg, "card image"], [duoSlot, "duo slot 1"], [duoSlot2, "duo slot 2"], [testimonialAvatar, "testimonial avatar"], [bannerMobile, "banner mobile"]] as const) {
      check(`${name} countMediaReferences >= 1`, (await countMediaReferences(id)) >= 1);
      check(`${name} NOT in listOrphans`, !orphans.has(id));
    }
    check("control countMediaReferences === 0", (await countMediaReferences(orphanCtl)) === 0);
    check("control IS in listOrphans (sanity: the seam can still see real orphans)", orphans.has(orphanCtl));
  } finally {
    if (bannerId) await db.execute(sql`DELETE FROM banners WHERE id=${bannerId}`);
    if (originalHome === null) await db.execute(sql`DELETE FROM site_settings WHERE key='home.blocks'`);
    else await db.execute(sql`UPDATE site_settings SET value=${originalHome} WHERE key='home.blocks'`);
    await db.execute(sql`DELETE FROM media WHERE id IN (${blockImg}, ${blockImgMobile}, ${cardImg}, ${duoSlot}, ${duoSlot2}, ${testimonialAvatar}, ${bannerMobile}, ${orphanCtl})`);
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

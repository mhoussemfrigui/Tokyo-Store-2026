import "server-only";

/**
 * Inline rich-HTML body references (modules/media/queries.ts — bodyRefMatch).
 *
 * The rich-text editor splices a media's PUBLIC /cdn URL straight into a body
 * (blog/product/category/page) with NO media_id, so the `*_media_id`
 * anti-join misses it. Before the fix such a media read as an ORPHAN → the
 * destructive reclaim sweep would hard-delete it + purge its object (broken
 * published content, irreversible loss), and the delete confirm showed "0
 * references". This pins that a body-referenced media is:
 *   - NOT listed as an orphan (listOrphans / countOrphans),
 *   - returned by listReferencedMediaIds (the destructive-sweep guard),
 *   - counted by countMediaReferences (the delete-confirm warning),
 * and that the match is on the storage-key BASE so it catches the VARIANT key
 * the editor inlined (body references `.webp`; the row's primary is `.jpg`).
 *
 * ALSO covers editorial value-prop CUSTOM ICONS (`value_props` jsonb
 * `iconMediaId` on categories/brands — valuePropIconMatch): same
 * data-loss class (no `*_media_id` column), so a média referenced only there
 * must be orphan-excluded, sweep-guarded and counted.
 *
 * Self-cleaning (`zztest-bodyref-`). Run (isolated DB only):
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… pnpm exec tsx --conditions=react-server \
 *     --env-file-if-exists=.env.local src/lib/db/tests/media-body-references.test.ts
 */
import { randomUUID } from "node:crypto";

import { eq, inArray, like } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { blog_posts } from "@/modules/blog/schema";
import { brands } from "@/modules/catalog/brand/schema";
import { categories } from "@/modules/catalog/category/schema";
import { countMediaReferences, listOrphans, listReferencedMediaIds } from "@/modules/media/queries";
import { media } from "@/modules/media/schema";
import { site_settings } from "@/modules/cms/setting/schema";

// Every operator-controlled landing that renders a "Réassurance" trust editor
// (ValuePropsEditor name="trust") persists a JSON-array of {icon,iconMediaId,...}
// under its own settings key. Custom trust icons on ANY of these must be tracked
// (HIGH data-loss class — see landingTrustIconMatch / LANDING_TRUST_KEYS).
const TRUST_KEYS = [
  "storefront.boutique_landing.trust",
  "pages.marques.trust",
] as const;

const TAG = "zztest-bodyref-";
const UNCAPPED = 1_000_000;

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

async function cleanup() {
  await db.delete(blog_posts).where(like(blog_posts.slug, `${TAG}%`));
  await db.delete(brands).where(like(brands.slug, `${TAG}%`));
  await db.delete(categories).where(like(categories.slug, `${TAG}%`));
  await db.delete(media).where(like(media.filename, `${TAG}%`));
  await db.delete(site_settings).where(inArray(site_settings.key, [...TRUST_KEYS]));
}

async function main() {
  await cleanup();
  try {
    // A media whose primary variant is a JPEG; body will reference its WEBP.
    const base = `products/${randomUUID()}-${TAG}shot`;
    const [m] = await db
      .insert(media)
      .values({
        storage_key: `${base}.jpg`,
        url: `/cdn/${base}.jpg`,
        webp_url: `/cdn/${base}.webp`,
        filename: `${TAG}${randomUUID().slice(0, 8)}.jpg`,
        mime_type: "image/jpeg",
        size_bytes: 1234,
      })
      .returning({ id: media.id });

    // Unreferenced to start.
    {
      const orphans = await listOrphans(UNCAPPED);
      const refs = await listReferencedMediaIds([m.id]);
      check("baseline: unreferenced media IS an orphan", orphans.some((o) => o.id === m.id));
      check("baseline: listReferencedMediaIds does NOT return it", !refs.has(m.id));
      check("baseline: countMediaReferences = 0", (await countMediaReferences(m.id)) === 0);
    }

    // Publish a blog post whose body inlines the media's WEBP variant /cdn URL.
    await db.insert(blog_posts).values({
      slug: `${TAG}${randomUUID().slice(0, 8)}`,
      title: "ZZ body-ref test",
      body: `<p>Intro</p><img src="/cdn/${base}.webp" alt="" /><p>Outro</p>`,
    } as never);

    {
      const orphans = await listOrphans(UNCAPPED);
      const refs = await listReferencedMediaIds([m.id]);
      check("after inline use: media is NO LONGER an orphan", !orphans.some((o) => o.id === m.id));
      check("after inline use: listReferencedMediaIds returns it (sweep-safe)", refs.has(m.id));
      check("after inline use: countMediaReferences > 0 (delete warns)", (await countMediaReferences(m.id)) > 0);
    }

    // brands.editorial_body uses the SAME rich-text editor (inline /cdn <img>
    // allowed), so a media referenced ONLY there must also be tracked — a real
    // orphan-purge data-loss gap if omitted.
    for (const which of ["brand"] as const) {
      const eb = `products/${randomUUID()}-${TAG}${which}`;
      const [mb] = await db
        .insert(media)
        .values({
          storage_key: `${eb}.jpg`,
          url: `/cdn/${eb}.jpg`,
          avif_url: `/cdn/${eb}.avif`,
          filename: `${TAG}${randomUUID().slice(0, 8)}.jpg`,
          mime_type: "image/jpeg",
          size_bytes: 1234,
        })
        .returning({ id: media.id });
      const slug = `${TAG}${randomUUID().slice(0, 8)}`;
      const bodyHtml = `<p>x</p><img src="/cdn/${eb}.avif" alt="" />`;
      await db.insert(brands).values({ slug, name: "ZZ brand", editorial_body: bodyHtml } as never);
      const orphans = await listOrphans(UNCAPPED);
      const refs = await listReferencedMediaIds([mb.id]);
      check(`${which} editorial_body inline media is NOT an orphan`, !orphans.some((o) => o.id === mb.id));
      check(`${which} editorial_body inline media is sweep-guarded`, refs.has(mb.id));
      check(`${which} editorial_body inline media count > 0`, (await countMediaReferences(mb.id)) > 0);
    }

    // Editorial value-prop CUSTOM ICON (value_props jsonb `iconMediaId`) on
    // categories / brands — a média referenced ONLY as a value-prop icon (no
    // *_media_id column) must be tracked, or the reclaim sweep hard-deletes an
    // in-use icon and the delete confirm shows 0 refs.
    for (const which of ["category", "brand"] as const) {
      const vb = `products/${randomUUID()}-${TAG}${which}vp`;
      const [mv] = await db
        .insert(media)
        .values({
          storage_key: `${vb}.jpg`,
          url: `/cdn/${vb}.jpg`,
          filename: `${TAG}${randomUUID().slice(0, 8)}.jpg`,
          mime_type: "image/jpeg",
          size_bytes: 1234,
        })
        .returning({ id: media.id });
      const slug = `${TAG}${randomUUID().slice(0, 8)}`;
      // A value-prop card whose ONLY link to this media is the custom iconMediaId.
      const vp = [{ icon: "", iconMediaId: mv.id, title: "Carte", body: "Texte" }];
      if (which === "category") {
        await db.insert(categories).values({ slug, name: "ZZ cat vp", value_props: vp } as never);
      } else {
        await db.insert(brands).values({ slug, name: "ZZ brand vp", value_props: vp } as never);
      }
      const orphans = await listOrphans(UNCAPPED);
      const refs = await listReferencedMediaIds([mv.id]);
      check(`${which} value-prop icon media is NOT an orphan`, !orphans.some((o) => o.id === mv.id));
      check(`${which} value-prop icon media is sweep-guarded`, refs.has(mv.id));
      check(`${which} value-prop icon media count > 0`, (await countMediaReferences(mv.id)) > 0);
    }

    // Landing TRUST-CARD custom icon (settings-JSON `iconMediaId`) on EACH
    // operator-controlled landing (boutique / marques — HIGH data-loss class).
    // A média referenced ONLY there (no *_media_id column, no value_props table)
    // must be orphan-excluded, sweep-guarded and counted — else the reclaim sweep
    // purges an in-use trust icon and the delete confirm shows 0 refs. Parametrized
    // so a newer landing's trust key can't silently regress (the boutique-only test
    // previously masked the marques gap).
    for (const trustKey of TRUST_KEYS) {
      const tb = `settings/${randomUUID()}-${TAG}trust`;
      const [mt] = await db
        .insert(media)
        .values({
          storage_key: `${tb}.jpg`,
          url: `/cdn/${tb}.jpg`,
          filename: `${TAG}${randomUUID().slice(0, 8)}.jpg`,
          mime_type: "image/jpeg",
          size_bytes: 1234,
        })
        .returning({ id: media.id });
      await db.insert(site_settings).values({
        key: trustKey,
        value: JSON.stringify([{ icon: "", iconMediaId: mt.id, title: "Livraison", body: "48h" }]),
        label: `test ${trustKey}`,
      } as never);
      const orphans = await listOrphans(UNCAPPED);
      const refs = await listReferencedMediaIds([mt.id]);
      check(`${trustKey} trust-icon media is NOT an orphan`, !orphans.some((o) => o.id === mt.id));
      check(`${trustKey} trust-icon media is sweep-guarded`, refs.has(mt.id));
      check(`${trustKey} trust-icon media count > 0`, (await countMediaReferences(mt.id)) > 0);
      // A corrupt (non-array) settings value must not crash the scan (22P02 guard).
      await db.update(site_settings).set({ value: "not-json" }).where(eq(site_settings.key, trustKey));
      let scanned = true;
      try {
        await countMediaReferences(mt.id);
        await listOrphans(UNCAPPED);
      } catch {
        scanned = false;
      }
      check(`corrupt ${trustKey} value does not crash the reference scan`, scanned);
    }

    // A media NOT referenced by any body stays an orphan (no false positive).
    const otherBase = `products/${randomUUID()}-${TAG}unused`;
    const [m2] = await db
      .insert(media)
      .values({
        storage_key: `${otherBase}.jpg`,
        url: `/cdn/${otherBase}.jpg`,
        filename: `${TAG}${randomUUID().slice(0, 8)}.jpg`,
        mime_type: "image/jpeg",
        size_bytes: 1234,
      })
      .returning({ id: media.id });
    {
      const refs = await listReferencedMediaIds([m2.id]);
      check("a different unused media is not falsely body-referenced", !refs.has(m2.id));
      check("…and its count stays 0", (await countMediaReferences(m2.id)) === 0);
    }
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

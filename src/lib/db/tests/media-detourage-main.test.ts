import "server-only";

/**
 * MAIN-image détourage (the product_white_bg_main_only path). Storage-free:
 *   1. resolveProductMainMediaId picks the product's CANONICAL cover — is_primary
 *      first, then the lowest display_order — so détourage never cleans the wrong
 *      gallery image when a non-first image is marked primary.
 *   2. detourageProductMainImage no-ops (returns false, no S3) for media that is
 *      NOT a product image, or already on a `-nobg` key — the eligibility gate.
 *
 * Self-cleaning (`zztest-dm-`). Run (isolated DB only):
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… pnpm exec tsx --conditions=react-server \
 *     --env-file-if-exists=.env.local src/lib/db/tests/media-detourage-main.test.ts
 */
import { randomUUID } from "node:crypto";

import { inArray, like } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { product_media } from "@/associations/product-media";
import { products } from "@/modules/catalog/product/schema";
import { media } from "@/modules/media/schema";
import { detourageProductMainImage } from "@/workflows/media/reprocess-product-white-bg";
import { resolveProductMainMediaId } from "@/events/subscribers/detourage-main-image";

const TAG = "zztest-dm-";
let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const productIds: string[] = [];

async function cleanup() {
  if (productIds.length) {
    await db.delete(product_media).where(inArray(product_media.product_id, productIds));
    await db.delete(products).where(inArray(products.id, productIds));
  }
  await db.delete(media).where(like(media.filename, `${TAG}%`));
}

async function mkMedia(key: string): Promise<string> {
  const [m] = await db
    .insert(media)
    .values({
      storage_key: key,
      url: `/cdn/${key}`,
      filename: `${TAG}${randomUUID().slice(0, 8)}.jpg`,
      mime_type: "image/jpeg",
      size_bytes: 1000,
    })
    .returning({ id: media.id });
  return m.id;
}

async function mkProduct(): Promise<string> {
  const [p] = await db
    .insert(products)
    .values({ slug: `${TAG}${randomUUID().slice(0, 8)}`, name: `${TAG} p`, price_cents: 1000 } as never)
    .returning({ id: products.id });
  productIds.push(p.id);
  return p.id;
}

async function main() {
  await cleanup();
  try {
    // ── 1. cover selection: is_primary beats display_order.
    const productId = await mkProduct();
    const a = await mkMedia(`products/${randomUUID()}-${TAG}a.jpg`); // display_order 0
    const b = await mkMedia(`products/${randomUUID()}-${TAG}b.jpg`); // display_order 1, PRIMARY
    const c = await mkMedia(`products/${randomUUID()}-${TAG}c.jpg`); // display_order 2
    await db.insert(product_media).values([
      { product_id: productId, media_id: a, is_primary: false, display_order: 0 },
      { product_id: productId, media_id: b, is_primary: true, display_order: 1 },
      { product_id: productId, media_id: c, is_primary: false, display_order: 2 },
    ]);
    const picked = await resolveProductMainMediaId(productId);
    check("main image = the is_primary one (not display_order 0)", picked === b);

    // No primary flag → falls back to the lowest display_order.
    const p2 = await mkProduct();
    const d = await mkMedia(`products/${randomUUID()}-${TAG}d.jpg`);
    const e = await mkMedia(`products/${randomUUID()}-${TAG}e.jpg`);
    await db.insert(product_media).values([
      { product_id: p2, media_id: e, is_primary: false, display_order: 1 },
      { product_id: p2, media_id: d, is_primary: false, display_order: 0 },
    ]);
    check("no is_primary → lowest display_order wins", (await resolveProductMainMediaId(p2)) === d);

    // A product with no gallery → null.
    check("no gallery → null", (await resolveProductMainMediaId(await mkProduct())) === null);

    // ── 2. eligibility no-ops (return false, no S3 touched).
    const orphanMedia = await mkMedia(`products/${randomUUID()}-${TAG}orphan.jpg`); // not linked to any product
    check("non-product media → détourage no-op (false)", (await detourageProductMainImage(orphanMedia, null)) === false);

    const nobgProduct = await mkProduct();
    const nobg = await mkMedia(`products/${randomUUID()}-${TAG}x-nobg.jpg`); // already détouré key
    await db.insert(product_media).values({ product_id: nobgProduct, media_id: nobg, is_primary: true, display_order: 0 });
    check("already -nobg media → détourage no-op (false)", (await detourageProductMainImage(nobg, null)) === false);
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

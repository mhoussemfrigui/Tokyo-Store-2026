import "server-only";

import { z } from "zod";

import { productService } from "@/modules/catalog/product/service";
import {
  listVariantsForProduct,
  listVariantValueLinks,
} from "@/modules/catalog/product/queries";
import { attributeService } from "@/modules/catalog/attribute/service";
import { careService } from "@/modules/catalog/care/service";
import { faqService } from "@/modules/cms/faq/service";
import {
  productBrandLink,
  productCategoryLinks,
  productMediaLink,
  productRelatedLinks,
  productComplementaryLinks,
} from "@/associations/catalog.service";
import { bus } from "@/events/bus";
import { db } from "@/lib/db/client";
import { checkSlugAvailability } from "@/lib/utils/slug-conflict";
import { fail, ok, workflow } from "../shared";

/**
 * Duplicate an existing product as a fresh draft.
 *
 * COPIES: the core row (name + " (copie)", new slug, draft status),
 * category / brand / media links, attribute assignments, the full VARIANT set
 * (each as a fresh row so a `variable` copy is sellable — variant ids are NOT
 * reused, so cart/order references to the source never bleed into the copy),
 * the "Vous aimerez aussi" mode + curated related-products list, and the Tokyo
 * Care per-product overrides (force include/exclude + price).
 *
 * DOES NOT COPY: SKU / GTIN (must stay unique — re-entered by the admin), the
 * canonical URL (URL-specific — a duplicate must not inherit the source's) and
 * the ON-HAND STOCK (the source's physical units): a tracked product/variant
 * copy starts at 0 / out of stock, an untracked one stays untracked.
 *
 * Always lands as `is_published = false` so admins can edit before going
 * live. Emits `product.created` so subscribers (audit, cache) see it the
 * same way they'd see a fresh entry.
 *
 * Slug derivation loops `-copie`, `-copie-2`, … with a generous cap; the
 * admin can override the slug afterwards.
 */
export const duplicateProductSchema = z.object({
  productId: z.string().uuid(),
});

export const duplicateProductWorkflow = workflow<
  [z.input<typeof duplicateProductSchema>, { actorUserId: string }],
  /** `stockReset` = the source tracked stock (product or any variant), so the
   *  copy's quantities were reset to 0 — the action tells the operator. */
  { productId: string; slug: string; stockReset: boolean }
>("product.duplicate", async (input, { actorUserId }) => {
  const parsed = duplicateProductSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  const source = await productService.findById(parsed.data.productId);
  if (!source) return fail("not_found", "Produit introuvable.");

  // Derive a unique slug suffix. Generous cap — admin retries are cheap.
  // Use the cross-namespace `checkSlugAvailability` (not the products-only
  // `findBySlug`) so the duplicate's slug can't collide with a category /
  // brand / page / reserved route — the same guard the /[slug] resolver
  // relies on for unambiguous resolution.
  let candidateSlug = `${source.slug}-copie`;
  for (let i = 2; i < 50; i++) {
    const availability = await checkSlugAvailability(candidateSlug);
    if (availability.ok) break;
    candidateSlug = `${source.slug}-copie-${i}`;
  }

  // Gather everything to replicate from the SOURCE up front — these reads need
  // only source.id, so the write transaction below stays tight. (Reordered so
  // the whole copy can be ONE all-or-nothing transaction; see below.)
  const [
    mediaRows,
    categoryLinkRows,
    brandId,
    valueIds,
    scalars,
    relatedIds,
    complementaryIds,
    sourceVariants,
    careRows,
    faqRows,
  ] = await Promise.all([
      productMediaLink.list(source.id),
      productCategoryLinks.listForProduct(source.id),
      productBrandLink.findBrandId(source.id),
      attributeService.listValueIdsForProduct(source.id),
      attributeService.getScalarsForProduct(source.id),
      productRelatedLinks.listForProduct(source.id),
      productComplementaryLinks.listForProduct(source.id),
      listVariantsForProduct(source.id),
      // Tokyo Care per-product overrides (include/exclude + price). Read from the
      // SOURCE up front like the other associations; the write below goes through tx.
      careService.getProductCare(source.id),
      // Per-product FAQ (admin = published + draft) — first-class product content
      // the edit form loads, so the copy must carry it or it silently vanishes.
      faqService.listForAdminProduct(source.id),
    ]);
  const valueLinks = sourceVariants.length
    ? await listVariantValueLinks(sourceVariants.map((v) => v.id))
    : new Map<string, string[]>();

  // All-or-nothing: insert the copy + replicate EVERY association in one
  // transaction so a mid-sequence failure can't leave an orphaned partial draft
  // (mirrors create-product). `product.created` is emitted only after commit, so
  // subscribers never see a half-wired copy.
  const copy = await db.transaction(async (tx) => {
  const copyRow = await productService.insert({
    slug: candidateSlug,
    name: `${source.name} (copie)`,
    platform: source.platform,
    sku: null, // SKUs are unique by convention — admin re-enters one
    gtin: null, // GTIN is a globally-unique barcode — never duplicate it
    mpn: source.mpn, // manufacturer part number can legitimately repeat
    condition: source.condition, // état carries over to the copy
    warranty_months: source.warranty_months,
    warranty_label: source.warranty_label,
    tax_rate_bps: source.tax_rate_bps, // preserve the per-product VAT override
    is_discountable: source.is_discountable,
    product_type: source.product_type,
    // Carry the explicit SHARED/PER-VARIANT stock-mode override (or NULL=inherit)
    // verbatim — without this a SHARED variable product silently flips to
    // per-variant stock on the copy when the global default differs.
    shared_variant_stock: source.shared_variant_stock,
    short_desc: source.short_desc,
    description: source.description,
    highlights: source.highlights,
    price_cents: source.price_cents,
    old_price_cents: source.old_price_cents,
    currency: source.currency,
    // On-hand stock belongs to the SOURCE's physical units — copying it would
    // publish phantom sellable units under the new listing. A tracked source's
    // copy starts tracked at 0 / out of stock (the admin enters the real count);
    // an untracked source's copy stays untracked with the same availability.
    in_stock: source.stock_qty === null ? source.in_stock : false,
    stock_qty: source.stock_qty === null ? null : 0,
    // Per-product purchase-quantity limits are a policy of the product, not of
    // any one listing — carry them so a copy enforces the same min/max the
    // source did (create/update both persist these; omitting them silently
    // reset the copy to "no limit").
    min_purchase_qty: source.min_purchase_qty,
    max_purchase_qty: source.max_purchase_qty,
    // Pre-order configuration is a product POLICY (like warranty / purchase limits),
    // not physical stock — carry it so a duplicated pre-order listing stays a
    // pre-order with the same planned release date + customer message. `reserved_qty`
    // is a LIVE reservation counter tied to the source's units, so it is intentionally
    // NOT copied — the copy starts with zero reservations (schema default).
    is_preorder: source.is_preorder,
    preorder_releases_at: source.preorder_releases_at,
    preorder_message: source.preorder_message,
    video_url: source.video_url,
    video_poster_media_id: source.video_poster_media_id,
    video_title: source.video_title,
    video_description: source.video_description,
    meta_title: source.meta_title,
    meta_description: source.meta_description,
    // Canonical is URL-specific — a duplicate must NOT inherit the source's
    // canonical (that would point the copy back at the original). Start clean.
    canonical_url: null,
    noindex: source.noindex,
    og_image_media_id: source.og_image_media_id,
    // Official-URL sameAs describes the SAME real-world product, so a duplicate
    // (e.g. a regional/variant copy) legitimately inherits it.
    same_as: source.same_as,
    display_order: source.display_order,
    related_mode: source.related_mode, // carry over the "Vous aimerez aussi" mode
    is_published: false, // always start a duplicate as a draft
    published_at: null,
  }, tx);

    // ── replicate associations (all threaded through `tx`) ────────────────
    if (mediaRows.length) {
      await productMediaLink.set(
        copyRow.id,
        mediaRows.map((m) => m.media_id),
        mediaRows.find((m) => m.is_primary)?.media_id,
        tx,
      );
    }
    if (categoryLinkRows.length) {
      const primaryCat = categoryLinkRows.find((c) => c.is_primary)?.category_id;
      await productCategoryLinks.set(
        copyRow.id,
        categoryLinkRows.map((c) => c.category_id),
        primaryCat,
        tx,
      );
    }
    if (brandId) await productBrandLink.set(copyRow.id, brandId, tx);

    if (valueIds.length) await attributeService.setProductAttributeValues(copyRow.id, valueIds, tx);

    // Per-product SCALARS (number/text attributes) — same first-class attribute
    // data as the value assignments above (otherwise e.g. "Stockage: 256 Go"
    // silently vanishes on duplicate).
    for (const s of scalars) {
      await attributeService.setScalar(
        copyRow.id,
        s.attribute_id,
        { numericValue: s.numeric_value, textValue: s.text_value },
        tx,
      );
    }

    // Curated "Vous aimerez aussi" list (manual/ai modes). The copy's own id
    // can't appear in the source's list, and set() self-filters, so this is safe.
    if (relatedIds.length) await productRelatedLinks.set(copyRow.id, relatedIds, tx);

    // Curated "Accessoires supplémentaires" list (manual-only). Same self-filter
    // safety as the related list above.
    if (complementaryIds.length) await productComplementaryLinks.set(copyRow.id, complementaryIds, tx);

    // Tokyo Care per-product overrides (force include/exclude + optional price) —
    // first-class product data (create-product persists it, the edit form loads
    // it), so the copy must carry it too or it silently reverts to bare
    // category-scope inheritance. ProductCareRow → ProductCareInput.
    if (careRows.length) {
      await careService.setProductCareForProduct(
        copyRow.id,
        careRows.map((c) => ({
          carePlanId: c.care_plan_id,
          mode: c.mode as "include" | "exclude",
          overridePriceCents: c.override_price_cents,
        })),
        tx,
      );
    }

    // Per-product FAQ — carried so a duplicate keeps its « Questions fréquentes »
    // (the copy has none yet, so insert, don't replace). Threaded through tx.
    if (faqRows.length) {
      await faqService.insertForProductInTx(
        tx,
        copyRow.id,
        faqRows.map((f) => ({
          question: f.question,
          answer: f.answer,
          displayOrder: f.display_order,
          isPublished: f.is_published,
        })),
      );
    }

    // Variant matrix — each source variant becomes a NEW row (id omitted →
    // insert) carrying its attribute-value combination; SKU/GTIN reset to null
    // (must stay unique). replaceVariants runs the inserts + value links in tx.
    if (sourceVariants.length) {
      await productService.replaceVariants(
        copyRow.id,
        sourceVariants.map((v) => ({
          label: v.label,
          sku: null, // unique by convention — admin re-enters
          gtin: null, // globally-unique barcode — never duplicate
          mpn: v.mpn,
          priceCents: v.price_cents,
          oldPriceCents: v.old_price_cents,
          // Same stock reset as the parent row above (no phantom units).
          stockQty: v.stock_qty === null ? null : 0,
          inStock: v.stock_qty === null ? v.in_stock : false,
          imageMediaId: v.image_media_id,
          displayOrder: v.display_order,
          isDefault: v.is_default,
          attributeValueIds: valueLinks.get(v.id) ?? [],
        })),
        tx,
      );
    }

    return copyRow;
  });

  await bus.emit(
    "product.created",
    {
      productId: copy.id,
      slug: copy.slug,
      // `copy` is the inserted row. A duplicate starts with sku/gtin/external_ref
      // null (the admin re-enters unique codes) — emit them anyway so the payload
      // shape is uniform across every product.created emitter.
      sku: copy.sku,
      gtin: copy.gtin,
      externalRef: copy.external_ref,
    },
    { actorUserId },
  );
  const stockReset = source.stock_qty !== null || sourceVariants.some((v) => v.stock_qty !== null);
  return ok({ productId: copy.id, slug: copy.slug, stockReset });
});

import "server-only";

import { getProductBySlug as backendGetProductBySlug } from "@/lib/api/products";
import { minorToDinars } from "@/lib/price";
import { getProductSpecs } from "@/modules/catalog/attribute/queries";
import { attributeService } from "@/modules/catalog/attribute/service";
import { faqService } from "@/modules/cms/faq/service";
import { getProductReviewSummary, listProductReviews } from "@/modules/catalog/review/queries";
import { imageUrl } from "@/types/catalog";
import type {
  Product,
  ProductReview,
  ProductReviewSummary,
  ProductSpec,
  ProductVariantAxis,
  ProductVariantCombo,
} from "@/storefront/types/catalog";

/**
 * LIVE PDP detail enrichment.
 *
 * The storefront catalogue SNAPSHOT (`products.json`) is intentionally card-sized
 * — it is bundled into the client (search, rails, cart resolution) so it must not
 * carry per-product descriptions, galleries, characteristics or variants. The flat
 * `/[slug]` PDP is a SERVER component, so it reads the heavy detail LIVE from the
 * backend (RSC) for the one product being viewed and passes it as props. Benefits:
 * the client bundle stays small, and admin edits to the description / caractéristiques
 * / gallery / variants appear on the PDP immediately with no `tokyo-export-catalog` run.
 *
 * Returns the subset of `Product` detail fields (all optional on the DTO), or an
 * empty object when the live product can't be resolved — the PDP then still renders
 * from the snapshot card + derived helpers (graceful, never throws).
 *
 * Covers EVERY attribute kind (Catalogue → Attributs): value-list kinds
 * (select / multiselect / color / boolean) and scalar kinds (number / text). Colour
 * values carry a swatch hex; variation axes render as swatches (colour) or labelled
 * pills (everything else); non-axis attributes populate the "Caractéristiques" grid.
 */
export type ProductDetail = Pick<
  Product,
  | "images"
  | "imagesAlt"
  | "imageAlt"
  | "shortDesc"
  | "description"
  | "warranty"
  | "warrantyMonths"
  | "minPurchaseQty"
  | "maxPurchaseQty"
  | "productType"
  | "brandSlug"
  | "highlights"
  | "specs"
  | "variantAxes"
  | "variantCombos"
  // Video — the full admin "Vidéo produit" tab (url + poster + alt + title + caption),
  // so the PDP can render a player AND emit a VideoObject. Previously only `videoUrl`
  // crossed the bridge, so the PDP had no poster/title/caption to render.
  | "videoUrl"
  | "videoPoster"
  | "videoPosterAlt"
  | "videoTitle"
  | "videoDescription"
  // Per-product FAQ (admin Catalogue → Produits → FAQ) — the PDP + its FAQPage JSON-LD
  // now read the REAL operator-authored Q/A instead of a hardcoded templated set.
  | "faq"
  // SEO overrides (admin SEO tab) the backend DTO resolves but the bridge dropped:
  // merchant identifiers + canonical/noindex/ogImage/sameAs for metadata + Product LD.
  | "gtin"
  | "mpn"
  | "canonicalUrl"
  | "noindex"
  | "sameAs"
  | "ogImage"
  | "publishedAt"
  // LIVE review aggregate — overlays the snapshot card's rating/reviews (which the
  // export bakes in and can be stale/zero) so the on-page stars + JSON-LD match the
  // backend's maintained products.rating / reviews_count.
  | "rating"
  | "reviews"
> & {
  /** Published reviews (approved, newest first) for the "Avis clients" section. */
  reviewItems?: ProductReview[];
  /** Headline average + count + per-star distribution for the reviews header. */
  reviewSummary?: ProductReviewSummary;
};

export async function getProductDetailBySlug(slug: string): Promise<ProductDetail> {
  const bp = await backendGetProductBySlug(slug);
  if (!bp || !bp.id) return {};

  // Characteristics (all active attributes the product carries data for).
  const rawSpecs = await getProductSpecs(bp.id);

  // Published reviews + aggregate (approved only; newest first) + the per-product
  // FAQ. Read LIVE (not via the cached card layer) so a newly-approved review or a
  // freshly-edited FAQ shows immediately.
  const [reviewRows, reviewSummary, faqRows] = await Promise.all([
    listProductReviews(bp.id, { limit: 50 }),
    getProductReviewSummary(bp.id),
    faqService.listByProductId(bp.id).catch(() => []),
  ]);
  // Operator-authored FAQ → the storefront {q,a} shape. Empty ⇒ left undefined so the
  // PDP falls back to its generic templated set (and emits no fabricated FAQPage LD).
  const faq = faqRows
    .map((f) => ({ q: f.question.trim(), a: f.answer.trim() }))
    .filter((f) => f.q.length > 0 && f.a.length > 0);
  const reviewItems: ProductReview[] = reviewRows.map((r) => ({
    id: r.id,
    author: r.author_name,
    rating: r.rating,
    title: r.title,
    body: r.body,
    verified: r.verified_purchase,
    source: r.source,
    date: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
  }));

  // Variation axes — resolve each axis attribute's kind + each value's colour hex
  // (the DTO's variantOptions carry only {id,label}). One batched read each.
  const axisAttrIds = (bp.variantOptions ?? []).map((o) => o.attributeId);
  const axisValueIds = (bp.variantOptions ?? []).flatMap((o) => o.values.map((v) => v.id));
  const [axisAttrs, axisValues] = await Promise.all([
    axisAttrIds.length ? attributeService.findAttributesByIds(axisAttrIds) : Promise.resolve([]),
    axisValueIds.length ? attributeService.findValuesByIds(axisValueIds) : Promise.resolve([]),
  ]);
  const kindByAttr = new Map(axisAttrs.map((a) => [a.id, a.kind]));
  const hexByValue = new Map(axisValues.map((v) => [v.id, v.color_hex ?? null]));
  const axisAttrIdSet = new Set(axisAttrIds);

  const variantAxes: ProductVariantAxis[] = (bp.variantOptions ?? []).map((o) => ({
    attributeId: o.attributeId,
    name: o.name,
    kind: kindByAttr.get(o.attributeId) ?? "select",
    values: o.values.map((v) => ({
      id: v.id,
      label: v.label,
      colorHex: hexByValue.get(v.id) ?? null,
    })),
  }));

  const variantCombos: ProductVariantCombo[] = (bp.variants ?? []).map((v) => ({
    id: v.id,
    label: v.label,
    optionValueIds: v.optionValueIds ?? [],
    inStock: v.inStock,
    isDefault: v.isDefault,
    image: v.image ? imageUrl(v.image) : null,
    price: minorToDinars(v.priceCents),
  }));

  // "Caractéristiques" grid/cards — exclude the variation-axis attributes (they are
  // shown as selectors) so a value isn't listed twice.
  const specs: ProductSpec[] = rawSpecs
    .filter((s) => !axisAttrIdSet.has(s.attributeId))
    .map((s) => ({
      name: s.attributeName,
      kind: s.kind,
      values: s.values.map((val) => ({ label: val.label, colorHex: val.colorHex })),
      text: s.text,
    }));

  const images = (bp.images ?? (bp.image ? [bp.image] : []))
    .map((img) => imageUrl(img))
    .filter((u): u is string => typeof u === "string" && u.length > 0);

  return {
    images: images.length ? images : undefined,
    imagesAlt: bp.imagesAlt,
    imageAlt: bp.imageAlt,
    shortDesc: bp.shortDesc || undefined,
    description: bp.description || undefined,
    warranty: bp.warranty,
    warrantyMonths: bp.warrantyMonths,
    minPurchaseQty: bp.minPurchaseQty,
    maxPurchaseQty: bp.maxPurchaseQty,
    productType: bp.productType,
    brandSlug: bp.brandSlug,
    highlights: bp.highlights && bp.highlights.length ? bp.highlights : undefined,
    specs: specs.length ? specs : undefined,
    variantAxes: variantAxes.length ? variantAxes : undefined,
    variantCombos: variantCombos.length ? variantCombos : undefined,
    // Full video payload (url + poster + alt + title + caption) for the PDP player + VideoObject.
    videoUrl: bp.videoUrl,
    // Poster is a backend ProductImage → same-origin URL string (parallels `images`).
    videoPoster: bp.videoPoster ? imageUrl(bp.videoPoster) : null,
    videoPosterAlt: bp.videoPosterAlt,
    videoTitle: bp.videoTitle,
    videoDescription: bp.videoDescription,
    faq: faq.length ? faq : undefined,
    // SEO overrides (merchant identifiers + canonical/noindex/ogImage/sameAs + publish date).
    gtin: bp.gtin,
    mpn: bp.mpn,
    canonicalUrl: bp.canonicalUrl,
    noindex: bp.noindex,
    sameAs: bp.sameAs,
    ogImage: bp.ogImage,
    publishedAt: bp.publishedAt,
    // Live aggregate overlays the (possibly stale/zero) snapshot rating; left
    // undefined at 0 so the snapshot value stands and "not yet rated" still shows.
    rating: reviewSummary.average > 0 ? reviewSummary.average : undefined,
    reviews: reviewSummary.count > 0 ? reviewSummary.count : undefined,
    reviewItems: reviewItems.length ? reviewItems : undefined,
    reviewSummary,
  };
}

import "server-only";

import { listPublicFeedProductsPage, PLACEHOLDER_IMAGE, type ApiProduct } from "@/lib/api/products";
import { htmlToText } from "@/lib/ai/parse";
import { buildCategoryChain } from "@/lib/catalog/category-chain";
import { categoryService } from "@/modules/catalog/category/service";
import type { CategorySlimRow } from "@/modules/catalog/category/schema";
import { resolveLivePromotionRowsForProducts, type LivePromoEntry } from "@/modules/promotion";
import type { ProductVariant, ProductVariantOption } from "@/types/catalog";
import { absolutize, realImage, feedGallery } from "./images";
import type { FeedAvailability, FeedProduct } from "./types";

/**
 * Load the published catalogue and map it to the shared `FeedProduct[]` consumed
 * by BOTH feed builders (Google Merchant + ACP). Reuses the SAME `listApiProducts`
 * data layer the headless /api/products uses — never scrapes HTML. Paginated +
 * bounded so a large catalogue can't blow memory; the route caches the result
 * (ISR) so this runs on revalidation, not every request.
 */

const PAGE = 200;
const MAX_PRODUCTS = 5000;

/** Prefer the social (non-AVIF) image so feeds get a JPEG/PNG/WebP, not AVIF. */
function primaryImage(p: ApiProduct, origin: string): string | null {
  return realImage(p.ogImage || (typeof p.image === "string" ? p.image : null), origin, PLACEHOLDER_IMAGE);
}

/**
 * Map a product/variant's stock state to the feed vocabulary, MIRRORING the
 * storefront `stockState` (src/storefront/lib/productMeta.ts): a pre-order
 * (`availability === "backorder"`) stays `backorder` — the product is orderable,
 * it just ships later — and must never collapse to `out_of_stock` (the PDP
 * JSON-LD Offer already maps it to schema.org/BackOrder, so the feed now agrees).
 * Falls back to the `inStock` boolean when the source carries no explicit
 * availability string, so simple in/out rows are unaffected. The optional
 * `availability` field is read structurally, so the backorder arm activates the
 * moment the catalogue DTO surfaces a three-state availability.
 */
function availabilityOf(src: { inStock: boolean; availability?: string | null }): FeedAvailability {
  if (src.availability === "backorder") return "backorder";
  if (src.availability === "in_stock") return "in_stock";
  if (src.availability === "out_of_stock") return "out_of_stock";
  return src.inStock ? "in_stock" : "out_of_stock";
}

/** Resolve a variant's option-value ids to a {axisName: valueLabel} dict. */
function variantDict(
  v: ProductVariant,
  options: ProductVariantOption[] | undefined,
): Record<string, string> {
  const dict: Record<string, string> = {};
  for (const opt of options ?? []) {
    const val = opt.values.find((x) => v.optionValueIds.includes(x.id));
    if (val) dict[opt.name] = val.label;
  }
  return dict;
}

/** Regular price = the strike-through `oldPrice` when set above the current
 *  price; the current price then becomes the sale_price. Otherwise no sale. */
function priceSplit(priceCents: number, oldPriceCents: number | null | undefined): {
  price: number;
  sale: number | null;
} {
  if (oldPriceCents != null && oldPriceCents > priceCents) {
    return { price: oldPriceCents, sale: priceCents };
  }
  return { price: priceCents, sale: null };
}

/** Per-product data resolved by the loader (DB reads batched there, not per row). */
type FeedContext = {
  /** Full breadcrumb category path "A > B > C" for `g:product_type`, or null. */
  categoryPath: string | null;
  /** The active fixed-window promo window governing the sale price, or null. */
  saleWindow: { start: string; end: string } | null;
};

function toFeedProducts(p: ApiProduct, origin: string, ctx: FeedContext): FeedProduct[] {
  const img = primaryImage(p, origin);
  if (!img) return []; // a feed item REQUIRES an image — skip imageless products
  // ALWAYS the product's own PDP — never its `canonicalUrl` override: the item's
  // id / title / price / availability are THIS product's, so a link to the master
  // URL a duplicate is canonicalised onto lands the shopper (and Merchant
  // Center's landing-page check) on a different product.
  const url = absolutize(`/${p.slug}`, origin);
  if (!url) return [];
  const description = htmlToText(p.description || p.shortDesc, 5000);
  const condition = p.condition ?? "new";
  const brand = p.brand || null;
  // g:product_type = the FULL taxonomy breadcrumb (root → leaf), matching the PDP
  // crumb; falls back to the single primary-category name when no chain resolves.
  const categoryPath = ctx.categoryPath ?? p.categoryName ?? null;
  // Feeds must avoid AVIF (Google Merchant / ACP reject it). Use the AVIF-avoiding
  // social gallery (parallel to `images`); fall back to `images` only if it's
  // absent (older cached rows), matching the AVIF-avoiding `img` primary above.
  const gallery = feedGallery(p.imagesSocial ?? p.images ?? [], origin, img, PLACEHOLDER_IMAGE);
  const reviewCount = p.reviews || null;
  const starRating = p.rating || null;

  // Précommande (product-level): the catalog mapper sets availability="backorder"
  // for an ACTIVE preorder. A DATED preorder maps to the feed's "preorder" +
  // availability_date (Google separates it from backorder = released-but-OOS); an
  // undated one stays "backorder". Overrides the per-row stock state for every row
  // of the product (variants of a preorder product are preorder too).
  const productPreorder = p.availability === "backorder";
  const preorderDate =
    productPreorder && p.preorderReleasesAt ? isoNoMs(new Date(p.preorderReleasesAt)) : null;
  const resolveAvailability = (base: FeedAvailability): FeedAvailability =>
    productPreorder ? (preorderDate ? "preorder" : "backorder") : base;

  if (p.productType === "variable" && p.variants && p.variants.length > 0) {
    return p.variants.map((v) => {
      const availability = resolveAvailability(availabilityOf(v));
      const { price, sale } = priceSplit(v.priceCents, v.oldPriceCents);
      // The variant's own image becomes this row's primary; dedupe the shared
      // gallery against THAT (not just the product-level `img`) so the primary
      // never re-appears as an additional_image_link for the variant.
      // AVIF-avoiding variant image for the row's primary image_link (falls back
      // to the display image, then the product primary).
      const rowImg =
        realImage(v.imageSocial ?? v.image, origin, PLACEHOLDER_IMAGE) || img;
      const rowGallery = rowImg === img ? gallery : gallery.filter((u) => u !== rowImg);
      return {
        id: `${p.id}_${v.id}`,
        groupId: p.id,
        title: `${p.name} — ${v.label}`,
        description,
        url,
        imageUrl: rowImg,
        additionalImageUrls: rowGallery,
        priceMinor: price,
        salePriceMinor: sale,
        // The promo window only qualifies the sale price — never attach it to a
        // row that carries no sale (it would describe a price that isn't there).
        salePriceEffective: sale != null ? ctx.saleWindow : null,
        availability,
        availabilityDate: preorderDate,
        condition,
        brand,
        gtin: v.gtin || null,
        mpn: v.sku || p.mpn || p.sku || null,
        categoryPath,
        variant: variantDict(v, p.variantOptions),
        reviewCount,
        starRating,
      } satisfies FeedProduct;
    });
  }

  const availability = resolveAvailability(availabilityOf(p));
  const { price, sale } = priceSplit(p.priceCents, p.oldPriceCents);
  return [
    {
      id: p.id,
      title: p.name,
      description,
      url,
      imageUrl: img,
      additionalImageUrls: gallery,
      priceMinor: price,
      salePriceMinor: sale,
      salePriceEffective: sale != null ? ctx.saleWindow : null,
      availability,
      availabilityDate: preorderDate,
      condition,
      brand,
      gtin: p.gtin || null,
      mpn: p.mpn || p.sku || null,
      categoryPath,
      reviewCount,
      starRating,
    } satisfies FeedProduct,
  ];
}

/** `YYYY-MM-DDThh:mm:ssZ` — ISO-8601 without the millisecond fraction, the form
 *  Google accepts for a `g:sale_price_effective_date` interval endpoint. */
function isoNoMs(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Walk the product's deepest known category (its primary category — `subcategory`
 * when the primary has a parent, else the top-hop `category`) UP to the root and
 * join the names root → leaf, so `g:product_type` carries the full taxonomy path
 * ("Montres > Homme > Plongée") the PDP breadcrumb shows — not just the top hop.
 * Pure: resolves against the one-shot category index the loader built.
 */
function categoryPathFor(
  leafSlug: string | null | undefined,
  bySlug: ReadonlyMap<string, CategorySlimRow>,
  byId: ReadonlyMap<string, CategorySlimRow>,
): string | null {
  if (!leafSlug) return null;
  const leaf = bySlug.get(leafSlug);
  if (!leaf) return null;
  const chain = buildCategoryChain(leaf.id, byId); // child → root
  if (chain.length === 0) return null;
  return chain
    .map((c) => c.name)
    .reverse() // root → leaf
    .join(" > ");
}

/**
 * The active fixed-window promo window per product id for this page, batched via
 * the SAME resolver the PDP/cart price through (`resolveLivePromotionRowsForProducts`,
 * which only returns currently-LIVE auto promos). A "fixed window" = a promo with
 * BOTH a start and an end — the head (highest-priority) such promo governs the
 * sale-price window. Open-ended promos / merchandiser compare-ats get no window.
 */
async function loadActivePromoWindows(
  products: readonly ApiProduct[],
): Promise<Map<string, { start: string; end: string }>> {
  const windows = new Map<string, { start: string; end: string }>();
  const ids = products.map((p) => p.id).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return windows;
  const entries = await resolveLivePromotionRowsForProducts(ids).catch(
    () => new Map<string, LivePromoEntry>(),
  );
  for (const [id, entry] of entries) {
    if (!entry.discountable) continue;
    // A PRICE-discounting promo with BOTH a start and an end governs the sale
    // window. Skip open-ended promos and free-shipping-only promos (discount_value
    // 0) — neither defines a price-valid-until window for the sale_price.
    const fixed = entry.rows.find(
      (r) => r.starts_at != null && r.ends_at != null && r.discount_value > 0,
    );
    if (fixed?.starts_at && fixed.ends_at) {
      windows.set(id, { start: isoNoMs(fixed.starts_at), end: isoNoMs(fixed.ends_at) });
    }
  }
  return windows;
}

export async function loadFeedProducts(origin: string): Promise<FeedProduct[]> {
  const out: FeedProduct[] = [];
  let capped = false;
  // ONE-SHOT category index (the tree is small) — used to resolve every product's
  // full breadcrumb path in memory, so g:product_type costs no per-product query.
  const catRows = await categoryService.listAllSlim().catch((): CategorySlimRow[] => []);
  const catById = new Map(catRows.map((c) => [c.id, c]));
  const catBySlug = new Map(catRows.map((c) => [c.slug, c]));
  for (let offset = 0; offset < MAX_PRODUCTS; offset += PAGE) {
    // PUBLIC-only: publishes the public catalogue (published products) into the
    // Google Merchant / ACP feeds. Paginate on the RAW page size so a product
    // that yields no feed row (e.g. an imageless one toFeedProducts skips) never
    // ends the loop early.
    const { products, rawCount } = await listPublicFeedProductsPage({ limit: PAGE, offset });
    const promoWindows = await loadActivePromoWindows(products);
    for (const p of products) {
      const ctx: FeedContext = {
        categoryPath: categoryPathFor(p.subcategory || p.category, catBySlug, catById),
        saleWindow: (p.id && promoWindows.get(p.id)) || null,
      };
      out.push(...toFeedProducts(p, origin, ctx));
    }
    if (rawCount < PAGE) break; // last (short) DB page → whole catalogue consumed
    if (offset + PAGE >= MAX_PRODUCTS) {
      // A full page landing exactly at the cap does NOT prove more remain — the
      // catalogue could be exactly MAX_PRODUCTS. Probe one row past the cap so
      // an exactly-at-cap catalogue isn't falsely reported as truncated.
      const { rawCount: beyond } = await listPublicFeedProductsPage({ limit: 1, offset: MAX_PRODUCTS });
      capped = beyond > 0;
    }
  }
  // No silent caps: a catalogue past MAX_PRODUCTS is truncated to the newest N,
  // so surface it in the logs rather than dropping rows invisibly.
  if (capped) {
    console.warn(
      `[feeds] catalogue exceeds MAX_PRODUCTS=${MAX_PRODUCTS}; feed truncated to the newest ${MAX_PRODUCTS} products.`,
    );
  }
  return out;
}

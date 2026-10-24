import "server-only";

import { cache } from "react";

import {
  getProductBySlug as backendGetProductBySlug,
  listApiProducts,
  listComplementaryProducts as backendListComplementary,
  listNewArrivals as backendListNewArrivals,
  listPreorderProducts as backendListPreorder,
  listProductsByCategory as backendListByCategory,
  listProductsByBrand as backendListByBrand,
  listProductsByIds as backendListByIds,
  listProductsBySlugs as backendListBySlugs,
  listPromotions as backendListPromotions,
  listRelatedProducts as backendListRelated,
} from "@/lib/api/products";
import {
  getCategoryBySlug as backendGetCategoryBySlug,
  listCategories as backendListCategories,
} from "@/lib/api/categories";
import { categoryService } from "@/modules/catalog/category/service";
import { brandQueries } from "@/modules/catalog/brand";
import { productCategoryLinks } from "@/associations/catalog.service";
import { resolveCareConfig } from "@/lib/care/config";
import { resolveOfferedCareForLines } from "@/lib/care/resolve-server";
import { withLivePromoPricing } from "@/lib/promotions/live-product-price";
import { minorToDinars } from "@/lib/price";
import { imageUrl, type Product as BackendProduct } from "@/types/catalog";
import type { Category, Product } from "@/storefront/types/catalog";

import type { CatalogSource } from "./source";

/**
 * LIVE catalogue source — reads the backend DB directly, so category listings,
 * search-hit resolution, PDP cards, cart resolution, the default home and the
 * vitrines reflect admin edits (price / stock / publish / précommande) with NO
 * `tokyo-export-catalog` re-export. Replaces the committed `products.json`
 * snapshot behind the same {@link CatalogSource} seam, so no component changes.
 *
 * It reuses the SAME backend readers + row→DTO mapping the old export script ran
 * offline (`@/lib/api/products`, `imageUrl`, `minorToDinars`, the care resolver),
 * so the storefront `Product` shape is byte-for-byte what the components already
 * consumed — only the freshness changes. Tokyo Care is resolved ONLY on the
 * single-product PDP path (cards never show it), keeping list queries cheap.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-request-memoised category chain resolver (root→leaf) for `product_type`
 *  (breadcrumb) + `category_path`. `cache()` dedupes the one `listAll` read
 *  across every product mapped within a single RSC render. */
const categoryChain = cache(async () => {
  const cats = await categoryService.listAll();
  const byId = new Map(cats.map((c) => [c.id, c]));
  const bySlug = new Map(cats.map((c) => [c.slug, c]));
  const chainOf = (slug: string): typeof cats => {
    const start = bySlug.get(slug);
    if (!start) return [];
    const chain: typeof cats = [];
    const seen = new Set<string>();
    let cur: (typeof cats)[number] | undefined = start;
    while (cur && !seen.has(cur.id)) {
      chain.unshift(cur);
      seen.add(cur.id);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return chain;
  };
  return {
    breadcrumb: (slug: string) => chainOf(slug).map((c) => c.name).join(" / "),
    chainSlugs: (slug: string) => chainOf(slug).map((c) => c.slug),
  };
});

type Chain = Awaited<ReturnType<typeof categoryChain>>;

/** Backend product → storefront card DTO (the single mapping the storefront card
 *  consumers depend on; formerly duplicated in the offline export script). */
function mapCard(p: BackendProduct, chain: Chain): Product {
  // File each product at its DEEPEST assigned category (leaf), as the export did.
  const leaf = p.subcategory ?? p.category;
  return {
    id: p.id ?? p.slug,
    sku: p.sku ?? null,
    slug: p.slug,
    title: p.name,
    link: `/${p.slug}`,
    image: imageUrl(p.image),
    price: p.price,
    oldPrice: p.oldPrice ?? null,
    currency: "TND",
    availability: p.availability ?? (p.inStock ? "in_stock" : "out_of_stock"),
    preorderReleasesAt: p.preorderReleasesAt ?? null,
    preorderMessage: p.preorderMessage ?? null,
    condition: p.condition ?? "new",
    brand: p.brand ?? "",
    category: leaf,
    product_type: chain.breadcrumb(leaf) || p.categoryName || leaf,
    rating: p.rating ?? 0,
    reviews: p.reviews ?? 0,
    metaTitle: p.metaTitle ?? null,
    metaDescription: p.metaDescription ?? null,
    category_path: chain.chainSlugs(leaf),
    care: [],
  };
}

async function mapCards(ps: BackendProduct[]): Promise<Product[]> {
  const chain = await categoryChain();
  return ps.map((p) => mapCard(p, chain));
}

/** Offered Tokyo Care plans (+ per-unit display price) for ONE product. Fails
 *  CLOSED to `[]` (feature off, non-uuid id, or any resolve error) — identical
 *  to the export + the server charge path. */
async function resolveCare(p: BackendProduct): Promise<Product["care"]> {
  return (await resolveCareForProducts([p])).get(p.id ?? "") ?? [];
}

/** Offered Tokyo Care plans for MANY products in ONE batch — the config read, the
 *  category-link lookup and the offer resolution each run ONCE for the whole set,
 *  so the client cart/favorites resolution isn't a per-item Care round-trip. Fails
 *  CLOSED to empty (feature off / non-uuid id / any error), like the single path. */
async function resolveCareForProducts(
  ps: BackendProduct[],
): Promise<Map<string, Product["care"]>> {
  const out = new Map<string, Product["care"]>();
  const withId = ps.filter((p): p is BackendProduct & { id: string } => !!p.id && UUID_RE.test(p.id));
  if (withId.length === 0) return out;
  try {
    const cfg = await resolveCareConfig();
    if (!cfg.enabled) return out;
    const catMap = await productCategoryLinks.categoryIdsForProducts(withId.map((p) => p.id));
    const offered = await resolveOfferedCareForLines(
      withId.map((p) => ({
        productId: p.id,
        productPriceCents: Math.round(p.price * 1000),
        warrantyMonths: p.warrantyMonths ?? null,
        condition: (p.condition ?? "new") as "new" | "used" | "refurbished",
        categoryIds: catMap.get(p.id) ?? [],
      })),
    );
    withId.forEach((p, i) => {
      out.set(
        p.id,
        (offered[i] ?? []).map((o) => ({
          id: o.plan.id,
          price: minorToDinars(o.unitCents),
          name: o.plan.name,
          durationMonths: o.plan.duration_months,
          perks: o.plan.perks ?? [],
        })),
      );
    });
  } catch {
    return new Map();
  }
  return out;
}

async function mapSingle(p: BackendProduct | null): Promise<Product | null> {
  if (!p) return null;
  const chain = await categoryChain();
  const card = mapCard(p, chain);
  card.care = await resolveCare(p);
  return card;
}

function mapCategory(c: { slug: string; name: string; count: number } | null): Category | null {
  return c ? { slug: c.slug, label: c.name, count: c.count } : null;
}

export const liveSource: CatalogSource = {
  async listAllProducts(): Promise<Product[]> {
    // No storefront caller today (the client typeahead has its own path); kept
    // complete for the contract — page the full published catalogue.
    const out: BackendProduct[] = [];
    for (let offset = 0; offset < 100000; ) {
      const page = await listApiProducts({ limit: 100, offset, public: true });
      if (page.length === 0) break;
      out.push(...page);
      offset += page.length;
    }
    return mapCards(out);
  },
  async getProductBySlug(slug): Promise<Product | null> {
    const p = await backendGetProductBySlug(slug);
    if (!p) return null;
    // Apply live AUTO-promotions so the PDP buy-box + cart/favorites resolution show
    // the SAME effective price the category cards, search and the checkout charge use.
    // Backend `getProductBySlug` returns the BASE DTO (no promo) by design; every LIST
    // reader (`listProductsByIds`/`ByCategory`/…) already enriches, so ONLY this by-slug
    // path missed it — which is why the cart total disagreed with the PDP it came from.
    // (Pricing Care off the now-promo `p.price` in mapSingle also matches place-order.)
    const priced =
      p.id != null
        ? await withLivePromoPricing(p, { id: p.id, price_cents: p.priceCents }).catch(() => p)
        : p;
    return mapSingle(priced);
  },
  async getProductById(id): Promise<Product | null> {
    const [p] = await backendListByIds([id]);
    return mapSingle(p ?? null);
  },
  async listProductsByCategory(categorySlug, limit): Promise<Product[]> {
    return mapCards(await backendListByCategory(categorySlug, limit));
  },
  async listProductsByIds(ids): Promise<Product[]> {
    return mapCards(await backendListByIds(ids));
  },
  async listProductsBySlugs(slugs): Promise<Product[]> {
    // ONE batched row+promo read, then ONE batched Tokyo Care resolve attached by
    // id — replaces the former getProductBySlug-per-slug fan-out (cart/favorites).
    const ps = await backendListBySlugs(slugs);
    const cards = await mapCards(ps);
    const careMap = await resolveCareForProducts(ps);
    for (const c of cards) {
      const care = careMap.get(c.id);
      if (care) c.care = care;
    }
    return cards;
  },
  async listRelatedProducts(slug, limit): Promise<Product[]> {
    return mapCards(await backendListRelated(slug, limit));
  },
  async listAlsoViewed(slug, limit): Promise<Product[]> {
    return mapCards(await backendListComplementary(slug, limit));
  },
  async listNewArrivals(limit): Promise<Product[]> {
    return mapCards(await backendListNewArrivals(limit));
  },
  async listPromotions(limit): Promise<Product[]> {
    return mapCards(await backendListPromotions(limit));
  },
  async listPreorderProducts(limit): Promise<Product[]> {
    return mapCards(await backendListPreorder(limit));
  },
  async listCategories(): Promise<Category[]> {
    return (await backendListCategories())
      .map((c) => mapCategory(c))
      .filter((c): c is Category => c !== null);
  },
  async getCategoryBySlug(slug): Promise<Category | null> {
    return mapCategory(await backendGetCategoryBySlug(slug));
  },
  async getCategoryLabel(slug): Promise<string> {
    const c = await backendGetCategoryBySlug(slug);
    return c?.name ?? slug;
  },
  async getBrandBySlug(slug): Promise<{ slug: string; name: string } | null> {
    // 404 a deactivated brand (its product reader is fail-closed too), so the
    // brand page never dangles an offline brand.
    const b = await brandQueries.getBrandBySlug(slug);
    return b && b.is_active ? { slug: b.slug, name: b.name } : null;
  },
  async listProductsByBrand(brandSlug, limit): Promise<Product[]> {
    return mapCards(await backendListByBrand(brandSlug, limit));
  },
};

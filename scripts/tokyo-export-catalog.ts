/**
 * Export the backend catalogue into the storefront's data module, so the new UI
 * (which reads `@/storefront/lib/catalog` → `src/storefront/data/*.json`) renders
 * the REAL backend catalogue in its exact design, with zero component changes.
 *
 * This is the data bridge: the UI is built around a synchronous catalogue module
 * used by its client components (header search, product rails, cart resolution)
 * AND the server facade's static source — so the single cleanest way to make it
 * "all data from the backend" without touching the design is to regenerate the
 * two JSON files it loads from the live DB. Re-run after any catalogue change
 * (import, admin edit). Prices are major-unit dinars; images are same-origin
 * `/cdn` URLs (so they load under the storefront CSP).
 *
 *   pnpm tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     scripts/tokyo-export-catalog.ts
 */
import fs from "node:fs";
import path from "node:path";

import { listApiProducts } from "@/lib/api/products";
import { categoryService } from "@/modules/catalog/category/service";
import { careService } from "@/modules/catalog/care/service";
import { resolveCareConfig } from "@/lib/care/config";
import { resolveOfferedCareForLines } from "@/lib/care/resolve-server";
import { productCategoryLinks } from "@/associations/catalog.service";
import { minorToDinars } from "@/lib/price";
import { imageUrl } from "@/types/catalog";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OUT_DIR = path.join(process.cwd(), "src/storefront/data");

type RawProduct = {
  id: string;
  /** Store product code (feed g:id, e.g. "TS-14051"); shown as the PDP reference. */
  sku: string | null;
  slug: string;
  title: string;
  link: string;
  image: string;
  price: number;
  /** Real compare-at / "was" price (dinars) when the product is genuinely
   *  discounted (stored old price or a live promotion); null otherwise. */
  oldPrice: number | null;
  currency: string;
  /** `"backorder"` = précommande (active preorder, orderable regardless of stock). */
  availability: "in_stock" | "out_of_stock" | "backorder";
  /** Précommande release instant (ISO) for a dated active preorder; null otherwise. */
  preorderReleasesAt: string | null;
  /** Operator précommande note for the PDP; null when none. */
  preorderMessage: string | null;
  condition: string;
  brand: string;
  category: string;
  product_type: string;
  /** Real backend rating + review count (0 = not yet rated). */
  rating: number;
  reviews: number;
  /** Admin SEO overrides; null falls back to title/description on the PDP. */
  metaTitle: string | null;
  metaDescription: string | null;
  /** Full category SLUG chain root→leaf (from the migration tree) — lets the
   *  storefront roll products up to any ancestor category, not just the leaf. */
  category_path: string[];
  /**
   * Offered Tokyo Care protection plans for this product, with the per-unit price
   * (dinars) resolved from the backend (category scope ∪ product include − exclude,
   * flat/percent + floors + overrides). Empty when none offered or the feature is
   * off. The plan DETAILS (name, duration, perks…) live in care-plans.json, keyed
   * by `id`. `price` is already in dinars (major unit, like `price`).
   */
  care: { id: string; price: number }[];
};

/** A care plan's presentational details, written to care-plans.json (keyed by id). */
type RawCarePlan = {
  id: string;
  name: string;
  durationMonths: number;
  perks: string[];
  icon: string | null;
  description: string | null;
};

/** A node of the nav taxonomy tree emitted to taxonomy.json. */
type TaxoNode = {
  slug: string;
  name: string;
  /** Rolled-up product count (this category + every descendant). */
  count: number;
  children: TaxoNode[];
};

async function main(): Promise<void> {
  // 1. Category tree → breadcrumb path per slug (the UI's `product_type`), used
  //    for display + the root-category fallback filter in getProductsForSlug.
  const cats = await categoryService.listAll();
  const byId = new Map(cats.map((c) => [c.id, c]));
  const bySlug = new Map(cats.map((c) => [c.slug, c]));
  /** Ancestor chain (root→leaf) of a category slug, as category rows. */
  const chainOf = (slug: string): (typeof cats)[number][] => {
    const start = bySlug.get(slug);
    if (!start) return [];
    const chain: (typeof cats)[number][] = [];
    const seen = new Set<string>();
    let cur: (typeof cats)[number] | undefined = start;
    while (cur && !seen.has(cur.id)) {
      chain.unshift(cur);
      seen.add(cur.id);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return chain;
  };
  const breadcrumb = (slug: string): string => chainOf(slug).map((c) => c.name).join(" / ");
  const chainSlugs = (slug: string): string[] => chainOf(slug).map((c) => c.slug);

  // 2. Page through every published product (full catalogue, no viewer embargo).
  //    The backend clamps page size, so advance by the ACTUAL returned count and
  //    stop only on an empty page (robust to whatever the cap is).
  const out: RawProduct[] = [];
  // Per-product care-resolution inputs, collected alongside `out` (aligned by the
  // product's real uuid). Resolved in ONE batched pass after the full catalogue is
  // loaded, so the plan/scope/tree reads happen once, not per page.
  const careBase: {
    productId: string;
    productPriceCents: number;
    warrantyMonths: number | null;
    condition: "new" | "used" | "refurbished";
  }[] = [];
  const LIMIT = 100;
  for (let offset = 0; offset < 100000; ) {
    const page = await listApiProducts({ limit: LIMIT, offset, public: false });
    if (page.length === 0) break;
    for (const p of page) {
      // File each product at its DEEPEST assigned category. listApiProducts uses a
      // 2-level model — `category` = the PARENT of the primary node, `subcategory` =
      // the primary node (the real leaf, e.g. "iphones-neufs"). Taking the parent
      // dropped a whole taxonomy level (iPhones landed under /iphone, never
      // /iphones-neufs), which is why products looked mis-categorised. The leaf's
      // own ancestor chain restores the full migration depth.
      const leaf = p.subcategory ?? p.category;
      out.push({
        id: p.id ?? p.slug,
        sku: p.sku ?? null,
        slug: p.slug,
        title: p.name,
        link: `/${p.slug}`,
        image: imageUrl(p.image),
        price: p.price,
        oldPrice: p.oldPrice ?? null,
        currency: "TND",
        // Mapper-computed SSOT (preorder → "backorder"); fall back for safety.
        availability: p.availability ?? (p.inStock ? "in_stock" : "out_of_stock"),
        preorderReleasesAt: p.preorderReleasesAt ?? null,
        preorderMessage: p.preorderMessage ?? null,
        condition: p.condition ?? "new",
        brand: p.brand ?? "",
        category: leaf,
        product_type: breadcrumb(leaf) || p.categoryName || leaf,
        rating: p.rating ?? 0,
        reviews: p.reviews ?? 0,
        metaTitle: p.metaTitle ?? null,
        metaDescription: p.metaDescription ?? null,
        category_path: chainSlugs(leaf),
        care: [],
      });
      careBase.push({
        productId: p.id ?? "",
        productPriceCents: Math.round(p.price * 1000),
        warrantyMonths: p.warrantyMonths ?? null,
        condition: (p.condition ?? "new") as "new" | "used" | "refurbished",
      });
    }
    offset += page.length;
  }

  // 2b. Tokyo Care — bake each product's OFFERED plans (+ per-unit price) into the
  //     snapshot, and the plan catalogue into care-plans.json. Fails CLOSED: when
  //     the feature is off, nothing is offered (care stays []), matching the server
  //     charge path. The per-product price here is a DISPLAY snapshot; place-order
  //     re-resolves + re-prices authoritatively from the live product at checkout.
  const careCfg = await resolveCareConfig();
  let carePlansOut: RawCarePlan[] = [];
  if (careCfg.enabled) {
    const activePlans = await careService.list({ activeOnly: true });
    carePlansOut = activePlans.map((pl) => ({
      id: pl.id,
      name: pl.name,
      durationMonths: pl.duration_months,
      perks: Array.isArray(pl.perks) ? (pl.perks as string[]) : [],
      icon: pl.icon ?? null,
      description: pl.description ?? null,
    }));
    // Only products with a real uuid can be resolved (category scope + overrides).
    const idx = careBase.map((b, i) => ({ b, i })).filter((x) => UUID_RE.test(x.b.productId));
    const catIds = await productCategoryLinks.categoryIdsForProducts(idx.map((x) => x.b.productId));
    const offered = await resolveOfferedCareForLines(
      idx.map((x) => ({ ...x.b, categoryIds: catIds.get(x.b.productId) ?? [] })),
    );
    idx.forEach((x, k) => {
      const plans = offered[k].map((o) => ({ id: o.plan.id, price: minorToDinars(o.unitCents) }));
      if (plans.length > 0) out[x.i].care = plans;
    });
  }

  // 3. Categories the UI consumes ({slug,label,count}); count = products filed
  //    directly on that category slug (matches getProductsForSlug's exact match).
  const countBySlug = new Map<string, number>();
  for (const p of out) countBySlug.set(p.category, (countBySlug.get(p.category) ?? 0) + 1);
  const catsOut = cats
    .map((c) => ({ slug: c.slug, label: c.name, count: countBySlug.get(c.slug) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  // 4. Nav taxonomy TREE (the migration category hierarchy) — the single source
  //    for the header mega-menu, the mobile accordion and the breadcrumb context,
  //    replacing the hand-curated Tokyo-Store-UI taxonomy. Counts are ROLLED UP
  //    (a category + all its descendants) via each product's category_path, so a
  //    universe/section node reflects everything filed beneath it.
  const rollup = new Map<string, number>();
  for (const p of out) for (const s of new Set(p.category_path)) rollup.set(s, (rollup.get(s) ?? 0) + 1);
  const childrenByParent = new Map<string | null, (typeof cats)[number][]>();
  for (const c of cats) {
    const key = c.parent_id ?? null;
    (childrenByParent.get(key) ?? childrenByParent.set(key, []).get(key)!).push(c);
  }
  const buildNode = (c: (typeof cats)[number]): TaxoNode => ({
    slug: c.slug,
    name: c.name,
    count: rollup.get(c.slug) ?? 0,
    children: (childrenByParent.get(c.id) ?? [])
      .map(buildNode)
      // Prune EMPTY categories at every level, so the nav never links to a shelf
      // with no products (e.g. a taxonomy leaf the catalogue doesn't stock).
      .filter((n) => n.count > 0)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  });
  // Roots WITH products beneath them (drops empty facet roots like Homme/Femme),
  // biggest universe first.
  const taxonomy = (childrenByParent.get(null) ?? [])
    .map(buildNode)
    .filter((n) => n.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  fs.writeFileSync(path.join(OUT_DIR, "products.json"), JSON.stringify(out));
  fs.writeFileSync(path.join(OUT_DIR, "categories.json"), JSON.stringify(catsOut, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "taxonomy.json"), JSON.stringify(taxonomy, null, 2));
  // Tokyo Care plan catalogue + the master on/off, consumed by the storefront
  // protection selector. `enabled: false` makes the storefront offer nothing.
  fs.writeFileSync(
    path.join(OUT_DIR, "care-plans.json"),
    JSON.stringify(
      {
        enabled: careCfg.enabled,
        // Mirror the charge rules so the storefront DISPLAY matches the CHARGE:
        // per-unit (×qty) vs once-per-line, and whether care counts toward the
        // free-shipping threshold.
        chargePerUnit: careCfg.chargePerUnit,
        countsTowardFreeShipping: careCfg.countsTowardFreeShipping,
        plans: carePlansOut,
      },
      null,
      2,
    ),
  );
  const careOffered = out.filter((p) => p.care.length > 0).length;
  console.log(
    `[export] wrote ${out.length} products, ${catsOut.length} categories, ${taxonomy.length} nav universes, ${carePlansOut.length} care plans (offered on ${careOffered} products) to ${OUT_DIR}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import careData from "@/storefront/data/care-plans.json";
import categoriesData from "@/storefront/data/categories.json";
import productsData from "@/storefront/data/products.json";
import type { CarePlanInfo, Category, Product } from "@/storefront/types/catalog";

// Re-export the canonical DTOs so existing `import { Product } from "@/storefront/lib/catalog"`
// call sites keep working after the type moved to `@/storefront/types/catalog`.
export type { CarePlanInfo, Category, Product } from "@/storefront/types/catalog";

/** Tokyo Care snapshot config (mirrors the backend so DISPLAY == CHARGE). */
export const careConfig: { enabled: boolean; chargePerUnit: boolean; countsTowardFreeShipping: boolean } = {
  enabled: (careData as { enabled?: boolean }).enabled === true,
  // Default true (the server default) when the snapshot predates these fields.
  chargePerUnit: (careData as { chargePerUnit?: boolean }).chargePerUnit !== false,
  countsTowardFreeShipping: (careData as { countsTowardFreeShipping?: boolean }).countsTowardFreeShipping === true,
};

const carePlanById = new Map<string, CarePlanInfo>(
  ((careData as { plans?: CarePlanInfo[] }).plans ?? []).map((p) => [p.id, p]),
);

/** A care plan's presentational details by id (name, duration, perks…), or null. */
export function carePlanInfo(id: string): CarePlanInfo | null {
  return carePlanById.get(id) ?? null;
}
// NOTE: consumers read `careConfig.enabled` (and the charge knobs) directly — no
// separate `careEnabled` flag, to keep one source.

type RawProduct = Omit<Product, "slug"> & { slug?: string };

function decodeEntities(s: string): string {
  if (!s) return s;
  return (
    s
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      /* Any numeric entity, not just the unpadded forms: the export writes
         apostrophes as &#039;, which a literal /&#39;/ never matches — it was
         rendering "Assassin&#039;s Creed" on the card. */
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
      /* Last, so "&amp;#039;" decodes once rather than twice. */
      .replace(/&amp;/g, "&")
  );
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’&]/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

const SMALL_WORDS = new Set([
  "de", "du", "des", "et", "la", "le", "les", "en", "au", "aux", "sur", "pour", "par", "à", "a",
]);

function titleCaseLabel(input: string): string {
  return input
    .split(/(\s+|-)/)
    .map((tok, i) => {
      if (/^\s+$/.test(tok) || tok === "-") return tok;
      const lower = tok.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      // handle apostrophes like d'occasion → D'Occasion
      return lower.replace(/([\p{L}])([\p{L}']*)/u, (_, a, b) => {
        const parts = (a + b).split("'");
        return parts.map((p: string) => (p ? p[0].toUpperCase() + p.slice(1) : p)).join("'");
      });
    })
    .join("");
}

/**
 * Build the product list with a STABLE, UNIQUE slug per product. Tokyo Store
 * routes products at the flat `/[slug]` URL (no `/p/<id>`), so we derive a slug
 * from the title and de-duplicate collisions with a numeric suffix. Both the
 * listing (link hrefs) and the `[slug]` resolver read from this single source,
 * so the URLs always line up.
 */
const seenSlugs = new Map<string, number>();
export const products: Product[] = (productsData as RawProduct[]).map((p) => {
  const title = decodeEntities(p.title);
  // Prefer the backend-provided slug (one slug space across home / category /
  // search / collection / PDP); fall back to a title-derived, de-duplicated slug
  // for data that carries none (the original static mock).
  let slug = p.slug?.trim();
  if (!slug) {
    const base = slugify(title) || slugify(p.id);
    const n = seenSlugs.get(base) ?? 0;
    seenSlugs.set(base, n + 1);
    slug = n === 0 ? base : `${base}-${n + 1}`;
  }
  return { ...p, title, slug };
});

export const categories: Category[] = (categoriesData as Category[]).map((c) => ({
  ...c,
  label: titleCaseLabel(c.label),
}));

const categoryBySlug = new Map(categories.map((c) => [c.slug, c]));
const productBySlug = new Map(products.map((p) => [p.slug, p]));
const productById = new Map(products.map((p) => [p.id, p]));

export function findCategory(slug: string): Category | undefined {
  const direct = categoryBySlug.get(slug);
  if (direct) return direct;
  // fuzzy: try matching by slugified label
  return categories.find((c) => slugify(c.label) === slug);
}

export function getCategoryLabel(slug: string): string {
  const cat = findCategory(slug);
  if (cat) return cat.label;
  // beautify slug
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function findProductBySlug(slug: string): Product | undefined {
  return productBySlug.get(slug);
}

export function findProductById(id: string): Product | undefined {
  return productById.get(id);
}

export function getProductsForSlug(slug: string): Product[] {
  const cat = findCategory(slug);
  const targetSlug = cat?.slug ?? slug;
  const label = cat?.label ?? slug.replace(/-/g, " ");
  // Primary: ROLL UP the migration tree — every product whose category_path
  // contains this slug, so a universe/section page shows all products filed
  // beneath it (not just the ones filed directly on the node). Falls back to the
  // leaf-exact match for older data that carries no category_path.
  const rolledUp = products.filter((p) =>
    p.category_path?.length ? p.category_path.includes(targetSlug) : p.category === targetSlug,
  );
  if (rolledUp.length > 0) return rolledUp;
  // Fallback: match by product_type containing the label (alias / fuzzy slugs).
  const needle = label.toLowerCase();
  return products.filter((p) => p.product_type.toLowerCase().includes(needle));
}

import "server-only";

import { asc, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { categories } from "@/modules/catalog/category/schema";
import { brands } from "@/modules/catalog/brand/schema";
import { listVariantsForProducts } from "@/modules/catalog/product/queries";

type Choice = { id: string; name: string };

/** Per-list cap of the (non-searchable) scope-target picker. */
export const SCOPE_CHOICE_CAP = 500;

export type PromotionScopeChoices = {
  products: Choice[];
  categories: Choice[];
  brands: Choice[];
  /** Flat variant options for the "cibler une variante précise" picker. Each id is
   *  `"<productId>:<variantId>"`, name is "Produit — Variante". Only products with
   *  live variants contribute; capped like the other lists. */
  productVariants: Choice[];
  /** Which lists hit the cap (more live rows exist than are listed). */
  truncated: {
    cap: number;
    product: boolean;
    category: boolean;
    brand: boolean;
    productVariant: boolean;
  };
};

type TargetScope = "product" | "category" | "brand";

/** Split the capped (+1) read into the listed rows + whether the cap was hit. */
function capped(rows: Choice[]): { items: Choice[]; truncated: boolean } {
  return { items: rows.slice(0, SCOPE_CHOICE_CAP), truncated: rows.length > SCOPE_CHOICE_CAP };
}

/** The current target row, even past the cap (or since archived — labelled). */
async function loadOne(scope: TargetScope, id: string): Promise<Choice | null> {
  const [row] =
    scope === "product"
      ? await db
          .select({ id: products.id, name: products.name, deletedAt: products.deleted_at })
          .from(products)
          .where(eq(products.id, id))
          .limit(1)
      : scope === "category"
        ? await db
            .select({ id: categories.id, name: categories.name, deletedAt: categories.deleted_at })
            .from(categories)
            .where(eq(categories.id, id))
            .limit(1)
        : await db
            .select({ id: brands.id, name: brands.name, deletedAt: brands.deleted_at })
            .from(brands)
            .where(eq(brands.id, id))
            .limit(1);
  if (!row) return null;
  return { id: row.id, name: row.deletedAt ? `${row.name} (archivé)` : row.name };
}

/** Human label of ONE product variant target — `"<pid>:<vid>"` → "Produit — Variante",
 *  even past the cap or once the product/variant is archived (so an edit form still
 *  shows the pinned variant instead of dropping it). NULL if either row is gone. */
async function loadVariantChoice(pid: string, vid: string): Promise<Choice | null> {
  const [[prod], [variant]] = await Promise.all([
    db
      .select({ name: products.name, deletedAt: products.deleted_at })
      .from(products)
      .where(eq(products.id, pid))
      .limit(1),
    db
      .select({ label: product_variants.label, sku: product_variants.sku, deletedAt: product_variants.deleted_at })
      .from(product_variants)
      .where(eq(product_variants.id, vid))
      .limit(1),
  ]);
  if (!prod || !variant) return null;
  const label = variant.label || variant.sku || "Variante";
  const archived = Boolean(prod.deletedAt || variant.deletedAt);
  return { id: `${pid}:${vid}`, name: `${prod.name} — ${label}${archived ? " (archivé)" : ""}` };
}

/**
 * Scope-target options for the promotion form: live products / categories /
 * brands in NAME order (stable id tie-break) so the capped window is the
 * predictable alphabetical head rather than an arbitrary heap-order slice,
 * capped at SCOPE_CHOICE_CAP each (`truncated` drives the form's notice). The
 * CURRENT target — an edited promotion's scope_id or a `lockScope` deep-link —
 * is always included even beyond the cap, so the picker shows the real target
 * instead of the empty placeholder.
 */
export async function loadPromotionScopeChoices(
  current?: { scope: string; id: string | null } | null,
  /** MULTI-target (scope='targeted') ids the edited promo already selected — each
   *  is ensured present even past the cap, so the form's checkboxes render checked
   *  rather than being silently dropped on a routine save. `productVariant` items are
   *  `"<productId>:<variantId>"` pairs (migration 0173). */
  extraIds?: {
    product?: string[];
    category?: string[];
    brand?: string[];
    productVariant?: string[];
  } | null,
): Promise<PromotionScopeChoices> {
  const limit = SCOPE_CHOICE_CAP + 1; // +1 row detects the cap
  const [productRows, categoryRows, brandRows] = await Promise.all([
    db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(isNull(products.deleted_at))
      .orderBy(asc(products.name), asc(products.id))
      .limit(limit),
    db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(isNull(categories.deleted_at))
      .orderBy(asc(categories.name), asc(categories.id))
      .limit(limit),
    db
      .select({ id: brands.id, name: brands.name })
      .from(brands)
      .where(isNull(brands.deleted_at))
      .orderBy(asc(brands.name), asc(brands.id))
      .limit(limit),
  ]);
  const lists: Record<TargetScope, { items: Choice[]; truncated: boolean }> = {
    product: capped(productRows),
    category: capped(categoryRows),
    brand: capped(brandRows),
  };
  const scope = current?.scope;
  const currentId = current?.id;
  if (currentId && (scope === "product" || scope === "category" || scope === "brand")) {
    const list = lists[scope];
    if (!list.items.some((x) => x.id === currentId)) {
      const row = await loadOne(scope, currentId);
      if (row) list.items = [row, ...list.items];
    }
  }
  // Ensure every already-selected multi-target id is listed (even past the cap /
  // since archived) so the edit form's checkboxes render checked.
  for (const t of ["product", "category", "brand"] as const) {
    const missing = [...new Set(extraIds?.[t] ?? [])].filter(
      (id) => !lists[t].items.some((x) => x.id === id),
    );
    for (const id of missing) {
      const row = await loadOne(t, id);
      if (row) lists[t].items = [...lists[t].items, row];
    }
  }

  // Variant options: one entry per live variant of a LISTED product, in the same
  // (product name, then variant order) sequence, capped like the other lists. Only
  // products that actually have variants contribute, so simple products add nothing.
  const variantMap = await listVariantsForProducts(lists.product.items.map((p) => p.id));
  const variantRows: Choice[] = [];
  for (const p of lists.product.items) {
    for (const v of variantMap.get(p.id) ?? []) {
      variantRows.push({ id: `${p.id}:${v.id}`, name: `${p.name} — ${v.label || v.sku || "Variante"}` });
    }
  }
  const variants = capped(variantRows);
  // Ensure every already-selected variant pair is present (past the cap / archived).
  const missingPairs = [...new Set(extraIds?.productVariant ?? [])].filter(
    (pair) => !variants.items.some((x) => x.id === pair),
  );
  for (const pair of missingPairs) {
    const [pid, vid] = pair.split(":");
    if (!pid || !vid) continue;
    const row = await loadVariantChoice(pid, vid);
    if (row) variants.items = [...variants.items, row];
  }

  return {
    products: lists.product.items,
    categories: lists.category.items,
    brands: lists.brand.items,
    productVariants: variants.items,
    truncated: {
      cap: SCOPE_CHOICE_CAP,
      product: lists.product.truncated,
      category: lists.category.truncated,
      brand: lists.brand.truncated,
      productVariant: variants.truncated,
    },
  };
}

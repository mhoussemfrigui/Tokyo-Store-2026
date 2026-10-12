import "server-only";

import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { categories, type CategoryRow, type CategorySlimRow, type NewCategoryRow } from "./schema";

/**
 * The structural column set (see {@link CategorySlimRow}) — every column EXCEPT
 * the heavy long-text / jsonb ones (description, editorial block, value_props,
 * meta fields). Used by {@link CategoryService.listAllSlim} so the tree / sitemap
 * / mega-menu builders don't drag those per row.
 */
const CATEGORY_SLIM_COLUMNS = {
  id: categories.id,
  slug: categories.slug,
  name: categories.name,
  tagline: categories.tagline,
  parent_id: categories.parent_id,
  external_ref: categories.external_ref,
  display_order: categories.display_order,
  canonical_url: categories.canonical_url,
  noindex: categories.noindex,
  og_image_media_id: categories.og_image_media_id,
  warranty_months: categories.warranty_months,
  tax_rate_bps: categories.tax_rate_bps,
  hero_media_id: categories.hero_media_id,
  boutique_image_media_id: categories.boutique_image_media_id,
  icon: categories.icon,
  icon_media_id: categories.icon_media_id,
  is_active: categories.is_active,
  is_discountable: categories.is_discountable,
  created_at: categories.created_at,
  updated_at: categories.updated_at,
  deleted_at: categories.deleted_at,
} as const;

class CategoryService {
  async findById(id: string): Promise<CategoryRow | null> {
    const [row] = await db
      .select()
      .from(categories)
      .where(and(eq(categories.id, id), isNull(categories.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Resolve a category by slug. `activeOnly` (default false) restricts the
   * lookup to `is_active = true` rows — used by the STOREFRONT read paths so a
   * deactivated category 404s like an inactive brand does. The admin tree
   * (`getCategoryTree`) and other internal callers leave it off so they can
   * still see/edit inactive categories.
   */
  async findBySlug(
    slug: string,
    parentId?: string | null,
    opts: { activeOnly?: boolean } = {},
  ): Promise<CategoryRow | null> {
    const conditions = [eq(categories.slug, slug), isNull(categories.deleted_at)];
    if (parentId === undefined) {
      // Search anywhere
    } else if (parentId === null) {
      conditions.push(isNull(categories.parent_id));
    } else {
      conditions.push(eq(categories.parent_id, parentId));
    }
    if (opts.activeOnly) {
      conditions.push(eq(categories.is_active, true));
    }
    const [row] = await db
      .select()
      .from(categories)
      .where(and(...conditions))
      .limit(1);
    return row ?? null;
  }

  /**
   * Resolve a single LIVE category by its external reference — O(1) via the
   * partial unique index `categories_external_ref_unique`. Used by the external
   * API (ERP linkage). NOT a fallback chain: the caller picks the field.
   */
  async findByExternalRef(externalRef: string): Promise<CategoryRow | null> {
    const [row] = await db
      .select()
      .from(categories)
      .where(and(eq(categories.external_ref, externalRef), isNull(categories.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  async insert(input: NewCategoryRow): Promise<CategoryRow> {
    const [row] = await db.insert(categories).values(input).returning();
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<CategoryRow, "id" | "created_at">>,
    txOrDb: DbOrTx = db,
  ): Promise<CategoryRow | null> {
    const [row] = await txOrDb
      .update(categories)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(categories.id, id))
      .returning();
    return row ?? null;
  }

  async softDelete(id: string): Promise<void> {
    await db
      .update(categories)
      .set({ deleted_at: new Date(), updated_at: sql`now()` })
      .where(eq(categories.id, id));
  }

  /**
   * Soft-delete a category and PROMOTE its live children one level up (to the
   * deleted node's own parent — `null` if it was a root) IN ONE TRANSACTION.
   *
   * A bare soft-delete leaves children with a `parent_id` pointing at a tomb-
   * stoned row, which drops them out of `getCategoryTree`'s root build (they're
   * neither roots nor reachable through a live parent) — i.e. they vanish from
   * the admin UI. Promotion keeps the sub-tree attached and navigable, gener-
   * alising the baseline self-FK's `ON DELETE SET NULL` (root promotion) to the
   * soft-delete path. The row is locked FOR UPDATE so a concurrent re-parent of
   * the same node can't race the promotion.
   *
   * Note: promoting a child to root can hit `categories_root_slug_unique` if its
   * slug already exists at root — that 23505 aborts the whole tx (delete fails
   * with a friendly conflict), which is the safe outcome (no orphan, no silent
   * slug clash).
   *
   * `txOrDb` lets deleteCategoryWorkflow run this inside its own transaction
   * (nested → SAVEPOINT) alongside the category_attribute_filters cleanup and
   * the product-link move. Returns the node's parent id (`null` for a root) —
   * the target the workflow re-homes the deleted node's product links onto
   * (the product_categories table belongs to the associations layer, not here).
   */
  async softDeleteWithChildPromotion(
    id: string,
    txOrDb: DbOrTx = db,
  ): Promise<{ parentId: string | null }> {
    return txOrDb.transaction(async (tx) => {
      const [row] = await tx
        .select({ parent_id: categories.parent_id })
        .from(categories)
        .where(eq(categories.id, id))
        .for("update")
        .limit(1);
      const newParentId = row?.parent_id ?? null;
      await tx
        .update(categories)
        .set({ parent_id: newParentId, updated_at: sql`now()` })
        .where(and(eq(categories.parent_id, id), isNull(categories.deleted_at)));
      await tx
        .update(categories)
        .set({ deleted_at: new Date(), updated_at: sql`now()` })
        .where(eq(categories.id, id));
      return { parentId: newParentId };
    });
  }

  /**
   * Hard-delete a set of categories by id. Returns the ids actually removed
   * so callers can report accurate counts.
   *
   * Unlike `softDelete`, this physically removes the rows so a subsequent
   * re-import starts from a truly empty tree. (As of migration 0017 the partial
   * unique index `categories_root_slug_unique` is
   * `WHERE parent_id IS NULL AND deleted_at IS NULL`, so a soft-deleted root
   * already frees its slug; hard delete is still used here to remove the rows
   * outright and cascade the product_categories links.)
   *
   * Safe to pass every category id at once: the self-FK
   * `categories.parent_id` is `ON DELETE SET NULL` (a deleted parent simply
   * detaches its children, which are being deleted in the same statement
   * anyway) and `category_attribute_filters.category_id` is `ON DELETE
   * CASCADE`. `product_categories.category_id` is also `ON DELETE CASCADE`, so
   * the link rows drop automatically — callers still detach first via
   * `productCategoryLinks.deleteForCategories` for deterministic ordering/counts.
   */
  async hardDeleteByIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await db
      .delete(categories)
      .where(inArray(categories.id, ids))
      .returning({ id: categories.id });
    return rows.map((r) => r.id);
  }

  async listChildren(parentId: string | null): Promise<CategoryRow[]> {
    return db
      .select()
      .from(categories)
      .where(
        and(
          isNull(categories.deleted_at),
          parentId === null ? isNull(categories.parent_id) : eq(categories.parent_id, parentId),
        ),
      )
      .orderBy(asc(categories.display_order), asc(categories.name));
  }

  async listAll(): Promise<CategoryRow[]> {
    return db
      .select()
      .from(categories)
      .where(isNull(categories.deleted_at))
      .orderBy(asc(categories.display_order), asc(categories.name));
  }

  /**
   * Like {@link listAll} but SELECTs only the structural columns (see
   * {@link CategorySlimRow}) — no description / editorial / value_props / meta.
   * Used by the tree, sitemap and mega-menu builders, which read only structure
   * and never those heavy fields. Keeps the full-row {@link listAll} for the
   * external API / full-row callers.
   */
  async listAllSlim(): Promise<CategorySlimRow[]> {
    return db
      .select(CATEGORY_SLIM_COLUMNS)
      .from(categories)
      .where(isNull(categories.deleted_at))
      .orderBy(asc(categories.display_order), asc(categories.name));
  }

  /**
   * Renumber `display_order` (0..n) over exactly ONE sibling group in a single
   * transaction. `orderedIds` is the desired order; only ids that genuinely
   * belong to `parentId`'s live sibling set are applied (so a stale/tampered id
   * can never renumber an unrelated branch), and rows already at their target
   * index are skipped. Returns the ids whose order actually changed — the
   * caller emits `category.updated` for each so the storefront/mega-menu order
   * cache busts. O(siblings); the drill-down panel calls it per level.
   *
   * The sibling SELECT locks the group FOR UPDATE (mirrors
   * softDeleteWithChildPromotion) so overlapping reorders of the same parent
   * serialize and a concurrent reparent/soft-delete of a sibling can't race the
   * renumber; each UPDATE is re-scoped to the parent + live rows so a row that
   * slipped the group between the lock and the write is skipped defensively.
   * `orderedIds` is de-duped first so a repeated id can't create index gaps.
   */
  async reorderSiblings(parentId: string | null, orderedIds: string[]): Promise<string[]> {
    if (orderedIds.length === 0) return [];
    const parentScope = () =>
      parentId === null ? isNull(categories.parent_id) : eq(categories.parent_id, parentId);
    return db.transaction(async (tx) => {
      const siblings = await tx
        .select({ id: categories.id, display_order: categories.display_order })
        .from(categories)
        .where(and(isNull(categories.deleted_at), parentScope()))
        .for("update");
      const currentOrder = new Map(siblings.map((s) => [s.id, s.display_order]));
      // De-dupe (a repeated id would skip an index and leave a gap) then keep
      // only ids that truly belong to this locked, live sibling set.
      const applied = Array.from(new Set(orderedIds)).filter((id) => currentOrder.has(id));
      // Only the rows whose index actually changes need writing.
      const changes: { id: string; ord: number }[] = [];
      for (let i = 0; i < applied.length; i++) {
        if (currentOrder.get(applied[i]) !== i) changes.push({ id: applied[i], ord: i });
      }
      if (changes.length === 0) return [];
      // ONE UPDATE for the whole group (a CASE mapping id → new index) instead of
      // N sequential UPDATEs — a single round-trip that holds the FOR UPDATE lock
      // for less time. The WHERE re-scopes to the parent + live rows defensively
      // (a row that slipped the group after the lock is skipped; FOR UPDATE makes
      // that rare), and ELSE keeps any untouched row at its current order.
      const caseSql = sql.join(
        [
          sql`case ${categories.id}`,
          ...changes.map((c) => sql`when ${c.id}::uuid then ${c.ord}::int`),
          sql`else ${categories.display_order} end`,
        ],
        sql` `,
      );
      await tx
        .update(categories)
        .set({ display_order: caseSql, updated_at: sql`now()` })
        .where(
          and(
            inArray(
              categories.id,
              changes.map((c) => c.id),
            ),
            isNull(categories.deleted_at),
            parentScope(),
          ),
        );
      return changes.map((c) => c.id);
    });
  }

  async count(): Promise<number> {
    const [row] = await db
      .select({ value: count() })
      .from(categories)
      .where(isNull(categories.deleted_at));
    return Number(row?.value ?? 0);
  }

  /**
   * Batched id-to-row resolver. Used by `mapProductRows` to fetch every
   * relevant category + its parent in one query instead of two hops per
   * product.
   */
  async findByIds(ids: string[]): Promise<Map<string, CategoryRow>> {
    if (ids.length === 0) return new Map();
    const rows = await db
      .select()
      .from(categories)
      .where(and(inArray(categories.id, ids), isNull(categories.deleted_at)));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * Batched slug-to-row resolver for live (non-deleted) categories. Used by
   * bulk import flows that need to look up many slugs at once without
   * disturbing the demo's idempotency contract.
   */
  async listBySlugs(slugs: string[]): Promise<CategoryRow[]> {
    if (slugs.length === 0) return [];
    return db
      .select()
      .from(categories)
      .where(and(inArray(categories.slug, slugs), isNull(categories.deleted_at)));
  }
}

export const categoryService = new CategoryService();

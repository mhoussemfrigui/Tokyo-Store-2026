import "server-only";

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { categories } from "@/modules/catalog/category/schema";
import {
  category_attribute_filters,
  product_attribute_assignments,
  product_attribute_scalars,
  product_attribute_values,
  product_attributes,
  type AttributeRow,
  type AttributeScalarRow,
  type AttributeValueRow,
  type NewAttributeRow,
  type NewAttributeValueRow,
} from "./schema";

/** A product that currently carries a given attribute (value or scalar). */
export type ProductUsingAttribute = { id: string; name: string; slug: string };

class AttributeService {
  // ─────────────────────────────────────────────────────────── attributes
  async findAttributeById(id: string): Promise<AttributeRow | null> {
    const [row] = await db
      .select()
      .from(product_attributes)
      .where(and(eq(product_attributes.id, id), isNull(product_attributes.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  async findAttributeBySlug(slug: string): Promise<AttributeRow | null> {
    const [row] = await db
      .select()
      .from(product_attributes)
      .where(and(eq(product_attributes.slug, slug), isNull(product_attributes.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  /** `txOrDb` lets createAttributeWorkflow insert the attribute + its seed
   *  values in ONE transaction (a failed seed value must not strand the row). */
  async insertAttribute(input: NewAttributeRow, txOrDb: DbOrTx = db): Promise<AttributeRow> {
    const [row] = await txOrDb.insert(product_attributes).values(input).returning();
    return row;
  }

  async updateAttribute(
    id: string,
    patch: Partial<Omit<AttributeRow, "id" | "created_at">>,
    txOrDb: DbOrTx = db,
  ): Promise<AttributeRow | null> {
    const [row] = await txOrDb
      .update(product_attributes)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(product_attributes.id, id))
      .returning();
    return row ?? null;
  }

  async softDeleteAttribute(id: string): Promise<void> {
    await db
      .update(product_attributes)
      .set({ deleted_at: new Date(), updated_at: sql`now()` })
      .where(eq(product_attributes.id, id));
  }

  /**
   * Hard-delete an attribute by id. The DB cascades clean up the rest:
   * `product_attribute_values.attribute_id` is `ON DELETE CASCADE` (removes
   * the values), and each value's `product_attribute_assignments` rows are
   * `ON DELETE CASCADE` too. Returns true when a row was removed.
   *
   * Used by the segmented `clean` flow instead of `softDeleteAttribute` so a
   * wipe fully removes the row (slug index is partial on `deleted_at IS NULL`
   * since migration 0007, so a soft-deleted attribute would NOT collide on
   * re-seed — but the clean flow still wants the row physically gone).
   */
  async hardDeleteAttribute(id: string): Promise<boolean> {
    const rows = await db
      .delete(product_attributes)
      .where(eq(product_attributes.id, id))
      .returning({ id: product_attributes.id });
    return rows.length > 0;
  }

  /**
   * Every attribute id, INCLUDING soft-deleted rows. The segmented `clean`
   * flow uses this (not `listAllAttributes`, which filters `deleted_at`) so a
   * wipe also removes any rows a prior soft-delete left behind — otherwise
   * they'd linger and collide with the same slug on the next re-seed via
   * `product_attributes_slug_unique`.
   */
  async listAllAttributeIdsIncludingDeleted(): Promise<string[]> {
    const rows = await db
      .select({ id: product_attributes.id })
      .from(product_attributes);
    return rows.map((r) => r.id);
  }

  async listActiveAttributes(): Promise<AttributeRow[]> {
    return db
      .select()
      .from(product_attributes)
      .where(and(isNull(product_attributes.deleted_at), eq(product_attributes.is_active, true)))
      .orderBy(asc(product_attributes.display_order), asc(product_attributes.name));
  }

  async listAllAttributes(): Promise<AttributeRow[]> {
    return db
      .select()
      .from(product_attributes)
      .where(isNull(product_attributes.deleted_at))
      .orderBy(asc(product_attributes.display_order), asc(product_attributes.name));
  }

  /** Attribute rows by id — NO is_active / deleted_at filter, so the storefront
   *  variant build can resolve an axis for an existing variant even if its
   *  attribute was later deactivated/deleted (the axis must still render). */
  async findAttributesByIds(ids: string[]): Promise<AttributeRow[]> {
    if (ids.length === 0) return [];
    return db
      .select()
      .from(product_attributes)
      .where(inArray(product_attributes.id, ids));
  }

  // ─────────────────────────────────────────────────────────── values
  /**
   * Which of the given value ids actually exist. For validating a variant's
   * `attributeValueIds` BEFORE a save so a stale id fails with a clean
   * validation error instead of a raw FK violation (23503) deep in the tx.
   * (product_attribute_values is hard-deleted, so presence == live.)
   */
  async findExistingValueIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await db
      .select({ id: product_attribute_values.id })
      .from(product_attribute_values)
      .where(inArray(product_attribute_values.id, ids));
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Which of the given value ids belong to a NON-DELETED attribute — active OR
   * inactive. The product write paths validate against this: deactivating an
   * attribute only hides it from the category filters (docs/modules.md), so a
   * product that already carries one of its values must stay saveable (the
   * edit form re-submits every assigned value id). Ids must be UUID-shaped
   * (the caller filters) — the `uuid` cast would otherwise throw.
   */
  async findLiveValueIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await db
      .select({ id: product_attribute_values.id })
      .from(product_attribute_values)
      .innerJoin(product_attributes, eq(product_attributes.id, product_attribute_values.attribute_id))
      .where(and(inArray(product_attribute_values.id, ids), isNull(product_attributes.deleted_at)));
    return new Set(rows.map((r) => r.id));
  }

  /** Full value rows for a set of ids (any attribute). Used by the storefront
   *  variant build to resolve ONLY the values variants reference, not the whole
   *  catalogue. */
  async findValuesByIds(ids: string[]): Promise<AttributeValueRow[]> {
    if (ids.length === 0) return [];
    return db
      .select()
      .from(product_attribute_values)
      .where(inArray(product_attribute_values.id, ids));
  }

  /** How many product attribute ASSIGNMENTS (the "Attributs" facet that drives
   *  category filtering) reference any of these value ids. Paired with the
   *  variant count in the deletion guard so a value used purely as a filter
   *  facet is also blocked from a silent cascading delete. */
  async countAssignmentsUsingValues(valueIds: string[]): Promise<number> {
    if (valueIds.length === 0) return 0;
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(product_attribute_assignments)
      .where(inArray(product_attribute_assignments.attribute_value_id, valueIds));
    return Number(row?.n ?? 0);
  }

  async findValueById(id: string): Promise<AttributeValueRow | null> {
    const [row] = await db
      .select()
      .from(product_attribute_values)
      .where(eq(product_attribute_values.id, id))
      .limit(1);
    return row ?? null;
  }

  async findValueBySlug(
    attributeId: string,
    slug: string,
  ): Promise<AttributeValueRow | null> {
    const [row] = await db
      .select()
      .from(product_attribute_values)
      .where(
        and(
          eq(product_attribute_values.attribute_id, attributeId),
          eq(product_attribute_values.slug, slug),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async insertValue(
    input: NewAttributeValueRow,
    txOrDb: DbOrTx = db,
  ): Promise<AttributeValueRow> {
    const [row] = await txOrDb.insert(product_attribute_values).values(input).returning();
    return row;
  }

  async updateValue(
    id: string,
    patch: Partial<Omit<AttributeValueRow, "id" | "attribute_id" | "created_at">>,
  ): Promise<AttributeValueRow | null> {
    const [row] = await db
      .update(product_attribute_values)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(product_attribute_values.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Hard delete — values are small enums and we want them to vanish from the
   * filter UI immediately. `product_attribute_assignments.attribute_value_id`
   * carries an ON DELETE CASCADE FK, so the DB cleans the M2M rows
   * automatically; the explicit delete below is a belt-and-suspenders
   * backstop and keeps both writes in one transaction.
   */
  async deleteValue(id: string, txOrDb: DbOrTx = db): Promise<void> {
    // A passed-in tx nests as a savepoint (keeps the caller's atomicity); a bare
    // db opens its own transaction so the two deletes still commit together.
    await txOrDb.transaction(async (tx) => {
      // Clean up the M2M assignments first (also enforced by the DB cascade).
      await tx
        .delete(product_attribute_assignments)
        .where(eq(product_attribute_assignments.attribute_value_id, id));
      await tx
        .delete(product_attribute_values)
        .where(eq(product_attribute_values.id, id));
    });
  }

  async listValuesForAttribute(
    attributeId: string,
    txOrDb: DbOrTx = db,
  ): Promise<AttributeValueRow[]> {
    return txOrDb
      .select()
      .from(product_attribute_values)
      .where(eq(product_attribute_values.attribute_id, attributeId))
      .orderBy(asc(product_attribute_values.display_order), asc(product_attribute_values.label));
  }

  async listValuesForAttributes(
    attributeIds: string[],
  ): Promise<Map<string, AttributeValueRow[]>> {
    const out = new Map<string, AttributeValueRow[]>();
    if (attributeIds.length === 0) return out;
    const rows = await db
      .select()
      .from(product_attribute_values)
      .where(inArray(product_attribute_values.attribute_id, attributeIds))
      .orderBy(asc(product_attribute_values.display_order), asc(product_attribute_values.label));
    for (const r of rows) {
      const existing = out.get(r.attribute_id);
      if (existing) existing.push(r);
      else out.set(r.attribute_id, [r]);
    }
    return out;
  }

  /**
   * Reorder an attribute's values: set `display_order = index` for each id in
   * the given order. The `attribute_id` guard ensures a value from another
   * attribute can't be reordered into this one. Sequential updates in one
   * transaction (value sets are small enums).
   */
  async setValueOrder(
    attributeId: string,
    orderedValueIds: string[],
    txOrDb: DbOrTx = db,
  ): Promise<void> {
    await txOrDb.transaction(async (tx) => {
      for (let i = 0; i < orderedValueIds.length; i += 1) {
        await tx
          .update(product_attribute_values)
          .set({ display_order: i, updated_at: sql`now()` })
          .where(
            and(
              eq(product_attribute_values.id, orderedValueIds[i]),
              eq(product_attribute_values.attribute_id, attributeId),
            ),
          );
      }
    });
  }

  // ─────────────────────────────────────────────────── category filters
  /**
   * Replace the set of attribute filters opted-in on a category. Used by the
   * category-form attributes editor (via the setCategoryFilters workflow).
   * Idempotent — wipes and re-inserts the set in one transaction.
   */
  async setCategoryFilters(
    categoryId: string,
    attributeIds: string[],
    txOrDb: DbOrTx = db,
  ): Promise<void> {
    await txOrDb.transaction(async (tx) => {
      await tx
        .delete(category_attribute_filters)
        .where(eq(category_attribute_filters.category_id, categoryId));
      if (attributeIds.length === 0) return;
      await tx.insert(category_attribute_filters).values(
        attributeIds.map((attributeId, idx) => ({
          category_id: categoryId,
          attribute_id: attributeId,
          display_order: idx,
        })),
      );
    });
  }

  async listCategoryFilters(categoryId: string): Promise<string[]> {
    const rows = await db
      .select({ attribute_id: category_attribute_filters.attribute_id })
      .from(category_attribute_filters)
      .where(eq(category_attribute_filters.category_id, categoryId))
      .orderBy(asc(category_attribute_filters.display_order));
    return rows.map((r) => r.attribute_id);
  }

  /** The LIVE categories this attribute is opted into (the reverse of
   *  `listCategoryFilters`, over the SAME `category_attribute_filters` table).
   *  Inner-joins live categories: a link left behind by a soft-deleted category
   *  (older deletes did not clear it) can't be shown or unticked in the
   *  attribute-side picker, yet would be re-submitted on save and rejected by
   *  setAttributeCategoriesWorkflow as "introuvable" — bricking every save.
   *  Omitting it here also self-heals: the next save diff-removes the orphan. */
  async listCategoriesForAttribute(attributeId: string): Promise<string[]> {
    const rows = await db
      .select({ category_id: category_attribute_filters.category_id })
      .from(category_attribute_filters)
      .innerJoin(categories, eq(categories.id, category_attribute_filters.category_id))
      .where(
        and(
          eq(category_attribute_filters.attribute_id, attributeId),
          isNull(categories.deleted_at),
        ),
      );
    return rows.map((r) => r.category_id);
  }

  /**
   * Set, FROM THE ATTRIBUTE SIDE, which categories expose this attribute as a
   * filter. Diff-based (add/remove) rather than wipe-all, so it preserves each
   * category's existing attribute ORDER — a newly-linked category appends the
   * attribute at the end of that category's filter list (max display_order + 1).
   * The reverse of the category editor's Filtres tab; writes the same M2M.
   */
  async setAttributeCategories(
    attributeId: string,
    categoryIds: string[],
    txOrDb: DbOrTx = db,
  ): Promise<void> {
    const desired = Array.from(new Set(categoryIds));
    const desiredSet = new Set(desired);
    await txOrDb.transaction(async (tx) => {
      const current = await tx
        .select({ category_id: category_attribute_filters.category_id })
        .from(category_attribute_filters)
        .where(eq(category_attribute_filters.attribute_id, attributeId));
      const currentSet = new Set(current.map((r) => r.category_id));

      const toRemove = [...currentSet].filter((c) => !desiredSet.has(c));
      if (toRemove.length > 0) {
        await tx
          .delete(category_attribute_filters)
          .where(
            and(
              eq(category_attribute_filters.attribute_id, attributeId),
              inArray(category_attribute_filters.category_id, toRemove),
            ),
          );
      }
      for (const categoryId of desired) {
        if (currentSet.has(categoryId)) continue;
        const [m] = await tx
          .select({
            max: sql<number>`coalesce(max(${category_attribute_filters.display_order}), -1)::int`,
          })
          .from(category_attribute_filters)
          .where(eq(category_attribute_filters.category_id, categoryId));
        await tx.insert(category_attribute_filters).values({
          category_id: categoryId,
          attribute_id: attributeId,
          display_order: (m?.max ?? -1) + 1,
        });
      }
    });
  }

  // ─────────────────────────────────────────────── product assignments
  /**
   * Replace the set of attribute-value assignments for a product. Wipes the
   * existing rows in `product_attribute_assignments` and re-inserts the new
   * set inside a single transaction so the product is never in a half-wired
   * state.
   */
  async setProductAttributeValues(
    productId: string,
    valueIds: string[],
    txOrDb: DbOrTx = db,
  ): Promise<void> {
    // De-dup the incoming IDs so a malformed admin submit can't trip the
    // composite-PK unique constraint.
    const unique = Array.from(new Set(valueIds));
    await txOrDb.transaction(async (tx) => {
      await tx
        .delete(product_attribute_assignments)
        .where(eq(product_attribute_assignments.product_id, productId));
      if (unique.length === 0) return;
      await tx.insert(product_attribute_assignments).values(
        unique.map((vid) => ({
          product_id: productId,
          attribute_value_id: vid,
        })),
      );
    });
  }

  /**
   * Value IDs currently assigned to a product. Used by the product-form
   * loader to pre-tick attribute checkboxes / radios.
   */
  async listValueIdsForProduct(productId: string): Promise<string[]> {
    const rows = await db
      .select({ attribute_value_id: product_attribute_assignments.attribute_value_id })
      .from(product_attribute_assignments)
      .where(eq(product_attribute_assignments.product_id, productId));
    return rows.map((r) => r.attribute_value_id);
  }

  /**
   * Merge-add a set of attribute values to a product (does NOT remove the
   * product's existing values). Used by the bulk-tagging UI: caller selects
   * N products + a set of value IDs, this method appends without disturbing
   * what's already assigned. `onConflictDoNothing` keeps the call idempotent
   * if the admin picks the same value twice.
   */
  async addProductAttributeValues(
    productId: string,
    valueIds: string[],
  ): Promise<void> {
    const unique = Array.from(new Set(valueIds));
    if (unique.length === 0) return;
    await db
      .insert(product_attribute_assignments)
      .values(
        unique.map((vid) => ({ product_id: productId, attribute_value_id: vid })),
      )
      .onConflictDoNothing();
  }

  /**
   * Batched variant of `listValueIdsForProduct` — one query, grouped in JS.
   * Used by the storefront category page to render attribute filter chips
   * without fanning out N+1 queries.
   *
   * Returns a Map keyed by product_id → array of attribute_value_id strings.
   * Products with no assignments are simply absent from the map.
   */
  /**
   * Live (non-deleted) products that currently carry this attribute — via a
   * value assignment (value-list kinds) OR a scalar row (number/text). Powers
   * the "products using this attribute" view on the attribute detail page so an
   * admin can find + manage usage across products.
   *
   * `rows` is capped for safety but DETERMINISTIC (first `limit` by name, id as
   * tiebreak — each product once even when it carries both a value and a
   * scalar); `total` is the TRUE distinct count, so the page can say
   * "N affichés sur M" instead of presenting an arbitrary truncated subset
   * (two unordered DISTINCT…LIMIT branches, re-sorted) as the full usage.
   */
  async listProductsUsingAttribute(
    attributeId: string,
    limit = 500,
  ): Promise<{ rows: ProductUsingAttribute[]; total: number }> {
    const viaValues = db
      .select({ id: product_attribute_assignments.product_id })
      .from(product_attribute_assignments)
      .innerJoin(
        product_attribute_values,
        eq(product_attribute_values.id, product_attribute_assignments.attribute_value_id),
      )
      .where(eq(product_attribute_values.attribute_id, attributeId));
    const viaScalars = db
      .select({ id: product_attribute_scalars.product_id })
      .from(product_attribute_scalars)
      .where(eq(product_attribute_scalars.attribute_id, attributeId));
    // One predicate for both queries: a live product reached through EITHER
    // path — counting `products` rows (not link rows) is the distinct count.
    const usesAttribute = and(
      isNull(products.deleted_at),
      or(inArray(products.id, viaValues), inArray(products.id, viaScalars)),
    );
    const [rows, [countRow]] = await Promise.all([
      db
        .select({ id: products.id, name: products.name, slug: products.slug })
        .from(products)
        .where(usesAttribute)
        .orderBy(asc(products.name), asc(products.id))
        .limit(Math.max(1, limit)),
      db.select({ n: sql<number>`count(*)::int` }).from(products).where(usesAttribute),
    ]);
    return {
      // Page re-sorted with the French collation for display (the SET is fixed
      // by the DB order above, so this never changes which products are shown).
      rows: rows.sort((x, y) => x.name.localeCompare(y.name, "fr")),
      total: Number(countRow?.n ?? 0),
    };
  }

  async listValueIdsForProducts(productIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (productIds.length === 0) return out;
    const rows = await db
      .select({
        product_id: product_attribute_assignments.product_id,
        attribute_value_id: product_attribute_assignments.attribute_value_id,
      })
      .from(product_attribute_assignments)
      .where(inArray(product_attribute_assignments.product_id, productIds));
    for (const r of rows) {
      const existing = out.get(r.product_id);
      if (existing) existing.push(r.attribute_value_id);
      else out.set(r.product_id, [r.attribute_value_id]);
    }
    return out;
  }

  // ─────────────────────────────────────── scalar values (number / text)
  /**
   * Upsert a product's per-attribute SCALAR (for kind=number/text). A
   * fully-empty value (both numeric + text blank) CLEARS the row. Keyed by the
   * (product_id, attribute_id) unique index. numeric is stored as the Postgres
   * `numeric` (string) to preserve precision.
   */
  async setScalar(
    productId: string,
    attributeId: string,
    value: { numericValue?: number | string | null; textValue?: string | null },
    txOrDb: DbOrTx = db,
  ): Promise<void> {
    // Coerce to a finite number before stringifying — a non-numeric string (from
    // a misbehaving caller) would otherwise hit the Postgres `numeric` column and
    // raise 22P02 → opaque 500. Non-finite / empty / null all clear the value.
    const numeric =
      value.numericValue === null ||
      value.numericValue === undefined ||
      value.numericValue === "" ||
      !Number.isFinite(Number(value.numericValue))
        ? null
        : String(Number(value.numericValue));
    const text =
      value.textValue != null && value.textValue.trim() !== "" ? value.textValue.trim() : null;
    if (numeric === null && text === null) {
      await txOrDb
        .delete(product_attribute_scalars)
        .where(
          and(
            eq(product_attribute_scalars.product_id, productId),
            eq(product_attribute_scalars.attribute_id, attributeId),
          ),
        );
      return;
    }
    await txOrDb
      .insert(product_attribute_scalars)
      .values({
        product_id: productId,
        attribute_id: attributeId,
        numeric_value: numeric,
        text_value: text,
      })
      .onConflictDoUpdate({
        target: [product_attribute_scalars.product_id, product_attribute_scalars.attribute_id],
        set: { numeric_value: numeric, text_value: text, updated_at: sql`now()` },
      });
  }

  async getScalarsForProduct(productId: string): Promise<AttributeScalarRow[]> {
    return db
      .select()
      .from(product_attribute_scalars)
      .where(eq(product_attribute_scalars.product_id, productId));
  }

  /** How many products carry a per-product SCALAR value for this attribute. Backs the
   *  guard against a number/text → value-list/boolean kind change, which would orphan
   *  these rows (the read paths only surface scalars for number/text kinds). */
  async countScalarsForAttribute(attributeId: string): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(product_attribute_scalars)
      .where(eq(product_attribute_scalars.attribute_id, attributeId));
    return row?.n ?? 0;
  }

  /** Batched per-product scalars for the storefront (range filter + PDP specs). */
  async listScalarsForProducts(
    productIds: string[],
  ): Promise<Map<string, AttributeScalarRow[]>> {
    const out = new Map<string, AttributeScalarRow[]>();
    if (productIds.length === 0) return out;
    const rows = await db
      .select()
      .from(product_attribute_scalars)
      .where(inArray(product_attribute_scalars.product_id, productIds));
    for (const r of rows) {
      const existing = out.get(r.product_id);
      if (existing) existing.push(r);
      else out.set(r.product_id, [r]);
    }
    return out;
  }
}

export const attributeService = new AttributeService();

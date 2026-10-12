import "server-only";

import { and, asc, count, eq, ilike, inArray, isNull, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { brands, type BrandRow, type NewBrandRow } from "./schema";

/** Escape LIKE/ILIKE metacharacters so user search input is treated literally
 *  (the default `\` escape char applies — no ESCAPE clause needed). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

class BrandService {
  async findById(id: string): Promise<BrandRow | null> {
    const [row] = await db
      .select()
      .from(brands)
      .where(and(eq(brands.id, id), isNull(brands.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  async findBySlug(slug: string): Promise<BrandRow | null> {
    const [row] = await db
      .select()
      .from(brands)
      .where(and(eq(brands.slug, slug), isNull(brands.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Resolve a single LIVE brand by its external reference — O(1) via the partial
   * unique index `brands_external_ref_unique`. Used by the external API (ERP
   * linkage). NOT a fallback chain: the caller picks the field.
   */
  async findByExternalRef(externalRef: string): Promise<BrandRow | null> {
    const [row] = await db
      .select()
      .from(brands)
      .where(and(eq(brands.external_ref, externalRef), isNull(brands.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  async insert(input: NewBrandRow): Promise<BrandRow> {
    const [row] = await db.insert(brands).values(input).returning();
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<BrandRow, "id" | "created_at">>,
    txOrDb: DbOrTx = db,
  ): Promise<BrandRow | null> {
    const [row] = await txOrDb
      .update(brands)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(brands.id, id))
      .returning();
    return row ?? null;
  }

  async softDelete(id: string): Promise<void> {
    await db
      .update(brands)
      .set({ deleted_at: new Date(), updated_at: sql`now()` })
      .where(eq(brands.id, id));
  }

  /**
   * List brands. `activeOnly` restricts to is_active=true (the PUBLIC/storefront
   * set); keyed ERP callers omit it to see drafts. `search` matches the name
   * (LIKE metacharacters escaped). `offset` powers admin pagination.
   */
  async list(
    opts: { search?: string; limit?: number; offset?: number; activeOnly?: boolean } = {},
  ): Promise<BrandRow[]> {
    const limit = Math.min(opts.limit ?? 200, 500);
    return db
      .select()
      .from(brands)
      .where(and(...this.listConditions(opts)))
      .orderBy(asc(brands.display_order), asc(brands.name))
      .limit(limit)
      .offset(Math.max(opts.offset ?? 0, 0));
  }

  /** ALL live brands, no pagination cap — used by the bulk content generator's
   *  scope resolver so a >500-brand catalog isn't silently truncated (twin of
   *  categoryService.listAll), AND by the admin "Réorganiser" mode which needs the
   *  full ordered set. */
  async listAll(): Promise<BrandRow[]> {
    return db
      .select()
      .from(brands)
      .where(isNull(brands.deleted_at))
      .orderBy(asc(brands.display_order), asc(brands.name));
  }

  /**
   * Renumber the FLAT brand `display_order` (0..n) in one transaction. `orderedIds`
   * is the desired order; only ids that belong to the live brand set are applied
   * (a stale/foreign id can't renumber), and rows already at their target index are
   * skipped. Returns the ids whose order actually changed — the caller emits
   * `brand.updated` per id so the `brands` cache tag busts. Brands are FLAT, so this
   * is the whole live set (no parent scope) — the parentless twin of
   * categoryService.reorderSiblings. The live set is locked FOR UPDATE so
   * overlapping reorders serialize; `orderedIds` is de-duped so a repeated id can't
   * create an index gap.
   */
  async reorderSiblings(orderedIds: string[]): Promise<string[]> {
    if (orderedIds.length === 0) return [];
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: brands.id, display_order: brands.display_order })
        .from(brands)
        .where(isNull(brands.deleted_at))
        .for("update");
      const currentOrder = new Map(rows.map((r) => [r.id, r.display_order]));
      const applied = Array.from(new Set(orderedIds)).filter((id) => currentOrder.has(id));
      const changes: { id: string; ord: number }[] = [];
      for (let i = 0; i < applied.length; i++) {
        if (currentOrder.get(applied[i]) !== i) changes.push({ id: applied[i], ord: i });
      }
      if (changes.length === 0) return [];
      const caseSql = sql.join(
        [
          sql`case ${brands.id}`,
          ...changes.map((c) => sql`when ${c.id}::uuid then ${c.ord}::int`),
          sql`else ${brands.display_order} end`,
        ],
        sql` `,
      );
      await tx
        .update(brands)
        .set({ display_order: caseSql, updated_at: sql`now()` })
        .where(
          and(
            inArray(
              brands.id,
              changes.map((c) => c.id),
            ),
            isNull(brands.deleted_at),
          ),
        );
      return changes.map((c) => c.id);
    });
  }

  /** Total brands matching the same filters as `list` (for admin pagination). */
  async count(opts: { search?: string; activeOnly?: boolean } = {}): Promise<number> {
    const [row] = await db
      .select({ value: count() })
      .from(brands)
      .where(and(...this.listConditions(opts)));
    return Number(row?.value ?? 0);
  }

  private listConditions(opts: { search?: string; activeOnly?: boolean }) {
    const conditions = [isNull(brands.deleted_at)];
    if (opts.activeOnly) conditions.push(eq(brands.is_active, true));
    if (opts.search) conditions.push(ilike(brands.name, `%${escapeLike(opts.search)}%`));
    return conditions;
  }

  /**
   * Resolve a set of brand slugs to their full rows in one query. Used by
   * bulk-import flows (e.g. demo seed) that need the generated id for each
   * known slug without firing N round-trips.
   */
  async listBySlugs(slugs: string[]): Promise<BrandRow[]> {
    if (slugs.length === 0) return [];
    return db
      .select()
      .from(brands)
      .where(and(inArray(brands.slug, slugs), isNull(brands.deleted_at)));
  }

  /**
   * Resolve a set of brand ids to their full rows in one query (live brands
   * only). Used by the catalog listing mapper to resolve ONLY the brands
   * referenced by the current page, instead of scanning the whole table.
   */
  async findByIds(ids: string[]): Promise<BrandRow[]> {
    if (ids.length === 0) return [];
    return db
      .select()
      .from(brands)
      .where(and(inArray(brands.id, ids), isNull(brands.deleted_at)));
  }

  /**
   * Hard-delete EVERY brand (including any soft-deleted rows). Returns the
   * deleted ids so callers can report counts. Used by the segmented `clean`
   * flow, which wipes all rows of a content type rather than a demo-keyed
   * subset. `product_brands.brand_id` is `ON DELETE CASCADE`, so product↔brand
   * links detach automatically.
   */
  async deleteAll(): Promise<string[]> {
    const rows = await db.delete(brands).returning({ id: brands.id });
    return rows.map((r) => r.id);
  }
}

export const brandService = new BrandService();

import "server-only";

import { and, asc, count, eq, ilike, inArray, isNull, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { product_care, type NewProductCareRow, type ProductCareRow } from "@/associations/product-care";
import {
  care_plan_scope_targets,
  care_plans,
  type CarePlanRow,
  type CarePlanScopeTargetRow,
  type NewCarePlanRow,
} from "./schema";

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** The scope the admin assigns a plan to — CATEGORY targets (per-product activation
 *  is handled by `product_care`, not scope targets). */
export type CareScopeInput = {
  categoryIds: string[];
  /** Category targets also cover products in SUBcategories (the cascade). */
  includeDescendants: boolean;
};

/** A per-product override row the product form writes (include/exclude + price). */
export type ProductCareInput = {
  carePlanId: string;
  mode: "include" | "exclude";
  overridePriceCents: number | null;
};

class CareService {
  // ─── plan CRUD ───────────────────────────────────────────────────────────
  async findById(id: string): Promise<CarePlanRow | null> {
    const [row] = await db
      .select()
      .from(care_plans)
      .where(and(eq(care_plans.id, id), isNull(care_plans.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  async findBySlug(slug: string): Promise<CarePlanRow | null> {
    const [row] = await db
      .select()
      .from(care_plans)
      .where(and(eq(care_plans.slug, slug), isNull(care_plans.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  async insert(input: NewCarePlanRow, txOrDb: DbOrTx = db): Promise<CarePlanRow> {
    const [row] = await txOrDb.insert(care_plans).values(input).returning();
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<CarePlanRow, "id" | "created_at">>,
    txOrDb: DbOrTx = db,
  ): Promise<CarePlanRow | null> {
    const [row] = await txOrDb
      .update(care_plans)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(care_plans.id, id))
      .returning();
    return row ?? null;
  }

  async softDelete(id: string): Promise<void> {
    await db
      .update(care_plans)
      .set({ deleted_at: new Date(), updated_at: sql`now()` })
      .where(eq(care_plans.id, id));
  }

  /** Admin listing (drafts included unless activeOnly). Ordered by priority DESC then name. */
  async list(
    opts: { search?: string; limit?: number; offset?: number; activeOnly?: boolean } = {},
  ): Promise<CarePlanRow[]> {
    const limit = Math.min(opts.limit ?? 200, 500);
    return db
      .select()
      .from(care_plans)
      .where(and(...this.listConditions(opts)))
      .orderBy(sql`${care_plans.display_priority} desc`, asc(care_plans.name))
      .limit(limit)
      .offset(Math.max(opts.offset ?? 0, 0));
  }

  async listAll(): Promise<CarePlanRow[]> {
    return db
      .select()
      .from(care_plans)
      .where(isNull(care_plans.deleted_at))
      .orderBy(sql`${care_plans.display_priority} desc`, asc(care_plans.name));
  }

  async count(opts: { search?: string; activeOnly?: boolean } = {}): Promise<number> {
    const [row] = await db
      .select({ value: count() })
      .from(care_plans)
      .where(and(...this.listConditions(opts)));
    return Number(row?.value ?? 0);
  }

  async findByIds(ids: string[]): Promise<CarePlanRow[]> {
    if (ids.length === 0) return [];
    return db
      .select()
      .from(care_plans)
      .where(and(inArray(care_plans.id, ids), isNull(care_plans.deleted_at)));
  }

  private listConditions(opts: { search?: string; activeOnly?: boolean }) {
    const conditions = [isNull(care_plans.deleted_at)];
    if (opts.activeOnly) conditions.push(eq(care_plans.is_active, true));
    if (opts.search) conditions.push(ilike(care_plans.name, `%${escapeLike(opts.search)}%`));
    return conditions;
  }

  // ─── scope targets (where a plan is ACTIVATED) ─────────────────────────────
  async getScopeTargets(planId: string): Promise<CarePlanScopeTargetRow[]> {
    return db
      .select()
      .from(care_plan_scope_targets)
      .where(eq(care_plan_scope_targets.care_plan_id, planId));
  }

  /**
   * Every CATEGORY scope target that belongs to an ACTIVE (non-deleted) plan —
   * the input to the storefront/admin "which plans does this product's category
   * offer?" resolver (see @/lib/care/scope). Inactive/soft-deleted plans are
   * excluded so a disabled plan never shows as offered.
   */
  async getAllCategoryScopeTargets(): Promise<CarePlanScopeTargetRow[]> {
    return db
      .select({
        id: care_plan_scope_targets.id,
        care_plan_id: care_plan_scope_targets.care_plan_id,
        target_type: care_plan_scope_targets.target_type,
        target_id: care_plan_scope_targets.target_id,
        include_descendants: care_plan_scope_targets.include_descendants,
        created_at: care_plan_scope_targets.created_at,
      })
      .from(care_plan_scope_targets)
      .innerJoin(care_plans, eq(care_plans.id, care_plan_scope_targets.care_plan_id))
      .where(
        and(
          eq(care_plan_scope_targets.target_type, "category"),
          eq(care_plans.is_active, true),
          isNull(care_plans.deleted_at),
        ),
      );
  }

  /** Replace a plan's ENTIRE scope-target set (delete-all then insert) in one tx.
   *  Category targets only — per-product activation lives in `product_care`. */
  async setScopeTargets(planId: string, scope: CareScopeInput, txOrDb: DbOrTx = db): Promise<void> {
    await txOrDb.delete(care_plan_scope_targets).where(eq(care_plan_scope_targets.care_plan_id, planId));
    const rows = dedupe(scope.categoryIds).map((cid) => ({
      care_plan_id: planId,
      target_type: "category" as const,
      target_id: cid,
      include_descendants: scope.includeDescendants,
    }));
    if (rows.length > 0) await txOrDb.insert(care_plan_scope_targets).values(rows);
  }

  // ─── per-product override (the product form's « Tokyo Care » sub-tab) ───────
  async getProductCare(productId: string): Promise<ProductCareRow[]> {
    return db.select().from(product_care).where(eq(product_care.product_id, productId));
  }

  /** Batched {@link getProductCare}: every override row for the given products,
   *  grouped by product_id. Empty-input safe (returns an empty map). */
  async getProductCareForProducts(productIds: string[]): Promise<Map<string, ProductCareRow[]>> {
    const out = new Map<string, ProductCareRow[]>();
    if (productIds.length === 0) return out;
    const rows = await db
      .select()
      .from(product_care)
      .where(inArray(product_care.product_id, productIds));
    for (const r of rows) {
      const list = out.get(r.product_id);
      if (list) list.push(r);
      else out.set(r.product_id, [r]);
    }
    return out;
  }

  /** Replace a PRODUCT's entire care-override set (include/exclude + price) in one tx. */
  async setProductCareForProduct(
    productId: string,
    rows: ProductCareInput[],
    txOrDb: DbOrTx = db,
  ): Promise<void> {
    await txOrDb.delete(product_care).where(eq(product_care.product_id, productId));
    const seen = new Set<string>();
    const values: NewProductCareRow[] = [];
    for (const r of rows) {
      if (seen.has(r.carePlanId)) continue;
      seen.add(r.carePlanId);
      values.push({
        product_id: productId,
        care_plan_id: r.carePlanId,
        mode: r.mode,
        override_price_cents: r.overridePriceCents,
      });
    }
    if (values.length > 0) await txOrDb.insert(product_care).values(values);
  }

  /** Hard-delete every care plan (incl. soft-deleted) — segmented clean flow.
   *  Scope targets + product_care CASCADE on the hard row delete. */
  async deleteAll(): Promise<string[]> {
    const rows = await db.delete(care_plans).returning({ id: care_plans.id });
    return rows.map((r) => r.id);
  }
}

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

export const careService = new CareService();

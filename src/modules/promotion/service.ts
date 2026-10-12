import "server-only";

import { and, asc, desc, eq, exists, gt, ilike, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import {
  promotion_redemptions,
  promotion_scope_targets,
  promotion_targets,
  promotions,
  type NewPromotionRedemptionRow,
  type PromotionRedemptionRow,
  type NewPromotionRow,
  type PromotionRow,
  type PromotionScope,
  type PromotionScopeTargetRow,
  type PromotionScopeTargetType,
  type PromotionTargetRow,
  type PromotionTargetType,
} from "./schema";

/**
 * Promotion service — owns every read/write on `promotions` and
 * `promotion_redemptions`. Workflows orchestrate; this service is the
 * single point that touches the tables (the module boundary).
 *
 * Notes on the "live window" predicate
 * ────────────────────────────────────
 * Every read path that returns "currently usable" promotions composes the
 * same SQL: is_active = true AND deleted_at IS NULL AND (starts_at IS NULL
 * OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now()).
 *
 * We push the `now()` comparison into Postgres rather than read the JS
 * clock (`new Date()`) for two reasons:
 *   1. Postgres's clock is the single source of truth — no skew between
 *      the app servers and the DB.
 *   2. Next.js 16 Cache Components treats `new Date()` on a non-cached
 *      server path as a prerender error; `sql\`now()\`` sidesteps that.
 */

const liveWindow = () =>
  and(
    eq(promotions.is_active, true),
    isNull(promotions.deleted_at),
    or(isNull(promotions.starts_at), lte(promotions.starts_at, sql`now()`)),
    or(isNull(promotions.ends_at), gt(promotions.ends_at, sql`now()`)),
  );

class PromotionService {
  // ─────────────────────────────────────────────────────────── CRUD ──
  async insert(input: NewPromotionRow): Promise<PromotionRow> {
    const [row] = await db.insert(promotions).values(input).returning();
    return row;
  }

  async findById(id: string): Promise<PromotionRow | null> {
    const [row] = await db
      .select()
      .from(promotions)
      .where(and(eq(promotions.id, id), isNull(promotions.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  async update(
    id: string,
    patch: Partial<Omit<PromotionRow, "id" | "created_at">>,
  ): Promise<PromotionRow | null> {
    const [row] = await db
      .update(promotions)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(promotions.id, id))
      .returning();
    return row ?? null;
  }

  async softDelete(id: string): Promise<void> {
    await db
      .update(promotions)
      .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
      .where(eq(promotions.id, id));
  }

  // ───────────────────────────────────── scheduled announcement (G4) ──
  /**
   * Ids of promotions whose scheduled email announcement is DUE — `announce_at`
   * set and reached, not yet announced, and still LIVE (the same window a manual
   * announce re-checks). A candidate scan for the sweep; each id is then CLAIMED
   * atomically via {@link claimAnnounce} (which re-asserts every condition), so a
   * promo deactivated between scan and claim is never fired. Ordered by due time.
   */
  async listDueForAnnounce(limit = 200): Promise<string[]> {
    const rows = await db
      .select({ id: promotions.id })
      .from(promotions)
      .where(
        and(
          isNull(promotions.announced_at),
          sql`${promotions.announce_at} is not null and ${promotions.announce_at} <= now()`,
          liveWindow(),
        ),
      )
      .orderBy(asc(promotions.announce_at))
      .limit(limit);
    return rows.map((r) => r.id);
  }

  /**
   * RACE-SAFE claim of a due announcement: stamps `announced_at = now()` only if it
   * is still NULL, the promo is due (`announce_at <= now()`), and it is still LIVE —
   * all folded into the UPDATE…WHERE so two overlapping sweep ticks (or a manual run
   * racing the heartbeat) can't both fire it. Returns true iff THIS caller won the
   * claim (then it may run the blast); false = already claimed / no longer due/live.
   * Mirrors the folded-UPDATE pattern of {@link incrementUsesCount}.
   */
  async claimAnnounce(id: string): Promise<boolean> {
    const rows = await db
      .update(promotions)
      .set({ announced_at: sql`now()`, updated_at: sql`now()` })
      .where(
        and(
          eq(promotions.id, id),
          isNull(promotions.announced_at),
          sql`${promotions.announce_at} is not null and ${promotions.announce_at} <= now()`,
          liveWindow(),
        ),
      )
      .returning({ id: promotions.id });
    return rows.length > 0;
  }

  /** Stamp `announced_at = now()` unconditionally (used by the immediate create-time
   *  announce + the manual « Annoncer maintenant » action, where the fire decision
   *  was already made outside a due/claim race). Idempotent for display purposes. */
  async markAnnounced(id: string, txOrDb: DbOrTx = db): Promise<void> {
    await txOrDb
      .update(promotions)
      .set({ announced_at: sql`now()`, updated_at: sql`now()` })
      .where(eq(promotions.id, id));
  }

  async list(opts?: {
    scope?: PromotionScope;
    scopeId?: string | null;
    activeOnly?: boolean;
    limit?: number;
  }): Promise<PromotionRow[]> {
    const conditions = [isNull(promotions.deleted_at)];
    if (opts?.scope) conditions.push(eq(promotions.scope, opts.scope));
    if (opts?.scopeId !== undefined) {
      conditions.push(
        opts.scopeId === null
          ? isNull(promotions.scope_id)
          : eq(promotions.scope_id, opts.scopeId),
      );
    }
    if (opts?.activeOnly) conditions.push(eq(promotions.is_active, true));

    return db
      .select()
      .from(promotions)
      .where(and(...conditions))
      .orderBy(desc(promotions.display_priority), desc(promotions.created_at))
      .limit(opts?.limit ?? 200);
  }

  /**
   * SERVER-paginated + searchable admin listing (fixes the old load-500-then-
   * client-filter that silently DROPPED the 501st+ promo). `q` matches name / code
   * / url_slug (case-insensitive); `trigger` filters auto|code|url. Returns the page
   * plus the total match count so the panel can render a real pager. pageSize is
   * clamped 5–100, page ≥ 1.
   */
  async listPaged(opts: {
    page?: number;
    pageSize?: number;
    q?: string;
    trigger?: "auto" | "code" | "url";
  }): Promise<{ items: PromotionRow[]; total: number; page: number; pageSize: number }> {
    const pageSize = Math.min(Math.max(Math.trunc(opts.pageSize ?? 25), 5), 100);
    const page = Math.max(Math.trunc(opts.page ?? 1), 1);
    const conditions = [isNull(promotions.deleted_at)];
    if (opts.trigger) conditions.push(eq(promotions.trigger_kind, opts.trigger));
    const q = opts.q?.trim();
    if (q) {
      conditions.push(
        or(
          ilike(promotions.name, `%${q}%`),
          ilike(promotions.code, `%${q}%`),
          ilike(promotions.url_slug, `%${q}%`),
        )!,
      );
    }
    const where = and(...conditions);
    const [items, [countRow]] = await Promise.all([
      db
        .select()
        .from(promotions)
        .where(where)
        .orderBy(desc(promotions.display_priority), desc(promotions.created_at))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ total: sql<number>`count(*)::int` }).from(promotions).where(where),
    ]);
    return { items, total: Number(countRow?.total ?? 0), page, pageSize };
  }

  // ─────────────────────────────────────────────── code / URL lookups ──
  /**
   * Find a live promotion by its coupon code (case-insensitive).
   * Caller is responsible for additional condition checks (min_cart_cents,
   * max_uses_per_user, etc.) — see `evaluateForCart`.
   */
  async findLiveByCode(code: string): Promise<PromotionRow | null> {
    const normalized = code.trim();
    if (!normalized) return null;
    const [row] = await db
      .select()
      .from(promotions)
      .where(
        and(
          eq(promotions.trigger_kind, "code"),
          sql`lower(${promotions.code}) = lower(${normalized})`,
          liveWindow(),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Find a live promotion by its URL slug. */
  async findLiveByUrlSlug(slug: string): Promise<PromotionRow | null> {
    const [row] = await db
      .select()
      .from(promotions)
      .where(
        and(
          eq(promotions.trigger_kind, "url"),
          eq(promotions.url_slug, slug),
          liveWindow(),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  // ─────────────────────────────────────────────── auto / scope reads ──
  /**
   * Live auto-applied promotions for a specific product. Includes any
   * promotion targeting that product directly OR any category/brand it
   * belongs to. Callers pass the resolved ancestor ids so this service
   * doesn't need to know the catalog topology.
   *
   * Returns rows ordered by display_priority DESC so the first match is
   * the strongest. Callers pick one (non-stackable) or all (stackable).
   */
  async listLiveAutoForProduct(opts: {
    productId: string;
    categoryIds: string[];
    brandIds: string[];
  }): Promise<PromotionRow[]> {
    const scopeMatches = or(
      and(
        eq(promotions.scope, "product"),
        eq(promotions.scope_id, opts.productId),
      ),
      // inArray, NOT `sql\`= ANY(${ids})\``: drizzle expands a JS array in a sql
      // template into a parenthesised param LIST — `ANY(($1))` (Postgres:
      // "malformed array literal") / `ANY(($1, $2))` ("requires array on right
      // side") — so ANY product with a category/brand link threw here and the
      // callers' catch silently dropped every auto-promo (PDP, add-to-cart,
      // quick order) while cards / place-order (batched path) applied it.
      opts.categoryIds.length > 0
        ? and(eq(promotions.scope, "category"), inArray(promotions.scope_id, opts.categoryIds))
        : undefined,
      opts.brandIds.length > 0
        ? and(eq(promotions.scope, "brand"), inArray(promotions.scope_id, opts.brandIds))
        : undefined,
    );

    return db
      .select()
      .from(promotions)
      .where(
        and(
          eq(promotions.trigger_kind, "auto"),
          scopeMatches,
          liveWindow(),
        ),
      )
      .orderBy(desc(promotions.display_priority), asc(promotions.created_at));
  }

  /**
   * Every live AUTO-applied promotion (any scope) — used by the Promotions
   * collection page to surface products that currently have an active discount.
   * Ordered strongest-priority first so callers can let the first match win.
   */
  async listLiveAutoPromotions(): Promise<PromotionRow[]> {
    return db
      .select()
      .from(promotions)
      .where(and(eq(promotions.trigger_kind, "auto"), liveWindow()))
      .orderBy(desc(promotions.display_priority), desc(promotions.created_at));
  }

  /**
   * Live COUPON (code-trigger) promotions — the selectable list for the manual-order
   * « Code promo » picker. Only `trigger_kind='code'` promos can be applied by code
   * (matching `findLiveByCode`, which the manual/ERP paths use to resolve the code →
   * id), filtered to the live window via the shared helper. Ordered strongest-priority
   * first, capped. Auto/URL promos are deliberately excluded (they can't be entered).
   */
  async listLiveCoupons(limit = 200): Promise<PromotionRow[]> {
    return db
      .select()
      .from(promotions)
      .where(and(eq(promotions.trigger_kind, "code"), liveWindow()))
      .orderBy(desc(promotions.display_priority), desc(promotions.created_at))
      .limit(limit);
  }

  /** Every live promotion targeting a specific product directly. */
  /**
   * Every live promotion that targets THIS product — for the product admin's
   * « Promotions sur ce produit ». Matches the legacy single-scope form
   * (scope='product', scope_id) OR a MULTI-target (scope='targeted') promo that
   * lists the product in promotion_scope_targets (incl. a variant-pinned target,
   * whose target_id is still the product). The EXISTS de-dupes: a promo that
   * matches both ways (a backfilled legacy promo) returns ONCE. Category / brand
   * -wide promos are intentionally NOT listed here — they aren't « sur ce produit ».
   */
  async listForProductScope(productId: string): Promise<PromotionRow[]> {
    return db
      .select()
      .from(promotions)
      .where(
        and(
          isNull(promotions.deleted_at),
          or(
            and(eq(promotions.scope, "product"), eq(promotions.scope_id, productId)),
            exists(
              db
                .select({ one: sql`1` })
                .from(promotion_scope_targets)
                .where(
                  and(
                    eq(promotion_scope_targets.promotion_id, promotions.id),
                    eq(promotion_scope_targets.target_type, "product"),
                    eq(promotion_scope_targets.target_id, productId),
                  ),
                ),
            ),
          ),
        ),
      )
      .orderBy(desc(promotions.created_at));
  }

  // ──────────────────────────────────────────────── usage / capacity ──
  /**
   * Race-safe bump of `uses_count`. The WHERE clause folds the cap check
   * into the UPDATE itself so two concurrent redemptions of the very last
   * available slot can't both succeed — the second one matches zero rows
   * and returns `false`. Callers MUST react to a false return (rollback /
   * fail the workflow) instead of trusting an earlier `hasCapacity` read.
   */
  async incrementUsesCount(id: string, txOrDb: DbOrTx = db): Promise<boolean> {
    const rows = await txOrDb
      .update(promotions)
      .set({
        uses_count: sql`${promotions.uses_count} + 1`,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(promotions.id, id),
          or(
            isNull(promotions.max_uses),
            lt(promotions.uses_count, promotions.max_uses),
          ),
        ),
      )
      .returning({ id: promotions.id });
    return rows.length > 0;
  }

  /** Total uses across all shoppers (live snapshot — race-safe via uses_count). */
  async hasCapacity(id: string, maxUses: number | null): Promise<boolean> {
    if (maxUses === null) return true;
    const [row] = await db
      .select({ uses_count: promotions.uses_count })
      .from(promotions)
      .where(eq(promotions.id, id))
      .limit(1);
    if (!row) return false;
    return row.uses_count < maxUses;
  }

  /** How many times a specific user has redeemed a promotion. Accepts a tx so
   *  the place-order transaction can re-count under a row lock (race-safe
   *  per-user cap); the default `db` is the pre-tx advisory read.
   *
   *  Computes a SIGNED SUM so a refund's balancing reversal row NETS OUT the
   *  original instead of merely being excluded (the old count(*) left a refunded
   *  user permanently blocked while the global cap was freed by
   *  `decrementUsesCount` — an asymmetry). Per row:
   *    +1  a discount redemption (`discount_cents > 0`)
   *    -1  its reversal (`discount_cents < 0`, free_shipping false)
   *    +1  a free-shipping redemption (`discount_cents = 0`, `free_shipping`)
   *  Order matters (discount>0 → <0 → free_shipping) so a free-ship-only row
   *  still scores +1. Net effect: a fully-refunded discount coupon frees the
   *  per-user slot (mirrors the global cap), while a free-ship redemption — which
   *  reconcile never reverses — stays counted. Clamped at 0. */
  async countRedemptionsByUser(
    promotionId: string,
    userId: string,
    txOrDb: DbOrTx = db,
  ): Promise<number> {
    const [row] = await txOrDb
      .select({
        n: sql<number>`coalesce(sum(case
          when ${promotion_redemptions.discount_cents} > 0 then 1
          when ${promotion_redemptions.discount_cents} < 0 then -1
          when ${promotion_redemptions.free_shipping} then 1
          else 0
        end), 0)::int`,
      })
      .from(promotion_redemptions)
      .where(
        and(
          eq(promotion_redemptions.promotion_id, promotionId),
          eq(promotion_redemptions.user_id, userId),
        ),
      );
    return Math.max(0, row?.n ?? 0);
  }

  /** Total coupon/promo redemptions by a user across ALL promotions — the customer
   *  detail « coupons utilisés » stat (each row = one coupon applied to an order). */
  async countRedemptionsForUser(userId: string): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(promotion_redemptions)
      .where(eq(promotion_redemptions.user_id, userId));
    return row?.n ?? 0;
  }

  /**
   * Row-lock a promotion inside a transaction (`SELECT … FOR UPDATE`) so that
   * concurrent redemptions of the SAME promotion serialize. The global cap is
   * race-safe via a folded UPDATE…WHERE, but the PER-USER cap is a separate
   * count that a single UPDATE can't express — callers take this lock, then
   * re-`countRedemptionsByUser(…, tx)`, before inserting the redemption.
   */
  async lockForRedemption(promotionId: string, txOrDb: DbOrTx = db): Promise<void> {
    await txOrDb.execute(sql`select 1 from promotions where id = ${promotionId} for update`);
  }

  async logRedemption(row: NewPromotionRedemptionRow, txOrDb: DbOrTx = db): Promise<void> {
    await txOrDb.insert(promotion_redemptions).values(row);
  }

  /**
   * Decrement `uses_count` for a refund/reversal. Clamped at zero so a
   * mis-ordered chain of reversals never lets the counter go negative.
   * The atomic `GREATEST(0, …)` keeps the column honest under concurrency.
   */
  async decrementUsesCount(id: string, txOrDb: DbOrTx = db): Promise<void> {
    await txOrDb
      .update(promotions)
      .set({
        uses_count: sql`GREATEST(0, ${promotions.uses_count} - 1)`,
        updated_at: sql`now()`,
      })
      .where(eq(promotions.id, id));
  }

  /**
   * Look up every redemption row attached to an order. Used by the refund
   * workflow to reverse the bumps applied at place-order time. Returns
   * ALL rows including any prior reversals so the caller can skip those
   * via `discount_cents > 0` if needed.
   */
  async listRedemptionsForOrder(orderId: string, txOrDb: DbOrTx = db): Promise<PromotionRedemptionRow[]> {
    return txOrDb
      .select()
      .from(promotion_redemptions)
      .where(eq(promotion_redemptions.order_id, orderId));
  }

  /**
   * Aggregated stats for the admin grid — total redemptions + revenue
   * impact (sum of discount_cents).
   */
  async statsForPromotion(promotionId: string) {
    const [row] = await db
      .select({
        // Count ORIGINAL redemptions (discount_cents > 0 OR free_shipping). A
        // refund/cancel appends a balancing NEGATIVE row (see
        // reconcile-order-promos), so a bare count(*) would double-count a
        // redeemed-then-refunded order and disagree with promotions.uses_count
        // (decremented on reversal); free-ship-only redemptions carry
        // discount_cents = 0 but are real uses, so OR them in.
        redemptions: sql<number>`count(*) filter (where ${promotion_redemptions.discount_cents} > 0 or ${promotion_redemptions.free_shipping})::int`,
        // Revenue impact = line discount + waived shipping, so a free-shipping
        // coupon's true cost is counted (discount_cents alone is 0 for it). Both
        // terms net to zero after a reversal (a free-ship-ONLY use is consumed
        // and stays counted by design — see the redemption schema note).
        revenue_impact_cents: sql<number>`coalesce(sum(${promotion_redemptions.discount_cents} + ${promotion_redemptions.shipping_waived_cents}), 0)::int`,
      })
      .from(promotion_redemptions)
      .where(eq(promotion_redemptions.promotion_id, promotionId));
    return row ?? { redemptions: 0, revenue_impact_cents: 0 };
  }

  /**
   * Recent redemption rows for the admin "Performance" detail view — newest
   * first, capped. Includes reversal rows (`discount_cents < 0`) so a refunded
   * order is visible as a balancing entry. The caller resolves order numbers /
   * client emails (kept out of this module to respect boundaries via `user_idx`
   * / `order_idx`).
   */
  async listRecentRedemptions(
    promotionId: string,
    limit = 50,
  ): Promise<PromotionRedemptionRow[]> {
    return db
      .select()
      .from(promotion_redemptions)
      .where(eq(promotion_redemptions.promotion_id, promotionId))
      .orderBy(desc(promotion_redemptions.created_at))
      .limit(limit);
  }

  // ───────────────────────────────────────────── targeting (promotion_targets)
  /** Every target restricting a promotion (empty = public). */
  async listTargets(promotionId: string, txOrDb: DbOrTx = db): Promise<PromotionTargetRow[]> {
    return txOrDb
      .select()
      .from(promotion_targets)
      .where(eq(promotion_targets.promotion_id, promotionId));
  }

  /** Target counts for many promotions in one grouped query (admin list badge). */
  async countTargetsForPromotions(promotionIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (promotionIds.length === 0) return out;
    const rows = await db
      .select({ id: promotion_targets.promotion_id, n: sql<number>`count(*)::int` })
      .from(promotion_targets)
      .where(inArray(promotion_targets.promotion_id, promotionIds))
      .groupBy(promotion_targets.promotion_id);
    for (const r of rows) out.set(r.id, r.n);
    return out;
  }

  /** Replace a promotion's full target set (delete-all + insert) in one tx. */
  async setTargets(
    promotionId: string,
    targets: Array<{ target_type: PromotionTargetType; target_id: string }>,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(promotion_targets).where(eq(promotion_targets.promotion_id, promotionId));
      if (targets.length > 0) {
        await tx
          .insert(promotion_targets)
          .values(
            targets.map((t) => ({
              promotion_id: promotionId,
              target_type: t.target_type,
              target_id: t.target_id,
            })),
          )
          .onConflictDoNothing();
      }
    });
  }

  // ─────────────────────────────────── scope targets (WHAT: the product set)
  /** A promotion's scope-target rows (product/category/brand it applies to). */
  async listScopeTargets(promotionId: string, txOrDb: DbOrTx = db): Promise<PromotionScopeTargetRow[]> {
    return txOrDb
      .select()
      .from(promotion_scope_targets)
      .where(eq(promotion_scope_targets.promotion_id, promotionId));
  }

  /**
   * Scope-target rows for MANY promotions in one query, grouped by promotion id.
   * The batched auto-promo resolver + the coupon-scope matcher use this to read a
   * uniform product set (legacy single-scope promos are backfilled with one row).
   * Empty input ⇒ empty map (no query).
   */
  async listScopeTargetsForPromotions(
    promotionIds: string[],
    txOrDb: DbOrTx = db,
  ): Promise<Map<string, PromotionScopeTargetRow[]>> {
    const out = new Map<string, PromotionScopeTargetRow[]>();
    if (promotionIds.length === 0) return out;
    const rows = await txOrDb
      .select()
      .from(promotion_scope_targets)
      .where(inArray(promotion_scope_targets.promotion_id, promotionIds));
    for (const r of rows) {
      const arr = out.get(r.promotion_id);
      if (arr) arr.push(r);
      else out.set(r.promotion_id, [r]);
    }
    return out;
  }

  /** Replace a promotion's full scope-target set (delete-all + insert) in one tx. */
  async setScopeTargets(
    promotionId: string,
    targets: Array<{
      target_type: PromotionScopeTargetType;
      target_id: string;
      include_descendants?: boolean;
      /** Product targets only (migration 0173): narrow to a single variant; null/omitted
       *  = all variants. */
      variant_id?: string | null;
    }>,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .delete(promotion_scope_targets)
        .where(eq(promotion_scope_targets.promotion_id, promotionId));
      if (targets.length > 0) {
        await tx
          .insert(promotion_scope_targets)
          .values(
            targets.map((t) => ({
              promotion_id: promotionId,
              target_type: t.target_type,
              target_id: t.target_id,
              include_descendants: t.include_descendants ?? true,
              variant_id: t.target_type === "product" ? (t.variant_id ?? null) : null,
            })),
          )
          .onConflictDoNothing();
      }
    });
  }

}

export const promotionService = new PromotionService();

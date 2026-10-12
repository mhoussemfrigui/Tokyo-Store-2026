import "server-only";

import { and, eq, getTableColumns, ilike, isNull, or, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { users } from "@/modules/auth/schema";
import { products } from "@/modules/catalog/product/schema";
import { categories } from "@/modules/catalog/category/schema";
import { product_categories } from "@/associations/product-category";
import { wishlists, wishlist_items, type WishlistRow } from "./schema";

/** Escape LIKE metacharacters so the admin's search is matched literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Public-profile filter for the admin moderation list + its count: every PUBLIC
 * list, optionally narrowed to a case-insensitive substring of the slug or the
 * pseudonym (capped at 100 chars — a filter fragment never needs more).
 */
function publicProfileFilter(q?: string): SQL {
  // The moderation board lists PUBLIC lists (to lock) AND LOCKED lists (to unlock);
  // an ordinary customer-private list (neither) is not moderatable and stays hidden.
  const moderatable = or(eq(wishlists.is_public, true), eq(wishlists.public_locked, true))!;
  const needle = q?.trim().slice(0, 100);
  if (!needle) return moderatable;
  const pattern = `%${escapeLike(needle)}%`;
  return and(
    moderatable,
    or(ilike(wishlists.public_slug, pattern), ilike(wishlists.public_display_name, pattern)),
  )!;
}

/** Walk the drizzle-wrapped driver error chain for a Postgres unique-violation. */
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && typeof e === "object" && depth < 6; depth++) {
    if ((e as { code?: string }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

class WishlistService {
  async findByUserId(userId: string): Promise<WishlistRow | null> {
    const [row] = await db.select().from(wishlists).where(eq(wishlists.user_id, userId)).limit(1);
    return row ?? null;
  }

  async findByToken(token: string): Promise<WishlistRow | null> {
    const [row] = await db.select().from(wishlists).where(eq(wishlists.token, token)).limit(1);
    return row ?? null;
  }

  async createForUser(userId: string): Promise<WishlistRow> {
    // Idempotent get-or-create: two concurrent first-time toggles both read null
    // from findByUserId and race to insert. ON CONFLICT DO NOTHING + a re-fetch
    // on the lost race avoids the partial-unique violation surfacing as a 500.
    const [row] = await db
      .insert(wishlists)
      .values({ user_id: userId })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const existing = await this.findByUserId(userId);
    if (!existing) throw new Error("wishlist: createForUser failed to get-or-create");
    return existing;
  }

  async createForToken(token: string): Promise<WishlistRow> {
    // Guests are especially exposed: two concurrent requests share the SAME
    // cookie token, so the insert collides deterministically without this guard.
    const [row] = await db
      .insert(wishlists)
      .values({ token })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const existing = await this.findByToken(token);
    if (!existing) throw new Error("wishlist: createForToken failed to get-or-create");
    return existing;
  }

  async hasItem(wishlistId: string, productId: string): Promise<boolean> {
    const [row] = await db
      .select({ one: sql`1` })
      .from(wishlist_items)
      .where(
        and(eq(wishlist_items.wishlist_id, wishlistId), eq(wishlist_items.product_id, productId)),
      )
      .limit(1);
    return Boolean(row);
  }

  async addItem(wishlistId: string, productId: string): Promise<void> {
    await db
      .insert(wishlist_items)
      .values({ wishlist_id: wishlistId, product_id: productId })
      .onConflictDoNothing();
  }

  async removeItem(wishlistId: string, productId: string): Promise<void> {
    await db
      .delete(wishlist_items)
      .where(
        and(eq(wishlist_items.wishlist_id, wishlistId), eq(wishlist_items.product_id, productId)),
      );
  }

  /** Product UUIDs in the list (newest first). */
  async listProductIds(wishlistId: string): Promise<string[]> {
    const rows = await db
      .select({ productId: wishlist_items.product_id })
      .from(wishlist_items)
      .where(eq(wishlist_items.wishlist_id, wishlistId))
      .orderBy(sql`${wishlist_items.created_at} desc`);
    return rows.map((r) => r.productId);
  }

  /**
   * Product SLUGS in the list — what the client heart checks against (cards
   * key by slug). Only surfaces published, non-deleted products so the heart
   * never references a slug the storefront can't render.
   */
  async listProductSlugs(wishlistId: string): Promise<string[]> {
    const rows = await db
      .select({ slug: products.slug })
      .from(wishlist_items)
      .innerJoin(products, eq(products.id, wishlist_items.product_id))
      .where(
        and(
          eq(wishlist_items.wishlist_id, wishlistId),
          eq(products.is_published, true),
          isNull(products.deleted_at),
        ),
      )
      .orderBy(sql`${wishlist_items.created_at} desc`);
    return rows.map((r) => r.slug).filter((s): s is string => Boolean(s));
  }

  /**
   * Favorited products for a wishlist, hydrated with name/slug for the admin
   * customer 360 (newest first). Includes unpublished/soft-deleted products
   * (admin context — show what the customer actually saved) via a left join,
   * so a since-deleted product still appears as a bare id.
   */
  async listForOwner(
    wishlistId: string,
  ): Promise<Array<{ productId: string; name: string | null; slug: string | null; createdAt: Date }>> {
    const rows = await db
      .select({
        productId: wishlist_items.product_id,
        name: products.name,
        slug: products.slug,
        createdAt: wishlist_items.created_at,
      })
      .from(wishlist_items)
      .leftJoin(products, eq(products.id, wishlist_items.product_id))
      .where(eq(wishlist_items.wishlist_id, wishlistId))
      .orderBy(sql`${wishlist_items.created_at} desc`);
    return rows;
  }

  /**
   * Aggregate counters for the admin Favoris board. `products` is the TRUE
   * distinct-product count. Favorites of soft-DELETED products are left out — the
   * products inner-join on `deleted_at IS NULL` (a product soft-delete keeps its
   * wishlist_items rows but drops off every favorites surface), matching the demand
   * board (favorites-filter.ts) so the KPIs reconcile.
   */
  async globalStats(): Promise<{ totalItems: number; owners: number; products: number }> {
    const [r] = await db
      .select({
        totalItems: sql<number>`count(*)::int`,
        owners: sql<number>`count(distinct ${wishlist_items.wishlist_id})::int`,
        products: sql<number>`count(distinct ${wishlist_items.product_id})::int`,
      })
      .from(wishlist_items)
      .innerJoin(products, eq(products.id, wishlist_items.product_id))
      .where(isNull(products.deleted_at));
    return {
      totalItems: Number(r?.totalItems ?? 0),
      owners: Number(r?.owners ?? 0),
      products: Number(r?.products ?? 0),
    };
  }

  /**
   * Most-favorited CATEGORIES — counts every saved product against its PRIMARY
   * category (one per product, so a single favorite isn't double-counted across
   * a product's multiple categories). Live categories and live (non-deleted)
   * products only.
   */
  async topCategories(
    limit = 15,
  ): Promise<Array<{ categoryId: string; name: string; slug: string; count: number }>> {
    const rows = await db
      .select({
        categoryId: categories.id,
        name: categories.name,
        slug: categories.slug,
        count: sql<number>`count(*)::int`.mapWith(Number),
      })
      .from(wishlist_items)
      .innerJoin(products, eq(products.id, wishlist_items.product_id))
      .innerJoin(
        product_categories,
        and(
          eq(product_categories.product_id, wishlist_items.product_id),
          eq(product_categories.is_primary, true),
        ),
      )
      .innerJoin(categories, eq(categories.id, product_categories.category_id))
      .where(and(isNull(categories.deleted_at), isNull(products.deleted_at)))
      .groupBy(categories.id, categories.name, categories.slug)
      .orderBy(sql`count(*) desc`)
      .limit(Math.min(limit, 100));
    return rows;
  }

  // ───────────────────────────────────────────── public shareable profiles
  /** The signed-in user's own public-favorites state (null if no list yet). */
  async getOwnPublicState(
    userId: string,
  ): Promise<{ id: string; isPublic: boolean; slug: string | null; displayName: string | null; locked: boolean } | null> {
    const w = await this.findByUserId(userId);
    if (!w) return null;
    return {
      id: w.id,
      isPublic: w.is_public,
      slug: w.public_slug,
      displayName: w.public_display_name,
      locked: w.public_locked,
    };
  }

  /**
   * Set the user's public-favorites state (get-or-create the list first). The
   * slug's case-insensitive uniqueness is DB-enforced — a clash surfaces as a
   * clean `slug_taken` rather than a 500.
   */
  async setPublicProfile(
    userId: string,
    input: { isPublic: boolean; slug: string | null; displayName: string | null },
  ): Promise<{ ok: true } | { ok: false; reason: "slug_taken" }> {
    const w = await this.createForUser(userId);
    try {
      await db
        .update(wishlists)
        .set({
          is_public: input.isPublic,
          public_slug: input.slug,
          public_display_name: input.displayName,
          updated_at: sql`now()`,
        })
        .where(eq(wishlists.id, w.id));
      return { ok: true };
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, reason: "slug_taken" };
      throw err;
    }
  }

  /** Resolve a PUBLIC wishlist by its vanity slug (case-insensitive). Null when
   *  no such slug, the owner has toggled it private, or the owner's account is
   *  gone / disabled (a banned owner can't sign in to hide it themselves — the
   *  page comes back on re-enable, the `is_public` flag is left untouched). */
  async findPublicBySlug(slug: string): Promise<WishlistRow | null> {
    const s = slug.trim();
    if (!s) return null;
    const [row] = await db
      .select(getTableColumns(wishlists))
      .from(wishlists)
      .innerJoin(users, eq(users.id, wishlists.user_id))
      .where(
        and(
          sql`lower(${wishlists.public_slug}) = lower(${s})`,
          eq(wishlists.is_public, true),
          isNull(users.disabledAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Count of public profiles — the admin KPI (no `q`) and the moderation list's
   * total for its pager (same optional slug / pseudonym filter as the list).
   */
  async publicProfileCount(q?: string): Promise<number> {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(wishlists)
      .where(publicProfileFilter(q));
    return Number(r?.n ?? 0);
  }

  /**
   * Public profiles for the admin moderation board (handle + pseudonym + item
   * count), newest first, SEARCHABLE (case-insensitive substring of the slug or
   * the pseudonym) and PAGED — it's the only UI path to force-private, so an
   * abusive profile older than the newest page must still be reachable. The item
   * count skips favorites of deleted products (same rule as `globalStats`).
   */
  async listPublicProfiles(
    opts: { q?: string; limit?: number; offset?: number } = {},
  ): Promise<Array<{ id: string; slug: string | null; displayName: string | null; items: number; createdAt: Date; isPublic: boolean; locked: boolean }>> {
    return db
      .select({
        id: wishlists.id,
        slug: wishlists.public_slug,
        displayName: wishlists.public_display_name,
        createdAt: wishlists.created_at,
        isPublic: wishlists.is_public,
        locked: wishlists.public_locked,
        // The outer id is spelled table-QUALIFIED: drizzle renders `${wishlists.id}`
        // as a bare "id" in a single-table select, which inside this subquery bound
        // to the inner row (wi.id) — the count was always 0.
        items: sql<number>`(select count(*) from ${wishlist_items} wi join ${products} p on p.id = wi.product_id where wi.wishlist_id = ${wishlists}.id and p.deleted_at is null)::int`.mapWith(Number),
      })
      .from(wishlists)
      .where(publicProfileFilter(opts.q))
      // id tie-breaker: a stable total order so offset pages never overlap/skip.
      .orderBy(sql`${wishlists.created_at} desc`, sql`${wishlists.id} desc`)
      .limit(Math.min(Math.max(opts.limit ?? 100, 1), 200))
      .offset(Math.max(0, Math.floor(opts.offset ?? 0)));
  }

  /**
   * Admin force-private + LOCK (moderation). Unpublishes the list and sets the lock
   * so the customer cannot re-publish the same abusive handle until an admin lifts
   * it. The slug/pseudonym are KEPT (not cleared): while locked the page is already
   * unreachable (is_public=false → /u/<slug> 404s), and retaining them lets the
   * moderation board still identify + review the offending profile. Lifted via
   * liftModerationLock.
   */
  async forcePrivate(wishlistId: string): Promise<void> {
    await db
      .update(wishlists)
      .set({ is_public: false, public_locked: true, updated_at: sql`now()` })
      .where(eq(wishlists.id, wishlistId));
  }

  /** Admin: lift a moderation lock so the customer may share again (fresh handle). */
  async liftModerationLock(wishlistId: string): Promise<void> {
    await db
      .update(wishlists)
      .set({ public_locked: false, updated_at: sql`now()` })
      .where(eq(wishlists.id, wishlistId));
  }


  /**
   * Merge a guest (token) list into a user's list on login, then delete the
   * guest list. Items already in the user's list are skipped (ON CONFLICT on
   * the wishlist_id+product_id unique).
   *
   * The copy + guest-list deletion run in ONE transaction so a crash can't
   * leave the items half-copied with the guest list already gone (or vice
   * versa). The copy is a SINGLE bulk insert rather than one round-trip per
   * item — N favorites merge in two statements, not N+1.
   */
  async mergeTokenIntoUser(token: string, userId: string): Promise<void> {
    const guest = await this.findByToken(token);
    if (!guest) return;
    let target = await this.findByUserId(userId);
    if (!target) target = await this.createForUser(userId);
    const targetId = target.id;
    const ids = await this.listProductIds(guest.id);

    await db.transaction(async (tx) => {
      if (ids.length > 0) {
        await tx
          .insert(wishlist_items)
          .values(ids.map((productId) => ({ wishlist_id: targetId, product_id: productId })))
          .onConflictDoNothing();
      }
      await tx.delete(wishlists).where(eq(wishlists.id, guest.id));
    });
  }

  /**
   * Retention: delete GUEST (token, no user) lists with no activity in N days —
   * the list row AND every item older than the cutoff. A guest list is created on
   * a cookieless heart toggle and otherwise only disappears when merged on login,
   * so abandoned ones piled up forever (and inflated the admin Favoris KPIs). The
   * cookie is set once, at creation, with a 180-day max-age, so a 180-day window
   * only reaps lists no browser can reach any more. Items cascade (FK ON DELETE
   * CASCADE); batched in 5000-row rounds like the cart purges. Returns the number
   * of lists removed.
   */
  async purgeStaleGuestLists(days: number): Promise<number> {
    const BATCH = 5000;
    let total = 0;
    for (;;) {
      const result = await db.execute<{ count: number }>(sql`
        WITH del AS (
          DELETE FROM wishlists
          WHERE id IN (
            SELECT w.id FROM wishlists w
            WHERE w.user_id IS NULL
              AND w.token IS NOT NULL
              AND GREATEST(w.created_at, w.updated_at) < now() - make_interval(days => ${days})
              AND NOT EXISTS (
                SELECT 1 FROM wishlist_items wi
                WHERE wi.wishlist_id = w.id
                  AND wi.created_at >= now() - make_interval(days => ${days})
              )
            LIMIT ${BATCH}
          )
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM del;
      `);
      const deleted = Number(result.rows[0]?.count ?? 0);
      total += deleted;
      if (deleted < BATCH) break;
    }
    return total;
  }
}

export const wishlistService = new WishlistService();

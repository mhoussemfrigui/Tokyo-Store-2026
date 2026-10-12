import "server-only";

import { and, desc, eq, isNull, notLike, or, sql } from "drizzle-orm";

import { db, type DbOrTx, type Tx } from "@/lib/db/client";
import { parseIncrementalCursor } from "@/lib/api/cursor";
import { products } from "@/modules/catalog/product/schema";
import {
  cart_items,
  carts,
  type CartItemRow,
  type CartRow,
  type NewCartItemRow,
  type NewCartRow,
} from "./schema";

/** Walk the drizzle-wrapped driver error chain for a Postgres unique-violation. */
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && typeof e === "object" && depth < 6; depth++) {
    if ((e as { code?: string }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Per-line quantity ceiling — the same 99 the add-to-cart / quick-buy schemas and
 * the cart stepper enforce. Also the storefront per-line cap in place-order.
 */
export const CART_LINE_QTY_MAX = 99;

/**
 * Quantity of a line after an ON CONFLICT merge (repeat add-to-cart, guest-cart
 * merge on login): the SUM, capped at {@link CART_LINE_QTY_MAX} AND at the
 * product's `max_purchase_qty` when set (CHECK ≥ 1, so the cap never reaches 0).
 * Each add validates only its OWN requested quantity, so without this cap
 * repeated adds grew a line without bound — an untracked product has no stock
 * gate at place-order, so e.g. 5 000 units got placed (and `unit_price × qty`
 * could overflow int4 in the cart summaries).
 */
const MERGED_LINE_QTY = sql`LEAST(
  cart_items.quantity + EXCLUDED.quantity,
  ${CART_LINE_QTY_MAX}::int,
  COALESCE(
    (SELECT ${products.max_purchase_qty} FROM ${products} WHERE ${products.id} = EXCLUDED.product_id),
    ${CART_LINE_QTY_MAX}::int
  )
)`;

/** One row of the admin « Paniers » list. */
export type CartSummaryRow = {
  id: string;
  userId: string | null;
  token: string | null;
  currency: string;
  itemCount: number;
  /** Σ add-time `unit_price_cents × quantity` (NOT live-repriced). */
  subtotalCents: number;
  createdAt: Date;
  /** Latest of the cart's own `updated_at` and its lines' `updated_at`. */
  lastActivityAt: Date;
};

/**
 * Admin list cursor `<µs ISO>__<cart id>` → validated parts, or null (a malformed
 * cursor falls back to the first page instead of 500-ing on the casts).
 */
function parseCartListCursor(cursor: string | null | undefined): { iso: string; id: string } | null {
  if (!cursor) return null;
  const sep = cursor.lastIndexOf("__");
  if (sep <= 0) return null;
  const parsed = parseIncrementalCursor(
    new URLSearchParams({ since: cursor.slice(0, sep), sinceId: cursor.slice(sep + 2) }),
  );
  return parsed.ok && parsed.sinceIso && parsed.sinceId
    ? { iso: parsed.sinceIso, id: parsed.sinceId }
    : null;
}

class CartService {
  async findById(id: string): Promise<CartRow | null> {
    const [row] = await db.select().from(carts).where(eq(carts.id, id)).limit(1);
    return row ?? null;
  }

  async findByUserId(userId: string): Promise<CartRow | null> {
    const [row] = await db.select().from(carts).where(eq(carts.user_id, userId)).limit(1);
    return row ?? null;
  }

  async findByToken(token: string): Promise<CartRow | null> {
    const [row] = await db.select().from(carts).where(eq(carts.token, token)).limit(1);
    return row ?? null;
  }

  async createCart(input: NewCartRow): Promise<CartRow> {
    const [row] = await db.insert(carts).values(input).returning();
    return row;
  }

  /**
   * Idempotent get-or-create for a user's single cart (VULN-3). Two concurrent
   * FIRST resolves for a brand-new authenticated session both see
   * findByUserId()==null and both try to insert; the partial-unique
   * `carts_user_unique` (user_id WHERE user_id IS NOT NULL) lets only one win,
   * and the loser's insert raises 23505. Catch it and re-fetch the winner's row
   * instead of letting an unhandled exception 500 the request. The unique index
   * still guarantees exactly one cart per user.
   */
  async getOrCreateForUser(userId: string): Promise<CartRow> {
    const existing = await this.findByUserId(userId);
    if (existing) return existing;
    try {
      return await this.createCart({ user_id: userId });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const row = await this.findByUserId(userId);
        if (row) return row;
      }
      throw err;
    }
  }

  /**
   * Merge a guest (token) cart into a user's cart on login, then delete the
   * guest cart. Closes the documented hand-off the schema promised ("once the
   * user logs in, the workflow merges anonymous cart into their user cart") —
   * previously unimplemented, so a guest's cart was silently abandoned.
   *
   * Quantities for a shared (product, variant) line SUM (same capped ON CONFLICT
   * as upsertItem); the user cart's captured unit price wins on a collision, the
   * guest's price seeds a new line. The user cart is stamped
   * merged_from_cart_id/merged_at for audit, and its updated_at bumped (a merge
   * is cart activity). Returns true when items moved.
   *
   * CONCURRENCY-SAFE + IDEMPOTENT: the guest row is `SELECT … FOR UPDATE`-locked
   * inside the tx, so two concurrent triggers (resolveCart on a mutation AND the
   * shop-layout mount action) can't double-count — the second waits, then finds
   * the guest cart already deleted and no-ops. Safe to call from every path.
   */
  async mergeGuestCart(token: string, userId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [guest] = await tx
        .select()
        .from(carts)
        .where(eq(carts.token, token))
        .limit(1)
        .for("update");
      // No guest cart, or the cookie token already points at a user cart.
      if (!guest || guest.user_id) return false;

      // Acquire the target user cart race-safely: two concurrent merges with
      // DIFFERENT guest tokens for the SAME brand-new user would both see
      // target==null and both insert, the loser hitting carts_user_unique (23505)
      // and dropping its guest items. onConflictDoNothing + a FOR UPDATE re-fetch
      // makes the loser block on, then merge into, the winner's committed cart.
      let [target] = await tx
        .insert(carts)
        .values({ user_id: userId })
        .onConflictDoNothing()
        .returning();
      if (!target) {
        [target] = await tx
          .select()
          .from(carts)
          .where(eq(carts.user_id, userId))
          .limit(1)
          .for("update");
      }
      if (!target || target.id === guest.id) return false;

      const items = await tx
        .select()
        .from(cart_items)
        .where(eq(cart_items.cart_id, guest.id));
      if (items.length > 0) {
        await tx
          .insert(cart_items)
          .values(
            items.map((it) => ({
              cart_id: target.id,
              product_id: it.product_id,
              variant_id: it.variant_id,
              quantity: Math.min(it.quantity, CART_LINE_QTY_MAX),
              unit_price_cents: it.unit_price_cents,
            })),
          )
          .onConflictDoUpdate({
            target: [cart_items.cart_id, cart_items.product_id, cart_items.variant_id],
            set: {
              quantity: MERGED_LINE_QTY,
              updated_at: sql`now()`,
            },
          });
      }
      await tx
        .update(carts)
        .set({ merged_from_cart_id: guest.id, merged_at: sql`now()`, updated_at: sql`now()` })
        .where(eq(carts.id, target.id));
      // cart_items cascade via the ON DELETE CASCADE FK.
      await tx.delete(carts).where(eq(carts.id, guest.id));
      return items.length > 0;
    });
  }

  async listItems(cartId: string): Promise<CartItemRow[]> {
    return db.select().from(cart_items).where(eq(cart_items.cart_id, cartId));
  }

  /**
   * Stamp cart activity (`carts.updated_at = now()`) after a line write — the
   * `timestamps()` helper has no $onUpdate and there's no trigger, so without
   * this `updated_at` stayed the creation time forever (the admin « Dernière
   * activité » column, the list order and the guest-cart retention read it).
   * Its own statement, AFTER the line write and never inside a caller's
   * transaction: no lock is held across the two, so it can't deadlock against a
   * placement holding the cart row (it just waits for that commit).
   * Best-effort — a display / retention timestamp must not fail a cart write that
   * already succeeded (the readers also take MAX(cart_items.updated_at)).
   */
  private async touch(cartId: string): Promise<void> {
    await db
      .update(carts)
      .set({ updated_at: sql`now()` })
      .where(eq(carts.id, cartId))
      .catch((err) => {
        console.error("[cart] updated_at bump failed", err);
      });
  }

  /** Fetch by item id only — NO cart filter here. Mutation workflows must
   *  compare the returned `cart_id` against the caller's cart to block IDOR
   *  (see add-to-cart.ts). */
  async findItemById(itemId: string): Promise<CartItemRow | null> {
    const [row] = await db
      .select()
      .from(cart_items)
      .where(eq(cart_items.id, itemId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Atomic add-to-cart: relies on the `(cart_id, product_id, variant_id)`
   * unique index to collapse "first insert" and "subsequent add" into a
   * single statement.
   * Two concurrent "+1" clicks land as a single row with quantity = 2 — the
   * old SELECT-then-INSERT/UPDATE pattern lost increments under contention.
   *
   * The merged quantity is capped (MERGED_LINE_QTY: ≤ 99 and ≤ the product's
   * max_purchase_qty), so repeated adds can't grow a line without bound.
   *
   * `updated_at` uses Postgres `now()` rather than `new Date()` so the clock
   * stays consistent with the rest of the schema and Next.js 16 Cache
   * Components doesn't treat the write path as a prerender error.
   */
  async upsertItem(input: NewCartItemRow): Promise<CartItemRow> {
    const [row] = await db
      .insert(cart_items)
      .values(input)
      .onConflictDoUpdate({
        // Includes variant_id so different variants of the same product are
        // distinct lines, while re-adding the same variant merges quantities.
        target: [cart_items.cart_id, cart_items.product_id, cart_items.variant_id],
        set: {
          quantity: MERGED_LINE_QTY,
          updated_at: sql`now()`,
        },
      })
      .returning();
    await this.touch(row.cart_id);
    return row;
  }

  async setQuantity(itemId: string, quantity: number): Promise<CartItemRow | null> {
    if (quantity <= 0) {
      await this.deleteItem(itemId);
      return null;
    }
    const [row] = await db
      .update(cart_items)
      .set({ quantity, updated_at: sql`now()` })
      .where(eq(cart_items.id, itemId))
      .returning();
    if (row) await this.touch(row.cart_id);
    return row ?? null;
  }

  /** Attach (or clear, with null) the chosen Tokyo Care plan on a cart line. The
   *  plan's offering + price are re-validated at place-order; this just records
   *  the shopper's choice so it rides from cart → checkout. */
  async setCarePlan(itemId: string, carePlanId: string | null): Promise<CartItemRow | null> {
    const [row] = await db
      .update(cart_items)
      .set({ care_plan_id: carePlanId, updated_at: sql`now()` })
      .where(eq(cart_items.id, itemId))
      .returning();
    if (row) await this.touch(row.cart_id);
    return row ?? null;
  }

  async deleteItem(itemId: string): Promise<void> {
    const [gone] = await db
      .delete(cart_items)
      .where(eq(cart_items.id, itemId))
      .returning({ cartId: cart_items.cart_id });
    if (gone) await this.touch(gone.cartId);
  }

  /**
   * Row-lock the cart (`SELECT … FOR UPDATE`) inside the caller's transaction —
   * order placement's idempotency guard: two concurrent placements of the SAME
   * cart serialize on this lock. It also holds off a concurrent add-to-cart of a
   * NEW line (its FK check needs a KEY SHARE lock on this row) until the
   * placement commits. Returns false when the cart row no longer exists.
   */
  async lockForCheckout(cartId: string, tx: Tx): Promise<boolean> {
    const [row] = await tx
      .select({ id: carts.id })
      .from(carts)
      .where(eq(carts.id, cartId))
      .limit(1)
      .for("update");
    return Boolean(row);
  }

  /**
   * Delete every line of the cart and return the deleted rows (RETURNING), so
   * order placement can verify it claimed exactly the lines it priced — an empty
   * result means a concurrent placement already consumed the cart.
   */
  async clear(cartId: string, txOrDb: DbOrTx = db): Promise<CartItemRow[]> {
    return txOrDb.delete(cart_items).where(eq(cart_items.cart_id, cartId)).returning();
  }

  /**
   * Admin « Paniers » roll-up: carts holding at least one item, newest ACTIVITY
   * first, keyset-paginated. Every filter runs in SQL BEFORE the LIMIT — the old
   * version LIMITed 200 rows ordered by the never-bumped `updated_at` and only
   * then dropped the empty ones in JS, so converted / emptied carts crowded the
   * real abandoned ones out of the page.
   *
   *  - Last activity = GREATEST(carts.updated_at, MAX(cart_items.updated_at)), so
   *    carts written before `updated_at` was maintained still sort by their real
   *    last line change.
   *  - Empty carts (INNER JOIN + HAVING SUM > 0) and ephemeral quick-buy carts
   *    (`qb-…`) are excluded. `merged_at` is NOT a filter: it marks a user cart
   *    that ABSORBED a guest cart (the guest row itself is deleted) — a live cart.
   *  - `cursor` = the previous page's `nextCursor` (`<µs ISO>__<id>`); a malformed
   *    one is ignored (first page).
   */
  async listCartsWithSummary(
    opts: { cursor?: string | null; limit?: number } = {},
  ): Promise<{ items: CartSummaryRow[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50) || 50, 1), 200);
    const after = parseCartListCursor(opts.cursor);
    // Activity = GREATEST(carts.updated_at, MAX(cart_items.updated_at)): `touch()` is
    // BEST-EFFORT (it swallows errors), so a line write whose updated_at bump silently
    // failed would otherwise sort/display by a stale carts.updated_at — the MAX(line)
    // term compensates (see touch()'s note). This is an aggregate sort key, so it can't
    // be index-served; acceptable here because « Paniers » is a low-frequency admin-only
    // read. (A future indexable version would need a trigger making carts.updated_at
    // authoritative on cart_items writes, then sort on that base column.)
    const lastActivity = sql`GREATEST(${carts.updated_at}, MAX(${cart_items.updated_at}))`;

    const rows = await db
      .select({
        id: carts.id,
        userId: carts.user_id,
        token: carts.token,
        currency: carts.currency,
        createdAt: carts.created_at,
        lastActivityAt: sql<Date>`${lastActivity}`.mapWith(carts.updated_at),
        // µs-faithful cursor rendered in SQL (a JS Date truncates to ms and could
        // skip rows sharing the boundary millisecond).
        cursorTs: sql<string>`to_char(${lastActivity} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        itemCount: sql<number>`SUM(${cart_items.quantity})::int`.mapWith(Number),
        subtotalCents: sql<number>`SUM(${cart_items.unit_price_cents}::bigint * ${cart_items.quantity})`.mapWith(Number),
      })
      .from(carts)
      .innerJoin(cart_items, eq(cart_items.cart_id, carts.id))
      .where(or(isNull(carts.token), notLike(carts.token, "qb-%")))
      .groupBy(carts.id)
      .having(
        and(
          sql`SUM(${cart_items.quantity}) > 0`,
          after
            ? sql`(${lastActivity}, ${carts.id}) < (${after.iso}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(sql`${lastActivity} DESC`, desc(carts.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        userId: r.userId,
        token: r.token,
        currency: r.currency,
        itemCount: r.itemCount,
        subtotalCents: r.subtotalCents,
        createdAt: r.createdAt,
        lastActivityAt: r.lastActivityAt,
      })),
      nextCursor: rows.length > limit && last ? `${last.cursorTs}__${last.id}` : null,
    };
  }

  /**
   * Purge stale EPHEMERAL quick-buy carts (token `qb-…`) older than N days.
   * Quick-buy stages a throwaway cart per request and only deletes it on a
   * SUCCESSFUL order; a failed/abandoned express checkout leaves the row behind
   * forever. This is the sweep the place-quick-order comment anticipates. The
   * window is generous (a quick-buy completes in seconds) so an in-flight one is
   * never touched; `cart_items` rows cascade via the ON DELETE CASCADE FK.
   *
   * BATCHED in 5000-row chunks (like the audit / search / webhook purges) and
   * backed by the partial index `carts_ephemeral_purge_idx (created_at) WHERE
   * token LIKE 'qb-%'` (migration 0026): the inner SELECT is then an index scan
   * over only the ephemeral carts, and each batch commits a small transaction
   * well under the pool's 10s `statement_timeout`. A single un-batched DELETE
   * here would seq-scan the whole `carts` table (one row per anonymous visitor)
   * and, on a large store, get killed by the timeout — leaving the purge to fail
   * + the cron to retry forever. Counts via `RETURNING 1` so no id list crosses
   * the wire. Returns the total number of carts removed.
   */
  async purgeEphemeralOlderThan(days: number): Promise<number> {
    let total = 0;
    for (;;) {
      const result = await db.execute<{ count: number }>(sql`
        WITH del AS (
          DELETE FROM carts
          WHERE id IN (
            SELECT id FROM carts
            WHERE token LIKE 'qb-%'
              AND created_at < now() - make_interval(days => ${days})
            LIMIT ${CART_PURGE_BATCH_SIZE}
          )
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM del;
      `);
      const deleted = Number(result.rows[0]?.count ?? 0);
      total += deleted;
      if (deleted < CART_PURGE_BATCH_SIZE) break;
    }
    return total;
  }

  /**
   * Purge stale GUEST carts — no user, and not an ephemeral `qb-` cart (those
   * have their own 2-day sweep) — whose LAST ACTIVITY is older than N days.
   * Checkout empties a guest cart and drops its cookie but keeps the row, and an
   * abandoned one is never revisited, so they accumulated forever (and crowded
   * the admin « Paniers » list). Activity = GREATEST(carts.updated_at,
   * MAX(cart_items.updated_at)), expressed as "cart row stale AND no line touched
   * since the cutoff" — never `updated_at` alone, which item writes only started
   * bumping recently. The guest cookie lives 30 days from creation, so a 60-day
   * window only reaps carts no browser can reach any more. A leaked operator /
   * ERP ephemeral cart (`manual_…` / `erp_…`, user_id NULL) is reaped too. Lines
   * cascade; batched in 5000-row rounds like the ephemeral purge. Returns the
   * number of carts removed.
   */
  async purgeStaleGuestCarts(days: number): Promise<number> {
    let total = 0;
    for (;;) {
      const result = await db.execute<{ count: number }>(sql`
        WITH del AS (
          DELETE FROM carts
          WHERE id IN (
            SELECT c.id FROM carts c
            WHERE c.user_id IS NULL
              AND (c.token IS NULL OR c.token NOT LIKE 'qb-%')
              AND c.updated_at < now() - make_interval(days => ${days})
              AND NOT EXISTS (
                SELECT 1 FROM cart_items ci
                WHERE ci.cart_id = c.id
                  AND ci.updated_at >= now() - make_interval(days => ${days})
              )
            LIMIT ${CART_PURGE_BATCH_SIZE}
          )
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM del;
      `);
      const deleted = Number(result.rows[0]?.count ?? 0);
      total += deleted;
      if (deleted < CART_PURGE_BATCH_SIZE) break;
    }
    return total;
  }
}

/** Rows deleted per round of the batched ephemeral-cart purge. */
const CART_PURGE_BATCH_SIZE = 5000;

export const cartService = new CartService();

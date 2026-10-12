import "server-only";

import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { parseIncrementalCursor, UUID_RE } from "@/lib/api/cursor";
import { keysetAfter, keysetCursor, settledBefore } from "@/lib/api/keyset";
import { normalizePhoneDigits } from "@/lib/format/phone";
import {
  addresses,
  customer_profiles,
  type AddressRow,
  type CustomerProfileRow,
  type NewAddressRow,
  type NewCustomerProfileRow,
} from "./schema";

/** Digits-only mirror of a phone for the stored phone_normalized column;
 *  null when blank so the partial index stays tight. */
function normPhone(phone: string | null | undefined): string | null {
  const d = normalizePhoneDigits(phone);
  return d.length > 0 ? d : null;
}

/**
 * Customer service — pure CRUD on the module's own tables.
 *
 * Workflows handle:
 *   - creating profile + linking to auth user (`workflows/auth/signup.ts`)
 *   - default-address enforcement (`workflows/customer/set-default-address.ts`
 *     and `update-address.ts`)
 *   - any side effects (events, emails)
 *
 * This file only mutates the data it owns. No imports from other modules.
 */

class CustomerService {
  // ──────────────────────────────────────────────────────── profile
  async findProfileById(
    id: string,
    txOrDb: DbOrTx = db,
    opts?: { forUpdate?: boolean },
  ): Promise<CustomerProfileRow | null> {
    const q = txOrDb
      .select()
      .from(customer_profiles)
      .where(and(eq(customer_profiles.id, id), isNull(customer_profiles.deleted_at)))
      .limit(1);
    const [row] = await (opts?.forUpdate ? q.for("update") : q);
    return row ?? null;
  }

  /** Batch-load LIVE profiles by id (archived excluded). Used by the per-segment
   *  CSV export to enrich a resolved member-id set. Order is not guaranteed — the
   *  caller keys by id. */
  async findProfilesByIds(ids: string[]): Promise<CustomerProfileRow[]> {
    if (ids.length === 0) return [];
    return db
      .select()
      .from(customer_profiles)
      .where(and(inArray(customer_profiles.id, ids), isNull(customer_profiles.deleted_at)));
  }

  async insertProfile(input: NewCustomerProfileRow): Promise<CustomerProfileRow> {
    // Keep phone_normalized in lock-step with phone (single write site).
    const values =
      input.phone !== undefined
        ? { ...input, phone_normalized: normPhone(input.phone) }
        : input;
    const [row] = await db.insert(customer_profiles).values(values).returning();
    return row;
  }

  async updateProfile(
    id: string,
    patch: Partial<Omit<CustomerProfileRow, "id" | "created_at">>,
  ): Promise<CustomerProfileRow | null> {
    // Recompute phone_normalized whenever phone is part of the patch.
    const next =
      patch.phone !== undefined
        ? { ...patch, phone_normalized: normPhone(patch.phone) }
        : patch;
    const [row] = await db
      .update(customer_profiles)
      .set({ ...next, updated_at: sql`now()` })
      .where(eq(customer_profiles.id, id))
      .returning();
    return row ?? null;
  }

  async softDeleteProfile(id: string): Promise<void> {
    await db
      .update(customer_profiles)
      .set({ deleted_at: new Date(), updated_at: sql`now()` })
      .where(eq(customer_profiles.id, id));
  }

  /**
   * Every live (non-deleted) customer profile id. Used by the segmented
   * `clean` flow to soft-delete ALL profiles (not just the demo-named set).
   * Soft delete is safe here — `customer_profiles` has no slug/name unique
   * index, so a re-seed never collides on a soft-deleted row.
   */
  async listAllIds(): Promise<string[]> {
    const rows = await db
      .select({ id: customer_profiles.id })
      .from(customer_profiles)
      .where(isNull(customer_profiles.deleted_at));
    return rows.map((r) => r.id);
  }

  // ──────────────────────────────────────────────────────── addresses
  async findAddressById(id: string): Promise<AddressRow | null> {
    const [row] = await db
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, id), isNull(addresses.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  async listAddressesByProfile(profileId: string): Promise<AddressRow[]> {
    return db
      .select()
      .from(addresses)
      .where(and(eq(addresses.customer_profile_id, profileId), isNull(addresses.deleted_at)))
      .orderBy(asc(addresses.created_at));
  }

  async insertAddress(input: NewAddressRow, txOrDb: DbOrTx = db): Promise<AddressRow> {
    const [row] = await txOrDb.insert(addresses).values(input).returning();
    return row;
  }

  async updateAddress(
    id: string,
    patch: Partial<Omit<AddressRow, "id" | "created_at">>,
    txOrDb: DbOrTx = db,
  ): Promise<AddressRow | null> {
    const [row] = await txOrDb
      .update(addresses)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(addresses.id, id))
      .returning();
    return row ?? null;
  }

  async softDeleteAddress(id: string): Promise<void> {
    await db
      .update(addresses)
      .set({ deleted_at: new Date(), updated_at: sql`now()` })
      .where(eq(addresses.id, id));
  }

  /**
   * Soft-delete EVERY live address of a profile — cascades the customer archive
   * so their address PII (street / city / phone) is not left live + queryable
   * after the customer is "deleted". Mirrors PrestaShop's Customer::update
   * address cascade. Idempotent (skips already-deleted rows).
   */
  async softDeleteAddressesByProfile(profileId: string): Promise<void> {
    await db
      .update(addresses)
      .set({ deleted_at: new Date(), updated_at: sql`now()` })
      .where(and(eq(addresses.customer_profile_id, profileId), isNull(addresses.deleted_at)));
  }

  /**
   * Clear `is_default_shipping` on every other address for this customer.
   * Called inside a transaction by the set-default-address and update-address
   * workflows.
   */
  async clearDefaultShipping(
    profileId: string,
    except?: string,
    txOrDb: DbOrTx = db,
  ): Promise<void> {
    await txOrDb
      .update(addresses)
      .set({ is_default_shipping: false, updated_at: sql`now()` })
      .where(
        and(
          eq(addresses.customer_profile_id, profileId),
          eq(addresses.is_default_shipping, true),
          except ? sql`${addresses.id} <> ${except}` : sql`true`,
        ),
      );
  }

  async clearDefaultBilling(
    profileId: string,
    except?: string,
    txOrDb: DbOrTx = db,
  ): Promise<void> {
    await txOrDb
      .update(addresses)
      .set({ is_default_billing: false, updated_at: sql`now()` })
      .where(
        and(
          eq(addresses.customer_profile_id, profileId),
          eq(addresses.is_default_billing, true),
          except ? sql`${addresses.id} <> ${except}` : sql`true`,
        ),
      );
  }

  /**
   * Paginated list for the admin panel. Optional `search` matches first/last
   * name. COMPOUND keyset cursor "<created_at-iso>|<id>": `created_at` alone is
   * not unique (a bulk import inserts many profiles in one instant), so a plain
   * `lt(created_at)` cursor would SKIP rows sharing the boundary timestamp. The
   * `id` tie-breaker makes `(created_at, id)` a total order. The timestamp part
   * is µs-FAITHFUL (`keysetCursor`, bound back as a raw `::timestamptz` cast):
   * a JS-Date `toISOString()` cursor truncated `.123456` → `.123`, so every
   * not-yet-returned row in the boundary row's millisecond (a bulk import's
   * shared `now()`) failed both `<` and `=` and was silently skipped. A
   * malformed/missing cursor falls back to the first page (never a 500).
   * Mirrors `searchCustomersForAdmin`.
   */
  async list(opts: {
    search?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ items: CustomerProfileRow[]; nextCursor: string | null }> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const conditions = [isNull(customer_profiles.deleted_at)];
    if (opts.search) {
      conditions.push(
        or(
          ilike(customer_profiles.first_name, `%${opts.search}%`),
          ilike(customer_profiles.last_name, `%${opts.search}%`),
        )!,
      );
    }
    if (opts.cursor) {
      const sep = opts.cursor.lastIndexOf("|");
      const curTs = sep >= 0 ? opts.cursor.slice(0, sep) : opts.cursor;
      const curId = sep >= 0 ? opts.cursor.slice(sep + 1) : undefined;
      // Same calendar-checked ISO gate as the API feeds, so the raw-string cast
      // below can't raise 22007/22008; a bad id is malformed too (22P02).
      const ts = parseIncrementalCursor(new URLSearchParams({ since: curTs }));
      if (ts.ok && ts.sinceIso && (curId === undefined || UUID_RE.test(curId))) {
        conditions.push(
          curId
            ? sql`(${customer_profiles.created_at} < ${ts.sinceIso}::timestamptz OR (${customer_profiles.created_at} = ${ts.sinceIso}::timestamptz AND ${customer_profiles.id} < ${curId}::uuid))`
            : sql`${customer_profiles.created_at} < ${ts.sinceIso}::timestamptz`,
        );
      }
    }

    const rows = await db
      .select({ row: customer_profiles, cursor: keysetCursor(customer_profiles.created_at) })
      .from(customer_profiles)
      .where(and(...conditions))
      .orderBy(desc(customer_profiles.created_at), desc(customer_profiles.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;
    const last = trimmed[trimmed.length - 1];
    return {
      items: trimmed.map((r) => r.row),
      nextCursor: hasMore && last ? `${last.cursor}|${last.row.id}` : null,
    };
  }

  // ──────────────────────────────────────────── external API (ERP) finders

  /** Resolve a live profile by the ERP `external_ref` (the two-way link key). */
  async findByExternalRef(ref: string): Promise<CustomerProfileRow | null> {
    const clean = ref.trim();
    if (!clean) return null;
    const [row] = await db
      .select()
      .from(customer_profiles)
      .where(and(eq(customer_profiles.external_ref, clean), isNull(customer_profiles.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  /** Resolve a live profile by phone in ANY format (matched on the normalized mirror). */
  async findByPhone(phone: string): Promise<CustomerProfileRow | null> {
    const norm = normPhone(phone);
    if (!norm) return null;
    const [row] = await db
      .select()
      .from(customer_profiles)
      .where(and(eq(customer_profiles.phone_normalized, norm), isNull(customer_profiles.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Incremental-sync list for the external API — ASC `(updated_at, id)` keyset so
   * an ERP pages FORWARD through changes (mirrors `orderService.listForApi`). The
   * composite cursor guarantees progress even when many rows share one
   * `updated_at`; a bare `since` (no id) is an inclusive watermark (legacy).
   * Same shared µs keyset + settle window as orders (`@/lib/api/keyset`).
   */
  async listForApi(
    opts: {
      sinceIso?: string;
      sinceId?: string;
      limit?: number;
      /** Settle window override (seconds); 0 only for tests. */
      settleSeconds?: number;
    } = {},
  ): Promise<{ items: CustomerProfileRow[]; nextSince: string | null; nextId: string | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const conditions = [isNull(customer_profiles.deleted_at)];
    const after = keysetAfter(customer_profiles.updated_at, customer_profiles.id, opts.sinceIso, opts.sinceId);
    if (after) conditions.push(after);
    const settled = settledBefore(customer_profiles.updated_at, opts.settleSeconds);
    if (settled) conditions.push(settled);
    const rows = await db
      .select({ row: customer_profiles, cursor: keysetCursor(customer_profiles.updated_at) })
      .from(customer_profiles)
      .where(and(...conditions))
      .orderBy(asc(customer_profiles.updated_at), asc(customer_profiles.id))
      .limit(limit);
    const last = rows[rows.length - 1];
    return {
      items: rows.map((r) => r.row),
      nextSince: last ? last.cursor : null,
      nextId: last ? last.row.id : null,
    };
  }
}

export const customerService = new CustomerService();
export type { CustomerService };

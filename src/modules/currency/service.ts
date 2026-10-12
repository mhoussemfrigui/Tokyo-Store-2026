import "server-only";

import { and, eq, ne, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { currencies, type CurrencyRow, type CurrencySymbolPosition } from "./schema";

/** Internal rollback signal: the target row wasn't activated (deleted mid-tx). */
class CurrencyNotActivatedError extends Error {}

/**
 * Writes for the currency registry. `setActive` flips the chosen row on and
 * every other row off inside ONE transaction so the "exactly one active"
 * invariant (also pinned by the partial unique index) never transiently breaks.
 */
class CurrencyService {
  // NOTE: the per-currency `decimals` column is NOT set here — display precision is
  // governed globally by the `price.decimals` setting, so the column keeps its schema
  // default and nothing reads it (see schema.ts). It is intentionally not a create/update
  // input.
  async create(input: {
    code: string;
    name: string;
    symbol: string;
    symbolPosition: CurrencySymbolPosition;
    displayOrder?: number;
  }): Promise<CurrencyRow> {
    const [row] = await db
      .insert(currencies)
      .values({
        code: input.code,
        name: input.name,
        symbol: input.symbol,
        symbol_position: input.symbolPosition,
        is_active: false,
        display_order: input.displayOrder ?? 0,
      })
      .returning();
    return row!;
  }

  async update(
    id: string,
    patch: Partial<{
      code: string;
      name: string;
      symbol: string;
      symbolPosition: CurrencySymbolPosition;
      displayOrder: number;
    }>,
  ): Promise<void> {
    const set: Record<string, unknown> = { updated_at: sql`now()` };
    if (patch.code !== undefined) set.code = patch.code;
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.symbol !== undefined) set.symbol = patch.symbol;
    if (patch.symbolPosition !== undefined) set.symbol_position = patch.symbolPosition;
    if (patch.displayOrder !== undefined) set.display_order = patch.displayOrder;
    await db.update(currencies).set(set).where(eq(currencies.id, id));
  }

  /** Make `id` the single active currency (atomically deactivates all others). */
  /**
   * Make `id` the single active currency. Returns false — and rolls the
   * deactivation back, so the store never ends up with ZERO active currency —
   * when the row no longer exists (a concurrent delete between the caller's
   * pre-read and this write). The activate UPDATE's rowcount is the atomic check
   * (mirrors stockLocationService.setDefault).
   */
  async setActive(id: string): Promise<boolean> {
    try {
      await db.transaction(async (tx) => {
        // Deactivate every OTHER row first so the partial unique index never sees
        // two active rows mid-transaction.
        await tx
          .update(currencies)
          .set({ is_active: false, updated_at: sql`now()` })
          .where(ne(currencies.id, id));
        const activated = await tx
          .update(currencies)
          .set({ is_active: true, updated_at: sql`now()` })
          .where(eq(currencies.id, id))
          .returning({ id: currencies.id });
        if (activated.length === 0) throw new CurrencyNotActivatedError();
      });
    } catch (err) {
      if (err instanceof CurrencyNotActivatedError) return false;
      throw err;
    }
    return true;
  }

  /**
   * Delete a currency ONLY when it is NOT the active one — atomically. The
   * `is_active = false` predicate is the authoritative guard: a concurrent
   * `setActive` that made this row active between the caller's pre-check and here
   * deletes 0 rows (returns false) rather than removing the now-active currency,
   * which would leave the store with ZERO active currencies (the partial unique
   * index forbids two active, not zero). Returns whether a row was deleted.
   */
  async remove(id: string): Promise<boolean> {
    const deleted = await db
      .delete(currencies)
      .where(and(eq(currencies.id, id), eq(currencies.is_active, false)))
      .returning({ id: currencies.id });
    return deleted.length > 0;
  }
}

export const currencyService = new CurrencyService();

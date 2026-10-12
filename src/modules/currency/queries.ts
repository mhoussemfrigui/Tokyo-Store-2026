import "server-only";

import { asc, eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { currencies, type CurrencyRow } from "./schema";

/** Reads for the currency registry. */

/** All currencies, ordered for the admin list. */
export async function list(): Promise<CurrencyRow[]> {
  return db
    .select()
    .from(currencies)
    .orderBy(asc(currencies.display_order), asc(currencies.code));
}

/** The single active currency, or null when none is flagged (cold/empty DB). */
export async function getActive(): Promise<CurrencyRow | null> {
  const [row] = await db.select().from(currencies).where(eq(currencies.is_active, true)).limit(1);
  return row ?? null;
}

/** A single currency by id, or null when it doesn't exist. */
export async function getById(id: string): Promise<CurrencyRow | null> {
  const [row] = await db.select().from(currencies).where(eq(currencies.id, id)).limit(1);
  return row ?? null;
}

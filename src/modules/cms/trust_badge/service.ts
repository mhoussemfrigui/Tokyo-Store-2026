import "server-only";

import { asc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { CMS_LIST_CAP } from "../list-cap";
import { trust_badges, type NewTrustBadgeRow, type TrustBadgeRow } from "./schema";

class TrustBadgeService {
  async findById(id: string): Promise<TrustBadgeRow | null> {
    const [row] = await db.select().from(trust_badges).where(eq(trust_badges.id, id)).limit(1);
    return row ?? null;
  }
  async list(): Promise<TrustBadgeRow[]> {
    // Bounded admin list (safety ceiling, not pagination — see CMS_LIST_CAP).
    // asc(id) is a deterministic tiebreaker — display_order defaults to 0 so
    // ties are the norm; without it Postgres returns tied rows in an unstable,
    // request-to-request order (uuid v7 ≈ creation order).
    return db
      .select()
      .from(trust_badges)
      .orderBy(asc(trust_badges.display_order), asc(trust_badges.id))
      .limit(CMS_LIST_CAP);
  }
  /** Storefront-visible badges: is_active, ordered. Stock gating is a render-time
   *  concern (the `visibility` column), not a query filter. Capped like list()
   *  (defense on the per-request path) with the same stable tiebreaker. */
  async listActive(): Promise<TrustBadgeRow[]> {
    return db
      .select()
      .from(trust_badges)
      .where(eq(trust_badges.is_active, true))
      .orderBy(asc(trust_badges.display_order), asc(trust_badges.id))
      .limit(CMS_LIST_CAP);
  }
  /** The next free display_order (max + 1, or 0 when empty) — so a freshly
   *  created badge appends to the end instead of piling onto display_order 0. */
  async nextDisplayOrder(): Promise<number> {
    const [row] = await db
      .select({ max: sql<number | null>`max(${trust_badges.display_order})` })
      .from(trust_badges);
    return (row?.max ?? -1) + 1;
  }
  async insert(input: NewTrustBadgeRow): Promise<TrustBadgeRow> {
    const [row] = await db.insert(trust_badges).values(input).returning();
    return row;
  }
  async update(id: string, patch: Partial<Omit<TrustBadgeRow, "id" | "created_at">>) {
    const [row] = await db
      .update(trust_badges)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(trust_badges.id, id))
      .returning();
    return row ?? null;
  }
  /** Hard-delete; returns the removed row (null when nothing matched) so the
   *  workflow can report not_found and emit a meaningful audit payload. */
  async delete(id: string): Promise<TrustBadgeRow | null> {
    const [row] = await db.delete(trust_badges).where(eq(trust_badges.id, id)).returning();
    return row ?? null;
  }
}

export const trustBadgeService = new TrustBadgeService();

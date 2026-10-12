import "server-only";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  customer_profiles,
  customer_segment_members,
  customer_segments,
  type CustomerSegmentRow,
  type NewCustomerSegmentRow,
} from "./schema";

/**
 * Customer SEGMENTS service (migration 0042) — reusable groupings a promotion
 * targets. Manual segments carry explicit members; dynamic segments carry a
 * `rule` evaluated at request-time (see src/lib/promotions/segments.ts). Pure
 * data, no other-module imports beyond the customer schema.
 */
class SegmentService {
  async list(opts: { includeDisabled?: boolean } = {}): Promise<CustomerSegmentRow[]> {
    const rows = await db
      .select()
      .from(customer_segments)
      .where(isNull(customer_segments.deleted_at))
      .orderBy(asc(customer_segments.name));
    return opts.includeDisabled ? rows : rows.filter((r) => r.enabled);
  }

  async get(id: string): Promise<CustomerSegmentRow | null> {
    const [row] = await db
      .select()
      .from(customer_segments)
      .where(and(eq(customer_segments.id, id), isNull(customer_segments.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  async insert(input: NewCustomerSegmentRow): Promise<CustomerSegmentRow> {
    const [row] = await db.insert(customer_segments).values(input).returning();
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<CustomerSegmentRow, "id" | "created_at">>,
  ): Promise<CustomerSegmentRow | null> {
    const [row] = await db
      .update(customer_segments)
      .set({ ...patch, updated_at: sql`now()` })
      .where(and(eq(customer_segments.id, id), isNull(customer_segments.deleted_at)))
      .returning();
    return row ?? null;
  }

  async softDelete(id: string): Promise<void> {
    await db
      .update(customer_segments)
      .set({ deleted_at: new Date(), updated_at: sql`now()` })
      .where(eq(customer_segments.id, id));
  }

  // ───────────────────────────────────────────── manual membership
  /** Members of a manual segment, joined to profile name (admin display).
   *  LIVE profiles only: an archived customer's membership row is inert (the
   *  buyer context and the audiences skip archived profiles), so listing it
   *  would show a member who can never match nor be mailed. */
  async listMembers(
    segmentId: string,
  ): Promise<Array<{ profileId: string; firstName: string; lastName: string }>> {
    return db
      .select({
        profileId: customer_segment_members.customer_profile_id,
        firstName: customer_profiles.first_name,
        lastName: customer_profiles.last_name,
      })
      .from(customer_segment_members)
      .innerJoin(
        customer_profiles,
        and(
          eq(customer_profiles.id, customer_segment_members.customer_profile_id),
          isNull(customer_profiles.deleted_at),
        ),
      )
      .where(eq(customer_segment_members.segment_id, segmentId))
      .orderBy(desc(customer_segment_members.created_at));
  }

  /** @returns true if a NEW membership row was inserted (false if it already existed). */
  async addMember(segmentId: string, profileId: string): Promise<boolean> {
    const inserted = await db
      .insert(customer_segment_members)
      .values({ segment_id: segmentId, customer_profile_id: profileId })
      .onConflictDoNothing()
      .returning({ segmentId: customer_segment_members.segment_id });
    return inserted.length > 0;
  }

  /** @returns true if a membership row was actually deleted (false if none matched). */
  async removeMember(segmentId: string, profileId: string): Promise<boolean> {
    const deleted = await db
      .delete(customer_segment_members)
      .where(
        and(
          eq(customer_segment_members.segment_id, segmentId),
          eq(customer_segment_members.customer_profile_id, profileId),
        ),
      )
      .returning({ segmentId: customer_segment_members.segment_id });
    return deleted.length > 0;
  }

  /** Validate a set of segment ids exist + are LIVE (enabled, not soft-deleted) —
   *  used by promo targeting so a disabled/deleted segment can't be saved as a target. */
  async filterLiveIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await db
      .select({ id: customer_segments.id })
      .from(customer_segments)
      .where(
        and(
          inArray(customer_segments.id, ids),
          eq(customer_segments.enabled, true),
          isNull(customer_segments.deleted_at),
        ),
      );
    return new Set(rows.map((r) => r.id));
  }
}

export const segmentService = new SegmentService();
export type { SegmentService };

import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { redirects, type RedirectRow, type RedirectStatusCode } from "./schema";
import type { ParsedRedirect } from "@/lib/redirects/normalize";

/**
 * Writes for the redirects module. All inputs are expected pre-normalized by
 * lib/redirects/normalize.ts (the action / CSV-import layer normalizes before
 * calling here). `create`/`bulkUpsert` conflict on the unique `source_path`.
 */
class RedirectService {
  /**
   * Insert a NEW rule. Returns null when a rule already exists for that source —
   * a create never silently overwrites (and re-activates) another rule's
   * destination / status / notes; the caller reports the conflict instead. (The
   * CSV import's explicit "update existing sources" semantics is `bulkUpsert`.)
   */
  async create(input: {
    sourcePath: string;
    destination: string;
    statusCode: RedirectStatusCode;
    isActive?: boolean;
    notes?: string | null;
  }): Promise<RedirectRow | null> {
    const [row] = await db
      .insert(redirects)
      .values({
        source_path: input.sourcePath,
        destination: input.destination,
        status_code: input.statusCode,
        is_active: input.isActive ?? true,
        notes: input.notes ?? null,
      })
      .onConflictDoNothing({ target: redirects.source_path })
      .returning();
    return row ?? null;
  }

  /** Patch a rule. A `sourcePath` already used by another rule throws the
   *  UNIQUE `redirects_source_unique` violation (23505) — callers map it. */
  async update(
    id: string,
    patch: Partial<{
      sourcePath: string;
      destination: string;
      statusCode: RedirectStatusCode;
      isActive: boolean;
      notes: string | null;
    }>,
  ): Promise<void> {
    const set: Record<string, unknown> = { updated_at: sql`now()` };
    if (patch.sourcePath !== undefined) set.source_path = patch.sourcePath;
    if (patch.destination !== undefined) set.destination = patch.destination;
    if (patch.statusCode !== undefined) set.status_code = patch.statusCode;
    if (patch.isActive !== undefined) set.is_active = patch.isActive;
    if (patch.notes !== undefined) set.notes = patch.notes;
    await db.update(redirects).set(set).where(eq(redirects.id, id));
  }

  async setActive(id: string, isActive: boolean): Promise<void> {
    await db
      .update(redirects)
      .set({ is_active: isActive, updated_at: sql`now()` })
      .where(eq(redirects.id, id));
  }

  async remove(id: string): Promise<void> {
    await db.delete(redirects).where(eq(redirects.id, id));
  }

  /**
   * Bulk import (CSV): upsert each parsed row on `source_path`. Returns how many
   * were inserted vs updated. Chunked so a large import stays a few round-trips.
   */
  async bulkUpsert(rows: ParsedRedirect[]): Promise<{ inserted: number; updated: number }> {
    if (rows.length === 0) return { inserted: 0, updated: 0 };
    let inserted = 0;
    let updated = 0;
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const res = await db
        .insert(redirects)
        .values(
          slice.map((r) => ({
            source_path: r.source,
            destination: r.destination,
            status_code: r.status,
            is_active: true,
          })),
        )
        .onConflictDoUpdate({
          target: redirects.source_path,
          set: {
            destination: sql`excluded.destination`,
            status_code: sql`excluded.status_code`,
            // Re-importing a source re-activates it (excluded.is_active is the
            // inserted `true`) — an import is an explicit "make these live" intent,
            // so it shouldn't silently leave a previously-toggled-off row disabled.
            is_active: sql`excluded.is_active`,
            updated_at: sql`now()`,
          },
        })
        .returning({ created: redirects.created_at, updated: redirects.updated_at });
      // A freshly inserted row has created_at == updated_at; an updated one bumped
      // updated_at via now(). Same-tick equality is possible but rare → close enough
      // for the import summary.
      for (const r of res) {
        if (r.created && r.updated && r.created.getTime() === r.updated.getTime()) inserted++;
        else updated++;
      }
    }
    return { inserted, updated };
  }

  /**
   * Bump the hit counter (fire-and-forget from the resolver — a lost increment
   * is acceptable, the count is advisory). One atomic `hits + 1` UPDATE per hit;
   * fine at this app's single-region scale. If a single redirect ever became
   * extremely hot, sample (1-in-N) or buffer/flush instead.
   */
  async recordHit(id: string): Promise<void> {
    await db
      .update(redirects)
      .set({ hits: sql`${redirects.hits} + 1`, last_hit_at: sql`now()` })
      .where(eq(redirects.id, id));
  }
}

export const redirectService = new RedirectService();

import "server-only";

import { eq, inArray, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { site_settings, type NewSiteSettingRow, type SiteSettingRow } from "./schema";

class SettingService {
  async findByKey(key: string): Promise<SiteSettingRow | null> {
    const [row] = await db
      .select()
      .from(site_settings)
      .where(eq(site_settings.key, key))
      .limit(1);
    return row ?? null;
  }

  /** Read many rows in ONE index-served query (served by settings_key_unique) —
   *  used by the batch upsert to diff existing values without an N× findByKey. */
  async findManyByKeys(keys: string[]): Promise<SiteSettingRow[]> {
    if (keys.length === 0) return [];
    return db.select().from(site_settings).where(inArray(site_settings.key, keys));
  }

  /**
   * Atomic upsert by `key` (single statement, via the `settings_key_unique`
   * index). The previous read-then-branch could lose a concurrent double-submit
   * to a unique-violation; `onConflictDoUpdate` removes that race AND halves the
   * round-trips. The SET list enumerates updatable columns so the conflicting
   * row's id/key are never overwritten.
   */
  async upsert(input: NewSiteSettingRow, txOrDb: DbOrTx = db): Promise<SiteSettingRow> {
    const [row] = await txOrDb
      .insert(site_settings)
      .values(input)
      .onConflictDoUpdate({
        target: site_settings.key,
        set: {
          value: input.value,
          type: input.type,
          group_key: input.group_key,
          label: input.label,
          description: input.description,
          updated_at: sql`now()`,
        },
      })
      .returning();
    return row;
  }

  /**
   * Hard-delete a set of settings by key. Reserved for trusted callers that
   * already know their keys (e.g. the demo seed wipe, which deletes only keys
   * it itself created) — there is no per-key system-namespace guard here, so a
   * caller must pass only keys it owns.
   *
   * Returns the ids of rows actually removed so the demo workflow can
   * report counts.
   */
  async deleteByKeys(keys: string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    const rows = await db
      .delete(site_settings)
      .where(inArray(site_settings.key, keys))
      .returning({ id: site_settings.id });
    return rows.map((r) => r.id);
  }
}

export const settingService = new SettingService();

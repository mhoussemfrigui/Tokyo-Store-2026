import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import type { CustomerSegmentRow } from "@/modules/customer/schema";
import { legacyRuleToTree } from "./rule-tree";
import {
  buildSegmentSqlCtx,
  rowToSegmentStats,
  SEGMENT_STATS_COLUMNS,
  segmentStatsSql,
  type SegmentStats,
} from "./rule-tree-sql";

export type { SegmentStats };

/**
 * Per-segment « Statistiques » — the live demographic breakdown of a segment's
 * members (total, purchased/not-yet, mailable opt-in subset, gender split,
 * cumulative spend). A DYNAMIC segment resolves through the shared SQL compiler
 * (same engine as targeting/mailing, so the count matches what a blast reaches);
 * a MANUAL segment aggregates its member rows. Both count LIVE profiles only
 * (deleted_at IS NULL) and report the SAME shape.
 */
export async function segmentStats(
  segment: Pick<CustomerSegmentRow, "id" | "kind" | "rule" | "rule_tree">,
): Promise<SegmentStats> {
  if (segment.kind === "dynamic") {
    const ctx = await buildSegmentSqlCtx();
    return segmentStatsSql(segment.rule_tree ?? legacyRuleToTree(segment.rule), ctx);
  }
  // Manual: aggregate the (live) member rows with the SAME column set as the
  // dynamic path, aliasing customer_profiles as `p`.
  const res = await db.execute(sql`
    select ${SEGMENT_STATS_COLUMNS}
    from customer_segment_members m
    join customer_profiles p on p.id = m.customer_profile_id and p.deleted_at is null
    where m.segment_id = ${segment.id}
  `);
  return rowToSegmentStats((res as unknown as { rows: Array<Record<string, unknown>> }).rows[0]);
}

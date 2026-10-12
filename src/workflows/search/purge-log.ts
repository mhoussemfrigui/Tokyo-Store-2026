import "server-only";

import { z } from "zod";

import { searchService } from "@/modules/search";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Delete `search_log` rows older than `olderThanDays`. Operator-triggered
 * retention sweep from the Recherche control center (Système → Recherche →
 * Purge), whose manual purge button passes the CONFIGURED window
 * (`search.purge_months` × 30, default 3 months = 90 days).
 *
 * The window is clamped to [7, 730] days (`min(7)…max(730)` below, mirroring
 * `searchService.purgeOlderThan`) so a stray UI value can't wipe this week's
 * telemetry. Emits `search_log.purged` so the removal is itself audited.
 */
export const purgeSearchLogSchema = z.object({
  olderThanDays: z.number().int().min(7).max(730),
});

export const purgeSearchLogWorkflow = workflow<
  [z.input<typeof purgeSearchLogSchema>, { actorUserId: string }],
  { deletedCount: number; olderThanDays: number }
>("search.purgeLog", async (input, { actorUserId }) => {
  const parsed = purgeSearchLogSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  const deleted = await searchService.purgeOlderThan(parsed.data.olderThanDays);
  await bus.emit(
    "search_log.purged",
    { olderThanDays: parsed.data.olderThanDays, deletedCount: deleted },
    { actorUserId },
  );
  return ok({ deletedCount: deleted, olderThanDays: parsed.data.olderThanDays });
});

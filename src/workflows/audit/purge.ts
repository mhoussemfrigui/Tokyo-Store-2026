import "server-only";

import { z } from "zod";

import { auditService } from "@/modules/audit/service";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Hard-delete audit entries older than `olderThanDays`. Operator-triggered
 * compliance purge — the UI exposes a fixed "> 1 an" button (365 days).
 *
 * The minimum window is 30 days so a stray UI bug can't wipe yesterday's
 * activity. Emits `audit.purged` so the very removal is itself audited.
 */
export const purgeAuditSchema = z.object({
  olderThanDays: z.number().int().min(30).max(3650),
});

export const purgeAuditWorkflow = workflow<
  [z.input<typeof purgeAuditSchema>, { actorUserId: string }],
  { deletedCount: number; olderThanDays: number }
>("audit.purge", async (input, { actorUserId }) => {
  const parsed = purgeAuditSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  const deleted = await auditService.purgeOlderThan(parsed.data.olderThanDays);
  await bus.emit(
    "audit.purged",
    { olderThanDays: parsed.data.olderThanDays, deletedCount: deleted },
    { actorUserId },
  );
  return ok({ deletedCount: deleted, olderThanDays: parsed.data.olderThanDays });
});

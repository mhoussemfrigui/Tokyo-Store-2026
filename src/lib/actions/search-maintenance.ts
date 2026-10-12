"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";

/**
 * Retention sweep for the `search_log` telemetry table. Without this the
 * table grows unbounded (every storefront search appends a row). The Recherche
 * → Purge tab's manual button passes the CONFIGURED window
 * (`search.purge_months` × 30), identical to the automatic cron purge.
 *
 * The window is floored at 7 days here and re-clamped inside the workflow /
 * service (max 730) so a stray UI value can never wipe recent telemetry.
 */
export async function purgeSearchLogAction(input: {
  olderThanDays: number;
}): Promise<ActionState & { deletedCount?: number }> {
  const session = await requirePermission("system_search", "manage");
  const days = Math.max(7, Math.floor(input.olderThanDays));
  const result = await workflows.search.purgeLog(
    { olderThanDays: days },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/system/search");
  return {
    ok: true,
    message: `${result.data.deletedCount} entrée${result.data.deletedCount === 1 ? "" : "s"} purgée${result.data.deletedCount === 1 ? "" : "s"} (> ${days} jours).`,
    deletedCount: result.data.deletedCount,
  };
}

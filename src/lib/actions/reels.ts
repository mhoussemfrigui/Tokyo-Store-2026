"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { parseReelsVideos, serializeReelsVideos, REELS_VIDEOS_KEY } from "@/lib/cms/reels-content";

/**
 * Save the storefront « Nos vidéos » (/reels) library to the `reels.videos`
 * setting. The panel posts the whole list as JSON in `reels_json`; it is parsed
 * and re-serialized through the shared model (drops any row with no video URL,
 * coerces platform/topic, trims) so only clean, real data is stored.
 */
export async function saveReelsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("reels", "update");
  const raw = String(formData.get("reels_json") ?? "");
  const value = serializeReelsVideos(parseReelsVideos(raw));
  const res = await workflows.cms.upsertSettingsBatch(
    {
      settings: [
        {
          key: REELS_VIDEOS_KEY,
          value,
          type: "text" as const,
          groupKey: "reels",
          label: "Vidéos (Reels)",
        },
      ],
    },
    { actorUserId: session.user.id },
  );
  if (!res.ok) return { ok: false, error: res.error, message: res.message, fieldErrors: res.fieldErrors };
  revalidatePath("/admin/cms/reels");
  revalidatePath("/reels");
  return { ok: true, message: "Vidéos enregistrées." };
}

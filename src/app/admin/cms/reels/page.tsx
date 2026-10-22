import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { resolveReelsVideos } from "@/lib/cms/reels-content";
import { ReelsAdminPanel } from "./reels-panel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Vidéos (Reels)" };

export default async function ReelsAdminPage() {
  await requirePermission("reels", "view");
  const videos = resolveReelsVideos(await getSettingsMap());
  return <ReelsAdminPanel videos={videos} />;
}

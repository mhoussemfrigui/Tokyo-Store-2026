/**
 * Import the Tokyo Store migration feed (Google-Merchant RSS) into the backend
 * catalogue — mirrors `startProductImportAction` but runs headless (no admin
 * session, no 8 MB upload cap). Run AFTER `tokyo-build-categories.ts` so feed
 * breadcrumbs map onto the real nested category tree.
 *
 * Creates products + brands (find-or-create) and downloads every image through
 * the SSRF-hardened media pipeline (sharp → webp/avif → SeaweedFS). ~2.6k
 * products × up to 8 images ⇒ long-running; run it in the background.
 *
 *   pnpm tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     scripts/tokyo-import-feed.ts "/home/mhoussem/Desktop/Tokyo Store Migration Data/tokyostore.xml"
 */
import fs from "node:fs";

import { db } from "@/lib/db/client";
import { users } from "@/modules/auth/schema";
import { importJobService } from "@/modules/import";
import { runProductImport } from "@/workflows/import/run-product-import";

const FEED =
  process.argv[2] ?? "/home/mhoussem/Desktop/Tokyo Store Migration Data/tokyostore.xml";

async function main(): Promise<void> {
  const xml = fs.readFileSync(FEED, "utf8");
  const [u] = await db.select({ id: users.id, email: users.email }).from(users).limit(1);
  if (!u) throw new Error("no user found to attribute the import");

  const job = await importJobService.createIfIdle({
    format: "xml",
    filename: FEED.split("/").pop() ?? "tokyostore.xml",
    source_content: xml,
    created_by: u.id,
  });
  if (!job) throw new Error("an import job is already active");
  console.log(`[import] job ${job.id} created (actor ${u.email}); running…`);

  await runProductImport(job.id, u.id);

  const done = await importJobService.findById(job.id);
  console.log(`[import] status=${done?.status} processed=${done?.processed}/${done?.total}`);
  console.log(`[import] result=${JSON.stringify(done?.result ?? null, null, 2)}`);
  process.exit(done?.status === "completed" ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

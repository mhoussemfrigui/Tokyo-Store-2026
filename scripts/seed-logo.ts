/**
 * One-time seed: ingest the Tokyo Store logo into the médiathèque (the
 * SAME pipeline an admin upload uses — sharp variants → object store → media row) and
 * point `site.logo_media_id` at it. Backend-correct: the header/footer resolve
 * the logo URL from this setting via the média facade — no hardcoded asset.
 *
 *   pnpm tsx --conditions=react-server --env-file-if-exists=.env.local scripts/seed-logo.ts
 */
import { readFile } from "node:fs/promises";
import { File } from "node:buffer";
import path from "node:path";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { uploadMediaWorkflow } from "@/workflows/media/upload-media";
import { settingService } from "@/modules/cms/setting/service";

const LOGO_SRC = path.resolve(
  process.cwd(),
  "..",
  "tokyo-medusa",
  "storefront",
  "assets",
  "logo-rk.png",
);

async function main() {
  // The médiathèque upload records an `uploaded_by` actor — use the bootstrap
  // admin. Access is role-only (the users.role enum was retired): an admin holds
  // the RBAC `*` wildcard via user_roles → role_permissions.
  const adminRes = await db.execute<{ id: string }>(
    sql`SELECT u.id FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.permission = '*'
        WHERE u.disabled_at IS NULL
        ORDER BY u.created_at LIMIT 1`,
  );
  const adminId = adminRes.rows[0]?.id;
  if (!adminId) throw new Error("No admin user found — boot the app once to create the default admin.");

  const buf = await readFile(LOGO_SRC);
  const file = new File([buf], "tokyo-store-logo.png", { type: "image/png" });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await uploadMediaWorkflow({ file: file as any, scope: "cms", altText: "Tokyo Store", uploadedBy: adminId });
  if (!res.ok) {
    console.error("[seed-logo] upload failed:", res);
    process.exit(1);
  }
  console.log("[seed-logo] uploaded → media", res.data.mediaId, res.data.url);

  await settingService.upsert({
    key: "site.logo_media_id",
    value: res.data.mediaId,
    type: "media",
    group_key: "branding",
    label: "Logo du site (médiathèque)",
    description: null,
  });
  console.log("[seed-logo] site.logo_media_id =", res.data.mediaId);
  process.exit(0);
}

main().catch((e) => {
  console.error("[seed-logo] error:", e);
  process.exit(1);
});

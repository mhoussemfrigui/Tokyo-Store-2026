/**
 * Seed the demo store: runs the demo import workflow (seeds the high-tech
 * categories + brands + banners + settings + nav + FAQs), then kicks the product
 * import from public/demo-assets/tokyostore.xml (the live Tokyo Store catalogue
 * export) and WAITS on the import job so the detached runner isn't killed on
 * process exit.
 *
 *   pnpm tsx --conditions=react-server --env-file-if-exists=.env.local scripts/seed-demo.ts
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { importDemoWorkflow } from "@/workflows/demo/import-demo";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Access is role-only (the users.role enum was retired): an admin is an active
  // account holding the RBAC `*` wildcard via user_roles → role_permissions.
  const adminRes = await db.execute<{ id: string }>(
    sql`SELECT u.id FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.permission = '*'
        WHERE u.disabled_at IS NULL
        ORDER BY u.created_at LIMIT 1`,
  );
  const adminId = adminRes.rows[0]?.id;
  if (!adminId) throw new Error("No admin user found — boot the app once first.");

  console.log("[seed-demo] seeding chrome + kicking product import…");
  const res = await importDemoWorkflow({ actorUserId: adminId });
  const data = (res as { ok?: boolean; data?: unknown }).data ?? res;
  console.log("[seed-demo] result:", JSON.stringify(data).slice(0, 1500));

  const jobId = (data as { productImportJobId?: string | null })?.productImportJobId ?? null;
  if (!jobId) {
    console.log("[seed-demo] no product import job — chrome seeded. Done.");
    process.exit(0);
  }

  console.log("[seed-demo] waiting on product import job", jobId, "…");
  const deadline = Date.now() + 9 * 60 * 1000;
  let last = "";
  while (Date.now() < deadline) {
    const r = await db.execute<{ status: string; processed: number }>(
      sql`SELECT status, processed FROM import_jobs WHERE id = ${jobId}`,
    );
    const row = r.rows[0];
    if (!row) {
      console.log("[seed-demo] job row missing — stopping.");
      break;
    }
    const line = `${row.status} · ${row.processed} traités`;
    if (line !== last) {
      console.log("[seed-demo]", line);
      last = line;
    }
    if (row.status === "completed" || row.status === "failed") break;
    await sleep(5000);
  }
  console.log("[seed-demo] done.");
  process.exit(0);
}

main().catch((e) => {
  console.error("[seed-demo] error:", e);
  process.exit(1);
});

import "server-only";

/**
 * Per-segment CSV export building blocks (Phase 6i). The HTTP route itself is auth-
 * gated (customers:export), so this covers its NEW, testable-without-a-request logic:
 *   • customerService.findProfilesByIds — batch, LIVE-only (archived excluded);
 *   • the extracted shared CUSTOMER_CSV_FIELDS accessors + the ?fields= selection
 *     (used by BOTH the Clients export and this segment export, so a refactor drift
 *     shows up here).
 * Self-cleaning (__sgx-exp). Run:
 *   tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/segment-export.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { customer_profiles, type CustomerProfileRow } from "@/modules/customer/schema";
import { selectCsvFields, csvHeaderLine, csvRowLine } from "@/lib/csv/fields";
import { CUSTOMER_CSV_FIELDS, CUSTOMER_ROW_VALUE, type CustomerExportRow } from "@/lib/export/customer-row";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__sgx-exp";

async function cleanup() {
  await db.execute(sql`delete from customer_user_links where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from customer_profiles where last_name like ${TAG + "%"}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
}

async function mk(key: string, o: { gender: string | null; deleted?: boolean }): Promise<string> {
  const uid = `${TAG}-${key}`;
  await authService.insert({ id: uid, email: `${uid}@x.test`, name: uid, role: "customer", emailVerified: true } as never);
  const [p] = await db
    .insert(customer_profiles)
    .values({
      first_name: key,
      last_name: `${TAG}-${key}`,
      gender: o.gender,
      deleted_at: o.deleted ? new Date() : null,
    } as never)
    .returning({ id: customer_profiles.id });
  await customerUserLink.create({ customer_profile_id: p.id, user_id: uid } as never);
  return p.id;
}

async function main() {
  await cleanup();

  const live1 = await mk("live1", { gender: "female" });
  const live2 = await mk("live2", { gender: null });
  const archived = await mk("arch", { gender: "male" });
  await db.execute(sql`update customer_profiles set deleted_at = now() where id = ${archived}`);

  // ── findProfilesByIds: batch, LIVE-only ──
  const got = await customerService.findProfilesByIds([live1, live2, archived]);
  const gotIds = new Set(got.map((p) => p.id));
  check("findProfilesByIds → returns both live profiles", gotIds.has(live1) && gotIds.has(live2));
  check("findProfilesByIds → excludes the archived profile", !gotIds.has(archived));
  check("findProfilesByIds([]) → empty (no query)", (await customerService.findProfilesByIds([])).length === 0);

  // ── Shared CSV accessors + ?fields= selection ──
  const row: CustomerExportRow = {
    p: got.find((p) => p.id === live1) as CustomerProfileRow,
    email: "buyer@x.test",
  };
  // Full catalog header includes the localized column labels.
  const allHeader = csvHeaderLine(CUSTOMER_CSV_FIELDS);
  check("header has Genre + Email columns", allHeader.includes("Genre") && allHeader.includes("Email"));

  // A ?fields= subset selects + orders exactly those columns.
  const subset = selectCsvFields(CUSTOMER_CSV_FIELDS, "email,gender,firstName");
  check("subset selection → 3 columns", subset.length === 3);
  const rowLine = csvRowLine(subset, row);
  check("row → email value", rowLine.includes("buyer@x.test"));
  check("row → gender label mapped (female → Femme)", rowLine.includes("Femme"));
  check("row → first-name passthrough (live1)", rowLine.includes("live1"));

  // Accessor unit checks (the extraction must preserve formatting).
  check("VALUE.gender: null → empty string", CUSTOMER_ROW_VALUE.gender({ ...row, p: { ...row.p, gender: null } }) === "");
  check("VALUE.marketing: false → « non »", CUSTOMER_ROW_VALUE.marketing({ ...row, p: { ...row.p, marketing_opt_in: false } }) === "non");

  await cleanup();
  console.log(`\n=== segment-export: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch { /* best-effort */ }
  process.exit(1);
});

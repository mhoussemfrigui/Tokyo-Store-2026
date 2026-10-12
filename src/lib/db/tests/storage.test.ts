/**
 * Pure storage summariser (src/lib/telemetry/storage.ts). No DB, no server-only.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/storage.test.ts
 */
import {
  summarizeStorage,
  groupForTable,
  LOG_TABLES,
  type TableSize,
} from "@/lib/telemetry/storage";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function t(relname: string, totalBytes: number, heapBytes: number, indexBytes: number): TableSize {
  return { relname, totalBytes, heapBytes, indexBytes, rows: 0 };
}

function main() {
  console.log("groupForTable:");
  check("audit_log → logs (explicit, before prefix)", groupForTable("audit_log").key === "logs");
  check("cart_events → logs (NOT orders via 'cart')", groupForTable("cart_events").key === "logs");
  check("carts → orders", groupForTable("carts").key === "orders");
  check("products → catalog", groupForTable("products").key === "catalog");
  check("media → catalog", groupForTable("media").key === "catalog");
  check("customer_profiles → customers", groupForTable("customer_profiles").key === "customers");
  check("email_suppressions → customers (not logs)", groupForTable("email_suppressions").key === "customers");
  check("blog_posts → cms", groupForTable("blog_posts").key === "cms");
  check("some_unknown_table → other", groupForTable("some_unknown_table").key === "other");

  // LOG_TABLES members that would otherwise mis-route → must reach logs via the
  // explicit list (would regress to "other"/"cms" if that routing broke — guard
  // the owner's intent). ai_call_logs starts with the "ai" prefix (→ cms) yet is
  // a retention log table, so the explicit list must win.
  check("ai_call_logs → logs (explicit list beats 'ai' prefix)", groupForTable("ai_call_logs").key === "logs");
  check("app_instance_heartbeats → logs (explicit)", groupForTable("app_instance_heartbeats").key === "logs");
  // stock_movements left LOG_TABLES (permanent ledger) → Catalogue via "stock".
  check("stock_movements → catalog (not logs anymore)", groupForTable("stock_movements").key === "catalog");
  // First-match-wins ordering: catalog "media" prefix beats cms.
  check("media_settings → catalog (media prefix wins)", groupForTable("media_settings").key === "catalog");
  check("two_factors → customers", groupForTable("two_factors").key === "customers");
  // Tables previously dumped into "other" now reach a real domain.
  check("hero_sections → cms", groupForTable("hero_sections").key === "cms");
  check("timeline_section_items → cms", groupForTable("timeline_section_items").key === "cms");
  check("showcase_pins → cms", groupForTable("showcase_pins").key === "cms");
  check("ai_provider_settings → cms ('ai' prefix)", groupForTable("ai_provider_settings").key === "cms");
  check("import_jobs → cms", groupForTable("import_jobs").key === "cms");
  check("email_campaigns → customers", groupForTable("email_campaigns").key === "customers");
  check("oauth_provider_settings → customers", groupForTable("oauth_provider_settings").key === "customers");
  check("payment_provider_settings → orders", groupForTable("payment_provider_settings").key === "orders");
  // RBAC trio kept together in customers (roles ARE about people/access).
  check("roles → customers", groupForTable("roles").key === "customers");
  check("role_permissions → customers", groupForTable("role_permissions").key === "customers");
  check("user_roles → customers", groupForTable("user_roles").key === "customers");

  console.log("summarizeStorage — totals + toast:");
  const rows: TableSize[] = [
    t("audit_log", 1000, 600, 400),
    t("search_log", 500, 300, 200),
    t("products", 2000, 1500, 500),
    t("orders", 800, 600, 200),
    t("zzz_misc", 100, 80, 20), // → other
  ];
  const s = summarizeStorage(rows);
  check("total = sum totals", s.totalBytes === 4400);
  check("heap = sum heap", s.heapBytes === 3080);
  check("index = sum index", s.indexBytes === 1320);
  check("toast = total - heap - index", s.toastBytes === 4400 - 3080 - 1320);
  check("tableCount", s.tableCount === 5);

  console.log("summarizeStorage — logs subtotal (exact):");
  check("logs bytes = audit+search totals", s.logs.bytes === 1500);
  check("logs tableCount = 2", s.logs.tableCount === 2);

  console.log("summarizeStorage — groups:");
  const byKey = Object.fromEntries(s.byGroup.map((g) => [g.key, g]));
  check("logs group bytes", byKey.logs?.bytes === 1500);
  check("catalog group bytes (products)", byKey.catalog?.bytes === 2000);
  check("orders group bytes", byKey.orders?.bytes === 800);
  check("other group present", byKey.other?.bytes === 100);
  check("byGroup sorted desc", s.byGroup.every((g, i, a) => i === 0 || a[i - 1].bytes >= g.bytes));

  console.log("summarizeStorage — logs subtotal with >2 LOG_TABLES (incl. non-prefix):");
  const logRows: TableSize[] = [
    t("audit_log", 1000, 700, 300),
    t("app_instance_heartbeats", 200, 150, 50),
    t("ai_call_logs", 300, 200, 100),
    t("products", 5000, 4000, 1000), // not a log
  ];
  const ls = summarizeStorage(logRows);
  check("logs subtotal sums all 3 log tables", ls.logs.bytes === 1500);
  check("logs tableCount = 3", ls.logs.tableCount === 3);
  check("non-log excluded from logs subtotal", ls.logs.bytes !== ls.totalBytes);

  console.log("summarizeStorage — toast clamp + empty:");
  const weird = summarizeStorage([t("x", 100, 90, 50)]); // heap+index > total
  check("toast clamps to 0 (never negative)", weird.toastBytes === 0);
  const empty = summarizeStorage([]);
  check("empty → zeros", empty.totalBytes === 0 && empty.logs.bytes === 0 && empty.byGroup.length === 0);

  console.log("LOG_TABLES sanity:");
  check("LOG_TABLES includes the retention log tables", LOG_TABLES.includes("email_logs") && LOG_TABLES.includes("app_instance_heartbeats"));

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();

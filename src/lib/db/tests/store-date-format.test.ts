/**
 * Printed order documents (facture / avoir / bon de livraison / reçu) + SAV
 * dates — the store-zone date formatter and the totals-card money-row rules.
 *
 *   - formatStoreDate: a document's gapless number (fiscalYear) is Africa/Tunis-
 *     local, so its printed DATE (from the created_at/invoiced_at instant) must be
 *     too — a bare toLocaleDateString on the UTC container dated a document
 *     issued 00:00–01:00 Tunis the previous day (the previous YEAR on 1 Jan).
 *     The runtime zone is forced to UTC below to reproduce the container.
 *   - documentShippingRow / documentShippingTaxCents: no « Livraison —
 *     Gratuite » on a pickup, and the shipping TVA term that makes the per-line
 *     TVA column reconcile with the TVA total.
 *
 * Pure, no DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/store-date-format.test.ts
 */
import { formatStoreDate } from "@/lib/time/store-tz";
import { fiscalYear } from "@/lib/fiscal-period";
import { documentShippingRow, documentShippingTaxCents } from "@/lib/order/document-money";

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

function main() {
  // Reproduce the Coolify/Docker runtime (no TZ → UTC) regardless of the host.
  process.env.TZ = "UTC";

  console.log("formatStoreDate — dates in Africa/Tunis, not the runtime zone:");
  // 2026-12-31 23:30 UTC = 2027-01-01 00:30 Tunis — the first hour of the new
  // fiscal year: the date must agree with the FAC-2027-… number beside it.
  const newYear = new Date("2026-12-31T23:30:00Z");
  check("Dec-31 23:30Z → « 1 janvier 2027 »", formatStoreDate(newYear) === "1 janvier 2027");
  check("printed year == fiscalYear() of the same instant", formatStoreDate(newYear, { year: "numeric" }) === fiscalYear(newYear));
  check(
    "a bare UTC toLocaleDateString WOULD print the previous year (proves the fix matters)",
    newYear.toLocaleDateString("fr-FR", { dateStyle: "long" }) === "31 décembre 2026",
  );
  // A late-night order: its created_at instant is rendered store-local.
  const lateNight = new Date("2026-09-22T23:30:00Z");
  check("Sep-22 23:30Z → « 23 septembre 2026 »", formatStoreDate(lateNight) === "23 septembre 2026");
  check("ISO string input is accepted", formatStoreDate("2026-09-22T23:30:00.000Z") === "23 septembre 2026");
  check(
    "explicit parts (account page) stay store-local",
    formatStoreDate(lateNight, { day: "numeric", month: "long", year: "numeric" }) === "23 septembre 2026",
  );
  // SAV card: numeric, same frame as computeWarrantyStatus's badge.
  check(
    "short style → « 23/09/2027 » (warranty badge format)",
    formatStoreDate(new Date("2027-09-22T23:30:00Z"), { dateStyle: "short" }) === "23/09/2027",
  );
  check(
    "short style == the warranty badge's own formatting",
    formatStoreDate(new Date("2027-09-22T23:30:00Z"), { dateStyle: "short" }) ===
      new Date("2027-09-22T23:30:00Z").toLocaleDateString("fr-FR", { timeZone: "Africa/Tunis" }),
  );
  // Just before Tunis midnight stays on the same day.
  check("Sep-22 22:30Z (23:30 Tunis) → « 22 septembre 2026 »", formatStoreDate(new Date("2026-09-22T22:30:00Z")) === "22 septembre 2026");
  // A caller-supplied timeZone can't override the store zone.
  check(
    "opts.timeZone is ignored (always the store zone)",
    formatStoreDate(lateNight, { dateStyle: "long", timeZone: "UTC" }) === "23 septembre 2026",
  );
  check("null → empty string", formatStoreDate(null) === "");
  check("invalid → empty string", formatStoreDate("not-a-date") === "");

  console.log("documentShippingRow — no « Livraison — Gratuite » on a pickup:");
  const homeFree = documentShippingRow("home_delivery", 0);
  check("home delivery, free → Livraison / Gratuite", homeFree?.label === "Livraison" && homeFree.free === true);
  const homePaid = documentShippingRow("home_delivery", 7_000);
  check("home delivery, 7 TND → Livraison / amount", homePaid?.label === "Livraison" && homePaid.free === false);
  check("in-store pickup, no fee → no row", documentShippingRow("in_store", 0) === null);
  check("drive pickup, no fee → no row", documentShippingRow("drive_by_pickup", 0) === null);
  const drivePaid = documentShippingRow("drive_by_pickup", 2_000);
  check("drive pickup with a fee → Frais de retrait", drivePaid?.label === "Frais de retrait" && drivePaid.free === false);

  console.log("documentShippingTaxCents — the TVA column reconciles with the TVA total:");
  // on_shipping at 19% (ht): 7 TND shipping → 1.330 TVA; two lines 10.000 + 4.000.
  const lines = [{ tax_cents: 10_000 }, { tax_cents: 4_000 }];
  const taxedOrder = { tax_cents: 15_330, shipping_cents: 7_000 };
  const shipTax = documentShippingTaxCents(taxedOrder, lines);
  check("shipping TVA = tax_cents − Σ line TVA (1.330)", shipTax === 1_330);
  check(
    "Σ line TVA + shipping TVA == order TVA total",
    lines.reduce((a, l) => a + l.tax_cents, 0) + shipTax === taxedOrder.tax_cents,
  );
  check("shipping not taxed → 0", documentShippingTaxCents({ tax_cents: 14_000, shipping_cents: 7_000 }, lines) === 0);
  check("free shipping → 0 (nothing to tax)", documentShippingTaxCents({ tax_cents: 15_330, shipping_cents: 0 }, lines) === 0);
  check("never negative", documentShippingTaxCents({ tax_cents: 9_000, shipping_cents: 7_000 }, lines) === 0);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();

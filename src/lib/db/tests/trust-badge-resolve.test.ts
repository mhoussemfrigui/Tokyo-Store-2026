/**
 * Trust-badge resolution — the gating rules that decide which admin badges
 * render on a surface (and with what copy). Pure logic, no DB. Locks in the
 * subtle cases: visibility vs stock, per-surface warranty, dynamic ETA/returns
 * copy, and the security/list split.
 *
 * Run:
 *   pnpm exec tsx src/lib/db/tests/trust-badge-resolve.test.ts
 */
import { resolveBuyBoxBadges, type TrustBadgeInput } from "@/lib/storefront/trust-badges";

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

// All icons below are real TRUST_ICON_NAMES members (no off-map fixture). The
// retired `preorder` visibility is gone — custom badges use always | in_stock.
const BADGES: TrustBadgeInput[] = [
  { kind: "security", label: "Paiement sécurisé", icon: "Lock", visibility: "always" },
  { kind: "delivery", label: "Livraison rapide", icon: "Truck", visibility: "in_stock" },
  { kind: "returns", label: "Retours sous conditions", icon: "RotateCcw", visibility: "always" },
  { kind: "warranty", label: "Garantie", icon: "ShieldCheck", visibility: "always" },
  { kind: null, label: "Click & Collect", icon: "MapPin", visibility: "in_stock" },
];

const base = {
  inStock: true,
  warranty: "Garantie 2 ans" as string | null,
  etaCopy: "Livré en 48h",
  returnsCopy: "Retours 14 jours",
};

function main() {
  // ── in stock ──────────────────────────────────────────────────────────────
  const inStock = resolveBuyBoxBadges(BADGES, base);
  check("security badge split out", inStock.security.length === 1 && inStock.security[0].label === "Paiement sécurisé");
  check("delivery uses dynamic ETA copy", inStock.list.some((b) => b.label === "Livré en 48h"));
  check("returns uses dynamic returns copy", inStock.list.some((b) => b.label === "Retours 14 jours"));
  check("warranty uses the product's own coverage", inStock.list.some((b) => b.label === "Garantie 2 ans"));
  check("in_stock custom badge shown when in stock", inStock.list.some((b) => b.label === "Click & Collect"));

  // ── warranty dropped when the product has none ─────────────────────────────
  const noWarranty = resolveBuyBoxBadges(BADGES, { ...base, warranty: null });
  check("warranty badge dropped when product has no coverage", !noWarranty.list.some((b) => b.icon === "ShieldCheck"));

  // ── out of stock → in_stock-gated badges hidden ────────────────────────────
  const oos = resolveBuyBoxBadges(BADGES, { ...base, inStock: false });
  check("in_stock delivery hidden when out of stock", !oos.list.some((b) => b.label === "Livré en 48h"));
  check("in_stock custom badge hidden when out of stock", !oos.list.some((b) => b.label === "Click & Collect"));
  check("always returns still shown when out of stock", oos.list.some((b) => b.label === "Retours 14 jours"));

  // ── empty list ─────────────────────────────────────────────────────────────
  const empty = resolveBuyBoxBadges([], base);
  check("no badges → empty groups", empty.security.length === 0 && empty.list.length === 0);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();

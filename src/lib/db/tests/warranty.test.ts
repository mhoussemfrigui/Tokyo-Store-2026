import "server-only";

/**
 * Warranty engine regression test — the PURE resolver + status math
 * (src/lib/warranty/index.ts). Covers the product→category→global cascade, the
 * category chain collapse (node/parent + the full child→root chain), addMonths
 * month-overflow clamp, computeWarrantyStatus (active/expired/none/no-date)
 * incl. the Africa/Tunis date rendering, and the ORDER-aware verdict
 * (warrantyStartDate: delivery → paid → created; computeOrderLineWarranty:
 * pending / cancelled / refunded orders read a neutral « Non couverte »). No DB. Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/warranty.test.ts
 */
import {
  resolveWarranty,
  categoryWarrantyFromChain,
  computeWarrantyStatus,
  computeOrderLineWarranty,
  orderStatusVoidsWarranty,
  warrantyStartDate,
  addMonths,
  formatWarrantyDuration,
  fillWarrantyLabelPlaceholder,
} from "@/lib/warranty";

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
  // ── formatWarrantyDuration ──
  check("0 months → 'Sans garantie'", formatWarrantyDuration(0) === "Sans garantie");
  check("12 → '1 an'", formatWarrantyDuration(12) === "1 an");
  check("24 → '2 ans'", formatWarrantyDuration(24) === "2 ans");
  check("18 → '18 mois'", formatWarrantyDuration(18) === "18 mois");

  // ── categoryWarrantyFromChain, two-node [node, parent] form (node wins) ──
  check(
    "category node rate wins over parent",
    categoryWarrantyFromChain([{ warranty_months: 6, warranty_label: null }, { warranty_months: 24, warranty_label: null }])?.months === 6,
  );
  check(
    "parent used when node has none",
    categoryWarrantyFromChain([{ warranty_months: null, warranty_label: null }, { warranty_months: 24, warranty_label: null }])?.months === 24,
  );
  check(
    "both unset → null",
    categoryWarrantyFromChain([{ warranty_months: null, warranty_label: null }, { warranty_months: null, warranty_label: null }]) === null,
  );

  // ── categoryWarrantyFromChain (full child → root chain, first set wins) ──
  const unset = { warranty_months: null, warranty_label: null };
  check(
    "root warranty reaches a depth-4 leaf (not only one hop up)",
    (() => {
      const w = categoryWarrantyFromChain([unset, unset, unset, { warranty_months: 24, warranty_label: "Garantie Maison" }]);
      return w?.months === 24 && w.label === "Garantie Maison";
    })(),
  );
  check(
    "nearest ancestor with a value wins (label travels with it)",
    (() => {
      const w = categoryWarrantyFromChain([
        unset,
        { warranty_months: 12, warranty_label: null },
        { warranty_months: 24, warranty_label: "Racine" },
      ]);
      return w?.months === 12 && w.label === null;
    })(),
  );
  check("0 months is an explicit value (not 'unset')", categoryWarrantyFromChain([unset, { warranty_months: 0, warranty_label: null }, { warranty_months: 24, warranty_label: null }])?.months === 0);
  check("empty / null chain → null", categoryWarrantyFromChain([]) === null && categoryWarrantyFromChain(null) === null);

  // ── resolveWarranty cascade ──
  check(
    "product wins; label from product",
    (() => {
      const r = resolveWarranty({ months: 12, label: "Garantie constructeur" }, { months: 24, label: "Cat" }, { months: 6, label: null });
      return r.source === "product" && r.months === 12 && r.label === "Garantie constructeur";
    })(),
  );
  check(
    "category wins when product unset",
    resolveWarranty({ months: null, label: null }, { months: 24, label: null }, { months: 6, label: null }).source === "category",
  );
  check(
    "global fallback when product+category unset",
    (() => {
      const r = resolveWarranty({ months: null, label: null }, null, { months: 6, label: null });
      return r.source === "global" && r.months === 6;
    })(),
  );
  check(
    "no warranty anywhere → display null",
    resolveWarranty({ months: null, label: null }, null, { months: 0, label: null }).display === null,
  );
  check(
    "product months=0 is honoured (not unset → global)",
    resolveWarranty({ months: 0, label: null }, { months: 24, label: null }, { months: 6, label: null }).months === 0,
  );

  // ── addMonths month-overflow clamp (forward, never short) ──
  check(
    "Jan 31 + 1 month clamps forward into March (not Feb 31)",
    (() => {
      const r = addMonths(new Date(2025, 0, 31), 1); // local Jan 31
      return r.getMonth() === 2; // March (0-indexed) — overflowed past Feb
    })(),
  );
  check("mid-month +12 lands same day next year", (() => {
    const r = addMonths(new Date(2025, 5, 15), 12);
    return r.getFullYear() === 2026 && r.getMonth() === 5 && r.getDate() === 15;
  })());

  // ── computeWarrantyStatus ──
  check(
    "no months → state 'none'",
    computeWarrantyStatus(new Date("2025-01-01T00:00:00Z"), 0, null).state === "none",
  );
  check(
    "duration but no purchase date → active, no expiry",
    (() => {
      const s = computeWarrantyStatus(null, 12, null);
      return s.state === "active" && s.expiresAt === null;
    })(),
  );
  check(
    "active when now < expiry",
    computeWarrantyStatus(new Date("2025-01-01T12:00:00Z"), 12, null, new Date("2025-06-01T12:00:00Z")).state === "active",
  );
  check(
    "expired when now > expiry",
    computeWarrantyStatus(new Date("2024-01-01T12:00:00Z"), 12, null, new Date("2025-06-01T12:00:00Z")).state === "expired",
  );
  check(
    "custom label is preferred in the display",
    computeWarrantyStatus(null, 12, "Garantie à vie").display === "Garantie à vie",
  );
  // TZ: the rendered expiry date is in Africa/Tunis, not the host TZ. Pick a
  // near-midnight-UTC instant so a UTC host would otherwise print the prior day.
  check(
    "expiry date renders in Africa/Tunis",
    (() => {
      const purchased = new Date("2025-12-31T23:30:00Z"); // Tunis: 2026-01-01 00:30
      const s = computeWarrantyStatus(purchased, 1, null, new Date("2026-01-15T00:00:00Z"));
      const expectedTunis = s.expiresAt!.toLocaleDateString("fr-FR", { timeZone: "Africa/Tunis" });
      return s.display.includes(expectedTunis);
    })(),
  );

  // ── fillWarrantyLabelPlaceholder (the "Garantie Constructeur X" fix) ──
  check(
    "trailing 'X' placeholder → duration appended",
    fillWarrantyLabelPlaceholder("Garantie Constructeur X", 24) === "Garantie Constructeur 2 ans",
  );
  check(
    "'X ans' placeholder → full duration",
    fillWarrantyLabelPlaceholder("Garantie X ans", 24) === "Garantie 2 ans",
  );
  check(
    "'X mois' placeholder → months duration",
    fillWarrantyLabelPlaceholder("Garantie X mois", 18) === "Garantie 18 mois",
  );
  check(
    "trailing 'X' with no duration → stray X dropped",
    fillWarrantyLabelPlaceholder("Garantie Constructeur X", 0) === "Garantie Constructeur",
  );
  check(
    "label without a standalone X is untouched",
    fillWarrantyLabelPlaceholder("Garantie constructeur 2 ans", 24) === "Garantie constructeur 2 ans",
  );
  check(
    "mid-word x (Max) is NOT treated as a placeholder",
    fillWarrantyLabelPlaceholder("Garantie Max Premium", 24) === "Garantie Max Premium",
  );
  check(
    "resolveWarranty display fills the placeholder (storefront), label stays raw",
    (() => {
      const r = resolveWarranty({ months: 24, label: "Garantie Constructeur X" }, null, { months: 0, label: null });
      return r.display === "Garantie Constructeur 2 ans" && r.label === "Garantie Constructeur X";
    })(),
  );

  // ── warrantyStartDate (delivery → payment → order date) ──
  const created = new Date("2024-01-01T10:00:00Z");
  const paid = new Date("2024-01-05T10:00:00Z");
  const delivered = new Date("2024-03-01T10:00:00Z");
  check(
    "start = delivery when recorded",
    warrantyStartDate({ createdAt: created, paidAt: paid, deliveredAt: delivered }) === delivered,
  );
  check(
    "start = paid_at when not delivered yet",
    warrantyStartDate({ createdAt: created, paidAt: paid, deliveredAt: null }) === paid,
  );
  check(
    "start = order date as last resort",
    warrantyStartDate({ createdAt: created, paidAt: null, deliveredAt: null }) === created,
  );

  // ── computeOrderLineWarranty (order-aware verdict) ──
  const facts = (status: string, deliveredAt: Date | null = null) => ({
    status,
    createdAt: created,
    paidAt: paid,
    deliveredAt,
  });
  check(
    "COD delivered 2 months late keeps full coverage (anchored on delivery, not creation)",
    (() => {
      // 12 months from creation would expire 2025-01-01; from delivery → 2025-03-01.
      const s = computeOrderLineWarranty(facts("delivered", delivered), 12, null, new Date("2025-02-15T12:00:00Z"));
      return s.state === "active" && s.expiresAt?.getTime() === addMonths(delivered, 12).getTime();
    })(),
  );
  check(
    "still expires once the delivery-anchored window passes",
    computeOrderLineWarranty(facts("delivered", delivered), 12, null, new Date("2025-03-15T12:00:00Z")).state ===
      "expired",
  );
  for (const [status, text] of [
    ["cancelled", "Non couverte — commande annulée"],
    ["refunded", "Non couverte — commande remboursée"],
    ["pending", "Pas encore couverte — commande en attente"],
  ] as const) {
    check(
      `${status} order → neutral « ${text} », never « Sous garantie »`,
      (() => {
        const s = computeOrderLineWarranty(facts(status), 24, "Garantie constructeur", new Date("2024-02-01T00:00:00Z"));
        return s.state === "not_covered" && s.display === text && s.expiresAt === null && s.label === "Garantie constructeur";
      })(),
    );
  }
  check(
    "orderStatusVoidsWarranty: pending/cancelled/refunded only",
    ["pending", "cancelled", "refunded"].every(orderStatusVoidsWarranty) &&
      !["paid", "preparing", "shipped", "delivered"].some(orderStatusVoidsWarranty),
  );
  check(
    "a line WITHOUT warranty stays « Sans garantie » even on a cancelled order",
    computeOrderLineWarranty(facts("cancelled"), 0, null).state === "none",
  );
  check(
    "paid / shipped orders are covered (from paid_at while undelivered)",
    (() => {
      const s = computeOrderLineWarranty(facts("shipped"), 12, null, new Date("2024-06-01T00:00:00Z"));
      return s.state === "active" && s.expiresAt?.getTime() === addMonths(paid, 12).getTime();
    })(),
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
process.exit(0);

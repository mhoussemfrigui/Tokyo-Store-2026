import "server-only";

/**
 * planAutoTransfers (PURE) — the order-driven store→depot auto-replenishment
 * planner. Verifies: depot shortfall (only what's missing), the sourcing
 * strategies (priority = display order, most_stock = biggest holder), the
 * source-level cap, no-source skip, depot-can-fill skip, and per-source grouping.
 * No DB. Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/auto-transfer.test.ts
 */
import { planAutoTransfers, levelKey, normalizePlanLines } from "@/lib/inventory/auto-transfer-plan";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const DEPOT = "depot";
const A = "storeA";
const B = "storeB";
const P1 = "11111111-1111-1111-1111-111111111111";
const P2 = "22222222-2222-2222-2222-222222222222";
const V1 = "99999999-9999-9999-9999-999999999999";

/** Build a levels map from {key: {loc: qty}}. */
function levels(spec: Record<string, Record<string, number>>): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  for (const [k, byLoc] of Object.entries(spec)) m.set(k, new Map(Object.entries(byLoc)));
  return m;
}

function main() {
  // ── Depot shortfall: depot 2, ordered 5 → move only the 3 short, from A. ────
  {
    const plans = planAutoTransfers({
      items: [{ productId: P1, variantId: null, quantity: 5 }],
      depotId: DEPOT,
      sources: [{ id: A, displayOrder: 0 }],
      levels: levels({ [P1]: { [DEPOT]: 2, [A]: 10 } }),
      sourcing: "priority",
    });
    check("shortfall: 1 transfer A→depot of the 3 missing (not the full 5)",
      plans.length === 1 && plans[0].fromLocationId === A && plans[0].items[0].qty === 3);
  }

  // ── Depot can already fill → no transfer. ──────────────────────────────────
  {
    const plans = planAutoTransfers({
      items: [{ productId: P1, variantId: null, quantity: 5 }],
      depotId: DEPOT,
      sources: [{ id: A, displayOrder: 0 }],
      levels: levels({ [P1]: { [DEPOT]: 5, [A]: 10 } }),
      sourcing: "priority",
    });
    check("depot fills the order → no transfer", plans.length === 0);
  }

  // ── priority vs most_stock choose different stores. ────────────────────────
  {
    const lv = levels({ [P1]: { [DEPOT]: 0, [A]: 5, [B]: 10 } });
    const base = { items: [{ productId: P1, variantId: null, quantity: 3 }], depotId: DEPOT, sources: [{ id: A, displayOrder: 0 }, { id: B, displayOrder: 1 }], levels: lv };
    const prio = planAutoTransfers({ ...base, sourcing: "priority" });
    const most = planAutoTransfers({ ...base, sourcing: "most_stock" });
    check("priority picks the first store by display order (A)", prio[0].fromLocationId === A);
    check("most_stock picks the biggest holder (B)", most[0].fromLocationId === B);
  }

  // ── Cap at the source's level (can't move more than it has). ───────────────
  {
    const plans = planAutoTransfers({
      items: [{ productId: P1, variantId: null, quantity: 10 }],
      depotId: DEPOT,
      sources: [{ id: A, displayOrder: 0 }],
      levels: levels({ [P1]: { [DEPOT]: 0, [A]: 4 } }),
      sourcing: "priority",
    });
    check("source cap: moves only the 4 A holds (not the 10 short)", plans.length === 1 && plans[0].items[0].qty === 4);
  }

  // ── No store holds it → skipped (operator handles manually). ───────────────
  {
    const plans = planAutoTransfers({
      items: [{ productId: P1, variantId: null, quantity: 5 }],
      depotId: DEPOT,
      sources: [{ id: A, displayOrder: 0 }],
      levels: levels({ [P1]: { [DEPOT]: 0, [A]: 0 } }),
      sourcing: "priority",
    });
    check("no source holds the item → no transfer", plans.length === 0);
  }

  // ── Grouping: two items, two different best sources → two transfers. ───────
  {
    const plans = planAutoTransfers({
      items: [
        { productId: P1, variantId: null, quantity: 3 },
        { productId: P2, variantId: null, quantity: 2 },
      ],
      depotId: DEPOT,
      sources: [{ id: A, displayOrder: 0 }, { id: B, displayOrder: 1 }],
      // P1 only at A, P2 only at B.
      levels: levels({ [P1]: { [DEPOT]: 0, [A]: 5 }, [P2]: { [DEPOT]: 0, [B]: 5 } }),
      sourcing: "priority",
    });
    check("grouping: 2 transfers (A→depot for P1, B→depot for P2)",
      plans.length === 2 &&
      plans.some((p) => p.fromLocationId === A && p.items[0].productId === P1) &&
      plans.some((p) => p.fromLocationId === B && p.items[0].productId === P2));
  }

  // ── Grouping: two items, same best source → ONE transfer with both lines. ──
  {
    const plans = planAutoTransfers({
      items: [
        { productId: P1, variantId: null, quantity: 3 },
        { productId: P2, variantId: null, quantity: 2 },
      ],
      depotId: DEPOT,
      sources: [{ id: A, displayOrder: 0 }],
      levels: levels({ [P1]: { [DEPOT]: 0, [A]: 5 }, [P2]: { [DEPOT]: 0, [A]: 5 } }),
      sourcing: "priority",
    });
    check("grouping: both lines from A → a single transfer with 2 items",
      plans.length === 1 && plans[0].fromLocationId === A && plans[0].items.length === 2);
  }

  // ── A variant line uses the productId:variantId level key. ─────────────────
  {
    const plans = planAutoTransfers({
      items: [{ productId: P1, variantId: V1, quantity: 4 }],
      depotId: DEPOT,
      sources: [{ id: A, displayOrder: 0 }],
      levels: levels({ [levelKey(P1, V1)]: { [DEPOT]: 1, [A]: 6 } }),
      sourcing: "priority",
    });
    check("variant line keyed by productId:variantId → transfer of the 3 short",
      plans.length === 1 && plans[0].items[0].variantId === V1 && plans[0].items[0].qty === 3);
  }

  // ── normalizePlanLines: a shared product's variant lines redirect to the pool
  //    (variantId null) and MERGE by key; per-variant products keep their key. ──
  {
    const V2 = "88888888-8888-8888-8888-888888888888";
    // P1 shared: two different variants → one pool line summing the quantities.
    const merged = normalizePlanLines(
      [
        { productId: P1, variantId: V1, quantity: 2 },
        { productId: P1, variantId: V2, quantity: 3 },
      ],
      new Set([P1]),
    );
    check(
      "normalize: shared product's 2 variant lines → 1 pool line (variantId null, qty 5)",
      merged.length === 1 && merged[0].variantId === null && merged[0].quantity === 5,
    );

    // P2 NOT shared: its variant line keeps its variant key untouched.
    const kept = normalizePlanLines([{ productId: P2, variantId: V1, quantity: 4 }], new Set([P1]));
    check(
      "normalize: non-shared product keeps its per-variant key",
      kept.length === 1 && kept[0].variantId === V1 && kept[0].quantity === 4,
    );

    // Same variant appearing twice merges regardless of shared mode.
    const dup = normalizePlanLines(
      [
        { productId: P2, variantId: V1, quantity: 1 },
        { productId: P2, variantId: V1, quantity: 2 },
      ],
      new Set(),
    );
    check("normalize: duplicate keys merge (qty summed)", dup.length === 1 && dup[0].quantity === 3);
  }

  // ── normalize → plan: a shared product plans against the POOL level, so a
  //    depot that can cover the merged quantity raises NO transfer. ────────────
  {
    const lines = normalizePlanLines([{ productId: P1, variantId: V1, quantity: 3 }], new Set([P1]));
    const plans = planAutoTransfers({
      items: lines,
      depotId: DEPOT,
      sources: [{ id: A, displayOrder: 0 }],
      // Pool level (P1, no variant) — NOT a per-variant key. Depot holds 3.
      levels: levels({ [P1]: { [DEPOT]: 3, [A]: 10 } }),
      sourcing: "priority",
    });
    check("normalize+plan: shared line reads the pool level → depot covers it, no transfer", plans.length === 0);
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();

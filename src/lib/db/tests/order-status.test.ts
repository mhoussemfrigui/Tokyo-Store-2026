/**
 * PURE order fulfilment state machine — NO database, NO network.
 *
 * Guards `src/lib/order/status.ts`: the payment-method → transition-graph
 * routing that decides whether an order gates fulfilment behind `paid`
 * (online/upfront) or skips it (cash-on-delivery). The code's own comment warns
 * that mis-routing a `konnect`/`card_stripe` order to the COD graph would "skip
 * the paid gate — a real regression", so pin the routing + both graphs here.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/order-status.test.ts
 */
import {
  adminStatusLabel,
  isActionableOrder,
  isUpfrontPaidMethod,
  isPickupDelivery,
  UPFRONT_PAID_METHODS,
  orderTransitionsFor,
  paymentMethodLabel,
  orderStatusLabel,
  orderStatusLabelFor,
  orderStatusActionLabelFor,
  orderStatusColor,
  ORDER_STATUSES,
  ORDER_STATUS_TRANSITIONS,
  ORDER_STATUS_TRANSITIONS_COD,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_COLORS,
  ORDER_STATUS_ACTION_LABELS,
  type OrderStatus,
} from "@/lib/order/status";

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
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// ── isUpfrontPaidMethod ─────────────────────────────────────────────────────
{
  // Live gateways + operator-recorded offline settlements keep the paid gate.
  for (const m of ["flouci", "clictopay", "cash", "bank_transfer"]) {
    check(`upfront: ${m} → true`, isUpfrontPaidMethod(m) === true);
  }
  // Legacy / forward-compat enum values MUST stay upfront so historical rows
  // don't get silently routed through the COD graph (documented regression).
  check("upfront: konnect (legacy) → true", isUpfrontPaidMethod("konnect") === true);
  check("upfront: card_stripe (forward-compat) → true", isUpfrontPaidMethod("card_stripe") === true);

  // COD + unset + junk settle at delivery → not upfront.
  check("cod → false", isUpfrontPaidMethod("cod") === false);
  check("null → false", isUpfrontPaidMethod(null) === false);
  check("undefined → false", isUpfrontPaidMethod(undefined) === false);
  check("empty string → false", isUpfrontPaidMethod("") === false);
  check("unknown method → false", isUpfrontPaidMethod("bitcoin") === false);
}

// ── orderTransitionsFor: online/upfront orders gate behind `paid` ───────────
{
  const t = orderTransitionsFor("pending", "flouci");
  check("upfront pending → [paid, cancelled]", same(t, ["paid", "cancelled"]));
  check("upfront pending does NOT allow preparing (paid gate)", !t.includes("preparing"));

  check(
    "upfront paid → [preparing, cancelled, refunded]",
    same(orderTransitionsFor("paid", "clictopay"), ["preparing", "cancelled", "refunded"]),
  );
  check(
    "cash routes to the upfront graph (pending → paid)",
    orderTransitionsFor("pending", "cash").includes("paid"),
  );
  check(
    "konnect (legacy) routes to the upfront graph, NOT COD",
    orderTransitionsFor("pending", "konnect").includes("paid") &&
      !orderTransitionsFor("pending", "konnect").includes("preparing"),
  );
}

// ── orderTransitionsFor: COD / unset skip the paid gate ─────────────────────
{
  const cod = orderTransitionsFor("pending", "cod");
  check("cod pending → [preparing, cancelled]", same(cod, ["preparing", "cancelled"]));
  check("cod pending has NO paid gate", !cod.includes("paid"));

  // An unset method behaves like COD (settles at delivery).
  check(
    "null method → COD graph (pending → preparing, cancelled)",
    same(orderTransitionsFor("pending", null), ["preparing", "cancelled"]),
  );
  check(
    "unknown method → COD graph (falls back off the upfront set)",
    same(orderTransitionsFor("pending", "bitcoin"), ["preparing", "cancelled"]),
  );
}

// ── pickup (in-store / drive) has NO shipping leg ───────────────────────────
{
  // Classifier: only the two counter-collection methods are "pickup".
  check("pickup: in_store → true", isPickupDelivery("in_store") === true);
  check("pickup: drive_by_pickup → true", isPickupDelivery("drive_by_pickup") === true);
  check("pickup: home_delivery → false", isPickupDelivery("home_delivery") === false);
  check("pickup: null → false", isPickupDelivery(null) === false);
  check("pickup: undefined → false", isPickupDelivery(undefined) === false);

  // A pickup order NEVER offers « shipped » — the ship step collapses into
  // « delivered » (collected). COD pickup: preparing → delivered (not shipped).
  check(
    "cod + in_store: preparing → [delivered, cancelled] (no shipped)",
    same(orderTransitionsFor("preparing", "cod", "in_store"), ["delivered", "cancelled"]),
  );
  check(
    "upfront + drive: preparing → [delivered, cancelled] (no shipped)",
    same(orderTransitionsFor("preparing", "flouci", "drive_by_pickup"), ["delivered", "cancelled"]),
  );
  // Home delivery is unchanged — the ship leg stays.
  check(
    "cod + home_delivery: preparing → [shipped, cancelled] (ship leg kept)",
    same(orderTransitionsFor("preparing", "cod", "home_delivery"), ["shipped", "cancelled"]),
  );
  check(
    "no delivery method → ship leg kept (back-compat)",
    same(orderTransitionsFor("preparing", "cod"), ["shipped", "cancelled"]),
  );
  // The remap dedupes — a graph that already lists `delivered` can't double it.
  check(
    "pickup remap never duplicates delivered",
    new Set(orderTransitionsFor("preparing", "cod", "in_store")).size ===
      orderTransitionsFor("preparing", "cod", "in_store").length,
  );

  // Labels: a collected pickup order reads « Retirée » / « Marquer retirée ».
  check(
    "orderStatusLabelFor(delivered, in_store) → Retirée",
    orderStatusLabelFor("delivered", "in_store") === "Retirée",
  );
  check(
    "orderStatusLabelFor(delivered, home_delivery) → Livrée",
    orderStatusLabelFor("delivered", "home_delivery") === "Livrée",
  );
  check(
    "orderStatusLabelFor(delivered, null) → Livrée (canonical)",
    orderStatusLabelFor("delivered", null) === "Livrée",
  );
  check(
    "orderStatusLabelFor(shipped, in_store) → canonical (only delivered remaps)",
    orderStatusLabelFor("shipped", "in_store") === "Expédiée",
  );
  check(
    "orderStatusActionLabelFor(delivered, drive_by_pickup) → Marquer retirée",
    orderStatusActionLabelFor("delivered", "drive_by_pickup") === "Marquer retirée",
  );
  check(
    "orderStatusActionLabelFor(delivered, home_delivery) → Marquer livrée",
    orderStatusActionLabelFor("delivered", "home_delivery") === "Marquer livrée",
  );
}

// ── terminal + unknown states ───────────────────────────────────────────────
{
  check("cancelled is terminal (upfront)", orderTransitionsFor("cancelled", "flouci").length === 0);
  check("refunded is terminal (cod)", orderTransitionsFor("refunded", "cod").length === 0);
  check(
    "unknown status → [] (never throws)",
    orderTransitionsFor("bogus" as OrderStatus, "flouci").length === 0,
  );
}

// ── structural invariants over BOTH graphs ──────────────────────────────────
{
  const known = new Set<string>(ORDER_STATUSES);
  for (const [graphName, graph] of [
    ["upfront", ORDER_STATUS_TRANSITIONS] as const,
    ["cod", ORDER_STATUS_TRANSITIONS_COD] as const,
  ]) {
    for (const status of ORDER_STATUSES) {
      const targets = graph[status];
      check(
        `${graphName}: ${status} targets are all known statuses`,
        targets.every((s) => known.has(s)),
      );
      check(`${graphName}: ${status} never transitions into itself`, !targets.includes(status));
      check(`${graphName}: ${status} has no duplicate targets`, new Set(targets).size === targets.length);
    }
  }
  // Every canonical status has a label, colour and action label (a hand-edit
  // that drops one would render a blank badge — the exact bug this file guards).
  for (const status of ORDER_STATUSES) {
    check(
      `${status} has label + colour + action label`,
      !!ORDER_STATUS_LABELS[status] && !!ORDER_STATUS_COLORS[status] && !!ORDER_STATUS_ACTION_LABELS[status],
    );
  }
}

// ── safe lookups (arbitrary DB string) ──────────────────────────────────────
{
  check("paymentMethodLabel(null) → —", paymentMethodLabel(null) === "—");
  check("paymentMethodLabel(flouci) → Flouci", paymentMethodLabel("flouci") === "Flouci");
  check("paymentMethodLabel(unknown) → echoes input", paymentMethodLabel("zzz") === "zzz");
  check("orderStatusLabel(paid) → Payée", orderStatusLabel("paid") === "Payée");
  check("orderStatusLabel(unknown) → echoes input", orderStatusLabel("zzz") === "zzz");
  check("orderStatusColor(unknown) → muted fallback", orderStatusColor("zzz").includes("bg-muted"));
}

// ── « À traiter » predicate + admin label (dashboard ⇄ Commandes parity) ─────
{
  // Fulfilment work owed.
  check("actionable: paid", isActionableOrder("paid", "flouci", "2026-01-01T00:00:00Z") === true);
  check("actionable: preparing (COD, unpaid)", isActionableOrder("preparing", "cod", null) === true);
  // A new COD order waits in `pending` for an operator — it IS in the queue
  // (the dashboard used to skip it while Commandes counted it).
  check("actionable: pending COD", isActionableOrder("pending", "cod", null) === true);
  check("actionable: pending with no method (COD graph)", isActionableOrder("pending", null, null) === true);
  // An unpaid online checkout is a chase/sweep candidate, not a queue item.
  check("NOT actionable: pending flouci unpaid", isActionableOrder("pending", "flouci", null) === false);
  check("NOT actionable: pending clictopay unpaid", isActionableOrder("pending", "clictopay", undefined) === false);
  check(
    "actionable: pending upfront that already carries paid_at",
    isActionableOrder("pending", "flouci", new Date()) === true,
  );
  for (const s of ["shipped", "delivered", "cancelled", "refunded"] as const) {
    check(`NOT actionable: ${s}`, isActionableOrder(s, "cod", null) === false);
  }

  check("admin label: pending COD → À préparer (COD)", adminStatusLabel("pending", "cod", null) === "À préparer (COD)");
  check("admin label: pending null method → À préparer", adminStatusLabel("pending", null, null) === "À préparer");
  check(
    "admin label: pending flouci unpaid → Paiement en ligne en attente",
    adminStatusLabel("pending", "flouci", null) === "Paiement en ligne en attente",
  );
  check("admin label: non-pending keeps canonical", adminStatusLabel("preparing", "cod", null) === "En préparation");
  // Label ⇄ predicate stay in lockstep: every actionable pending reads « À préparer… ».
  for (const m of [null, "cod", "flouci", "clictopay", "cash", "bank_transfer", "konnect"]) {
    for (const paidAt of [null, "2026-01-01T00:00:00Z"]) {
      check(
        `label/predicate agree (pending, ${m}, paid=${paidAt != null})`,
        adminStatusLabel("pending", m, paidAt).startsWith("À préparer") ===
          isActionableOrder("pending", m, paidAt),
      );
    }
  }
  // The exported SQL IN-list is exactly the set isUpfrontPaidMethod accepts.
  check(
    "UPFRONT_PAID_METHODS ⇄ isUpfrontPaidMethod",
    UPFRONT_PAID_METHODS.every((m) => isUpfrontPaidMethod(m)) && !UPFRONT_PAID_METHODS.includes("cod"),
  );
}

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);

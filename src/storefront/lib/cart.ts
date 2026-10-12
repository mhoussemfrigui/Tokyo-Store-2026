"use client";

import { useSyncExternalStore } from "react";

import {
  addToCartBySlugAction,
  getStorefrontCartAction,
  removeCartItemBySlugAction,
  setCartItemCarePlanAction,
  setCartItemQuantityAction,
} from "@/lib/actions/cart";
import type { Product } from "@/storefront/lib/catalog";
import { careConfig, carePlanInfo, findProductBySlug } from "@/storefront/lib/catalog";
import { conditionLabel } from "@/storefront/lib/productMeta";

/**
 * Cart store — the LINES *and* the per-line Tokyo Care protection PLAN are backed
 * by the backend cart (DB, guest cookie or signed-in user) via the storefront
 * cart actions. The chosen plan is persisted on the cart line (`care_plan_id`),
 * so it rides from cart → checkout and the backend charges it; the storefront
 * reads the selection back from the cart (single source of truth). The hook API
 * is unchanged, so cart-view / product-card / header are not touched — only the
 * data source is the backend. Slug-keyed (simple products).
 */
export type CartLine = {
  /** Product slug (the unified slug space). */
  id: string;
  qty: number;
  /** id of the chosen Tokyo Care protection plan for this line, else null. */
  plan: string | null;
};

export type CartState = { lines: CartLine[] };

let state: CartState = { lines: [] };
let started = false;
let ready = false;
const listeners = new Set<() => void>();
/** slug → backend cart-item id, for qty/remove/care by slug. */
const itemIdBySlug = new Map<string, string>();

function emit() {
  listeners.forEach((l) => l());
}
function setLines(lines: CartLine[]) {
  state = { lines };
  emit();
}
/** Flip the one-way "initial fetch settled" flag and notify. */
function markReady() {
  if (ready) return;
  ready = true;
  emit();
}

async function refresh() {
  try {
    const { lines } = await getStorefrontCartAction();
    itemIdBySlug.clear();
    for (const l of lines) itemIdBySlug.set(l.slug, l.itemId);
    // The plan selection is read from the backend line (care_plan_id) — no overlay.
    setLines(lines.map((l) => ({ id: l.slug, qty: l.qty, plan: l.carePlanId })));
  } catch {
    /* keep current state on failure */
  }
}

async function hydrate() {
  if (started || typeof window === "undefined") return;
  started = true;
  try {
    await refresh();
  } finally {
    // Ready even if the fetch failed: an empty cart is then the real answer, so
    // the cart/checkout pages show their empty state instead of a skeleton.
    markReady();
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  void hydrate();
  return () => {
    listeners.delete(cb);
  };
}

const EMPTY: CartState = { lines: [] };

export function useCart() {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY,
  );
}

/**
 * True once the initial backend cart fetch has settled (success OR failure).
 * The cart & checkout pages gate their empty state on this so the "panier vide"
 * card never flashes before the server answers. False on server + hydration.
 */
export function useCartReady(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => ready,
    () => false,
  );
}

export function addToCart(id: string, qty = 1, carePlanId: string | null = null) {
  void hydrate();
  // Optimistic: reflect the add immediately, then reconcile with the server.
  const existing = state.lines.find((l) => l.id === id);
  const optimistic = existing
    ? state.lines.map((l) =>
        l.id === id ? { ...l, qty: Math.min(9, l.qty + qty), plan: carePlanId ?? l.plan } : l,
      )
    : [...state.lines, { id, qty: Math.min(9, Math.max(1, qty)), plan: carePlanId }];
  setLines(optimistic);
  addToCartBySlugAction(id, qty)
    .then(async () => {
      // Refresh first so the line's backend itemId is known, THEN persist the
      // chosen plan against it (the add doesn't carry a plan of its own).
      await refresh();
      if (carePlanId) {
        const itemId = itemIdBySlug.get(id);
        if (itemId) {
          await setCartItemCarePlanAction(itemId, carePlanId).catch(() => {});
          await refresh();
        }
      }
    })
    .catch(() => refresh());
}

export function setQty(id: string, qty: number) {
  void hydrate();
  if (qty <= 0) return removeFromCart(id);
  const clamped = Math.min(9, qty);
  setLines(state.lines.map((l) => (l.id === id ? { ...l, qty: clamped } : l)));
  const itemId = itemIdBySlug.get(id);
  const done = itemId
    ? setCartItemQuantityAction(itemId, clamped)
    : addToCartBySlugAction(id, clamped); // not yet hydrated → add
  done.then(() => refresh()).catch(() => refresh());
}

export function removeFromCart(id: string) {
  void hydrate();
  setLines(state.lines.filter((l) => l.id !== id));
  removeCartItemBySlugAction(id)
    .then(() => refresh())
    .catch(() => refresh());
}

export function setLinePlan(id: string, plan: string | null) {
  void hydrate();
  // Optimistic local update, then persist on the backend cart line so the plan
  // rides to checkout and is charged. Re-validated + re-priced server-side.
  setLines(state.lines.map((l) => (l.id === id ? { ...l, plan } : l)));
  const itemId = itemIdBySlug.get(id);
  if (!itemId) return; // not hydrated yet; nothing to persist against
  setCartItemCarePlanAction(itemId, plan)
    .then(() => refresh())
    .catch(() => refresh());
}

export function clearCart() {
  void hydrate();
  const slugs = state.lines.map((l) => l.id);
  setLines([]);
  Promise.allSettled(slugs.map((s) => removeCartItemBySlugAction(s))).then(() => refresh());
}

/* ---------------- Plans de protection Tokyo Care ---------------- */

export type ProtectionPlan = {
  id: string;
  label: string;
  months: number;
  monthly: number;
  total: number;
  perks: string[];
};

/**
 * The Tokyo Care plans OFFERED on a product — straight from the backend snapshot
 * (`product.care`, resolved from the plan's category scope ∪ per-product overrides,
 * priced flat/percent with floors). The plan details (name, duration, perks) come
 * from the care-plans catalogue. Returns [] when the feature is off or none apply.
 * `total` is the per-UNIT price (dinars); the line charge is per-unit × qty or once,
 * per `careConfig.chargePerUnit` (see cartTotals). The server re-prices at checkout.
 */
export function protectionPlans(product: Product): ProtectionPlan[] {
  if (!careConfig.enabled) return [];
  return (product.care ?? []).flatMap((offer) => {
    const info = carePlanInfo(offer.id);
    if (!info) return [];
    const months = Math.max(1, info.durationMonths);
    return [
      {
        id: offer.id,
        label: info.name,
        months: info.durationMonths,
        monthly: Math.max(1, Math.round(offer.price / months)),
        total: offer.price,
        perks: info.perks,
      },
    ];
  });
}

export function planById(product: Product, id: string | null): ProtectionPlan | null {
  if (!id) return null;
  return protectionPlans(product).find((p) => p.id === id) ?? null;
}

/** The care charge for ONE line (dinars): per-unit price × qty, or once per line. */
function lineCareCharge(plan: ProtectionPlan | null, qty: number): number {
  if (!plan) return 0;
  return careConfig.chargePerUnit ? plan.total * qty : plan.total;
}

/* ---------------- Totaux ---------------- */

export type CartItem = {
  line: CartLine;
  product: Product;
  plan: ProtectionPlan | null;
  condition: string;
  lineTotal: number;
};

/* ---------------- Shipping (home-delivery base) — backend-driven ----------------
   The config (flat fee + free-shipping threshold, in dinars) is seeded on the
   SERVER by the (tokyo) layout and read through React context — see
   ./shipping-config. Re-exported here so the cart/checkout call sites keep a
   single import surface. `cartTotals` takes it as an argument (callers pass
   `useShippingConfig()`), falling back to the safe DEFAULT only outside a
   provider. */
import { DEFAULT_SHIPPING, useShippingConfig, type ShippingConfig } from "./shipping-config";
export { DEFAULT_SHIPPING, useShippingConfig, type ShippingConfig };

export function cartItems(stateIn: CartState): CartItem[] {
  return stateIn.lines.flatMap((line) => {
    const product = findProductBySlug(line.id);
    if (!product) return [];
    const plan = planById(product, line.plan);
    return [
      {
        line,
        product,
        plan,
        condition: conditionLabel(product.condition),
        lineTotal: product.price * line.qty + lineCareCharge(plan, line.qty),
      },
    ];
  });
}

export function cartTotals(
  items: CartItem[],
  mode: "delivery" | "pickup" = "delivery",
  cfg: ShippingConfig = DEFAULT_SHIPPING,
) {
  const products = items.reduce((s, i) => s + i.product.price * i.line.qty, 0);
  // Tokyo Care is now a REAL charge: the backend order records + bills it, so it
  // is part of the payable total (DISPLAY == CHARGE). Per-unit × qty or once per
  // line, per `careConfig.chargePerUnit`.
  const protection = items.reduce((s, i) => s + lineCareCharge(i.plan, i.line.qty), 0);
  // Free shipping is decided on the same base the backend uses: the product
  // subtotal, plus care only when `countsTowardFreeShipping` is on (matches
  // place-order's freeShipBaseCents). freeFrom === 0 ⇒ "no free-shipping offer".
  const freeShipBase = products + (careConfig.countsTowardFreeShipping ? protection : 0);
  const qualifiesFree = cfg.freeFrom > 0 && freeShipBase >= cfg.freeFrom;
  const shipping = mode === "pickup" || products === 0 || qualifiesFree ? 0 : cfg.fee;
  const count = items.reduce((s, i) => s + i.line.qty, 0);
  // subtotal = goods only; `total` now INCLUDES the care charge.
  return { products, protection, subtotal: products, shipping, total: products + protection + shipping, count };
}

export function useCartCount() {
  const s = useCart();
  return s.lines.reduce((a, l) => a + l.qty, 0);
}

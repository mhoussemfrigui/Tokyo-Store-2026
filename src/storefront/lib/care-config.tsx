"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * The store-wide Tokyo Care CHARGING knobs the storefront needs to price a cart
 * line the way the backend will (DISPLAY == CHARGE). Seeded on the SERVER (the
 * `(tokyo)` layout reads them from the backend via `resolveCareConfig`) and
 * handed to the client through React context — so the cart/checkout totals match
 * what `place-order` bills, with no bundled snapshot.
 *
 * The master `enabled` switch is NOT carried here: a disabled feature resolves to
 * an empty `product.care` on every product (the live source fails closed), so the
 * storefront simply offers no plans — these two knobs only shape the MATH once a
 * plan is chosen.
 */
export type CareDisplayConfig = {
  /** Charge the plan once per LINE (false) or per UNIT × quantity (true). */
  chargePerUnit: boolean;
  /** Count the care charge toward the free-shipping threshold. */
  countsTowardFreeShipping: boolean;
};

/* Matches `buildCareConfig`'s server defaults (per-unit on, not counted toward
   free shipping) — a safety net for a consumer rendered outside a provider; the
   layout always supplies the live value. */
export const DEFAULT_CARE: CareDisplayConfig = {
  chargePerUnit: true,
  countsTowardFreeShipping: false,
};

const CareConfigContext = createContext<CareDisplayConfig>(DEFAULT_CARE);

export function CareConfigProvider({
  value,
  children,
}: {
  value: CareDisplayConfig;
  children: ReactNode;
}) {
  return <CareConfigContext.Provider value={value}>{children}</CareConfigContext.Provider>;
}

/** The live Tokyo Care charging config from context (server-seeded). */
export function useCareConfig(): CareDisplayConfig {
  return useContext(CareConfigContext);
}

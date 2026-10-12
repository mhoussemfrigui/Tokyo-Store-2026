"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * The home-delivery shipping config the storefront DISPLAYS, in major-unit dinars.
 * Seeded on the SERVER (the `(tokyo)` layout reads it from the backend's checkout
 * settings via `getStorefrontShippingConfig`) and handed to the client through
 * React context — so the server render, crawlers and the first client paint all
 * show the real, admin-configured fee/threshold (no hardcoded default, no
 * post-mount flash), and it still equals what `resolveDelivery` charges.
 */
export type ShippingConfig = {
  /** Flat home-delivery fee in dinars (0 when the store ships free). */
  fee: number;
  /** Free-shipping threshold in dinars; 0 means "no free-shipping offer". */
  freeFrom: number;
};

/* The backend's own CHECKOUT_COPY_FALLBACKS (7 TND, free ≥ 250 TND), used only
   when a consumer renders outside a provider — the layout always supplies the
   live value, so this is a safety net, never the normal path. */
export const DEFAULT_SHIPPING: ShippingConfig = { fee: 7, freeFrom: 250 };

const ShippingConfigContext = createContext<ShippingConfig>(DEFAULT_SHIPPING);

export function ShippingConfigProvider({
  value,
  children,
}: {
  value: ShippingConfig;
  children: ReactNode;
}) {
  return <ShippingConfigContext.Provider value={value}>{children}</ShippingConfigContext.Provider>;
}

/** The live shipping config from context (server-seeded). */
export function useShippingConfig(): ShippingConfig {
  return useContext(ShippingConfigContext);
}

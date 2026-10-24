"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * The store's TVA display mode, seeded on the SERVER (the `(tokyo)` layout reads
 * `tax.mode` from settings) and handed to the client through context — so the
 * storefront never claims "TVA incluse" when the store has tax DISABLED (no VAT
 * at all) or runs in HT (prices are pre-tax, TVA added at checkout). Mirrors
 * {@link ShippingConfigProvider}.
 *
 *   - "disabled" → no VAT anywhere → show no tax caption.
 *   - "ttc"      → prices are tax-inclusive → "TVA incluse".
 *   - "ht"       → prices are pre-tax, TVA added on top → "TVA en sus".
 *
 * (A precise HT line-item total on the client needs per-line effective rates and
 * is intentionally out of scope here — this only governs the honest caption.)
 */
export type TaxDisplayMode = "disabled" | "ttc" | "ht";

const TaxModeContext = createContext<TaxDisplayMode>("disabled");

export function TaxModeProvider({ value, children }: { value: TaxDisplayMode; children: ReactNode }) {
  return <TaxModeContext.Provider value={value}>{children}</TaxModeContext.Provider>;
}

/** The live tax display mode from context (server-seeded; defaults to disabled). */
export function useTaxMode(): TaxDisplayMode {
  return useContext(TaxModeContext);
}

/** The honest price caption for the current mode (null = show nothing). */
export function taxCaption(mode: TaxDisplayMode): string | null {
  if (mode === "ttc") return "TVA incluse";
  if (mode === "ht") return "TVA en sus";
  return null;
}

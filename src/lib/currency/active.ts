import "server-only";

import { cache } from "react";

import { currencyQueries } from "@/modules/currency";
import { DEFAULT_CURRENCY, rowToActiveCurrency, type ActiveCurrency } from "./normalize";

/**
 * The store's single ACTIVE currency, resolved from the `currencies` registry
 * (Commandes → Devises). Drives how prices are LABELLED on the storefront,
 * JSON-LD, and new-order snapshots — it does NOT convert stored amounts.
 *
 * `cache()`-wrapped (React per-request memo) so callers within one render share
 * a single query — mirrors `getPriceDecimals`. Never throws: a cold/empty DB
 * degrades to the TND default. The pure shape/mapper/default live in ./normalize
 * (unit-tested); display DECIMALS stay governed by the `price.decimals` setting.
 */
export { DEFAULT_CURRENCY };
export type { ActiveCurrency };

export const getActiveCurrency = cache(async (): Promise<ActiveCurrency> => {
  try {
    const row = await currencyQueries.getActive();
    return row ? rowToActiveCurrency(row) : DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
});

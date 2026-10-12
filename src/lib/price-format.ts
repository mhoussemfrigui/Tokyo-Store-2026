import "server-only";

import { cache } from "react";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { DEFAULT_PRICE_DECIMALS, MONEY_MAX_DECIMALS } from "@/lib/price";

/**
 * Admin-controlled price DISPLAY precision.
 *
 * The minor unit is always millimes (see src/lib/price.ts); this setting only
 * controls how many decimal places the storefront SHOWS. 0 = whole dinars
 * ("250 TND"), 3 = full millimes ("249,900 TND"). Resolved server-side and
 * handed to the client via `MoneyProvider` (src/components/money-provider.tsx)
 * so every price surface honors the same precision.
 *
 * Server-only + React.cache so all callers in one render share a single read.
 */
export const PRICE_DECIMALS_SETTING_KEY = "price.decimals";

export const getPriceDecimals = cache(async (): Promise<number> => {
  try {
    const settings = await getSettingsMap();
    const raw = settings[PRICE_DECIMALS_SETTING_KEY];
    if (raw == null || raw.trim() === "") return DEFAULT_PRICE_DECIMALS;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_PRICE_DECIMALS;
    return Math.max(0, Math.min(MONEY_MAX_DECIMALS, Math.trunc(n)));
  } catch {
    // Settings table unavailable (cold DB) — fall back to whole dinars.
    return DEFAULT_PRICE_DECIMALS;
  }
});

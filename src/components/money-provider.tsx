"use client";

import { createContext, useContext, type ReactNode } from "react";

import {
  DEFAULT_PRICE_DECIMALS,
  dinarsToMinor,
  formatMoney,
  formatMoneyExact,
} from "@/lib/price";

/**
 * Store-wide price DISPLAY config, provided to client components: the admin
 * `price.decimals` precision AND the active currency's symbol + position
 * (Commandes → Devises).
 *
 * The server resolves both once per request (src/lib/price-format.ts +
 * src/lib/currency/active.ts) and seeds this provider in the shop layout. Client
 * price surfaces read it via `useMoney()` so the cart, PDP, product cards and
 * checkout all render the same precision + currency label without each one
 * re-fetching. RELABEL only — the millime scale is unchanged.
 */
type MoneyConfig = {
  decimals: number;
  currencySymbol: string;
  currencyPosition: "before" | "after";
};

const MoneyContext = createContext<MoneyConfig>({
  decimals: DEFAULT_PRICE_DECIMALS,
  currencySymbol: "TND",
  currencyPosition: "after",
});

export function MoneyProvider({
  decimals,
  currencySymbol = "TND",
  currencyPosition = "after",
  children,
}: {
  decimals: number;
  /** Active currency symbol/label (defaults to TND). */
  currencySymbol?: string;
  currencyPosition?: "before" | "after";
  children: ReactNode;
}) {
  return (
    <MoneyContext.Provider value={{ decimals, currencySymbol, currencyPosition }}>
      {children}
    </MoneyContext.Provider>
  );
}

/**
 * Money formatters bound to the store's display precision + active currency.
 * `fromMinor` takes integer minor units (millimes); `fromDinars` takes a
 * major-unit dinar value. Both render "X <currency>" at the admin-chosen
 * number of decimals. `exact` is the financial-document formatter (full
 * sub-dinar precision, decimals only when fractional) carrying the SAME active
 * currency label — for the checkout summary, which must not round a discounted
 * total yet must match the currency the line items show.
 */
export function useMoney(): {
  decimals: number;
  fromMinor: (minor: number) => string;
  fromDinars: (dinars: number) => string;
  exact: (minor: number) => string;
} {
  const { decimals, currencySymbol, currencyPosition } = useContext(MoneyContext);
  return {
    decimals,
    fromMinor: (minor: number) => formatMoney(minor, decimals, currencySymbol, currencyPosition),
    fromDinars: (dinars: number) =>
      formatMoney(dinarsToMinor(dinars), decimals, currencySymbol, currencyPosition),
    exact: (minor: number) => formatMoneyExact(minor, currencySymbol, currencyPosition),
  };
}

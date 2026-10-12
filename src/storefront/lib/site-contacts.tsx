"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * The store's public contact phone + email the storefront DISPLAYS. Seeded on
 * the SERVER (the `(tokyo)` layout reads `site_settings` « Identité & contact »
 * via `getSiteContacts`, the SAME source the footer uses) and handed to client
 * components through context — so the header, checkout confirmation, order
 * tracking and the home service CTAs all show the real, admin-configured number
 * instead of a per-file hardcoded literal. Mirrors `ShippingConfigProvider`.
 */
export type SiteContacts = { phone: string; email: string };

/** Fresh-DB fallback, used only outside a provider / when the backend is unset. */
export const DEFAULT_CONTACTS: SiteContacts = {
  phone: "+216 50 059 160",
  email: "contact@tokyostore.tn",
};

const SiteContactsContext = createContext<SiteContacts>(DEFAULT_CONTACTS);

export function SiteContactsProvider({
  value,
  children,
}: {
  value: SiteContacts;
  children: ReactNode;
}) {
  return <SiteContactsContext.Provider value={value}>{children}</SiteContactsContext.Provider>;
}

/** The live store contacts from context (server-seeded). Defensive: any missing
 *  field falls back to DEFAULT_CONTACTS, so a partial / absent context value can
 *  never leave a consumer (e.g. telHref) with an undefined phone/email. */
export function useSiteContacts(): SiteContacts {
  const ctx = useContext(SiteContactsContext);
  return {
    phone: ctx?.phone?.trim() ? ctx.phone : DEFAULT_CONTACTS.phone,
    email: ctx?.email?.trim() ? ctx.email : DEFAULT_CONTACTS.email,
  };
}

/** `tel:` href from a display phone (strips spaces/formatting, keeps +digits).
 *  Tolerates an empty/undefined phone (returns "") so it never crashes a render.
 *  The store's single number works for both calls and WhatsApp, so contact
 *  affordances keep using tel:; only WhatsApp-dependent FEATURES (e.g. automated
 *  order notifications) stay disabled until that integration exists. */
export function telHref(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/[^\d+]/g, "");
  return digits ? `tel:${digits}` : "";
}

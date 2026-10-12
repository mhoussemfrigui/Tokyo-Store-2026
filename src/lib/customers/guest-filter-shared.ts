/**
 * Guest-clients FILTER model — PURE, client-safe (no DB, no "server-only"), shared by
 * the guests browser (client), the search action (server) and the filtered-export route
 * (server, parses the query string). The SQL that applies it lives in ./guest-filter.ts.
 *
 * A "guest client" is every order placed WITHOUT an account (user_id IS NULL) grouped by
 * its identity — (lower(contact_email), contact_phone). The same person across several
 * guest checkouts collapses to one row. Amounts are entered in DINARS in the UI and
 * converted to millimes in the SQL layer. TriState / TRI_OPTIONS are shared with the
 * registered-clients filter to keep the two panels consistent.
 */

import type { TriState } from "./filter-shared";
export { TRI_OPTIONS, type TriState } from "./filter-shared";

/** One enriched guest-list row (shared by the server list + the client table + export). */
export type GuestRow = {
  /** lower(contact_email) group key — null when the guest checked out with no email. */
  emailKey: string | null;
  /** Latest display email (as typed). */
  email: string | null;
  phone: string | null;
  /** Latest ship_full_name. */
  name: string | null;
  orderCount: number;
  /** Paid spend (matches the customer-360 basis), in millimes. */
  paidSpendCents: number;
  totalSpendCents: number;
  firstOrderAt: string | null; // ISO
  lastOrderAt: string | null; // ISO
  /** A registered account whose email matches this guest's — the retro-link candidate.
   *  Present but still a guest ⇒ the account hasn't verified/claimed yet. */
  accountUserId: string | null;
  accountVerified: boolean;
  /** Customer-profile id of the matched account (deep-links to its detail page). */
  accountProfileId: string | null;
};

/** Stat-card counts over the filtered guest set (each card doubles as a quick-filter). */
export type GuestStats = {
  total: number; // distinct guest identities
  totalOrders: number;
  paidRevenueCents: number;
  withEmail: number;
  withoutEmail: number;
  withPhone: number;
  /** Identities whose email matches a registered account (conversion candidates). */
  withAccount: number;
  /** Identities with ≥ 2 guest orders (loyal guests worth converting). */
  repeat: number;
};

export type GuestFilter = {
  /** Email / phone / name fragment. */
  search: string;
  /** Checked out with an email (the only identities that can be retro-linked). */
  hasEmail: TriState;
  hasPhone: TriState;
  /** Email matches a registered account. */
  hasAccount: TriState;
  /** Guest-order-count range (empty = unbounded). */
  ordersMin: string;
  ordersMax: string;
  /** Paid spend range, in DINARS (empty = unbounded). */
  spendMin: string;
  spendMax: string;
  /** Last-order date range (yyyy-mm-dd, empty = unbounded). */
  lastFrom: string;
  lastTo: string;
};

export const EMPTY_GUEST_FILTER: GuestFilter = {
  search: "",
  hasEmail: "any",
  hasPhone: "any",
  hasAccount: "any",
  ordersMin: "",
  ordersMax: "",
  spendMin: "",
  spendMax: "",
  lastFrom: "",
  lastTo: "",
};

/** True when the filter constrains nothing (used to short-circuit / label « tous »). */
export function isEmptyGuestFilter(f: GuestFilter): boolean {
  return (Object.keys(EMPTY_GUEST_FILTER) as Array<keyof GuestFilter>).every(
    (k) => f[k] === EMPTY_GUEST_FILTER[k],
  );
}

/** Non-default fields → a flat query object (for the export URL + audit). */
export function guestFilterToParams(f: GuestFilter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(EMPTY_GUEST_FILTER) as Array<keyof GuestFilter>) {
    if (f[k] !== EMPTY_GUEST_FILTER[k] && f[k] !== "") out[k] = String(f[k]);
  }
  return out;
}

const TRI = new Set<string>(["any", "yes", "no"]);

/** Parse a query string (export route) back into a validated GuestFilter. Unknown /
 *  malformed values fall back to the empty default — never throws. */
export function guestFilterFromParams(get: (k: string) => string | null): GuestFilter {
  const tri = (k: string): TriState => {
    const v = get(k) ?? "";
    return TRI.has(v) ? (v as TriState) : "any";
  };
  const str = (k: string) => (get(k) ?? "").slice(0, 120);
  return {
    search: str("search"),
    hasEmail: tri("hasEmail"),
    hasPhone: tri("hasPhone"),
    hasAccount: tri("hasAccount"),
    ordersMin: str("ordersMin"),
    ordersMax: str("ordersMax"),
    spendMin: str("spendMin"),
    spendMax: str("spendMax"),
    lastFrom: str("lastFrom"),
    lastTo: str("lastTo"),
  };
}

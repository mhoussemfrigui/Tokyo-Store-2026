/**
 * Clients-list FILTER model — PURE, client-safe (no DB, no "server-only"), so the
 * filter panel (client), the search action (server) and the filtered-export route
 * (server, parses the query string) all share ONE definition. The SQL that applies it
 * lives in ./filter.ts. Amounts are entered in DINARS in the UI and converted to
 * millimes in the SQL layer.
 */

/** One enriched Clients-list row (shared by the server list + the client table). */
export type FilteredCustomerRow = {
  profileId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  gender: string | null;
  createdAt: string;
};

/** Stat-card counts over the filtered set (each card doubles as a quick-filter). */
export type CustomerFilterStats = {
  total: number;
  genderKnown: number;
  genderUnset: number;
  female: number;
  male: number;
  otherGender: number;
  marketing: number;
  withCart: number;
  usedCoupon: number;
};

/** Three-way toggle for the boolean-ish dimensions (any = no constraint). */
export type TriState = "any" | "yes" | "no";
export type GenderFilter = "any" | "female" | "male" | "other" | "unset" | "known";

export type CustomerFilter = {
  /** Name / email / phone fragment. */
  search: string;
  gender: GenderFilter;
  /** Has ever redeemed a coupon/promo (promotion_redemptions). */
  usedCoupon: TriState;
  /** Has a live (non quick-buy) cart with items. */
  hasCart: TriState;
  marketing: TriState;
  /** Account-created date range (yyyy-mm-dd, empty = unbounded). */
  createdFrom: string;
  createdTo: string;
  /** Birthday month 1-12 ("" = any). */
  birthdayMonth: string;
};

export const EMPTY_CUSTOMER_FILTER: CustomerFilter = {
  search: "",
  gender: "any",
  usedCoupon: "any",
  hasCart: "any",
  marketing: "any",
  createdFrom: "",
  createdTo: "",
  birthdayMonth: "",
};

export const TRI_OPTIONS: ReadonlyArray<{ value: TriState; label: string }> = [
  { value: "any", label: "Tous" },
  { value: "yes", label: "Oui" },
  { value: "no", label: "Non" },
];

export const GENDER_FILTER_OPTIONS: ReadonlyArray<{ value: GenderFilter; label: string }> = [
  { value: "any", label: "Tous" },
  { value: "known", label: "Renseigné" },
  { value: "female", label: "Femme" },
  { value: "male", label: "Homme" },
  { value: "other", label: "Autre" },
  { value: "unset", label: "Non renseigné" },
];

/** True when the filter constrains nothing (used to short-circuit / label « tous »). */
export function isEmptyCustomerFilter(f: CustomerFilter): boolean {
  return (Object.keys(EMPTY_CUSTOMER_FILTER) as Array<keyof CustomerFilter>).every(
    (k) => f[k] === EMPTY_CUSTOMER_FILTER[k],
  );
}

/** Non-default fields → a flat query object (for the export URL + audit). */
export function customerFilterToParams(f: CustomerFilter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(EMPTY_CUSTOMER_FILTER) as Array<keyof CustomerFilter>) {
    if (f[k] !== EMPTY_CUSTOMER_FILTER[k] && f[k] !== "") out[k] = String(f[k]);
  }
  return out;
}

const TRI = new Set<string>(["any", "yes", "no"]);
const GENDERS = new Set<string>(["any", "female", "male", "other", "unset", "known"]);

/** Parse a query string (export route) back into a validated CustomerFilter. Unknown /
 *  malformed values fall back to the empty default — never throws. */
export function customerFilterFromParams(get: (k: string) => string | null): CustomerFilter {
  const tri = (k: string): TriState => {
    const v = get(k) ?? "";
    return TRI.has(v) ? (v as TriState) : "any";
  };
  const str = (k: string) => (get(k) ?? "").slice(0, 120);
  const genderRaw = get("gender") ?? "";
  const monthRaw = Number(get("birthdayMonth"));
  return {
    search: str("search"),
    gender: GENDERS.has(genderRaw) ? (genderRaw as GenderFilter) : "any",
    usedCoupon: tri("usedCoupon"),
    hasCart: tri("hasCart"),
    marketing: tri("marketing"),
    createdFrom: str("createdFrom"),
    createdTo: str("createdTo"),
    birthdayMonth: Number.isInteger(monthRaw) && monthRaw >= 1 && monthRaw <= 12 ? String(monthRaw) : "",
  };
}

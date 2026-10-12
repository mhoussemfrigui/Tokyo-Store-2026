import type { CustomerProfileRow } from "./schema";

export type CustomerFullName = Pick<CustomerProfileRow, "first_name" | "last_name">;

export function formatCustomerName(p: CustomerFullName): string {
  return `${p.first_name} ${p.last_name}`.trim();
}

export function getInitials(p: CustomerFullName): string {
  const first = p.first_name?.[0] ?? "";
  const last = p.last_name?.[0] ?? "";
  return `${first}${last}`.toUpperCase() || "?";
}

/** The closed gender set stored on customer_profiles.gender (NULL = not provided).
 *  Pinned by a CHECK in migration 0158. Powers the `gender` segment dimension and
 *  the `provide_gender` engagement reward. */
export const CUSTOMER_GENDERS = ["female", "male", "other"] as const;
export type CustomerGender = (typeof CUSTOMER_GENDERS)[number];
export const CUSTOMER_GENDER_LABELS: Record<CustomerGender, string> = {
  female: "Femme",
  male: "Homme",
  other: "Autre",
};
export function isCustomerGender(v: unknown): v is CustomerGender {
  return typeof v === "string" && (CUSTOMER_GENDERS as readonly string[]).includes(v);
}

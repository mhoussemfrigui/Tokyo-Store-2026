import { WILDCARD } from "./registry";

/**
 * Coarse ACCOUNT-TYPE — derived, not stored.
 *
 * The account type is DERIVED from a user's effective RBAC permission set, so it
 * can never drift from the access the user actually holds. The permission set IS
 * the account type:
 *   - `admin`    → holds the global wildcard `'*'` (effective super-admin)
 *   - `staff`    → holds SOME grant, but not the wildcard (has admin-area access)
 *   - `customer` → empty set (no back-office access — a normal shopper)
 *
 * This is the same three-way split the authorize engine already draws
 * (`resolveAdminShellAccess`: wildcard vs non-empty vs empty), surfaced as a label.
 * PURE + synchronous so a caller that resolved the set once can label without
 * re-querying, and so it is unit-testable with no DB. It replaces the legacy
 * `users.role` enum (retired in the Stage-4 migration).
 */
export type AccountType = "customer" | "staff" | "admin";

export function accountTypeFromPerms(perms: ReadonlySet<string>): AccountType {
  if (perms.has(WILDCARD)) return "admin";
  return perms.size > 0 ? "staff" : "customer";
}

/** French labels for the admin surfaces (KPI cards, fiche « Type de compte »). */
export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  customer: "Client",
  staff: "Staff",
  admin: "Admin",
};

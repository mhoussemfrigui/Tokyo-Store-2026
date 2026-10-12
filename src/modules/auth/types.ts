import type { UserRow } from "./schema";

/**
 * Public user shape — what gets passed around the app.
 * Never includes password hash, OAuth tokens, or any other secret.
 *
 * Carries NO account-type / role field: authorization is resolved live from the
 * RBAC engine (`resolveUserPermissions`) and the coarse account TYPE is derived
 * (`lib/rbac/account-type.ts`), never stored on the user.
 */
export type AuthUser = Pick<
  UserRow,
  "id" | "email" | "name" | "image" | "emailVerified" | "twoFactorEnabled" | "createdAt"
>;

/** Strip sensitive fields before sending a user object to a client. */
export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    image: row.image,
    emailVerified: row.emailVerified,
    twoFactorEnabled: row.twoFactorEnabled,
    createdAt: row.createdAt,
  };
}

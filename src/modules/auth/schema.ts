import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Auth module — tables managed by Better Auth.
 *
 * Better Auth's Drizzle adapter introspects camelCase field names
 * (emailVerified, createdAt, etc.) so this schema deviates from the
 * snake_case convention used elsewhere in the codebase. SQL columns
 * stay snake_case via the explicit `text("column_name")` second arg,
 * so DB integrity is unchanged.
 *
 * Authorization is NOT stored on this table: access is governed entirely by the
 * RBAC `roles` / `user_roles` / `role_permissions` tables + the per-user
 * `user_permissions` overlay. The legacy `users.role` enum (customer|staff|admin)
 * was retired in migration 0193 — the ACCOUNT TYPE is derived from the effective
 * permission set (see `lib/rbac/account-type.ts` + `lib/rbac/roster.ts`).
 */

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    // Optional opt-in TOTP 2FA (Better Auth twoFactor plugin). Flips true ONLY
    // after the user verifies an authenticator code (skipVerificationOnEnable
    // is false). The secret + backup codes live in `two_factors`, encrypted.
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    // Per-user setting for OAuth auto-linking (migration 0099; default flipped ON
    // in 0157). TRUE = a verified-email Google sign-in may link onto this account and
    // sign the user in. The auth gate ALWAYS refuses this silent link when the account
    // has 2FA enabled (a second factor is never bypassed), so the ON default is safe;
    // the user can still turn it OFF from their profile.
    oauthAutolink: boolean("oauth_autolink").notNull().default(true),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailUnique: uniqueIndex("users_email_unique").on(table.email),
    createdAtIdx: index("users_created_at_idx").on(table.createdAt),
    // DB-only trigram GINs for the admin Utilisateurs `%q%` search (email + name):
    //   users_email_trgm  (baseline)   — gin (email gin_trgm_ops)
    //   users_name_trgm   (migration 0069) — gin (name  gin_trgm_ops)
    // Declared in SQL (drizzle-kit can't express gin_trgm_ops); listed here so
    // the index set stays discoverable from the schema.
  }),
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenUnique: uniqueIndex("sessions_token_unique").on(table.token),
    userIdx: index("sessions_user_idx").on(table.userId),
    expiresIdx: index("sessions_expires_idx").on(table.expiresAt),
  }),
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerAccountUnique: uniqueIndex("accounts_provider_account_unique").on(
      table.providerId,
      table.accountId,
    ),
    userIdx: index("accounts_user_idx").on(table.userId),
  }),
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identifierIdx: index("verifications_identifier_idx").on(table.identifier),
    expiresIdx: index("verifications_expires_idx").on(table.expiresAt),
  }),
);

/**
 * Two-factor enrolment (Better Auth twoFactor plugin). One row per user (UNIQUE
 * user_id). `secret` (TOTP) + `backup_codes` are stored ENCRYPTED by the plugin
 * with BETTER_AUTH_SECRET — never plaintext, never returned to the client. The
 * plugin's model name is `twoFactor`; we map it to this table in the adapter
 * schema (server.ts). Deleting a user cascades. JS camelCase keys ↔ snake_case
 * SQL columns, matching the Better Auth adapter convention used above.
 */
export const twoFactors = pgTable(
  "two_factors",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One TOTP secret per user — UNIQUE (not the plugin's default non-unique
    // index) so a re-enable / race can't leave two rows and a non-deterministic
    // findOne. Doubles as the user_id lookup index.
    userUnique: uniqueIndex("two_factors_user_unique").on(table.userId),
    // (two_factors_secret_idx dropped in 0135 — a dead index on the AES-encrypted
    //  secret; the one-per-user lookup uses two_factors_user_unique above.)
  }),
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type TwoFactorRow = typeof twoFactors.$inferSelect;

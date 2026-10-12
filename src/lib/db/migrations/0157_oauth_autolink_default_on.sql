-- 0157 — Google auto-link ON by default.
--
-- `users.oauth_autolink` (0099) gates whether a verified Google sign-in may silently
-- link onto an EXISTING email/password account and mint a session. It shipped OFF by
-- default (secure). Per product decision the convenience is now the default: a Google
-- sign-in whose email matches an account links automatically.
--
-- IMPORTANT: this does NOT re-open the 2FA-bypass the toggle was built to close. The
-- auth gate (src/lib/auth/server.ts account.create.before) still NEVER links silently
-- onto an account with an ENABLED second factor — a 2FA account must complete a full
-- password + TOTP sign-in — regardless of this flag. So the default flip only affects
-- accounts without 2FA.
ALTER TABLE "users" ALTER COLUMN "oauth_autolink" SET DEFAULT true;
--> statement-breakpoint
-- Bring EXISTING accounts onto the new default. Safe here: the store is pre-launch, no
-- user has meaningfully opted out (there was no prompt to change it and Google OAuth is
-- disabled until credentials are configured), so no deliberate opt-out is overwritten.
UPDATE "users" SET "oauth_autolink" = true WHERE "oauth_autolink" = false;

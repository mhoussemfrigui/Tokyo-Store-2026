import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";

/**
 * Better Auth CLIENT — for client components only (social sign-in buttons,
 * the /account 2FA panel, etc.). Same-origin base URL, so no env wiring is
 * needed. The server-side instance lives in `./server.ts` and must never be
 * imported from the client.
 *
 * `signIn.social({ provider, callbackURL })` starts the OAuth redirect flow;
 * the providers themselves are configured server-side (env vars OR
 * admin-entered, encrypted DB credentials — see src/lib/auth/social-config.ts)
 * and the buttons are gated by the admin `auth.social.*_enabled` settings — see
 * `src/lib/auth/pages-config.ts`.
 *
 * `twoFactorClient` exposes `authClient.twoFactor.{enable,disable,verifyTotp,
 * getTotpUri,generateBackupCodes,verifyBackupCode}` for the opt-in 2FA UI.
 * `twoFactorPage` is where a client-driven `signIn.email` would redirect when
 * the account has 2FA on; our primary email/password login is a SERVER action,
 * which handles that redirect itself (see lib/actions/auth.ts), so this is a
 * belt-and-suspenders default for any client-side sign-in.
 */
export const authClient = createAuthClient({
  plugins: [twoFactorClient({ twoFactorPage: "/login/2fa" })],
});

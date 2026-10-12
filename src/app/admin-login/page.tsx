import type { Metadata } from "next";

import { getSiteLogoUrl } from "@/lib/api/cms";
import { AdminLoginForm } from "./admin-login-form";

export const metadata: Metadata = {
  title: "Connexion administration",
  // Staff entry point — never indexed.
  robots: { index: false, follow: false },
};

/** Allow-list a same-origin redirect path (mirrors signinAction's guard).
 *  Default to /admin so a bare visit lands staff in the panel after sign-in. */
function safeFrom(v: string | undefined): string {
  if (!v) return "/admin";
  if (!/^\/(?![/\\])/.test(v)) return "/admin";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\s]/.test(v)) return "/admin";
  return v;
}

/**
 * Dedicated STAFF / admin login — a separate connection point from the customer
 * `/login`. Lives OUTSIDE the gated `/admin/*` segment so an unauthenticated
 * visitor can reach it. Reachable at `/admin-login` (or the secret
 * ADMIN_LOGIN_PATH, rewritten by proxy.ts). On success the shared Better Auth
 * sign-in redirects to `from` (default `/admin`); the /admin layout then
 * enforces RBAC — a non-admin who signs in here simply 404s at /admin.
 */
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const [sp, logoUrl] = await Promise.all([
    searchParams,
    getSiteLogoUrl().catch(() => null),
  ]);
  return <AdminLoginForm from={safeFrom(sp.from)} logoUrl={logoUrl} />;
}

import type { Metadata } from "next";
import { Suspense } from "react";

import { getAuthPagesConfig } from "@/lib/auth/pages-config";
import { AUTH_PAGES_FALLBACK } from "@/components/auth/pages-fallback";

import { ResetPasswordForm } from "./reset-password-form";

// The reset token rides in the URL and must never be cached / statically
// prerendered (same useSearchParams-is-the-whole-page shape as /login).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Réinitialiser le mot de passe",
  alternates: { canonical: "/reset-password" },
  robots: { index: false, follow: true },
  // Keep the token out of the Referer header on any navigation away (even
  // same-origin). Defence-in-depth atop single-use + 1h TTL.
  referrer: "no-referrer",
};

export default async function ResetPasswordPage() {
  const config = await getAuthPagesConfig().catch(() => null);
  const { resetPassword } = config ?? AUTH_PAGES_FALLBACK;
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm copy={resetPassword} />
    </Suspense>
  );
}

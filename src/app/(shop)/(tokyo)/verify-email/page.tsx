import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { workflows } from "@/workflows";
import { getCurrentUser } from "@/lib/auth/session";
import { getAuthPagesConfig } from "@/lib/auth/pages-config";
import { AUTH_PAGES_FALLBACK } from "@/components/auth/pages-fallback";
import { AuthShell } from "@/storefront/components/storefront/auth-shell";
import { btn } from "@/storefront/components/storefront/ui-classes";
import { cn } from "@/storefront/lib/utils";

export const metadata: Metadata = {
  title: "Vérification de l'e-mail",
  alternates: { canonical: "/verify-email" },
  robots: { index: false, follow: true },
};

/**
 * Verify-email RESULT page (Tokyo design). The emailed link is handled by Better
 * Auth (GET /api/auth/verify-email), which verifies, signs the user in, claims
 * their guest orders, then redirects here:
 *   - `?error=<CODE>` → the « lien invalide » copy;
 *   - `?confirmed=1` → success (signed in → /account, else → /login?verified=1);
 *   - `?token=…` → a legacy direct link, verified through the workflow;
 *   - nothing → the « lien incomplet » copy.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string; confirmed?: string }>;
}) {
  const { token, error, confirmed } = await searchParams;

  const config = await getAuthPagesConfig().catch(() => null);
  const { verifyEmail } = config ?? AUTH_PAGES_FALLBACK;

  if (error) {
    return <Result title={verifyEmail.invalidTitle} body={verifyEmail.invalidBody} href="/login" cta="Retour à la connexion" />;
  }

  if (confirmed === "1") {
    const user = await getCurrentUser().catch(() => null);
    if (!user) redirect("/login?verified=1");
    return (
      <Result
        title="Adresse e-mail confirmée"
        body="Merci ! Votre adresse e-mail est vérifiée et votre compte est prêt."
        href="/account"
        cta="Accéder à mon compte"
      />
    );
  }

  if (!token) {
    return <Result title={verifyEmail.incompleteTitle} body={verifyEmail.incompleteBody} href="/login" cta="Retour à la connexion" />;
  }

  const result = await workflows.auth.verifyEmail({ token });
  if (result.ok) redirect("/login?verified=1");

  return <Result title={verifyEmail.invalidTitle} body={result.message ?? verifyEmail.invalidBody} href="/login" cta="Retour à la connexion" />;
}

function Result({
  title,
  body,
  href,
  cta,
}: {
  title: string;
  body: string;
  href: string;
  cta: string;
}) {
  return (
    <AuthShell crumbLabel="Vérification" title={title} subtitle={body}>
      <Link href={href} className={cn(btn.base, btn.lg, btn.primary, "w-full")}>
        {cta}
      </Link>
    </AuthShell>
  );
}

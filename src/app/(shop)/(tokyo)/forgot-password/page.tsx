import type { Metadata } from "next";

import { getAuthPagesConfig } from "@/lib/auth/pages-config";
import { AUTH_PAGES_FALLBACK } from "@/components/auth/pages-fallback";

import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = {
  title: "Mot de passe oublié",
  description: "Demandez un lien de réinitialisation de votre mot de passe Tokyo Store.",
  alternates: { canonical: "/forgot-password" },
  robots: { index: false, follow: true },
};

export default async function ForgotPasswordPage() {
  // Recovery copy is admin-editable (Clients → Connexion & comptes).
  const config = await getAuthPagesConfig().catch(() => null);
  const { forgotPassword } = config ?? AUTH_PAGES_FALLBACK;
  return <ForgotPasswordForm copy={forgotPassword} />;
}

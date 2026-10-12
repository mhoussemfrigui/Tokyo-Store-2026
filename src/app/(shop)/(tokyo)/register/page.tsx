import type { Metadata } from "next";
import { Suspense } from "react";

import { getAuthPagesConfig } from "@/lib/auth/pages-config";
import { AUTH_PAGES_FALLBACK } from "@/components/auth/pages-fallback";

import { AuthExperience } from "../auth-experience";

export const metadata: Metadata = {
  title: "Créer un compte",
  description:
    "Créez votre compte Tokyo Store : suivi de commandes, favoris, garanties et offres réservées aux membres.",
  alternates: { canonical: "/register" },
  robots: { index: false, follow: true },
};

export default async function RegisterPage() {
  // Page copy + social toggles are admin-editable (Clients → Connexion &
  // comptes). A DB outage degrades to the bundled defaults — never a crash.
  const config = await getAuthPagesConfig().catch(() => null);
  const { social, register } = config ?? AUTH_PAGES_FALLBACK;
  // AuthExperience reads `from` via useSearchParams → needs Suspense. It renders
  // both modes so /register can morph into login in place.
  return (
    <Suspense fallback={null}>
      <AuthExperience
        initialMode="register"
        social={social}
        registerCopy={{ title: register.title, footnote: register.footnote }}
      />
    </Suspense>
  );
}

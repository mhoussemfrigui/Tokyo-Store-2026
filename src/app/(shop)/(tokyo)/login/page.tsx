import type { Metadata } from "next";
import { Suspense } from "react";

import { getAuthPagesConfig } from "@/lib/auth/pages-config";
import { AUTH_PAGES_FALLBACK } from "@/components/auth/pages-fallback";

import { AuthExperience } from "../auth-experience";

export const metadata: Metadata = {
  title: "Connexion",
  alternates: { canonical: "/login" },
  robots: { index: false, follow: true },
};

export default async function LoginPage() {
  // Social toggles + register copy are admin-editable (Clients → Connexion &
  // comptes); a DB outage degrades to the bundled defaults — never a crash.
  const config = await getAuthPagesConfig().catch(() => null);
  const { social, register } = config ?? AUTH_PAGES_FALLBACK;
  // AuthExperience reads `from`/`verified` via useSearchParams → needs Suspense.
  // It renders both modes so /login can morph into register in place.
  return (
    <Suspense fallback={null}>
      <AuthExperience
        initialMode="login"
        social={social}
        registerCopy={{ title: register.title, footnote: register.footnote }}
      />
    </Suspense>
  );
}

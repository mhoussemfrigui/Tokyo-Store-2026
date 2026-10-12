import type { Metadata } from "next";
import { Suspense } from "react";

import { TwoFactorForm } from "./two-factor-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Vérification en deux étapes",
  alternates: { canonical: "/login/2fa" },
  robots: { index: false, follow: false },
};

export default function TwoFactorPage() {
  // useSearchParams (in TwoFactorForm) needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <TwoFactorForm />
    </Suspense>
  );
}

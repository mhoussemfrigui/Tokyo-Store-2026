"use client";

// global-error REPLACES the root layout, so it must render its own <html>/<body>
// and bring its own stylesheet (the root layout's CSS import no longer applies).
import "./globals.css";

import { ErrorCard } from "@/components/error-card";

/**
 * The absolute last-resort boundary — catches a throw in the ROOT layout itself
 * (where `src/app/error.tsx` cannot reach). Without this, Next renders its own
 * unstyled default page. The crimson card self-scopes `.tokyo`; fonts fall back
 * to the system stack here (next/font isn't wired on this bare document), which
 * is acceptable for a last-resort screen.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="fr-TN">
      <body>
        <ErrorCard error={error} reset={reset} fullScreen homeHref="/" />
      </body>
    </html>
  );
}

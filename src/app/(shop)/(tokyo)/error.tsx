"use client";

import { ErrorCard } from "@/components/error-card";

/**
 * Crimson storefront error boundary. Renders inside the (tokyo) chrome
 * (header/footer stay mounted), so the card centers within the page.
 *
 * NOTE: next@16.2.6's error-boundary prop is `reset` — the previous version here
 * destructured a non-existent `retry`, so « Réessayer » threw. It uses `reset`.
 */
export default function StorefrontError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorCard error={error} reset={reset} variant="storefront" homeHref="/" />;
}

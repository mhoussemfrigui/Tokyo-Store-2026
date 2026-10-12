"use client";

import { ErrorCard } from "@/components/error-card";

/**
 * Legacy-storefront error boundary. Keeps the (shell) chrome mounted; renders the
 * shared crimson error card centered within the page.
 */
export default function ShopError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorCard error={error} reset={reset} variant="storefront" homeHref="/" homeLabel="Retour à la boutique" />;
}

"use client";

import { ErrorCard } from "@/components/error-card";

/**
 * Admin-scoped error boundary. Catches any uncaught throw in `/admin/*` so the
 * dashboard chrome (sidebar, user menu) stays mounted. Renders the shared crimson
 * error card in "admin" mode — which adds the « Voir dans le journal » deep-link
 * (filtered to this incident's reference) + the Infrastructure tabs, so an
 * operator can trace the error. The reference matches what the `onRequestError`
 * hook wrote to the audit log; the raw message/stack are never shown in prod.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorCard
      error={error}
      reset={reset}
      variant="admin"
      homeHref="/admin"
      homeLabel="Retour au tableau de bord"
    />
  );
}

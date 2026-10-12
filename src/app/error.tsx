"use client";

import { ErrorCard } from "@/components/error-card";

/**
 * Root error boundary — the last resort for anything thrown outside the (shop)
 * and /admin segment trees (and the fallback when a nested boundary itself
 * throws). Renders bare (no chrome), so the card centers full-screen.
 *
 * The reference shown is derived from `error.digest`; the server `onRequestError`
 * hook (src/instrumentation.ts) logs the SAME reference to the audit log +
 * container logs, so the incident is traceable.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorCard error={error} reset={reset} fullScreen homeHref="/" />;
}

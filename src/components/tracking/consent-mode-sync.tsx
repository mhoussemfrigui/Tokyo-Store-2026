"use client";

import { useEffect } from "react";

import { useConsent } from "@/components/consent/consent-provider";
import { signalsFromState, type ConsentModeStrategy } from "@/lib/tracking/consent-mode";

/**
 * Pushes the EFFECTIVE consent (after bypass / banner-disabled / offer masking)
 * into the loaded tags whenever it changes:
 *  - Google tags: `gtag('consent','update',…)` — skipped when the strategy is
 *    "off" (no Consent Mode signalling at all). Otherwise the default-consent
 *    stub from the layout defined `gtag`, so this always lands in the dataLayer
 *    and GTM/GA pick up the latest state whenever they load.
 *  - Meta Pixel: its OWN model — `fbq('consent','grant'|'revoke')` — driven by
 *    the marketing decision regardless of the Google strategy (Meta ignores
 *    Consent Mode). The pixel script may still be loading, so we retry briefly.
 *
 * Renders nothing. Mount once next to <TrackingScripts>.
 */
export function ConsentModeSync({
  mode,
  hasPixel,
}: {
  mode: ConsentModeStrategy;
  /** Whether a Meta Pixel id is configured — gates the fbq sync + its warning. */
  hasPixel: boolean;
}) {
  const consent = useConsent();
  const decided = consent?.effectiveDecided ?? false;
  const state = consent?.effectiveState;

  useEffect(() => {
    if (!decided || !state) return;
    const w = window as Window & {
      gtag?: (...args: unknown[]) => void;
      fbq?: (...args: unknown[]) => void;
    };

    // Google Consent Mode v2 update (all seven signals). Skipped under "off"
    // (no Consent Mode) — Google tags then collect per their own default.
    if (mode !== "off" && typeof w.gtag === "function") {
      w.gtag("consent", "update", signalsFromState(state));
    }

    // Meta Pixel mirror — only when a pixel is actually configured. Without this
    // guard fbq never loads for a store with no pixel, so the retry below would
    // poll (and, in dev, "warn") on every page for no reason.
    if (!hasPixel) return;
    // Retry until fbq is ready (it loads asynchronously).
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const grant = state.marketing ? "grant" : "revoke";
    const applyFbq = () => {
      if (cancelled) return;
      if (typeof w.fbq === "function") {
        w.fbq("consent", grant);
        return;
      }
      if (tries++ < 20) {
        timer = setTimeout(applyFbq, 250);
      } else if (process.env.NODE_ENV !== "production") {
        // A pixel IS configured but fbq never loaded (blocked / CSP / slow network)
        // after ~5s — the marketing grant/revoke was lost. Surface it in dev rather
        // than failing silently.
        console.warn(
          `[consent] Meta Pixel (fbq) never loaded after 5s — marketing consent "${grant}" not applied`,
        );
      }
    };
    applyFbq();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [decided, state, mode, hasPixel]);

  return null;
}

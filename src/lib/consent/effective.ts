/**
 * EFFECTIVE consent resolver — the single source of truth that HARMONIZES the
 * Cookies & RGPD config (banner enabled + offered categories) with the Suivi &
 * Analytics bypass switch, into the consent the storefront actually acts on.
 *
 * PURE (no "server-only", no "use client", no DOM): the client ConsentProvider
 * calls `resolveEffectiveConsent` (the runtime source of truth for `isAllowed` +
 * the pushed signals) and `isForceGranted`; also covered directly by unit tests.
 *
 * Three postures:
 *   - "bypass"   — admin turned ON « Bypass / tout suivre » in Suivi: collect
 *                  from EVERYONE regardless of the banner or the visitor's
 *                  choice. The banner may still render (the owner's call) but it
 *                  has no effect. Legally the owner's responsibility.
 *   - "disabled" — the consent banner is OFF: there is no consent gate, so
 *                  everything is granted (mirrors the provider's existing
 *                  "consent management disabled" behaviour, now also reflected in
 *                  Consent Mode).
 *   - "managed"  — the normal GDPR path: the visitor's stored decision, MASKED
 *                  by the offered categories. A category the admin no longer
 *                  offers is ALWAYS denied — even for a returning visitor whose
 *                  cookie still carries an old grant (this is what makes the
 *                  "Catégories proposées" toggles authoritative).
 */

import {
  deniedState,
  grantedState,
  type ConsentState,
} from "./categories";

export type ConsentPosture = "bypass" | "disabled" | "managed";

export type ConsentOffer = {
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
};

/**
 * Force every non-offered optional category denied. The offer toggles are
 * authoritative even over a stale stored grant from before the admin disabled
 * the category (`necessary` is always granted).
 */
export function maskByOffer(state: ConsentState, offer: ConsentOffer): ConsentState {
  return {
    necessary: true,
    functional: state.functional && offer.functional,
    analytics: state.analytics && offer.analytics,
    marketing: state.marketing && offer.marketing,
  };
}

/**
 * Resolve the effective consent + posture from both configs and the visitor's
 * decision. `decision`/`decided` describe the visitor's stored choice (managed
 * path only); bypass + disabled short-circuit to a full grant.
 */
export function resolveEffectiveConsent(opts: {
  bannerEnabled: boolean;
  bypass: boolean;
  offer: ConsentOffer;
  decided: boolean;
  decision: ConsentState;
}): { state: ConsentState; posture: ConsentPosture; decided: boolean } {
  if (opts.bypass) return { state: grantedState(), posture: "bypass", decided: true };
  if (!opts.bannerEnabled) return { state: grantedState(), posture: "disabled", decided: true };
  if (!opts.decided) return { state: deniedState(), posture: "managed", decided: false };
  return { state: maskByOffer(opts.decision, opts.offer), posture: "managed", decided: true };
}

/**
 * Whether the storefront collects freely (no per-visitor consent gate) — true
 * for the bypass + banner-disabled postures. The ConsentProvider uses it to
 * force consent allowed (which in turn drives the funnel + ConsentModeSync); the
 * server layout computes the same condition inline for the Consent Mode default
 * stub.
 */
export function isForceGranted(posture: ConsentPosture): boolean {
  return posture === "bypass" || posture === "disabled";
}

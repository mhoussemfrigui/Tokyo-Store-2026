"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import {
  deniedState,
  grantedState,
  type ConsentCategory,
  type ConsentConfig,
  type ConsentState,
} from "@/lib/consent/categories";
import {
  clearTrackingCookies,
  isConsentRecordCurrent,
  readConsentRecord,
  setConsentManagementDisabled,
  setConsentOffer,
  setConsentRevision,
  writeConsentRecord,
} from "@/lib/consent/state";
import { resolveEffectiveConsent, isForceGranted } from "@/lib/consent/effective";
import { flushFunnelQueue } from "@/lib/tracking/funnel";

/**
 * Client consent context. Mirrors the WishlistProvider pattern (the codebase's
 * single client-context precedent): `createContext<T | null>(null)` + a nullable
 * `useConsent()` that callers null-check.
 *
 * The admin CONFIG arrives as a server-rendered prop (no flash). The visitor's
 * DECISION is read from the `tokyo.consent` cookie on mount; the banner only
 * appears after hydration when there is no valid decision, so returning visitors
 * never see a flash. All non-necessary categories are opt-in (default denied).
 */

type ConsentContextValue = {
  config: ConsentConfig;
  /** True once the visitor has made (or inherited) a decision. */
  decided: boolean;
  /** The visitor's RAW decision (drives the banner + the preferences dialog). */
  state: ConsentState;
  /**
   * What the storefront actually acts on after harmonizing with the Suivi
   * bypass switch + the offered categories: granted-everything under bypass /
   * banner-disabled, else the decision masked by `config.offer`. Drives
   * `isAllowed` and the Consent Mode signals pushed.
   */
  effectiveState: ConsentState;
  /** True when `effectiveState` is meaningful to push (decided OR force-granted). */
  effectiveDecided: boolean;
  bannerVisible: boolean;
  preferencesOpen: boolean;
  isAllowed: (category: ConsentCategory) => boolean;
  acceptAll: () => void;
  rejectAll: () => void;
  savePreferences: (choices: { functional: boolean; analytics: boolean; marketing: boolean }) => void;
  openPreferences: () => void;
  closePreferences: () => void;
};

const ConsentContext = createContext<ConsentContextValue | null>(null);

export function ConsentProvider({
  config,
  bypass = false,
  children,
}: {
  config: ConsentConfig;
  /** « Bypass / tout suivre » (Suivi & Analytics): collect from everyone,
   *  ignoring the banner + the visitor's choice. The banner may still render. */
  bypass?: boolean;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<ConsentState>(deniedState());
  const [decided, setDecided] = useState(false);
  const [bannerVisible, setBannerVisible] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);

  // The single source of truth for what the storefront acts on — the pure
  // resolver harmonizes bypass + banner-disabled + the offered categories with
  // the visitor's decision (see lib/consent/effective.ts). `decided`/`state`
  // describe the visitor's raw choice; bypass/disabled short-circuit to granted.
  const eff = useMemo(
    () =>
      resolveEffectiveConsent({
        bannerEnabled: config.enabled,
        bypass,
        offer: config.offer,
        decided,
        decision: state,
      }),
    [config.enabled, bypass, config.offer, decided, state],
  );
  const forceGranted = isForceGranted(eff.posture);

  // Mirror "no consent gate" + the offered categories + the consent revision
  // into the framework-agnostic funnel synchronously on the client — before any
  // child effect can call track(). Without the revision, a returning visitor was
  // re-prompted here while the funnel kept honouring their voided pre-bump grant.
  // Client-guarded so SSR never mutates shared module state across
  // requests. Not writing a cookie here is deliberate: re-enabling consent later
  // correctly re-prompts every visitor (no fabricated grant lingers).
  if (typeof window !== "undefined") {
    setConsentManagementDisabled(forceGranted);
    setConsentOffer(config.offer);
    setConsentRevision(config.revision);
  }

  // Hydrate the decision from the cookie once, after mount.
  useEffect(() => {
    if (!config.enabled) {
      // Owner turned consent management OFF → full grant in memory (isAllowed
      // short-circuits, the funnel honors the in-memory flag). No cookie is
      // persisted, so a later re-enable re-prompts cleanly.
      setState(grantedState());
      setDecided(true);
      return;
    }
    const record = readConsentRecord();
    if (record && isConsentRecordCurrent(record, config.revision)) {
      setState(record.categories);
      setDecided(true);
    } else {
      // No decision (or stale after a revision bump) → ask.
      setDecided(false);
      setBannerVisible(true);
    }
  }, [config.enabled, config.revision]);

  const commit = useCallback(
    (next: ConsentState) => {
      setState(next);
      setDecided(true);
      setBannerVisible(false);
      setPreferencesOpen(false);
      writeConsentRecord(next, config.revision, Date.now());
      // Sweep known third-party cookies for any category now denied.
      if (!next.functional || !next.analytics || !next.marketing) clearTrackingCookies();
    },
    [config.revision],
  );

  const acceptAll = useCallback(
    () =>
      commit({
        necessary: true,
        functional: config.offer.functional,
        analytics: config.offer.analytics,
        marketing: config.offer.marketing,
      }),
    [commit, config.offer.functional, config.offer.analytics, config.offer.marketing],
  );

  const rejectAll = useCallback(() => commit(deniedState()), [commit]);

  const savePreferences = useCallback(
    (choices: { functional: boolean; analytics: boolean; marketing: boolean }) =>
      // Mask each choice by whether the owner offers the category at all.
      commit({
        necessary: true,
        functional: config.offer.functional && choices.functional,
        analytics: config.offer.analytics && choices.analytics,
        marketing: config.offer.marketing && choices.marketing,
      }),
    [commit, config.offer.functional, config.offer.analytics, config.offer.marketing],
  );

  // The effective consent the storefront acts on (from the resolver above):
  // granted-everything under bypass / banner-disabled, else the decision masked
  // by the offered categories.
  const effectiveState = eff.state;
  const effectiveDecided = eff.decided;

  const isAllowed = useCallback(
    (category: ConsentCategory) =>
      category === "necessary" ? true : effectiveState[category] === true,
    [effectiveState],
  );

  // When analytics consent becomes allowed, replay any events captured before
  // the decision (entry-page view, or a purchase decided at checkout).
  useEffect(() => {
    if (isAllowed("analytics")) flushFunnelQueue();
  }, [isAllowed]);

  const value = useMemo<ConsentContextValue>(
    () => ({
      config,
      decided,
      state,
      effectiveState,
      effectiveDecided,
      bannerVisible,
      preferencesOpen,
      isAllowed,
      acceptAll,
      rejectAll,
      savePreferences,
      openPreferences: () => setPreferencesOpen(true),
      closePreferences: () => setPreferencesOpen(false),
    }),
    [config, decided, state, effectiveState, effectiveDecided, bannerVisible, preferencesOpen, isAllowed, acceptAll, rejectAll, savePreferences],
  );

  return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}

/** Nullable on purpose — callers must null-check (matches useWishlist). */
export function useConsent(): ConsentContextValue | null {
  return useContext(ConsentContext);
}

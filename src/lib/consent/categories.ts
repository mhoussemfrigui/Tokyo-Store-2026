/**
 * Cookie-consent categories + shared types.
 *
 * This module is intentionally PURE (no "server-only", no "use client", no
 * `document`/`window` access) so it can be imported from the server config
 * loader, the client provider/banner, AND the framework-agnostic tracking
 * funnel without dragging a runtime boundary along.
 *
 * GDPR/ePrivacy model: "necessary" cookies are exempt and always granted; every
 * other category is OPT-IN (default denied) and only set after an explicit,
 * affirmative choice. Withdrawing consent must be as easy as giving it.
 */

export const CONSENT_COOKIE = "tokyo.consent";

/** How long a stored consent decision is honoured before we re-ask (≈ CNIL's 13 months). */
export const CONSENT_MAX_AGE_DAYS = 180;

export type ConsentCategory = "necessary" | "functional" | "analytics" | "marketing";

/** The four categories, in display order. `necessary` is locked on. */
export const CONSENT_CATEGORIES: ReadonlyArray<{
  key: ConsentCategory;
  /** Whether the visitor can toggle it (necessary cannot). */
  locked: boolean;
  label: string;
  description: string;
}> = [
  {
    key: "necessary",
    locked: true,
    label: "Strictement nécessaires",
    description:
      "Indispensables au fonctionnement du site : session, panier, sécurité. Toujours actifs — ils ne déposent aucune donnée à des fins de suivi.",
  },
  {
    key: "functional",
    locked: false,
    label: "Fonctionnels",
    description:
      "Mémorisent vos préférences (liste d'envies, choix d'affichage) pour améliorer votre expérience.",
  },
  {
    key: "analytics",
    locked: false,
    label: "Mesure d'audience",
    description:
      "Nous aident à comprendre l'utilisation du site (pages vues, parcours d'achat) afin de l'améliorer.",
  },
  {
    key: "marketing",
    locked: false,
    label: "Marketing",
    description:
      "Permettent de mesurer nos campagnes et d'afficher des contenus pertinents (pixels publicitaires).",
  },
];

/** Per-category grant flags. `necessary` is always true. */
export type ConsentState = {
  necessary: true;
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
};

/** The record persisted in the visitor's `tokyo.consent` cookie. */
export type ConsentRecord = {
  /** Consent revision at the time of the decision (re-prompt when admin bumps it). */
  v: number;
  /** Decision timestamp (epoch ms). */
  t: number;
  categories: ConsentState;
};

/** All non-necessary categories OFF — the GDPR-safe default + "Tout refuser" result. */
export function deniedState(): ConsentState {
  return { necessary: true, functional: false, analytics: false, marketing: false };
}

/** All categories ON — the "Tout accepter" result. */
export function grantedState(): ConsentState {
  return { necessary: true, functional: true, analytics: true, marketing: true };
}

/**
 * Admin-facing configuration for the consent UI (sourced from `consent.*`
 * site_settings). This is the CONFIG (which categories exist, copy, tag ids) —
 * NOT the per-visitor decision, which lives in the cookie.
 */
export type ConsentConfig = {
  /** Master switch — when false the banner never renders and nothing is gated as opt-in. */
  enabled: boolean;
  title: string;
  description: string;
  policyUrl: string;
  privacyUrl: string;
  /** Whether each optional category is offered to visitors. `necessary` is implicit. */
  offer: { functional: boolean; analytics: boolean; marketing: boolean };
  /** Bump to invalidate every stored decision and re-prompt (e.g. after adding a tag). */
  revision: number;
};

/** True when the category is offered as a toggle (necessary is never a toggle). */
export function isCategoryOffered(config: ConsentConfig, key: ConsentCategory): boolean {
  if (key === "necessary") return false;
  return config.offer[key];
}

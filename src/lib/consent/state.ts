/**
 * Client-side consent persistence + read helpers.
 *
 * The visitor's decision lives in a first-party, JS-readable cookie
 * (`tokyo.consent`) so that BOTH React (the provider/banner) and the
 * framework-agnostic tracking funnel can read it synchronously without a round
 * trip. Storing a consent choice is itself exempt from consent (it's strictly
 * necessary to remember the choice).
 *
 * Everything here is guarded for SSR (`typeof document === "undefined"`) and
 * never throws — a malformed cookie degrades to "no decision yet".
 */

import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_DAYS,
  deniedState,
  type ConsentCategory,
  type ConsentRecord,
  type ConsentState,
} from "./categories";

/** Broadcast on the window whenever the decision changes, so non-React readers can react. */
export const CONSENT_CHANGE_EVENT = "gz:consent-change";

function readRawCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split("; ")) {
    if (part.startsWith(prefix)) return part.slice(prefix.length);
  }
  return null;
}

/** Parse the stored decision, or null when none / malformed. */
export function readConsentRecord(): ConsentRecord | null {
  const raw = readRawCookie(CONSENT_COOKIE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as Partial<ConsentRecord>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.v !== "number") return null;
    const c = parsed.categories ?? ({} as Partial<ConsentState>);
    return {
      v: parsed.v,
      t: typeof parsed.t === "number" ? parsed.t : 0,
      categories: {
        necessary: true,
        functional: Boolean(c.functional),
        analytics: Boolean(c.analytics),
        marketing: Boolean(c.marketing),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Persist a decision. `now` is passed in by the caller (the provider has a real
 * clock) so this stays pure-ish and testable.
 */
export function writeConsentRecord(state: ConsentState, revision: number, now: number): void {
  if (typeof document === "undefined") return;
  const record: ConsentRecord = { v: revision, t: now, categories: state };
  const value = encodeURIComponent(JSON.stringify(record));
  const maxAge = CONSENT_MAX_AGE_DAYS * 24 * 60 * 60;
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${CONSENT_COOKIE}=${value}; path=/; max-age=${maxAge}; SameSite=Lax${secure}`;
  try {
    window.dispatchEvent(new CustomEvent(CONSENT_CHANGE_EVENT, { detail: record }));
  } catch {
    /* CustomEvent unavailable — non-fatal */
  }
}

/**
 * In-memory mirror of "consent management is disabled by the admin", set by the
 * ConsentProvider on the client. When true, every category is allowed AND no
 * decision cookie is persisted — so if the admin later re-enables consent, the
 * visitor is correctly re-prompted (no fabricated/persisted grant lingers).
 * Deliberately NOT persisted and NOT read on the server (the funnel no-ops on
 * the server anyway).
 */
let consentManagementDisabled = false;

export function setConsentManagementDisabled(disabled: boolean): void {
  consentManagementDisabled = disabled;
}

/**
 * In-memory mirror of which optional categories the admin currently OFFERS, set
 * by the ConsentProvider. A category the admin no longer offers is never granted
 * — even if the visitor's cookie still carries a stale grant from before. This
 * makes the "Catégories proposées" toggles authoritative for the framework-
 * agnostic funnel too (not just the React provider). Defaults to all-offered so
 * the server / pre-mount path never under-reports.
 */
let consentOffer: { functional: boolean; analytics: boolean; marketing: boolean } = {
  functional: true,
  analytics: true,
  marketing: true,
};

export function setConsentOffer(offer: {
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
}): void {
  consentOffer = offer;
}

/**
 * Whether a stored decision still counts under the admin's current consent
 * revision. Bumping `consent.revision` voids every earlier decision (the admin
 * copy: « Les choix antérieurs deviennent caducs »), so a record from an older
 * revision is NO decision — the visitor is re-prompted and nothing is granted
 * until they answer. PURE — shared by the provider, `hasConsent` (the funnel)
 * and the server-side /api/track gate so all three agree.
 */
export function isConsentRecordCurrent(
  record: { v?: unknown } | null | undefined,
  revision: number,
): boolean {
  return !!record && typeof record.v === "number" && record.v >= revision;
}

/**
 * In-memory mirror of the admin's consent revision, set by the ConsentProvider
 * next to the offer. Defaults to 1 (the config default) so the server /
 * pre-mount path matches an un-bumped store.
 */
let consentRevision = 1;

export function setConsentRevision(revision: number): void {
  consentRevision = revision;
}

/**
 * Whether a category is currently granted. `necessary` is always true; any
 * other category is false until an explicit decision grants it (opt-in), unless
 * the admin has turned consent management off entirely (or « Bypass » is on, both
 * mirrored via `setConsentManagementDisabled`). A category the admin doesn't
 * offer is always denied (masked), regardless of a stale cookie grant, and a
 * decision from before a revision bump is void (mirrored via
 * `setConsentRevision`). Safe to call from non-React modules (e.g. the tracking
 * funnel).
 */
export function hasConsent(category: ConsentCategory): boolean {
  if (category === "necessary") return true;
  if (consentManagementDisabled) return true;
  if (!consentOffer[category]) return false;
  const record = readConsentRecord();
  if (!record || !isConsentRecordCurrent(record, consentRevision)) return false;
  return record.categories[category] === true;
}

/**
 * Best-effort removal of common third-party tracking cookies when a category is
 * withdrawn. Only touches known analytics/marketing cookies — NEVER the app's
 * own strictly-necessary ones (gz.session_token / gz.cart_token /
 * gz.wishlist_token are httpOnly anyway, so JS can't and must not clear them).
 */
const TRACKING_COOKIE_PREFIXES = ["_ga", "_gid", "_gat", "_gcl_", "_fbp", "_fbc", "_ttp", "_hj"];

export function clearTrackingCookies(): void {
  if (typeof document === "undefined") return;
  const host = location.hostname;
  // Trackers may scope cookies to the exact host or to the registrable parent
  // domain. Try: no-domain, the exact host, ".host", and the last-two-labels
  // apex (".example.com") so multi-subdomain / apex+www setups are covered.
  const labels = host.split(".");
  const apex = labels.length > 2 ? labels.slice(-2).join(".") : host.replace(/^www\./, "");
  const domains = Array.from(
    new Set(["", `; domain=${host}`, `; domain=.${host}`, `; domain=.${apex}`]),
  );
  for (const part of document.cookie.split("; ")) {
    const name = part.split("=")[0];
    if (!name) continue;
    if (!TRACKING_COOKIE_PREFIXES.some((p) => name === p || name.startsWith(p))) continue;
    for (const domain of domains) {
      document.cookie = `${name}=; path=/; max-age=0${domain}`;
    }
  }
}

/** Convenience used by the funnel when no decision applies. */
export { deniedState };

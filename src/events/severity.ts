/**
 * PURE event-severity model — NO "server-only", NO DB import, so it can be
 * unit-tested directly and imported from anywhere (subscribers, the admin UI,
 * the CSV export label). Mirrors src/modules/search/parse-config.ts and
 * src/lib/seo/settings-normalize.ts.
 *
 * Every audit/telemetry event carries an implicit SEVERITY derived from its
 * name. The level drives three things:
 *   1. the structured-logger console verbosity gate (audit.log_level),
 *   2. whether the "log-everything" subscriber persists a low-signal row
 *      (audit.persist_low_signal),
 *   3. the `severity` column written on every audit_log row + the UI filter.
 *
 * The map is the SINGLE SOURCE OF TRUTH — it is computed once at write time
 * (auditService.record) and reused read-side. Changing a mapping does NOT
 * retro-rewrite already-stored rows (each row records the level judged at the
 * time, which is the desirable behaviour for an append-only log).
 */

import { isSensitiveSettingKey } from "@/lib/cms/sensitive-settings";
import type { EventName } from "./types";

export type Severity = "debug" | "info" | "warn" | "error";

/** The console verbosity floor — a superset of Severity with an "off" sentinel. */
export type LogLevel = "off" | Severity;

export const LOG_LEVELS: readonly LogLevel[] = ["off", "error", "warn", "info", "debug"];

/** Numeric rank for level comparisons (higher = more verbose / less severe-only). */
export const SEVERITY_ORDER: Record<Severity, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * High-churn, low-audit-value events (cache-invalidation surface). These are
 * the rows `audit.persist_low_signal=false` drops, and they print only when
 * the console floor is "debug". Matched by prefix/exact BEFORE the
 * ".deleted ⇒ warn" rule so e.g. `attribute_value.deleted` stays debug.
 */
function isLowSignal(eventName: string): boolean {
  // A destructive delete is never "low-signal" — let it fall through to the
  // ".deleted ⇒ warn" rule (so persist_low_signal can't drop it).
  if (eventName.endsWith(".deleted")) return false;
  return (
    eventName.startsWith("attribute_value.") ||
    eventName.startsWith("nav.item.") ||
    eventName === "page.section.changed" ||
    eventName === "faq.updated" ||
    eventName === "category.filter_attributes.updated" ||
    eventName === "product.price_changed" ||
    eventName === "product.restocked"
  );
}

/**
 * Per-event overrides for the high-signal security / money / fraud events that
 * matter most in an investigation. Everything not listed falls through to the
 * low-signal / ".deleted" / domain rules.
 */
const EXPLICIT_SEVERITY: Partial<Record<EventName, Severity>> = {
  // ── fraud / reconciliation (highest)
  "webhook.payment.amount_mismatch": "error",
  "webhook.payment.unmatched": "error",

  // ── auth / account security
  "user.disabled": "warn",
  "user.enabled": "warn",
  "user.roles_changed": "warn",
  // Per-user permission OVERLAY edit (allow/deny deltas) — a privilege change as
  // sensitive as a role change, so audited at the same level (surfaces on Sécurité).
  "user.permissions_changed": "warn",
  "user.password_reset_requested": "warn",
  "user.password_reset_completed": "warn",
  "user.password_set": "warn",
  "user.sessions_revoked": "warn",
  "user.invited": "warn",
  "user.created_by_admin": "warn",
  "user.two_factor_disabled_by_admin": "warn",
  // Admin email-verification override — account-takeover-enabling, always audited.
  "user.email_verified_admin_override": "warn",
  "user.two_factor_enabled": "warn",
  "user.two_factor_disabled": "warn",
  // Self-service credential / identity changes (account-takeover trail).
  "user.password_changed": "warn",
  "user.email_changed": "warn",
  "auth.oauth_settings_updated": "warn",
  // Auth FAILURES — the attack trail. warn so the wildcard subscriber persists
  // them and they surface on the Sécurité page (recent failed logins / lockouts).
  "user.sign_in_failed": "warn",
  "user.two_factor_failed": "warn",
  "auth.rate_limited": "warn",
  "rbac.permission_denied": "warn",
  "api_key.auth_failed": "warn",

  // ── money / fiscal
  "order.payment_initiated": "warn",
  "order.paid": "warn",
  "order.refunded": "warn",
  "order.invoice_issued": "warn",
  "order.credit_note_issued": "warn",
  "order.return.received": "warn",
  // A resolved/rejected warranty claim is a SAV outcome (may refund) — surface it.
  "warranty.claim.resolved": "warn",
  "currency.activated": "warn",
  "payment.provider_settings_updated": "warn",
  "ai.provider_settings_updated": "warn",

  // ── credentials / access surface
  "api_key.created": "warn",
  "api_key.revoked": "warn",
  "api.access_settings_updated": "warn",
  // An outbound endpoint is a data-egress channel (it can receive every business
  // event) — registering / revoking one is as sensitive as an API key.
  "webhook_endpoint.created": "warn",
  "webhook_endpoint.revoked": "warn",

  // ── mass-comms / RGPD
  "mailing.campaign_sent": "warn",
  "mailing.global_settings_updated": "warn",
  "data.exported": "warn",
  "favorites.moderated": "warn",

  // ── customer record
  "customer.deleted": "warn",

  // ── destructive ops
  "demo.purged": "warn",

  // ── runtime performance alerts (recovery falls through to info)
  "perf.alert.raised": "warn",

  // ── inventory operator alerts (a sale crossed the low-stock / out-of-stock edge)
  "product.stock_low": "warn",
  "product.stock_depleted": "warn",
};

/**
 * Default severity by domain (the first dotted segment of the event name).
 * Anything absent falls through to "info".
 */
const DOMAIN_DEFAULT: Record<string, Severity> = {
  rbac: "warn",
  webhook: "error",
  api: "warn",
  api_key: "warn",
  payment: "warn",
};

/**
 * Resolve an event's severity. Resolution order (first match wins):
 *   0. payload-aware: a `setting.upserted` for a security-relevant key
 *      (lib/cms/sensitive-settings — auth.*, checkout.payment.*, site.mode,
 *      seo.site_url, consent/redirects toggles, contact + link destinations)
 *      ⇒ warn, so disabling e.g. email verification for ALL accounts doesn't
 *      blend into routine copy edits. Only when the caller passes the payload;
 *      name-only callers (catalog UI, wildcard logger) keep the name default.
 *   1. explicit per-event override
 *   2. low-signal cache-churn prefixes ⇒ debug
 *   3. name ends with ".deleted" ⇒ warn (destructive)
 *   4. domain default
 *   5. "info"
 */
export function severityFor(eventName: string, payload?: unknown): Severity {
  if (eventName === "setting.upserted" && payload && typeof payload === "object") {
    const key = (payload as { key?: unknown }).key;
    if (typeof key === "string" && isSensitiveSettingKey(key)) return "warn";
  }
  const explicit = EXPLICIT_SEVERITY[eventName as EventName];
  if (explicit) return explicit;
  if (isLowSignal(eventName)) return "debug";
  if (eventName.endsWith(".deleted")) return "warn";
  const domain = eventName.split(".")[0] ?? "";
  return DOMAIN_DEFAULT[domain] ?? "info";
}

/**
 * Whether an event at `severity` clears the console verbosity `floor`.
 * `off` silences everything; otherwise a row prints when it is at least as
 * severe as the floor (debug floor ⇒ everything prints).
 */
export function shouldLog(floor: LogLevel, severity: Severity): boolean {
  if (floor === "off") return false;
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[floor];
}

/**
 * Sampling gate for the debug firehose. `rate` is a 0–100 percentage; `rnd`
 * is an injected [0,1) random (so the decision is pure/testable). rate ≥ 100
 * always passes, rate ≤ 0 never does. Only meaningful for debug-level lines —
 * callers apply it to the noisy long tail, never to warn/error.
 */
export function passesSample(rate: number, rnd: number): boolean {
  if (rate >= 100) return true;
  if (rate <= 0) return false;
  return rnd * 100 < rate;
}

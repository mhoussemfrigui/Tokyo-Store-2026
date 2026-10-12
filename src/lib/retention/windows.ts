/**
 * Data-retention windows (days) for the unbounded, PII-bearing log tables — in
 * ONE place so the scheduled cron (`/api/cron/retention`), the admin purge
 * buttons, and the Database diagnostics tab all agree. Pure constants (no
 * imports, no side effects) so any surface — incl. client components (the
 * Tâches planifiées confirm) and the plain-data job registry — can import them.
 */
export const RETENTION_WINDOWS = {
  /** storefront search telemetry (query + ip). DEFAULT only (= the 3-month
   *  `search.purge_months` default) — the live window is resolved at purge time
   *  from `search.purge_months` (Recherche → Purge); see `resolveRetentionWindow`.
   *  A settings-read failure SKIPS this purge (fail closed) rather than falling
   *  back to this shorter default. */
  search_log: 90,
  /** payment idempotency ledger (order_id soft-FK) */
  webhook_events: 90,
  /** OUTBOUND webhook delivery log (event payload snapshots) — keep ~90 d of
   *  delivery history for the admin log + debugging, then trim. */
  webhook_deliveries: 90,
  /** actor/target activity trail (actor_ip). DEFAULT only — the live window is
   *  resolved at purge time from `audit.retention_months` (Journal d'audit →
   *  Réglages); see `resolveRetentionWindow`. Equals the audit default (12 months
   *  × 30 = 360). A settings-read failure SKIPS this purge (fail closed). */
  audit_log: 360,
  /** abandoned quick-buy ephemeral carts (token `qb-…`); a quick-buy completes
   *  in seconds, so 2 days is far beyond any in-flight express checkout. */
  ephemeral_carts: 2,
  /** stale GUEST carts (no user, not `qb-…`) — keyed on LAST ACTIVITY
   *  (cart row + its lines), not creation. The guest cookie lives 30 days from
   *  creation, so 60 days only reaps carts no browser can reach any more (incl.
   *  the emptied rows checkout leaves behind). */
  guest_carts: 60,
  /** stale GUEST wishlists (token, no user) — keyed on last activity; the guest
   *  cookie's max-age is 180 days (set once, at creation), so this matches it. */
  guest_wishlists: 180,
  /** scheduled/cron job run history; the per-key prune keeps a bounded tail
   *  (see jobRunLogService.prune), this TTL additionally reaps rows of
   *  removed/renamed jobs the per-key prune never revisits (see
   *  jobRunLogService.purgeOlderThan). */
  job_run_log: 90,
  /** sent-email audit log (recipient address + rendered body); pinned rows are
   *  excluded from the purge so an operator can keep evidence indefinitely. */
  email_logs: 180,
  /** automation idempotency ledger (mailing_sends) — keep well past any dedup
   *  window (birthday = per year) so a key never expires while still relevant. */
  mailing_sends: 540,
  /** add-to-cart analytics events — GA4-style; ~6 months is plenty for the
   *  most-added-to-cart 7/30-day windows + a little trend headroom. */
  cart_events: 180,
  /** app instance boot heartbeats (one row per process start). Self-bounds at a
   *  few rows/day; 90 d keeps a quarter of restart/downtime history for the
   *  Performance uptime view, then trims (the live instance is protected by its
   *  refreshed last_seen_at). */
  instance_heartbeats: 90,
  /** AI call log — one transport-level row per provider call (chat + embeddings).
   *  With semantic search on, embeddings append at search/backfill rate, so this
   *  needs an ACTIVE bound; 14 days is ample for the diagnostic « Journal » use. */
  ai_call_logs: 14,
} as const;

export type RetentionTable = keyof typeof RETENTION_WINDOWS;

/**
 * THE inventory of everything the retention purge (`runRetentionPurge`) deletes
 * — one entry per purge target, in display order. Every surface derives from it
 * so none can drift: the purge itself (its `deleted` keys + summary), the
 * Database tab's « Rétention » card, the API page's retention card, the
 * storage « Journaux » subtotal (LOG_TABLES), the job registry description and
 * the Tâches planifiées destructive-confirm copy.
 *
 *  - `id`         RETENTION_WINDOWS key (day-windowed) or the auth table name
 *                 (expiry-based) — the stable display id.
 *  - `key`        the `RetentionPurgeResult.deleted` / `errors` key.
 *  - `table`      physical table the rows live in (diagnostics).
 *  - `window`     "static" (RETENTION_WINDOWS[id]), "setting" (admin-configurable
 *                 months × 30, RETENTION_WINDOWS[id] is only the default) or
 *                 "expiry" (expires_at < now()).
 *  - `log`        a log / telemetry table (counted in the storage « Journaux »
 *                 subtotal) — carts, wishlists and auth rows are not.
 */
export type RetentionTargetDef = {
  id: RetentionTable | "sessions" | "verifications";
  key: string;
  table: string;
  /** Database-tab description. */
  label: string;
  /** Lower-case noun phrase for the job description / confirm / run summary. */
  shortLabel: string;
  window: "static" | "setting" | "expiry";
  /** The site_settings key driving a "setting" window. */
  settingKey?: string;
  log: boolean;
};

export const RETENTION_TARGETS = [
  { id: "search_log", key: "searchLog", table: "search_log", label: "Télémétrie de recherche (requête + IP)", shortLabel: "journal de recherche", window: "setting", settingKey: "search.purge_months", log: true },
  { id: "webhook_events", key: "webhookEvents", table: "webhook_events", label: "Registre d'idempotence des paiements", shortLabel: "évènements webhook (paiements)", window: "static", log: true },
  { id: "webhook_deliveries", key: "webhookDeliveries", table: "webhook_deliveries", label: "Journal des livraisons de webhooks sortants (ERP)", shortLabel: "livraisons de webhooks sortants", window: "static", log: true },
  { id: "audit_log", key: "auditLog", table: "audit_log", label: "Journal d'audit (acteur / cible)", shortLabel: "journal d'audit", window: "setting", settingKey: "audit.retention_months", log: true },
  { id: "ephemeral_carts", key: "ephemeralCarts", table: "carts", label: "Paniers éphémères (achat express, token qb-…)", shortLabel: "paniers éphémères", window: "static", log: false },
  { id: "guest_carts", key: "guestCarts", table: "carts", label: "Paniers invités inactifs (dernière activité)", shortLabel: "paniers invités inactifs", window: "static", log: false },
  { id: "guest_wishlists", key: "guestWishlists", table: "wishlists", label: "Favoris invités inactifs (dernière activité)", shortLabel: "favoris invités inactifs", window: "static", log: false },
  { id: "job_run_log", key: "jobRunLog", table: "job_run_log", label: "Historique des tâches planifiées", shortLabel: "historique des tâches planifiées", window: "static", log: true },
  { id: "email_logs", key: "emailLogs", table: "email_logs", label: "Journal des emails envoyés (épinglés exclus)", shortLabel: "journal des emails (hors épinglés)", window: "static", log: true },
  { id: "mailing_sends", key: "mailingSends", table: "mailing_sends", label: "Registre d'idempotence des automatisations email", shortLabel: "registre d'idempotence mailing", window: "static", log: true },
  { id: "cart_events", key: "cartEvents", table: "cart_events", label: "Évènements d'ajout au panier (analytics)", shortLabel: "évènements panier", window: "static", log: true },
  { id: "instance_heartbeats", key: "instanceHeartbeats", table: "app_instance_heartbeats", label: "Battements d'instance (uptime/downtime)", shortLabel: "battements d'instance", window: "static", log: true },
  { id: "ai_call_logs", key: "aiCallLogs", table: "ai_call_logs", label: "Journal des appels IA (chat + embeddings)", shortLabel: "journal des appels IA", window: "static", log: true },
  { id: "sessions", key: "expiredSessions", table: "sessions", label: "Sessions Better Auth expirées (expires_at)", shortLabel: "sessions expirées", window: "expiry", log: false },
  { id: "verifications", key: "expiredVerifications", table: "verifications", label: "Jetons de vérification expirés (expires_at)", shortLabel: "vérifications expirées", window: "expiry", log: false },
] as const satisfies readonly RetentionTargetDef[];

export type RetentionTarget = (typeof RETENTION_TARGETS)[number];
/** `RetentionPurgeResult.deleted` keys — exactly one per target. */
export type RetentionResultKey = RetentionTarget["key"];

/** « journal de recherche, évènements webhook (paiements), … » — the full list,
 *  for the job description and the destructive « Exécuter maintenant » confirm. */
export const RETENTION_TARGETS_TEXT = RETENTION_TARGETS.map((t) => t.shortLabel).join(", ");

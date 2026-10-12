import "server-only";

import { auditService } from "@/modules/audit/service";
import { minorToDinars } from "@/lib/price";
import { redactForStorage } from "@/lib/telemetry/redact";
import { getAuditRuntimeConfig } from "@/lib/audit/runtime-config";
import { severityFor } from "@/events/severity";
import { summarizeApiAccessChange } from "@/lib/api-auth/access-settings-diff";
import { bus } from "../bus";
import type { EventEnvelope, EventName, EventPayload } from "../types";

/**
 * Audit-trail subscriber.
 *
 * Curated allowlist — intentionally narrower than the "log every event"
 * wildcard in `audit-everything.ts`, which it complements by attaching a
 * higher-signal summary row for operations that admins audit-search for
 * the most:
 *
 *   - user lifecycle (disable/enable/sessions revoked/password reset)
 *   - order mutations (status, refund, payment ref) + returns/SAV + fiscal
 *     documents (invoice / credit note)
 *   - customer ops (notes, default address)
 *   - audit purge (logging the purge itself)
 *   - settings management (upsert)
 *   - attribute CRUD (create/update/delete)
 *   - bulk media deletion
 *   - product archive / duplicate
 *   - credentials / access (API keys + access toggles, outbound webhook
 *     endpoints, payment / OAuth provider creds, self-service password / email
 *     changes)
 *   - mass-comms / RGPD (campaign send, mailing globals, newsletter unsub,
 *     bulk CSV exports)
 *   - scheduled tasks (kill-switch toggle, manual run), currency activation,
 *     bulk redirect import
 *   - config surfaces without another audit home: delivery zones, stock
 *     locations, AI feature prompts, search aliases, CMS page meta
 *
 * Each handler resolves a `target_type`/`target_id` pair best-suited to
 * the event so the audit UI's "view related rows" filter works. Errors
 * are swallowed — failing audit must NEVER break the originating
 * workflow (the service itself also catches, but the try/catch here
 * keeps the boundary explicit).
 */

type AuditHint = {
  targetType: string;
  targetId: string | null;
  summary: string;
};

type HintBuilder<T extends EventName> = (env: EventEnvelope<T>) => AuditHint;

/** French label of each bulk-export resource (data.exported summary). */
const EXPORT_LABELS: Record<EventPayload<"data.exported">["resource"], string> = {
  customers: "clients",
  guests: "invités",
  orders: "commandes",
  audit: "journal d'audit",
  newsletter: "newsletter",
  favorites: "favoris",
};

/** « value » (capped) / « (vide) » for a setting value in a curated summary. */
function settingValueLabel(v: string | null | undefined): string {
  if (v == null || v === "") return "(vide)";
  return `« ${v.length > 80 ? `${v.slice(0, 80)}…` : v} »`;
}

const HINTS: { [K in EventName]?: HintBuilder<K> } = {
  // ── user lifecycle
  "user.disabled": (env) => ({
    targetType: "user",
    targetId: env.payload.userId,
    summary: "User disabled",
  }),
  "user.enabled": (env) => ({
    targetType: "user",
    targetId: env.payload.userId,
    summary: "User re-enabled",
  }),
  "user.sessions_revoked": (env) => ({
    targetType: "user",
    targetId: env.payload.userId,
    summary: `Revoked ${env.payload.revokedCount} session(s)`,
  }),
  // `sendResetPassword` (lib/auth/server.ts) emits
  // `user.password_reset_requested` when a reset link goes out — that's the
  // key to audit.
  "user.password_reset_requested": (env) => ({
    targetType: "user",
    targetId: env.payload.userId,
    summary: "Password reset link requested",
  }),
  "user.invited": (env) => ({
    targetType: "user",
    targetId: env.payload.userId,
    summary: env.payload.internal ? "Compte interne invité" : "Client invité",
  }),
  "user.password_changed": (env) => ({
    targetType: "user",
    targetId: env.payload.userId,
    summary: "Mot de passe modifié par l'utilisateur",
  }),
  "user.email_changed": (env) => ({
    targetType: "user",
    targetId: env.payload.userId,
    // Both (masked) addresses are in the metadata — kept out of the plain summary.
    summary: "Adresse email de connexion modifiée",
  }),
  "auth.oauth_settings_updated": (env) => ({
    targetType: "auth",
    targetId: env.payload.provider,
    summary: `Identifiants OAuth (${env.payload.provider}) mis à jour`,
  }),

  // ── orders
  "order.status_changed": (env) => ({
    targetType: "order",
    targetId: env.payload.orderId,
    summary: `Order ${env.payload.orderNumber}: ${env.payload.fromStatus} → ${env.payload.toStatus}`,
  }),
  "order.refunded": (env) => ({
    targetType: "order",
    targetId: env.payload.orderId,
    summary: `Refunded ${minorToDinars(env.payload.amountCents)} (total refunded ${minorToDinars(env.payload.totalRefundedCents)})`,
  }),
  "order.payment_reference_updated": (env) => ({
    targetType: "order",
    targetId: env.payload.orderId,
    summary: `Payment reference updated for ${env.payload.orderNumber}`,
  }),
  "order.linked_to_user": (env) => ({
    targetType: "order",
    targetId: env.payload.orderId,
    summary: `Order ${env.payload.orderNumber} linked to a customer account`,
  }),

  // ── customer
  "customer.deleted": (env) => ({
    targetType: "customer",
    targetId: env.payload.customerProfileId,
    summary: "Customer profile deleted",
  }),

  // ── audit purge (yes, log the purge itself)
  "audit.purged": (env) => ({
    targetType: "audit",
    targetId: null,
    summary: `Purged ${env.payload.deletedCount} entry(ies) older than ${env.payload.olderThanDays}d`,
  }),

  // ── destructive demo purge + relaunch
  "demo.purged": (env) => ({
    targetType: "demo",
    targetId: null,
    summary: `PURGE totale + relance démo (${env.payload.ordersDeleted} commande(s) supprimée(s))`,
  }),

  // ── search-log retention sweep
  "search_log.purged": (env) => ({
    targetType: "search_log",
    targetId: null,
    summary: `Purged ${env.payload.deletedCount} search-log row(s) older than ${env.payload.olderThanDays}d`,
  }),

  // ── settings — the admin settings path emits `setting.upserted`. A
  // security-relevant key carries `from`/`to` (workflows/cms/setting.ts) → the
  // summary names the before/after values (warn severity via severityFor).
  "setting.upserted": (env) => ({
    targetType: "setting",
    targetId: env.payload.key,
    summary:
      "from" in env.payload || "to" in env.payload
        ? `Paramètre sensible ${env.payload.key} : ${settingValueLabel(env.payload.from)} → ${settingValueLabel(env.payload.to)}`
        : `Setting ${env.payload.key} saved`,
  }),

  // ── attributes (catalog filters)
  "attribute.created": (env) => ({
    targetType: "attribute",
    targetId: env.payload.attributeId,
    summary: `Attribute ${env.payload.slug} created`,
  }),
  "attribute.updated": (env) => ({
    targetType: "attribute",
    targetId: env.payload.attributeId,
    summary: "Attribute updated",
  }),
  "attribute.deleted": (env) => ({
    targetType: "attribute",
    targetId: env.payload.attributeId,
    summary: "Attribute deleted",
  }),

  // ── media bulk
  "media.bulk_deleted": (env) => ({
    targetType: "media",
    targetId: null,
    summary: `Bulk-deleted ${env.payload.deletedCount} media row(s)`,
  }),

  // ── credentials / API access (security-sensitive)
  "api_key.created": (env) => ({
    targetType: "api_key",
    targetId: env.payload.keyId,
    summary: `Clé API créée${env.payload.label ? ` — ${env.payload.label}` : ""}`,
  }),
  "api_key.revoked": (env) => ({
    targetType: "api_key",
    targetId: env.payload.keyId,
    summary: "Clé API révoquée",
  }),
  "api.access_settings_updated": (env) => ({
    targetType: "api",
    targetId: null,
    summary: summarizeApiAccessChange(env.payload),
  }),
  "payment.provider_settings_updated": (env) => ({
    targetType: "payment",
    targetId: null,
    summary: `Identifiants paiement (${env.payload.provider}) mis à jour`,
  }),
  // Outbound endpoints are a data-egress channel — curated like API keys.
  "webhook_endpoint.created": (env) => ({
    targetType: "webhook_endpoint",
    targetId: env.payload.endpointId,
    summary: `Endpoint webhook sortant « ${env.payload.name} » créé${
      env.payload.host ? ` → ${env.payload.host}` : ""
    } (${
      env.payload.eventTypes.includes("*")
        ? "tous les évènements"
        : `${env.payload.eventTypes.length} évènement(s)`
    })`,
  }),
  "webhook_endpoint.updated": (env) => ({
    targetType: "webhook_endpoint",
    targetId: env.payload.endpointId,
    summary:
      env.payload.active === true
        ? "Endpoint webhook sortant réactivé"
        : env.payload.active === false
          ? "Endpoint webhook sortant mis en pause"
          : "Endpoint webhook sortant modifié",
  }),
  "webhook_endpoint.revoked": (env) => ({
    targetType: "webhook_endpoint",
    targetId: env.payload.endpointId,
    summary: "Endpoint webhook sortant révoqué",
  }),

  // ── fiscal documents
  "order.invoice_issued": (env) => ({
    targetType: "order",
    targetId: env.payload.orderId,
    summary: `Facture ${env.payload.invoiceNumber} émise (commande ${env.payload.orderNumber})`,
  }),
  "order.credit_note_issued": (env) => ({
    targetType: "order",
    targetId: env.payload.orderId,
    summary: `Avoir ${env.payload.creditNoteNumber} émis (commande ${env.payload.orderNumber})`,
  }),

  // ── returns / SAV
  "order.return.created": (env) => ({
    targetType: "order",
    targetId: env.payload.orderId,
    summary: `Retour créé pour ${env.payload.orderNumber}`,
  }),
  "order.return.received": (env) => ({
    targetType: "order",
    targetId: env.payload.orderId,
    summary: `Retour reçu pour ${env.payload.orderNumber} (${env.payload.restockedItems} article(s) réintégré(s))`,
  }),
  "order.return.rejected": (env) => ({
    targetType: "order",
    targetId: env.payload.orderId,
    summary: `Retour refusé pour ${env.payload.orderNumber}`,
  }),

  // ── warranty / SAV claims
  "warranty.claim.created": (env) => ({
    targetType: "order",
    targetId: env.payload.orderId,
    summary: `Garantie : réclamation ouverte pour ${env.payload.orderNumber}`,
  }),
  "warranty.claim.updated": (env) => ({
    targetType: "order",
    targetId: env.payload.orderId,
    summary: `Garantie : réclamation mise à jour (${env.payload.orderNumber})`,
  }),
  "warranty.claim.resolved": (env) => ({
    targetType: "order",
    targetId: env.payload.orderId,
    summary: `Garantie : réclamation clôturée — ${env.payload.resolution} (${env.payload.orderNumber})`,
  }),

  // ── currency (relabels every storefront price)
  "currency.activated": (env) => ({
    targetType: "currency",
    targetId: env.payload.currencyId,
    summary: `Devise active : ${env.payload.code}`,
  }),

  // ── mass-comms / RGPD
  "mailing.campaign_sent": (env) => ({
    targetType: "mailing",
    targetId: env.payload.campaignId ?? null,
    summary: `Campagne envoyée à ${env.payload.audienceCount} destinataire(s)`,
  }),
  "mailing.global_settings_updated": () => ({
    targetType: "mailing",
    targetId: null,
    summary: "Réglages mailing globaux mis à jour (kill-switch / codes promo)",
  }),
  "newsletter.unsubscribed": () => ({
    targetType: "newsletter",
    targetId: null,
    // The address is in the (masked) metadata — kept out of the plain summary.
    summary: "Désinscription marketing",
  }),
  "data.exported": (env) => ({
    targetType: "data",
    targetId: env.payload.resource,
    summary: `Export CSV ${EXPORT_LABELS[env.payload.resource] ?? env.payload.resource} (${env.payload.count} ligne(s))`,
  }),
  "favorites.moderated": (env) => ({
    targetType: "wishlist",
    targetId: env.payload.wishlistId,
    summary:
      env.payload.action === "locked"
        ? "Favoris publics verrouillés (modération)"
        : "Verrou des favoris publics levé",
  }),

  // ── scheduled tasks
  "job.enabled_changed": (env) => ({
    targetType: "job",
    targetId: env.payload.jobKey,
    summary: `Tâche planifiée « ${env.payload.jobKey} » ${env.payload.enabled ? "activée" : "désactivée"}`,
  }),
  "job.run_triggered": (env) => ({
    targetType: "job",
    targetId: env.payload.jobKey,
    summary: `Exécution manuelle : « ${env.payload.jobKey} »`,
  }),

  // ── redirects (bulk)
  "redirect.bulk_imported": (env) => ({
    targetType: "redirect",
    targetId: null,
    summary: `Import redirections : ${env.payload.created} créée(s), ${env.payload.updated} mise(s) à jour, ${env.payload.skipped} ignorée(s)`,
  }),

  // ── delivery zones (region pricing — money-affecting config)
  "delivery.zone.created": (env) => ({
    targetType: "delivery",
    targetId: env.payload.zoneId,
    summary: `Zone de livraison « ${env.payload.name} » créée`,
  }),
  "delivery.zone.updated": (env) => ({
    targetType: "delivery",
    targetId: env.payload.zoneId,
    summary: `Zone de livraison « ${env.payload.name} » modifiée`,
  }),
  "delivery.zone.deleted": (env) => ({
    targetType: "delivery",
    targetId: env.payload.zoneId,
    summary: `Zone de livraison « ${env.payload.name} » supprimée`,
  }),

  // ── stock locations (multi-location inventory)
  "stock_location.created": (env) => ({
    targetType: "stock_location",
    targetId: env.payload.locationId,
    summary: `Emplacement de stock « ${env.payload.name} » créé`,
  }),
  "stock_location.updated": (env) => ({
    targetType: "stock_location",
    targetId: env.payload.locationId,
    summary: `Emplacement de stock « ${env.payload.name} » ${
      env.payload.isActive === true
        ? "activé"
        : env.payload.isActive === false
          ? "désactivé"
          : "modifié"
    }`,
  }),
  "stock_location.deleted": (env) => ({
    targetType: "stock_location",
    targetId: env.payload.locationId,
    summary: `Emplacement de stock « ${env.payload.name} » supprimé`,
  }),

  // ── AI generation prompts
  "ai.feature_prompts_updated": (env) => ({
    targetType: "ai",
    targetId: env.payload.feature,
    summary: `Prompts IA « ${env.payload.feature}${env.payload.task ? ` / ${env.payload.task}` : ""} » mis à jour`,
  }),

  // ── search aliases / synonyms
  "search_alias.created": (env) => ({
    targetType: "search_alias",
    targetId: env.payload.aliasId,
    summary: `Alias de recherche « ${env.payload.term} »${
      env.payload.expansion ? ` → « ${env.payload.expansion} »` : ""
    } créé`,
  }),
  "search_alias.updated": (env) => ({
    targetType: "search_alias",
    targetId: env.payload.aliasId,
    summary: `Alias de recherche${env.payload.term ? ` « ${env.payload.term} »` : ""} ${
      env.payload.isActive === true
        ? "activé"
        : env.payload.isActive === false
          ? "désactivé"
          : "modifié"
    }`,
  }),
  "search_alias.deleted": (env) => ({
    targetType: "search_alias",
    targetId: env.payload.aliasId,
    summary: `Alias de recherche${env.payload.term ? ` « ${env.payload.term} »` : ""} supprimé`,
  }),
  "search_alias.seeded": (env) => ({
    targetType: "search_alias",
    targetId: null,
    summary: `Alias par défaut : ${env.payload.count} ajouté(s)`,
  }),

  // ── CMS page meta (section edits stay on page.section.changed)
  "page.updated": (env) => ({
    targetType: "page",
    targetId: env.payload.pageId,
    summary: `Page « ${env.payload.slug} » modifiée`,
  }),
};

const AUDIT_TRAIL_EVENTS = Object.keys(HINTS) as readonly EventName[];

async function recordOne<T extends EventName>(name: T, env: EventEnvelope<T>): Promise<void> {
  const builder = HINTS[name] as HintBuilder<T> | undefined;
  if (!builder) return;
  try {
    // Honour the master capture switch (curated rows ignore persist_low_signal
    // — they are high-signal by definition). EXCEPTION: a change to the
    // audit/debug capture config itself must ALWAYS be recorded — otherwise
    // *disabling* auditing (or any audit.*/debug.* tweak) would be eclipsed by
    // its own kill-switch, breaking the "la désactivation reste tracée" promise.
    const cfg = await getAuditRuntimeConfig();
    if (!cfg.enabled) {
      const key =
        name === "setting.upserted"
          ? (env.payload as { key?: string }).key
          : undefined;
      const isCaptureConfig = !!key && (key.startsWith("audit.") || key.startsWith("debug."));
      if (!isCaptureConfig) return;
    }
    const { targetType, targetId, summary } = builder(env);
    await auditService.record({
      event_name: env.name,
      actor_user_id: env.actorUserId ?? null,
      actor_ip: env.actorIp ?? null,
      target_type: targetType,
      target_id: targetId,
      summary,
      // Payload-aware: a security-relevant setting key is warn (severityFor).
      severity: severityFor(env.name, env.payload),
      metadata: redactForStorage(env.payload),
    });
  } catch (err) {
    // Audit service already swallows DB errors, but a builder throw would
    // bubble — keep the subscriber boundary safe.
    console.error("[telemetry:audit-trail] handler failed", { event: name, err });
  }
}

export function registerAuditTrailSubscriber() {
  for (const name of AUDIT_TRAIL_EVENTS) {
    bus.on(name, async (env) => {
      await recordOne(name, env as EventEnvelope);
    });
  }
}

/** Exported for tests / debugging — the curated allowlist. */
export { AUDIT_TRAIL_EVENTS };

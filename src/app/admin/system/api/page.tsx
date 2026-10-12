import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { AdminPageHeader } from "@/components/admin/page-header";
import { requirePermission } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { resolvePaymentConfig } from "@/lib/payments/config";
import { providerSupportsTestMode } from "@/lib/payments/shared";
import { listAiProviderStatus } from "@/lib/ai/config";
import { AI_PROVIDERS } from "@/lib/ai/providers";
import { AI_FEATURES } from "@/lib/ai/tasks";
import { RETENTION_TARGETS } from "@/lib/retention/windows";
import { resolveRetentionWindow, retentionWindowText } from "@/lib/retention/resolve";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { AUTH_RATE_LIMITS } from "@/lib/auth/policy";
import { apiKeyService } from "@/modules/api-key";
import { authService } from "@/modules/auth/service";
import { apiSettingsService } from "@/modules/api-settings/service";
import { webhookEndpointService } from "@/modules/webhook-endpoints";
import { EVENT_CATALOG } from "@/lib/api-auth/event-catalog";
import { ALL_SCOPES, actorMayGrantScope } from "@/lib/api-auth/scopes";
import { UUID_RE } from "@/lib/api/cursor";
import { resolveUserPermissions } from "@/lib/rbac/authorize";

import {
  ApiWebhooksPanel,
  type ApiWebhooksData,
  type ApiKeyView,
  type AiTaskView,
} from "./api-webhooks-panel";

export const metadata: Metadata = { title: "API & Webhooks" };
// Config + live DB counts are admin-live; never statically cache.
export const dynamic = "force-dynamic";

/**
 * API & Webhooks hub. The page is the data gatherer; the tabbed UI (settings &
 * auth, route inventory, payment gateways, AI providers, AI generation, limits
 * & retention) lives in the client `ApiWebhooksPanel`. NO requireAdmin here —
 * the admin layout enforces it; the mutating actions re-check it themselves.
 */

/**
 * Where each AI generation task's "Générer (IA)" button lives in the editor.
 * Keyed by the COMPOSITE `<feature>.<task>` id — bare task ids collide across
 * features (produits / categories / marques all expose faq + seo), so a bare
 * key would mis-frame a category SEO task as a product-editor one. Tasks
 * without a precise tab here fall back to their feature's editor below.
 */
const AI_TASK_TRIGGER: Record<string, string> = {
  "produits.description_short": "Onglet Description (champ « courte »)",
  "produits.description_full": "Onglet Description (champ « complète »)",
  "produits.faq": "Onglet FAQ",
  "produits.seo": "Onglet SEO",
  "produits.categorization": "Onglet Catégorisation",
  "produits.attributes": "Onglet Attributs",
  "produits.variants": "Onglet Variantes",
};

/** Fallback editor surface per feature (used when no precise tab is mapped). */
const AI_EDITOR_BY_FEATURE: Record<string, string> = {
  produits: "Éditeur de produit",
  categories: "Éditeur de catégorie",
  marques: "Éditeur de marque",
  attributs: "Éditeur d'attribut",
  avis: "Génération d'avis (onglet Avis)",
};

/** Key lifecycle status. Module-scope helper (not the component) so the
 * `Date.now()` comparison stays out of render-purity scope. */
function keyStatus(
  revokedAt: Date | null,
  expiresAt: Date | null,
): "active" | "revoked" | "expired" {
  if (revokedAt) return "revoked";
  if (expiresAt && expiresAt.getTime() <= Date.now()) return "expired";
  return "active";
}

/** The key-card creator line. `null` = no creator recorded (read-only key);
 *  `missing` = the creator id no longer resolves (deleted account), or the
 *  lookup failed (`creators` null) — never guessed. */
function creatorView(
  createdBy: string | null,
  creators: Map<string, { name: string; email: string; disabledAt: Date | null }> | null,
): ApiKeyView["createdBy"] {
  if (!createdBy) return null;
  const u = creators?.get(createdBy);
  if (!u) return { id: createdBy, name: null, email: null, disabled: false, missing: creators !== null };
  return { id: createdBy, name: u.name, email: u.email, disabled: Boolean(u.disabledAt), missing: false };
}

export default async function ApiWebhooksPage({
  searchParams,
}: {
  searchParams: Promise<{ deliveries?: string; endpoint?: string }>;
}) {
  const session = await requirePermission("system_api", "view");
  const rawBase = process.env.NEXT_PUBLIC_SITE_URL?.trim() ?? "";
  const siteUrl = rawBase ? rawBase.replace(/\/$/, "") : "https://votre-domaine";

  // Delivery-log filters (?deliveries=failed&endpoint=<uuid>) — so a failed ERP
  // delivery stays findable + re-sendable once newer traffic pushed it out of
  // the 50-row window. A malformed endpoint id is ignored (no 22P02).
  const sp = await searchParams;
  const deliveryFilter = {
    failedOnly: sp.deliveries === "failed",
    endpointId: sp.endpoint && UUID_RE.test(sp.endpoint) ? sp.endpoint : null,
  };

  const [clictopay, flouci, bucketCount, aiStatuses, settings, keyRows, endpointRows, deliveryRows, viewerPerms, settingsMap] =
    await Promise.all([
      resolvePaymentConfig("clictopay").catch(() => null),
      resolvePaymentConfig("flouci").catch(() => null),
      db
        .execute(sql`SELECT count(*)::int AS n FROM rate_limit_buckets WHERE expires_at > now()`)
        .then((r) => (r.rows[0] as { n?: number } | undefined)?.n ?? null)
        .catch(() => null),
      // Strict: a degraded read would show every AI provider as unconfigured.
      listAiProviderStatus({ strict: true }),
      // Strict + no `.catch`: these values pre-fill the global toggles form. The
      // runtime `get()` fails CLOSED (apiEnabled:false, publicRoutes:[]), which a
      // normal save would PERSIST — locking the ERP/external API out and wiping
      // the public routes. A failure reaches the admin error boundary (retry).
      apiSettingsService.getStrict(),
      apiKeyService.list().catch(() => []),
      webhookEndpointService.list().catch(() => []),
      webhookEndpointService
        .listRecent(50, deliveryFilter.endpointId ?? undefined, deliveryFilter.failedOnly ? "failed" : undefined)
        .catch(() => []),
      resolveUserPermissions(session.user.id),
      // For the LIVE search/audit retention windows; null on failure ⇒ those
      // two show « indisponible » (the purge skips them then, too).
      getSettingsMap().catch(() => null),
    ]);

  // Who minted each key (one batched lookup) — shown on the key card so that
  // after a demotion the operator can find + revoke that person's keys. The
  // request-time guard already refuses a scope the creator no longer holds.
  const creatorIds = [...new Set(keyRows.map((k) => k.created_by).filter((id): id is string => Boolean(id)))];
  const creators = await authService.findUsersByIds(creatorIds).catch(() => null);

  const aiDocsById = new Map(AI_PROVIDERS.map((p) => [p.id, p.docsUrl]));
  const aiProviders = aiStatuses.map((s) => ({
    id: s.id,
    label: s.label,
    baseUrl: s.baseUrl,
    endpoint: s.id === "anthropic" ? `${s.baseUrl}/v1/messages` : `${s.baseUrl}/chat/completions`,
    docsUrl: aiDocsById.get(s.id),
    configured: s.configured,
    enabled: s.enabled,
  }));

  const aiTasks: AiTaskView[] = AI_FEATURES.flatMap((f) =>
    f.tasks.map((t) => ({
      id: `${f.id}.${t.id}`,
      label: t.label,
      description: t.description,
      kind: t.kind,
      trigger:
        AI_TASK_TRIGGER[`${f.id}.${t.id}`] ?? AI_EDITOR_BY_FEATURE[f.id] ?? "Éditeur",
      output: t.kind === "attribution" ? "JSON → sélection" : "Texte / HTML",
    })),
  );

  const payment = [
    {
      key: "clictopay",
      label: "ClicToPay",
      configured: Boolean(clictopay?.userName && clictopay?.password),
      // null → the panel renders "—" instead of a mode pill. Only providers
      // whose client actually acts on test_mode show a Sandbox/Live pill.
      testMode: providerSupportsTestMode("clictopay") ? clictopay?.testMode ?? null : null,
      unavailable: clictopay == null,
    },
    {
      key: "flouci",
      label: "Flouci",
      configured: Boolean(flouci?.appToken && flouci?.appSecret),
      testMode: providerSupportsTestMode("flouci") ? flouci?.testMode ?? null : null,
      unavailable: flouci == null,
    },
  ];

  const data: ApiWebhooksData = {
    siteUrl,
    settings,
    keys: keyRows.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      expiresAt: k.expires_at ? k.expires_at.toISOString() : null,
      lastUsedAt: k.last_used_at ? k.last_used_at.toISOString() : null,
      revokedAt: k.revoked_at ? k.revoked_at.toISOString() : null,
      createdAt: k.created_at ? k.created_at.toISOString() : new Date(0).toISOString(),
      status: keyStatus(k.revoked_at, k.expires_at),
      createdBy: creatorView(k.created_by, creators),
    })),
    cronConfigured: Boolean(process.env.CRON_SECRET?.trim()),
    // Scopes this viewer may mint (bounded by their own RBAC — the create action
    // re-checks); the create-key card greys out the rest.
    grantableScopes: ALL_SCOPES.filter((s) => actorMayGrantScope(viewerPerms, s)),
    webhooks: {
      endpoints: endpointRows.map((e) => ({
        id: e.id,
        name: e.name,
        url: e.url,
        prefix: e.prefix,
        eventTypes: e.event_types,
        isActive: e.is_active,
        description: e.description,
        revokedAt: e.revoked_at ? e.revoked_at.toISOString() : null,
        createdAt: e.created_at.toISOString(),
      })),
      recentDeliveries: deliveryRows.map((d) => ({
        id: d.id,
        endpointId: d.endpoint_id,
        eventName: d.event_name,
        status: d.status,
        responseStatus: d.response_status,
        attempts: d.attempts,
        maxAttempts: d.max_attempts,
        nextAttemptAt: d.next_attempt_at ? d.next_attempt_at.toISOString() : null,
        errorMessage: d.error_message,
        createdAt: d.created_at.toISOString(),
      })),
      deliveryFilter,
      eventDomains: EVENT_CATALOG.map((cat) => ({ domain: cat.domain, label: cat.label, events: cat.events })),
    },
    payment,
    aiProviders,
    aiTasks,
    authRate: {
      maxPerWindow: AUTH_RATE_LIMITS.maxPerWindow,
      windowSeconds: AUTH_RATE_LIMITS.windowSeconds,
      rules: Object.entries(AUTH_RATE_LIMITS.rules).map(([endpoint, rule]) => ({
        endpoint,
        window: rule.window,
        max: rule.max,
      })),
    },
    bucketCount,
    // Every purge target (RETENTION_TARGETS — the purge's own inventory) with
    // its LIVE window, resolved exactly like runRetentionPurge (search/audit from
    // settings), so the card can't drift from what actually gets deleted.
    retention: Object.fromEntries(
      RETENTION_TARGETS.map((t) => [
        t.id,
        retentionWindowText(resolveRetentionWindow(t, settingsMap), "jours"),
      ]),
    ),
  };

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/system"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour au Système
        </Link>
        <div className="mt-2">
          <AdminPageHeader
            title="API & Webhooks"
            description="Authentification par clé, points d'accès, webhooks et limites de l'API."
          />
        </div>
      </div>

      <ApiWebhooksPanel data={data} />
    </div>
  );
}

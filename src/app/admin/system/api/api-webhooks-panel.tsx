"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Bot,
  Check,
  Clock,
  Copy,
  CreditCard,
  ExternalLink,
  Gauge,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";

import { FormTabs, FormTab } from "@/components/admin/_components/form-tabs";
import { ToggleField } from "@/components/admin/_components/setting-fields";
import { SelectField } from "@/components/ui/select-field";
import { type ActionState } from "@/lib/actions/types";
import {
  saveApiTogglesAction,
  createApiKeyAction,
  revokeApiKeyAction,
  type CreateApiKeyState,
} from "@/lib/actions/api-settings";
import {
  createWebhookEndpointAction,
  toggleWebhookEndpointAction,
  revokeWebhookEndpointAction,
  redeliverWebhookAction,
  type CreateWebhookEndpointState,
} from "@/lib/actions/webhooks";
import { ALL_HTTP_ENDPOINTS, TOGGLEABLE_PUBLIC_ROUTES, type ApiRoute, type RouteDomain } from "@/lib/api-auth/route-catalog";
import { API_RESOURCES, COARSE_SCOPES, OFFERED_SCOPES, WRITABLE_RESOURCES } from "@/lib/api-auth/scopes";
import {
  ApiOverviewTab,
  ErpApiTab,
  InternalApiTab,
  EventsTab,
  WebhooksCronTab,
  DecouplingTab,
  Section,
} from "./api-catalog-tabs";

/* ─────────────────────────────────── types ─────────────────────────────────── */
export type ApiKeyView = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** Computed server-side (avoids Date.now() in client render). */
  status: "active" | "revoked" | "expired";
  /** Who minted the key — `null` when no creator is recorded (read-only key).
   *  `missing` = the id no longer resolves to an account. */
  createdBy: {
    id: string;
    name: string | null;
    email: string | null;
    disabled: boolean;
    missing: boolean;
  } | null;
};
export type PaymentProviderView = {
  key: string;
  label: string;
  configured: boolean;
  testMode: boolean | null;
  unavailable: boolean;
};
export type AiProviderView = {
  id: string;
  label: string;
  endpoint: string;
  baseUrl: string;
  docsUrl?: string;
  configured: boolean;
  enabled: boolean;
};
export type AiTaskView = {
  id: string;
  label: string;
  description: string;
  kind: "text" | "attribution";
  trigger: string;
  output: string;
};
export type WebhookEndpointView = {
  id: string;
  name: string;
  url: string;
  prefix: string;
  eventTypes: string[];
  isActive: boolean;
  description: string | null;
  revokedAt: string | null;
  createdAt: string;
};
export type WebhookDeliveryView = {
  id: string;
  endpointId: string;
  eventName: string;
  status: string;
  responseStatus: number | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  errorMessage: string | null;
  createdAt: string;
};
export type WebhookEventDomainView = { domain: string; label: string; events: string[] };
export type WebhookDeliveryFilter = { failedOnly: boolean; endpointId: string | null };

export type ApiWebhooksData = {
  siteUrl: string;
  settings: { apiEnabled: boolean; webhooksEnabled: boolean; outboundWebhooksEnabled: boolean; publicRoutes: string[] };
  keys: ApiKeyView[];
  cronConfigured: boolean;
  /** Scopes the viewer may put on a new key (bounded by their own RBAC grants). */
  grantableScopes: string[];
  webhooks: {
    endpoints: WebhookEndpointView[];
    recentDeliveries: WebhookDeliveryView[];
    /** The delivery-log filter the page applied (?deliveries=failed&endpoint=). */
    deliveryFilter: WebhookDeliveryFilter;
    eventDomains: WebhookEventDomainView[];
  };
  payment: PaymentProviderView[];
  aiProviders: AiProviderView[];
  aiTasks: AiTaskView[];
  authRate: { maxPerWindow: number; windowSeconds: number; rules: Array<{ endpoint: string; window: number; max: number }> };
  bucketCount: number | null;
  // target → display window (« 90 jours », « à l'expiration », « indisponible
  // (réglages) ») for EVERY RETENTION_TARGETS entry, live search/audit windows
  // resolved like the purge — so a new retention target appears here automatically.
  retention: Record<string, string>;
};

/* ─────────────────────────────── shared chrome ──────────────────────────────── */
function Card({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[28px] border border-border bg-card p-6">
      <div className="flex items-start gap-3">
        <div className="rounded-[12px] border border-border bg-surface/50 p-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-4 space-y-3 text-sm">{children}</div>
    </div>
  );
}

function ConfigBadge({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
        ok
          ? "border border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]"
          : "border border-border bg-muted text-muted-foreground"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-[#15803d]" : "bg-muted-foreground/50"}`} />
      {ok ? "Configuré" : "Non configuré"}
    </span>
  );
}

function ModePill({ testMode }: { testMode: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${
        testMode
          ? "border border-[#f3e3bd] bg-[#fff4e0] text-[#b45309]"
          : "border border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]"
      }`}
    >
      {testMode ? "Sandbox (test)" : "Live (production)"}
    </span>
  );
}

function StatusNote({ state }: { state: ActionState | null }) {
  if (!state) return null;
  return (
    <p
      className={`text-xs font-medium ${state.ok ? "text-[#15803d]" : "text-destructive"}`}
      role="status"
    >
      {state.message}
    </p>
  );
}

function SubmitButton({ pending, children }: { pending: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-11 items-center gap-2 rounded-full bg-foreground px-5 text-[14px] font-extrabold text-background transition hover:opacity-90 disabled:opacity-60"
    >
      {pending && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

/* ────────────────────────────────── root ────────────────────────────────────── */
export function ApiWebhooksPanel({ data }: { data: ApiWebhooksData }) {
  const tabs = [
    { id: "apercu", label: "Vue d'ensemble" },
    { id: "erp", label: "API externe (ERP)" },
    { id: "interne", label: "API interne (actions)" },
    { id: "inventaire", label: "Endpoints HTTP" },
    { id: "evenements", label: "Évènements" },
    { id: "webhooks", label: "Webhooks & Cron" },
    { id: "webhooks-out", label: "Webhooks sortants (ERP)" },
    { id: "decouplage", label: "Découplage" },
    { id: "reglages", label: "Réglages & Clés" },
    { id: "paiement", label: "Passerelles de paiement" },
    { id: "ia", label: "Fournisseurs IA" },
    { id: "generation", label: "Génération de contenu IA" },
    { id: "limites", label: "Limites & Rétention" },
  ];

  // Honour a `?tab=` deep link (e.g. /admin/system/api?tab=erp linked from the
  // Commandes area) so a section can be opened directly; falls back to overview.
  // The valid-id set derives from `tabs` (single source) — no second literal.
  const requestedTab = useSearchParams().get("tab");
  const [activeTab, setActiveTab] = useState(
    requestedTab && tabs.some((t) => t.id === requestedTab) ? requestedTab : "apercu",
  );

  return (
    <FormTabs tabs={tabs} defaultTab="apercu" activeTab={activeTab} onActiveTabChange={setActiveTab}>
      {(active) => (
        <>
          <FormTab id="apercu" active={active}>
            <ApiOverviewTab />
          </FormTab>
          <FormTab id="erp" active={active}>
            <ErpApiTab siteUrl={data.siteUrl} />
          </FormTab>
          <FormTab id="interne" active={active}>
            <InternalApiTab />
          </FormTab>
          <FormTab id="inventaire" active={active}>
            <InventoryTab siteUrl={data.siteUrl} publicRoutes={data.settings.publicRoutes} />
          </FormTab>
          <FormTab id="evenements" active={active}>
            <EventsTab />
          </FormTab>
          <FormTab id="webhooks" active={active}>
            <WebhooksCronTab cronConfigured={data.cronConfigured} />
          </FormTab>
          <FormTab id="webhooks-out" active={active}>
            <WebhooksOutboundTab
              webhooks={data.webhooks}
              outboundEnabled={data.settings.outboundWebhooksEnabled}
              cronConfigured={data.cronConfigured}
            />
          </FormTab>
          <FormTab id="decouplage" active={active}>
            <DecouplingTab />
          </FormTab>
          <FormTab id="reglages" active={active}>
            <SettingsAuthTab data={data} />
          </FormTab>
          <FormTab id="paiement" active={active}>
            <PaymentTab providers={data.payment} />
          </FormTab>
          <FormTab id="ia" active={active}>
            <AiProvidersTab providers={data.aiProviders} />
          </FormTab>
          <FormTab id="generation" active={active}>
            <AiGenerationTab tasks={data.aiTasks} />
          </FormTab>
          <FormTab id="limites" active={active}>
            <LimitsTab
              authRate={data.authRate}
              bucketCount={data.bucketCount}
              retention={data.retention}
              cronConfigured={data.cronConfigured}
              siteUrl={data.siteUrl}
            />
          </FormTab>
        </>
      )}
    </FormTabs>
  );
}

/* ───────────────────────── Réglages & Authentification ──────────────────────── */
function SettingsAuthTab({ data }: { data: ApiWebhooksData }) {
  return (
    <div className="space-y-6">
      <GlobalTogglesForm settings={data.settings} />
      <CreateKeyCard grantableScopes={data.grantableScopes} />
      <KeysList keys={data.keys} />
    </div>
  );
}

function GlobalTogglesForm({ settings }: { settings: ApiWebhooksData["settings"] }) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveApiTogglesAction,
    null,
  );
  return (
    <form action={formAction} className="rounded-[28px] border border-border bg-card p-6">
      <div className="flex items-start gap-3">
        <div className="rounded-[12px] border border-border bg-surface/50 p-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">Activation & accès</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Interrupteurs généraux et routes ouvertes au public. Par défaut, toute route externe
            exige une clé API — la sécurité maximale.
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <ToggleField
          name="api.enabled"
          label="API externe activée"
          description="Coupe-circuit général. Désactivée, toutes les routes externes répondent 503 — même avec une clé valide."
          defaultChecked={settings.apiEnabled}
        />
        <ToggleField
          name="webhooks.enabled"
          label="Webhooks entrants activés"
          description="Contrôle les callbacks de paiement ClicToPay et Flouci (/api/webhooks/clictopay et /api/webhooks/flouci). Désactivés, les deux répondent 503 ; la vérification au retour client sur /order/[id] et la réconciliation planifiée restent actives."
          defaultChecked={settings.webhooksEnabled}
        />
        <ToggleField
          name="webhooks.outbound_enabled"
          label="Webhooks sortants activés (ERP)"
          description="Coupe-circuit général de la livraison des webhooks sortants. Désactivés, aucun évènement n'est mis en file et les livraisons déjà en file sont suspendues (elles repartent à la réactivation)."
          defaultChecked={settings.outboundWebhooksEnabled}
        />
      </div>

      <div className="mt-5">
        <p className="mb-1 flex items-center gap-2 text-[13px] font-bold text-foreground">
          <Lock className="h-3 w-3" /> Routes publiques (lecture sans clé)
        </p>
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          Activez une route pour la rendre accessible sans clé. Seules les lectures peuvent être
          publiques — les écritures exigent toujours une clé.
        </p>
        <div className="space-y-2">
          {TOGGLEABLE_PUBLIC_ROUTES.map((r) => (
            <ToggleField
              key={r.id}
              name={`public.${r.id}`}
              label={`${r.method} ${r.path}`}
              description={r.notes}
              defaultChecked={settings.publicRoutes.includes(r.id)}
            />
          ))}
        </div>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <SubmitButton pending={pending}>Enregistrer les réglages</SubmitButton>
        <StatusNote state={state} />
      </div>
    </form>
  );
}

function CreateKeyCard({ grantableScopes }: { grantableScopes: string[] }) {
  const grantable = new Set(grantableScopes);
  const restricted = OFFERED_SCOPES.some((s) => !grantable.has(s));
  const [state, formAction, pending] = useActionState<CreateApiKeyState | null, FormData>(
    createApiKeyAction,
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  // Derive what to show from `state` rather than mirroring it into state inside
  // an effect (which the react-hooks lint forbids). `dismissedKey`/`copiedKey`
  // are keyed by the plaintext so they reset automatically for a new key.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const lastSeen = useRef<CreateApiKeyState | null>(null);

  const freshSecret = state?.ok && state.plaintext ? state.plaintext : null;
  const secret = freshSecret && freshSecret !== dismissedKey
    ? { plaintext: freshSecret, name: state && state.ok ? (state.keyName ?? "") : "" }
    : null;
  const copied = copiedKey != null && copiedKey === secret?.plaintext;

  // On a NEW successful creation, clear the form fields. Pure DOM side-effect
  // (form.reset()), no setState — so this is allowed inside the effect.
  useEffect(() => {
    if (!state || state === lastSeen.current) return;
    lastSeen.current = state;
    if (state.ok && state.plaintext) formRef.current?.reset();
  }, [state]);

  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.plaintext);
      setCopiedKey(secret.plaintext);
    } catch {
      /* clipboard blocked — the value is selectable in the box */
    }
  };

  return (
    <div className="rounded-[28px] border border-border bg-card p-6">
      <div className="flex items-start gap-3">
        <div className="rounded-[12px] border border-border bg-surface/50 p-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">Créer une clé API</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            La clé n&apos;est affichée qu&apos;une seule fois. Stockez-la en lieu sûr — seul son
            empreinte est conservée.
          </p>
        </div>
      </div>

      {secret && (
        <div className="mt-4 rounded-2xl border border-[#f3e3bd] bg-[#fff4e0] p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#b45309]">
            Clé « {secret.name} » — copiez-la maintenant
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded-lg bg-background px-3 py-2 font-mono text-xs text-foreground">
              {secret.plaintext}
            </code>
            <button
              type="button"
              onClick={copy}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[12px] border-[1.5px] border-input bg-card px-3 text-xs font-bold text-foreground transition hover:bg-surface/60"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-[#15803d]" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copiée" : "Copier"}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setDismissedKey(secret.plaintext)}
            className="mt-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            J&apos;ai stocké la clé — masquer
          </button>
        </div>
      )}

      <form ref={formRef} action={formAction} className="mt-4 space-y-4">
        <div>
          <label htmlFor="key-name" className="text-[13px] font-bold text-foreground">
            Nom
          </label>
          <input
            id="key-name"
            name="name"
            maxLength={80}
            placeholder="ex. App mobile (lecture)"
            className="mt-2 h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-sm text-foreground placeholder:text-muted-foreground/60 transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]"
          />
        </div>

        <div>
          <SelectField
            label="Expiration"
            name="expiresInDays"
            defaultValue=""
            options={[
              { value: "", label: "Jamais" },
              { value: "30", label: "30 jours" },
              { value: "90", label: "90 jours" },
              { value: "180", label: "180 jours" },
              { value: "365", label: "1 an" },
            ]}
          />
        </div>

        <div>
          <p className="text-[13px] font-bold text-foreground">
            Permissions (portées)
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Combinez un raccourci global et/ou des portées par ressource. « full » = tout ;
            « write » implique « read ».
          </p>
          {restricted && (
            <p className="mt-2 rounded-xl border border-[#f3e3bd] bg-[#fff4e0] px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              Les portées grisées dépassent vos propres droits : une clé ne peut pas faire plus
              que son créateur (« write » et « full » sont réservés au super-administrateur).
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {COARSE_SCOPES.map((s) => (
              <ScopeChip key={s} value={s} label={s} disabled={!grantable.has(s)} />
            ))}
          </div>

          <div className="mt-3 overflow-hidden rounded-[22px] border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                  <th className="px-4 py-2">Ressource</th>
                  <th className="px-4 py-2 text-center">Lecture</th>
                  <th className="px-4 py-2 text-center">Écriture</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {API_RESOURCES.map((r) => (
                  <tr key={r}>
                    <td className="px-4 py-2.5 font-medium capitalize text-foreground">{r}</td>
                    <td className="px-4 py-2.5 text-center">
                      <ScopeBox value={`${r}:read`} disabled={!grantable.has(`${r}:read`)} />
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {/* Only resources with a write route get a write box — on the
                          read-only ones a write scope would grant nothing. */}
                      {WRITABLE_RESOURCES.includes(r) ? (
                        <ScopeBox value={`${r}:write`} disabled={!grantable.has(`${r}:write`)} />
                      ) : (
                        <span
                          className="text-[11px] text-muted-foreground"
                          title="Aucune route d'écriture pour cette ressource — lecture seule."
                        >
                          lecture seule
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <SubmitButton pending={pending}>
            <Plus className="h-4 w-4" /> Créer la clé
          </SubmitButton>
          {state && !state.ok && <StatusNote state={state} />}
        </div>
      </form>
    </div>
  );
}

function ScopeChip({ value, label, disabled }: { value: string; label: string; disabled?: boolean }) {
  return (
    <label
      title={disabled ? "Dépasse vos propres droits" : undefined}
      className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium transition has-[:checked]:border-primary/50 has-[:checked]:bg-primary/10 has-[:checked]:text-primary has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
    >
      <input
        type="checkbox"
        name="scope"
        value={value}
        disabled={disabled}
        className="h-3.5 w-3.5 accent-[var(--primary)]"
      />
      {label}
    </label>
  );
}

function ScopeBox({ value, disabled }: { value: string; disabled?: boolean }) {
  return (
    <input
      type="checkbox"
      name="scope"
      value={value}
      aria-label={value}
      disabled={disabled}
      title={disabled ? "Dépasse vos propres droits" : undefined}
      className="h-4 w-4 accent-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-40"
    />
  );
}

function KeysList({ keys }: { keys: ApiKeyView[] }) {
  return (
    <Card icon={KeyRound} title="Clés existantes" subtitle="Empreintes uniquement — le secret n'est jamais réaffiché.">
      {keys.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-surface/40 px-4 py-6 text-center text-xs text-muted-foreground">
          Aucune clé pour l&apos;instant. Créez-en une ci-dessus.
        </p>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <KeyRow key={k.id} k={k} />
          ))}
        </div>
      )}
    </Card>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return "—";
  }
}

/** "Créée par …" — the key acts AS its creator (and only within the grants
 *  that person still holds), so after a demotion the operator can spot and
 *  revoke that person's keys here. */
function creatorLabel(c: ApiKeyView["createdBy"]): string {
  if (!c) return "aucun compte (lecture seule)";
  if (!c.name && !c.email) return c.missing ? "compte supprimé" : "—";
  const who = c.email && c.name && c.name !== c.email ? `${c.name} (${c.email})` : (c.name || c.email || "—");
  return c.disabled ? `${who} — compte désactivé` : who;
}

function KeyRow({ k }: { k: ApiKeyView }) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    revokeApiKeyAction,
    null,
  );
  const [confirming, setConfirming] = useState(false);

  const status = k.status;
  const statusChip =
    status === "active"
      ? "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]"
      : "border-border bg-muted text-muted-foreground";

  return (
    <div className="rounded-2xl border border-border bg-background px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {k.name}
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusChip}`}>
              {status === "active" ? "Active" : status === "revoked" ? "Révoquée" : "Expirée"}
            </span>
          </p>
          <code className="mt-0.5 block break-all font-mono text-[11px] text-muted-foreground">
            {k.prefix}…
          </code>
        </div>
        {status === "active" &&
          (confirming ? (
            <form action={formAction} className="flex items-center gap-1.5">
              <input type="hidden" name="keyId" value={k.id} />
              <button
                type="submit"
                disabled={pending}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-destructive/40 bg-destructive/10 px-3 text-xs font-semibold text-destructive transition hover:bg-destructive/20 disabled:opacity-60"
              >
                {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Confirmer
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="inline-flex h-9 items-center rounded-[12px] border-[1.5px] border-input bg-card px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Annuler
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-[12px] border-[1.5px] border-input bg-card px-3 text-xs font-bold text-foreground transition hover:bg-surface/60"
            >
              <Trash2 className="h-3.5 w-3.5" /> Révoquer
            </button>
          ))}
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {k.scopes.map((s) => (
          <span key={s} className="inline-flex items-center rounded-full border border-border bg-surface/50 px-2 py-0.5 font-mono text-[10px] text-foreground">
            {s}
          </span>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>Créée : {fmtDate(k.createdAt)}</span>
        <span>Créée par : {creatorLabel(k.createdBy)}</span>
        <span>Expire : {k.expiresAt ? fmtDate(k.expiresAt) : "jamais"}</span>
        <span>Dernier usage : {fmtDate(k.lastUsedAt)}</span>
        {k.revokedAt && <span>Révoquée : {fmtDate(k.revokedAt)}</span>}
      </div>
      {state && !state.ok && <StatusNote state={state} />}
    </div>
  );
}

/* ─────────────────────────── Webhooks sortants (ERP) ─────────────────────────── */
function WebhooksOutboundTab({
  webhooks,
  outboundEnabled,
  cronConfigured,
}: {
  webhooks: ApiWebhooksData["webhooks"];
  outboundEnabled: boolean;
  cronConfigured: boolean;
}) {
  const endpointsById = new Map(webhooks.endpoints.map((e) => [e.id, e]));
  const activeCount = webhooks.endpoints.filter((e) => !e.revokedAt && e.isActive).length;
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border bg-surface/40 p-4 text-[12px] leading-relaxed text-muted-foreground">
        <p className="font-semibold text-foreground">Webhooks sortants (push vers l&apos;ERP)</p>
        <p className="mt-1">
          Chaque évènement de la boutique (commande, stock, produit, client…) est POST-é en JSON
          signé (HMAC-SHA256) vers les endpoints abonnés, avec reprise + back-off. En-têtes :
          <code className="mx-1 rounded bg-surface px-1 py-0.5">X-Webhook-Signature</code>,
          <code className="mx-1 rounded bg-surface px-1 py-0.5">X-Webhook-Id</code>,
          <code className="mx-1 rounded bg-surface px-1 py-0.5">X-Webhook-Event</code>,
          <code className="mx-1 rounded bg-surface px-1 py-0.5">X-Webhook-Timestamp</code>. La
          signature = HMAC du secret sur <code className="rounded bg-surface px-1 py-0.5">timestamp.body</code>.
        </p>
        {!outboundEnabled && (
          <p className="mt-2 rounded-xl border border-[#f3e3bd] bg-[#fff4e0] px-3 py-2 text-[#b45309]">
            L&apos;interrupteur « Webhooks sortants » est désactivé (onglet Réglages & Clés) — aucun
            évènement n&apos;est mis en file et la file existante n&apos;est plus livrée.
          </p>
        )}
        {!cronConfigured && (
          <p className="mt-2 rounded-xl border border-[#f3e3bd] bg-[#fff4e0] px-3 py-2 text-[#b45309]">
            CRON_SECRET n&apos;est pas configuré — la livraison (POST /api/cron/webhooks) est
            inactive tant qu&apos;un planificateur ne l&apos;appelle pas.
          </p>
        )}
      </div>

      <CreateWebhookEndpointCard eventDomains={webhooks.eventDomains} />

      <Section icon={ExternalLink} title={`Endpoints (${webhooks.endpoints.length}${activeCount < webhooks.endpoints.length ? ` · ${activeCount} actifs` : ""})`} subtitle="Destinations abonnées. Mettez en pause ou révoquez sans supprimer l'historique.">
        {webhooks.endpoints.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
            Aucun endpoint. Créez-en un ci-dessus pour commencer à pousser les évènements.
          </p>
        ) : (
          <div className="space-y-2">
            {webhooks.endpoints.map((e) => (
              <WebhookEndpointRow key={e.id} ep={e} />
            ))}
          </div>
        )}
      </Section>

      <WebhookDeliveryLog
        deliveries={webhooks.recentDeliveries}
        endpoints={webhooks.endpoints}
        endpointsById={endpointsById}
        filter={webhooks.deliveryFilter}
      />
    </div>
  );
}

function CreateWebhookEndpointCard({ eventDomains }: { eventDomains: WebhookEventDomainView[] }) {
  const [state, formAction, pending] = useActionState<CreateWebhookEndpointState | null, FormData>(
    createWebhookEndpointAction,
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [allEvents, setAllEvents] = useState(true);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const lastSeen = useRef<CreateWebhookEndpointState | null>(null);

  const freshSecret = state?.ok && state.secret ? state.secret : null;
  const secret = freshSecret && freshSecret !== dismissed ? freshSecret : null;

  useEffect(() => {
    if (!state || state === lastSeen.current) return;
    lastSeen.current = state;
    if (state.ok && state.secret) {
      formRef.current?.reset();
      // `reset()` unchecks the DOM box without a React event; re-assert the
      // controlled `allEvents` to its default so state and the checkbox agree
      // (otherwise a second "all events" create would submit with neither).
      setAllEvents(true);
    }
  }, [state]);

  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(secret);
    } catch {
      /* clipboard blocked — the value is selectable */
    }
  };

  return (
    <div className="rounded-[28px] border border-border bg-card p-6">
      <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">Créer un endpoint</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Le secret de signature n&apos;est affiché qu&apos;une seule fois — stockez-le côté ERP pour
        vérifier chaque livraison.
      </p>

      {secret && (
        <div className="mt-4 rounded-2xl border border-[#f3e3bd] bg-[#fff4e0] p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#b45309]">
            Secret « {state?.ok ? state.endpointName : ""} » — copiez-le maintenant
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded-lg bg-background px-3 py-2 font-mono text-xs text-foreground">
              {secret}
            </code>
            <button type="button" onClick={copy} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[12px] border-[1.5px] border-input bg-card px-3 text-xs font-bold text-foreground transition hover:bg-surface/60">
              {copied === secret ? <Check className="h-3.5 w-3.5 text-[#15803d]" /> : <Copy className="h-3.5 w-3.5" />}
              {copied === secret ? "Copié" : "Copier"}
            </button>
          </div>
          <button type="button" onClick={() => setDismissed(secret)} className="mt-2 text-[11px] font-medium text-muted-foreground hover:text-foreground">
            J&apos;ai stocké le secret — masquer
          </button>
        </div>
      )}

      <form ref={formRef} action={formAction} className="mt-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">Nom</span>
            <input name="name" required maxLength={120} placeholder="ERP production" className="h-9 w-full rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-sm text-foreground transition focus:border-foreground focus:bg-white focus:outline-none" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">URL (https)</span>
            <input name="url" required type="url" placeholder="https://erp.example.com/hooks/tokyo" className="h-9 w-full rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-sm text-foreground transition focus:border-foreground focus:bg-white focus:outline-none" />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">Description (optionnel)</span>
          <input name="description" maxLength={300} className="h-9 w-full rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-sm text-foreground transition focus:border-foreground focus:bg-white focus:outline-none" />
        </label>

        <label className="flex items-start gap-2 rounded-xl border border-border bg-surface/30 px-3 py-2">
          <input
            type="checkbox"
            name="allEvents"
            checked={allEvents}
            onChange={(e) => setAllEvents(e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-foreground">S&apos;abonner à TOUS les évènements</span>
            <span className="block text-[11px] text-muted-foreground">
              Reçoit chaque évènement (recommandé pour une synchro ERP complète), SAUF les évènements de sécurité
              porteurs de données personnelles : <code className="font-mono">auth.*</code>, <code className="font-mono">rbac.*</code>,{" "}
              <code className="font-mono">api_key.*</code>, <code className="font-mono">user.*</code> (dont{" "}
              <code className="font-mono">user.created</code>, <code className="font-mono">user.email_verified</code>) et{" "}
              <code className="font-mono">data.*</code>. Pour les recevoir, décochez et sélectionnez-les par leur nom (ou
              créez un second endpoint dédié). Décochez aussi pour choisir des évènements précis.
            </span>
          </span>
        </label>

        {!allEvents && (
          <div className="max-h-72 space-y-3 overflow-y-auto rounded-xl border border-border bg-surface/30 p-3">
            {eventDomains.map((d) => (
              <div key={d.domain}>
                <p className="mb-1 text-[13px] font-bold text-foreground">{d.label}</p>
                <div className="grid gap-1 sm:grid-cols-2">
                  {d.events.map((ev) => (
                    <label key={ev} className="flex items-center gap-2 text-[12px] text-foreground">
                      <input type="checkbox" name="event" value={ev} className="h-3.5 w-3.5" />
                      <code className="font-mono text-[11px]">{ev}</code>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3">
          <SubmitButton pending={pending}>
            <Plus className="h-3.5 w-3.5" /> Créer l&apos;endpoint
          </SubmitButton>
          {state && !state.ok && <StatusNote state={state} />}
        </div>
      </form>
    </div>
  );
}

function WebhookEndpointRow({ ep }: { ep: WebhookEndpointView }) {
  const [toggleState, toggleAction, toggling] = useActionState<ActionState | null, FormData>(toggleWebhookEndpointAction, null);
  const [revokeState, revokeAction, revoking] = useActionState<ActionState | null, FormData>(revokeWebhookEndpointAction, null);
  const [confirming, setConfirming] = useState(false);
  const revoked = Boolean(ep.revokedAt);
  const chip = revoked
    ? "border-border bg-muted text-muted-foreground"
    : ep.isActive
      ? "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]"
      : "border-[#f3e3bd] bg-[#fff4e0] text-[#b45309]";
  const allEvents = ep.eventTypes.includes("*");
  return (
    <div className="rounded-2xl border border-border bg-background px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {ep.name}
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${chip}`}>
              {revoked ? "Révoqué" : ep.isActive ? "Actif" : "En pause"}
            </span>
          </p>
          <code className="mt-0.5 block break-all font-mono text-[11px] text-muted-foreground">{ep.url}</code>
        </div>
        {!revoked && (
          <div className="flex items-center gap-1.5">
            <form action={toggleAction}>
              <input type="hidden" name="endpointId" value={ep.id} />
              {ep.isActive ? null : <input type="hidden" name="active" value="on" />}
              <button type="submit" disabled={toggling} className="inline-flex h-9 items-center gap-1.5 rounded-[12px] border-[1.5px] border-input bg-card px-3 text-xs font-bold text-foreground transition hover:bg-surface/60 disabled:opacity-60">
                {toggling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {ep.isActive ? "Mettre en pause" : "Activer"}
              </button>
            </form>
            {confirming ? (
              <form action={revokeAction} className="flex items-center gap-1.5">
                <input type="hidden" name="endpointId" value={ep.id} />
                <button type="submit" disabled={revoking} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-destructive/40 bg-destructive/10 px-3 text-xs font-semibold text-destructive transition hover:bg-destructive/20 disabled:opacity-60">
                  {revoking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Confirmer
                </button>
                <button type="button" onClick={() => setConfirming(false)} className="inline-flex h-9 items-center rounded-[12px] border-[1.5px] border-input bg-card px-3 text-xs font-medium text-muted-foreground hover:text-foreground">Annuler</button>
              </form>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} className="inline-flex h-9 items-center gap-1.5 rounded-[12px] border-[1.5px] border-input bg-card px-3 text-xs font-bold text-foreground transition hover:bg-surface/60">
                <Trash2 className="h-3.5 w-3.5" /> Révoquer
              </button>
            )}
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="font-mono">{ep.prefix}…</span>
        <span>{allEvents ? "Tous les évènements (hors sécurité)" : `${ep.eventTypes.length} évènement(s)`}</span>
        <span>Créé : {fmtDate(ep.createdAt)}</span>
        {ep.description && <span className="truncate">{ep.description}</span>}
      </div>
      {toggleState && !toggleState.ok && <StatusNote state={toggleState} />}
      {revokeState && !revokeState.ok && <StatusNote state={revokeState} />}
    </div>
  );
}

function WebhookDeliveryLog({
  deliveries,
  endpoints,
  endpointsById,
  filter,
}: {
  deliveries: WebhookDeliveryView[];
  endpoints: WebhookEndpointView[];
  endpointsById: Map<string, WebhookEndpointView>;
  filter: WebhookDeliveryFilter;
}) {
  const router = useRouter();
  const [navPending, startNav] = useTransition();
  const filtered = filter.failedOnly || filter.endpointId !== null;
  // Filtering is server-side (page.tsx re-queries on ?deliveries=&endpoint=), so
  // a failed delivery older than the last 50 rows stays reachable + re-sendable.
  // `tab` is kept in the URL so a reload lands back on this tab.
  const applyFilter = (next: Partial<WebhookDeliveryFilter>) => {
    const failedOnly = next.failedOnly ?? filter.failedOnly;
    const endpointId = next.endpointId !== undefined ? next.endpointId : filter.endpointId;
    const params = new URLSearchParams({ tab: "webhooks-out" });
    if (failedOnly) params.set("deliveries", "failed");
    if (endpointId) params.set("endpoint", endpointId);
    startNav(() => router.replace(`/admin/system/api?${params.toString()}`, { scroll: false }));
  };
  const statusChip = (s: string) =>
    s === "delivered"
      ? "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]"
      : s === "failed"
        ? "border-destructive/30 bg-destructive/10 text-destructive"
        : "border-[#f3e3bd] bg-[#fff4e0] text-[#b45309]";
  return (
    <Section
      icon={Clock}
      title="Journal de livraison"
      subtitle={
        filtered
          ? "Les 50 dernières livraisons correspondant au filtre — statut, code de réponse, tentatives."
          : "Les 50 dernières livraisons — statut, code de réponse, tentatives."
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <SelectField
          size="sm"
          ariaLabel="Statut des livraisons"
          value={filter.failedOnly ? "failed" : "all"}
          onChange={(v) => applyFilter({ failedOnly: v === "failed" })}
          disabled={navPending}
          options={[
            { value: "all", label: "Tous les statuts" },
            { value: "failed", label: "Échecs uniquement" },
          ]}
        />
        <SelectField
          size="sm"
          ariaLabel="Endpoint"
          value={filter.endpointId ?? "all"}
          onChange={(v) => applyFilter({ endpointId: v === "all" ? null : v })}
          disabled={navPending}
          options={[
            { value: "all", label: "Tous les endpoints" },
            ...endpoints.map((e) => ({ value: e.id, label: e.revokedAt ? `${e.name} (révoqué)` : e.name })),
          ]}
        />
        {navPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      {deliveries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          {filtered ? "Aucune livraison ne correspond au filtre." : "Aucune livraison pour l'instant."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[22px] border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                <th className="px-3 py-2 font-bold">Évènement</th>
                <th className="px-3 py-2 font-bold">Endpoint</th>
                <th className="px-3 py-2 font-bold">Statut</th>
                <th className="px-3 py-2 font-bold">HTTP</th>
                <th className="px-3 py-2 font-bold">Tentatives</th>
                <th className="px-3 py-2 font-bold">Date</th>
                <th className="px-3 py-2 font-bold"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {deliveries.map((d) => (
                <tr key={d.id}>
                  <td className="px-3 py-2 font-mono text-[11px] text-foreground">{d.eventName}</td>
                  <td className="px-3 py-2 text-[12px] text-muted-foreground">{endpointsById.get(d.endpointId)?.name ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusChip(d.status)}`}>{d.status}</span>
                    {d.errorMessage && d.status !== "delivered" && (
                      <p className="mt-1 max-w-[240px] truncate text-[10px] text-muted-foreground" title={d.errorMessage}>
                        {d.errorMessage}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-[12px] text-muted-foreground">{d.responseStatus ?? "—"}</td>
                  <td className="px-3 py-2 text-[12px] text-muted-foreground">{d.attempts}/{d.maxAttempts}</td>
                  <td className="px-3 py-2 text-[11px] text-muted-foreground">
                    {fmtDate(d.createdAt)}
                    {d.status === "queued" && d.nextAttemptAt && (
                      <span className="mt-0.5 block text-[10px] text-[#b45309]" title="Prochaine tentative">
                        ↻ {fmtDate(d.nextAttemptAt)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {(d.status === "failed" || d.status === "delivered") && <RedeliverButton deliveryId={d.id} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function RedeliverButton({ deliveryId }: { deliveryId: string }) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(redeliverWebhookAction, null);
  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="deliveryId" value={deliveryId} />
      <button type="submit" disabled={pending} title={state && state.ok ? "Reprogrammée" : "Reprogrammer"} className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-card px-2 text-[11px] font-semibold text-foreground transition hover:bg-surface/60 disabled:opacity-60">
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Renvoyer
      </button>
      {/* Surface the result inline — success AND "Livraison introuvable." — instead
          of hiding it in the button's title tooltip. */}
      <StatusNote state={state} />
    </form>
  );
}

/* ─────────────────────────── Inventaire des routes ──────────────────────────── */
const DOMAIN_ORDER: RouteDomain[] = [
  "products",
  "categories",
  "brands",
  "attributes",
  "stock",
  "orders",
  "customers",
  "warranty",
  "content",
  "blog",
  "reviews",
  "search",
  "tracking",
  "webhooks",
  "auth",
  "admin",
  "système",
];
const DOMAIN_LABEL: Record<RouteDomain, string> = {
  products: "Produits",
  categories: "Catégories",
  brands: "Marques",
  attributes: "Attributs",
  stock: "Stock",
  orders: "Commandes",
  customers: "Clients",
  warranty: "Garanties (SAV)",
  content: "Contenu (headless)",
  blog: "Blog",
  reviews: "Avis",
  search: "Recherche",
  tracking: "Tracking",
  webhooks: "Webhooks",
  auth: "Authentification",
  admin: "Admin (session)",
  système: "Système",
};

function authChip(route: ApiRoute, publicRoutes: string[]) {
  if (route.tier === "external") {
    const isPublic = route.canBePublic && publicRoutes.includes(route.id);
    if (isPublic) return { label: "Public", cls: "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]" };
    return { label: `Clé · ${route.scope}`, cls: "border-border bg-muted text-foreground" };
  }
  if (route.tier === "first-party")
    return { label: route.authLabel ?? "Même origine", cls: "border-[#c9cdf5] bg-[#eef2ff] text-[#3730a3]" };
  return { label: route.authLabel ?? "—", cls: "border-[#f3e3bd] bg-[#fff4e0] text-[#b45309]" };
}

function InventoryTab({ siteUrl, publicRoutes }: { siteUrl: string; publicRoutes: string[] }) {
  const byDomain = new Map<RouteDomain, ApiRoute[]>();
  for (const r of ALL_HTTP_ENDPOINTS) {
    const arr = byDomain.get(r.domain) ?? [];
    arr.push(r);
    byDomain.set(r.domain, arr);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card p-4 text-sm">
        <span className="text-[13px] font-bold text-foreground">Base des URL</span>
        <code className="break-all rounded-lg bg-surface/60 px-2 py-1 font-mono text-xs text-foreground">{siteUrl}</code>
      </div>

      {DOMAIN_ORDER.filter((d) => byDomain.has(d)).map((domain) => (
        <div key={domain} className="overflow-hidden rounded-[22px] border border-border bg-card">
          <header className="border-b border-border px-6 py-3">
            <h3 className="text-sm font-semibold text-foreground">{DOMAIN_LABEL[domain]}</h3>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                  <th className="px-6 py-2.5">Méthode</th>
                  <th className="px-6 py-2.5">Chemin</th>
                  <th className="px-6 py-2.5">Accès</th>
                  <th className="px-6 py-2.5">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(byDomain.get(domain) ?? []).map((r) => {
                  const chip = authChip(r, publicRoutes);
                  return (
                    <tr key={`${r.method} ${r.path} ${r.id}`} className="align-top">
                      <td className="whitespace-nowrap px-6 py-2.5 font-mono text-xs text-foreground">{r.method}</td>
                      <td className="px-6 py-2.5 font-mono text-xs text-foreground">{r.path}</td>
                      <td className="whitespace-nowrap px-6 py-2.5">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${chip.cls}`}>
                          {chip.label}
                        </span>
                      </td>
                      <td className="px-6 py-2.5 text-xs text-muted-foreground">{r.notes}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ──────────────────────────── Passerelles de paiement ───────────────────────── */
function PaymentTab({ providers }: { providers: PaymentProviderView[] }) {
  return (
    <Card
      icon={CreditCard}
      title="Passerelles de paiement"
      subtitle="Identifiants configurés et mode de chaque passerelle. Les secrets ne sont jamais affichés."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
              <th className="py-2 pr-4">Passerelle</th>
              <th className="py-2 pr-4">État</th>
              <th className="py-2">Mode</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {providers.map((p) => (
              <tr key={p.key}>
                <td className="py-3 pr-4 font-medium text-foreground">{p.label}</td>
                <td className="py-3 pr-4">
                  {p.unavailable ? (
                    <span className="text-xs text-muted-foreground">indisponible</span>
                  ) : (
                    <ConfigBadge ok={p.configured} />
                  )}
                </td>
                <td className="py-3">
                  {p.unavailable || p.testMode == null ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : (
                    <ModePill testMode={p.testMode} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="pt-1 text-xs text-muted-foreground">
        Modifiez les identifiants dans{" "}
        <Link href="/admin/system/payments" className="text-primary hover:underline">
          Paiements
        </Link>
        .
      </p>
    </Card>
  );
}

/* ─────────────────────────────── Fournisseurs IA ────────────────────────────── */
function AiProvidersTab({ providers }: { providers: AiProviderView[] }) {
  return (
    <Card
      icon={Bot}
      title="Fournisseurs IA"
      subtitle="Endpoints de génération résolus pour chaque fournisseur. Les clés API ne sont jamais affichées."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
              <th className="py-2 pr-4">Fournisseur</th>
              <th className="py-2 pr-4">Endpoint de génération</th>
              <th className="py-2 pr-4">Docs</th>
              <th className="py-2">État</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {providers.map((p) => (
              <tr key={p.id} className="align-top">
                <td className="py-3 pr-4 font-medium text-foreground">{p.label}</td>
                <td className="py-3 pr-4">
                  <span className="break-all font-mono text-xs text-foreground">{p.endpoint}</span>
                  <span className="mt-0.5 block break-all font-mono text-[11px] text-muted-foreground">base : {p.baseUrl}</span>
                </td>
                <td className="py-3 pr-4">
                  {p.docsUrl ? (
                    <a
                      href={p.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      Clés API <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <ConfigBadge ok={p.configured} />
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                        p.enabled
                          ? "border border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]"
                          : "border border-border bg-muted text-muted-foreground"
                      }`}
                    >
                      {p.enabled ? "Activé" : "Désactivé"}
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="pt-1 text-xs text-muted-foreground">
        Gérez les clés et les prompts dans{" "}
        <Link href="/admin/system/ai" className="text-primary hover:underline">
          IA &amp; Automation
        </Link>
        . Anthropic utilise l&apos;API Messages ; les autres sont compatibles OpenAI.
      </p>
    </Card>
  );
}

/* ─────────────────────────── Génération de contenu IA ───────────────────────── */
function AiGenerationTab({ tasks }: { tasks: AiTaskView[] }) {
  return (
    <Card
      icon={Sparkles}
      title="Génération de contenu IA"
      subtitle="Boutons « Générer (IA) » câblés dans l'éditeur de produit. Chaque tâche résout son prompt puis appelle le premier fournisseur configuré + activé — ou celui forcé sur la tâche."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
              <th className="py-2 pr-4">Tâche</th>
              <th className="py-2 pr-4">Type</th>
              <th className="py-2 pr-4">Déclenchée depuis</th>
              <th className="py-2">Sortie</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {tasks.map((t) => (
              <tr key={t.id} className="align-top">
                <td className="py-3 pr-4">
                  <span className="font-medium text-foreground">{t.label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{t.description}</span>
                </td>
                <td className="py-3 pr-4">
                  <span className="inline-flex items-center rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
                    {t.kind === "attribution" ? "Attribution" : "Texte"}
                  </span>
                </td>
                <td className="py-3 pr-4 text-xs text-muted-foreground">{t.trigger}</td>
                <td className="py-3 font-mono text-[11px] text-muted-foreground">{t.output}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="pt-1 text-xs text-muted-foreground">
        Les tâches « Attribution » choisissent <span className="font-medium text-foreground">strictement</span> parmi les
        options existantes — l&apos;IA ne crée jamais de catégorie, d&apos;attribut ni de valeur.
      </p>
    </Card>
  );
}

/* ─────────────────────────────── Limites & Rétention ─────────────────────────── */
function LimitsTab({
  authRate,
  bucketCount,
  retention,
  cronConfigured,
  siteUrl,
}: {
  authRate: ApiWebhooksData["authRate"];
  bucketCount: number | null;
  retention: ApiWebhooksData["retention"];
  cronConfigured: boolean;
  siteUrl: string;
}) {
  return (
    <div className="space-y-6">
      <Card icon={Gauge} title="Limites de débit" subtitle="Limiteur Better Auth (par IP) et limiteur Postgres applicatif (clés API, recherche, tracking).">
        <div className="rounded-xl border border-border bg-surface/40 p-3">
          <p className="text-[13px] font-bold text-foreground">Better Auth — défaut</p>
          <p className="mt-2 text-xs text-foreground">
            {authRate.maxPerWindow} requêtes / {authRate.windowSeconds} s par IP sur{" "}
            <code className="font-mono">/api/auth/*</code>.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[360px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                <th className="py-2 pr-4">Endpoint</th>
                <th className="py-2 pr-4">Fenêtre</th>
                <th className="py-2">Max</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {authRate.rules.map((rule) => (
                <tr key={rule.endpoint}>
                  <td className="py-2 pr-4 font-mono text-xs text-foreground">{rule.endpoint}</td>
                  <td className="py-2 pr-4 text-xs tabular-nums text-muted-foreground">{rule.window} s</td>
                  <td className="py-2 text-xs tabular-nums text-muted-foreground">{rule.max}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rounded-xl border border-border bg-surface/40 p-3 text-xs text-muted-foreground">
          Limiteur Postgres (table <code className="font-mono">rate_limit_buckets</code>, fenêtre fixe) — clés API
          (120 / 60 s), recherche, tracking, newsletter.
          <div className="mt-2 flex items-center gap-2">
            <span className="font-semibold text-foreground">Compartiments actifs :</span>
            {bucketCount == null ? (
              <span>indisponible</span>
            ) : (
              <span className="tabular-nums text-foreground">{bucketCount.toLocaleString("fr-FR")}</span>
            )}
          </div>
        </div>
      </Card>

      <Card icon={Clock} title="Rétention des données" subtitle="Purge planifiée des journaux PII non bornés.">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
          <span className="text-[13px] font-bold text-foreground">Endpoint cron</span>
          <code className="break-all font-mono text-xs text-foreground">{siteUrl}/api/cron/retention</code>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
          <span className="text-[13px] font-bold text-foreground">Authentification</span>
          <span className="flex items-center gap-2 text-xs text-foreground">
            Bearer CRON_SECRET <ConfigBadge ok={cronConfigured} />
          </span>
        </div>
        <ul className="space-y-1 pt-1 text-xs">
          {Object.entries(retention).map(([table, windowText]) => (
            <li key={table} className="flex items-center justify-between">
              <code className="font-mono text-foreground">{table}</code>
              <span className="text-muted-foreground">{windowText}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

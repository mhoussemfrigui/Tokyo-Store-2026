"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Boxes,
  ChevronDown,
  ChevronRight,
  Cog,
  Network,
  Radio,
  Unplug,
  Webhook,
} from "lucide-react";

import { AdminCallout, AdminSearch } from "@/components/admin/_components/filter-bar";

import {
  ALL_HTTP_ENDPOINTS,
  EXTERNAL_API_ROUTES,
  type ApiRoute,
} from "@/lib/api-auth/route-catalog";
import {
  INTERNAL_API_CATALOG,
  INTERNAL_ACTION_COUNT,
  type InternalActionKind,
} from "@/lib/api-auth/internal-api-catalog";
import { EVENT_CATALOG, EVENT_COUNT } from "@/lib/api-auth/event-catalog";
import { severityFor, type Severity } from "@/events/severity";

/* ── shared chrome (local, kept self-contained) ───────────────────────────── */
export function Section({
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
      <div className="mt-4">{children}</div>
    </div>
  );
}

const KIND_STYLE: Record<InternalActionKind, string> = {
  write: "bg-muted text-foreground border-border",
  read: "bg-surface text-muted-foreground border-border",
  settings: "bg-[#eef2ff] text-[#3730a3] border-[#c9cdf5]",
  destructive: "bg-[#fdecef] text-[#d40530] border-[#f6cdd6]",
  auth: "bg-[#fff4e0] text-[#b45309] border-[#f3e3bd]",
};
const KIND_LABEL: Record<InternalActionKind, string> = {
  write: "écriture",
  read: "lecture",
  settings: "réglage",
  destructive: "destructif",
  auth: "auth",
};

const SEV_STYLE: Record<Severity, string> = {
  error: "bg-[#fdecef] text-[#d40530] border-[#f6cdd6]",
  warn: "bg-[#fff4e0] text-[#b45309] border-[#f3e3bd]",
  info: "bg-surface text-muted-foreground border-border",
  debug: "bg-surface/60 text-muted-foreground/70 border-border",
};

function MethodBadge({ method }: { method: string }) {
  const tone =
    method === "GET"
      ? "bg-[#eaf7ee] text-[#15803d] border-[#cdebd6]"
      : method === "DELETE"
        ? "bg-[#fdecef] text-[#d40530] border-[#f6cdd6]"
        : "bg-muted text-foreground border-border";
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-bold ${tone}`}>{method}</span>
  );
}

/* ── 1. Vue d'ensemble ─────────────────────────────────────────────────────── */
export function ApiOverviewTab() {
  const ext = EXTERNAL_API_ROUTES.length;
  const http = ALL_HTTP_ENDPOINTS.length;
  // Distinct webhook PATHS (the Flouci endpoint exposes POST + a GET browser-return
  // on the same path — that's one endpoint, not two).
  const wh = new Set(ALL_HTTP_ENDPOINTS.filter((r) => r.domain === "webhooks").map((r) => r.path)).size;
  const cron = ALL_HTTP_ENDPOINTS.filter((r) => r.path.startsWith("/api/cron/")).length;
  const stats: { label: string; value: number; hint: string }[] = [
    { label: "Endpoints HTTP", value: http, hint: "toutes routes (api + métadonnées)" },
    { label: "API externe (ERP)", value: ext, hint: "clé requise par défaut" },
    { label: "Actions serveur", value: INTERNAL_ACTION_COUNT, hint: "API d'écriture interne" },
    { label: "Évènements", value: EVENT_COUNT, hint: "bus interne (pub/sub)" },
    { label: "Webhooks", value: wh, hint: "entrants (Flouci)" },
    { label: "Tâches cron", value: cron, hint: "planifiées (Bearer secret)" },
  ];
  return (
    <div className="space-y-5">
      <Section
        icon={Network}
        title="Surface d'API — vue d'ensemble"
        subtitle="Tout le contrat backend : HTTP externe (ERP) + actions serveur internes + lecture + évènements + webhooks. Conçu pour découpler le frontend (documentation complète : API.md)."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {stats.map((s) => (
            <div key={s.label} className="rounded-[16px] border border-border bg-surface/40 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{s.value}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{s.hint}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-[12px] leading-relaxed text-muted-foreground">
          Objectif découplage : un nouveau frontend lit/écrit la boutique via l'API HTTP (onglet « API externe / ERP »).
          Les opérations d'administration passent par les actions serveur (onglet « API interne ») — détaillées avec leur
          modèle d'autorisation. L'onglet « Découplage » présente la matrice lecture/écriture par domaine.
        </p>
      </Section>
    </div>
  );
}

/* ── 2. API externe (ERP) ──────────────────────────────────────────────────── */
export function ErpApiTab({ siteUrl }: { siteUrl: string }) {
  const base = siteUrl.replace(/\/$/, "");
  const reads = EXTERNAL_API_ROUTES.filter((r) => r.action === "read");
  const writes = EXTERNAL_API_ROUTES.filter((r) => r.action !== "read");
  const Row = ({ r }: { r: ApiRoute }) => (
    <tr className="border-t border-border align-top transition hover:bg-[#fffbfb]">
      <td className="py-2 pr-3"><MethodBadge method={r.method} /></td>
      <td className="py-2 pr-3 font-mono text-[12px] text-foreground">{r.path}</td>
      <td className="py-2 pr-3">
        {r.scope ? (
          <code className="rounded bg-surface px-1.5 py-0.5 text-[11px]">{r.scope}</code>
        ) : (
          <span className="text-[11px] text-muted-foreground">{r.authLabel ?? "—"}</span>
        )}
      </td>
      <td className="py-2 text-[12px] text-muted-foreground">
        {r.notes}
        {r.canBePublic && <span className="ml-1 rounded-full bg-[#eaf7ee] px-1.5 py-0.5 text-[10px] font-semibold text-[#15803d]">lecture publiable</span>}
      </td>
    </tr>
  );
  return (
    <div className="space-y-5">
      <Section
        icon={Boxes}
        title="API externe (ERP / intégrations)"
        subtitle="Le contrat HTTP pour outils tiers & ERP. Clé requise par défaut (posture max-sécurité) ; les écritures ne sont JAMAIS publiques."
      >
        <div className="rounded-[16px] border border-border bg-surface/40 p-4 text-[12px] leading-relaxed text-muted-foreground">
          <p className="font-semibold text-foreground">Authentification</p>
          <p className="mt-1">
            En-tête <code className="rounded bg-surface px-1 py-0.5">Authorization: Bearer &lt;clé&gt;</code> ou{" "}
            <code className="rounded bg-surface px-1 py-0.5">X-API-Key: &lt;clé&gt;</code>. Chaque clé porte des scopes
            (onglet « Réglages & Authentification » pour émettre/révoquer). Limites : 120 req/min par clé, 60 req/min par IP
            sur une lecture publique. Erreurs : 401 (clé absente/invalide/expirée), 403 (scope manquant), 429 (débit).
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg border border-border bg-background p-3 text-[11px] text-foreground">
            <code>{`curl -s "${base}/api/products?limit=20" \\\n  -H "Authorization: Bearer gz_live_…"`}</code>
          </pre>
        </div>

        <p className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Lectures (catalogue / commandes / stock)</p>
        <div className="mt-1.5 overflow-x-auto rounded-[22px] border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                <th className="px-3 py-2 font-bold">Méthode</th>
                <th className="px-3 py-2 font-bold">Chemin</th>
                <th className="px-3 py-2 font-bold">Scope</th>
                <th className="px-3 py-2 font-bold">Description</th>
              </tr>
            </thead>
            <tbody className="px-3">{reads.map((r) => <Row key={r.id} r={r} />)}</tbody>
          </table>
        </div>

        <p className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Écritures (ingestion / synchronisation)</p>
        <div className="mt-1.5 overflow-x-auto rounded-[22px] border border-border">
          <table className="w-full text-sm">
            <tbody>{writes.map((r) => <Row key={r.id} r={r} />)}</tbody>
          </table>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <div className="rounded-[16px] border border-border bg-surface/40 p-4 text-[12px] text-muted-foreground">
            <p className="font-semibold text-foreground">Cas d'usage ERP</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-4">
              <li>Synchroniser les commandes : <code className="rounded bg-surface px-1 py-0.5">/api/orders</code> + <code className="rounded bg-surface px-1 py-0.5">/api/orders/[id]/status</code>.</li>
              <li>Synchroniser le stock : <code className="rounded bg-surface px-1 py-0.5">/api/stock</code>.</li>
              <li>Tirer le catalogue : produits / catégories / marques / attributs.</li>
              <li>Charger en masse : import catalogue (CSV/XML) via l'admin.</li>
            </ul>
          </div>
          <div className="rounded-[16px] border border-border bg-surface/40 p-4 text-[12px] text-muted-foreground">
            <p className="font-semibold text-foreground">Graphe de liaisons (intégrateurs)</p>
            <p className="mt-1">
              commande → paiement → client → lignes → produit/variante → promotion (cible + fenêtre de dates). Le détail
              du graphe d'entités + les exemples request/response sont dans{" "}
              <code className="rounded bg-surface px-1 py-0.5">API.md</code> (guide de découplage, dans le dépôt).
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-border bg-surface/40 p-4 text-[12px] leading-relaxed text-muted-foreground">
          <p className="font-semibold text-foreground">Référence externe (ERP) — la clé de liaison</p>
          <p className="mt-1">
            Le champ <strong>« Référence externe (ERP) »</strong> (colonne{" "}
            <code className="rounded bg-surface px-1 py-0.5">external_ref</code>), présent sur les éditeurs de{" "}
            <strong>produit, catégorie, marque</strong> (et porté par les <strong>commandes</strong>, où il se renseigne
            via l'API), stocke un code stable propre à VOTRE système (ERP / PIM / WMS). Il évite à chacun de connaître
            l'UUID interne de l'autre :
            renseignez-le une fois, puis adressez l'entité par votre propre référence. Unique (un seul enregistrement
            vivant par valeur ; distinct du SKU).
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>
              Résoudre par référence : <code className="rounded bg-surface px-1 py-0.5">?externalRef=</code> sur
              produits / catégories / marques / commandes / stock (le segment{" "}
              <code className="rounded bg-surface px-1 py-0.5">/api/orders/[id]</code> accepte l'UUID ou la référence).
            </li>
            <li>Chaque réponse renvoie <code className="rounded bg-surface px-1 py-0.5">externalRef</code> → mapping UUID ↔ votre référence en un appel.</li>
            <li>
              Lier une commande : <code className="rounded bg-surface px-1 py-0.5">PATCH /api/orders/[id]/status</code>{" "}
              avec <code className="rounded bg-surface px-1 py-0.5">{`{ externalRef }`}</code> (idempotent ; conflits gardés :
              <code className="rounded bg-surface px-1 py-0.5">already_linked</code> / <code className="rounded bg-surface px-1 py-0.5">external_ref_conflict</code>).
            </li>
            <li>
              Catalogue : se définit via l'API à clé —{" "}
              <code className="rounded bg-surface px-1 py-0.5">POST/PATCH /api/{`{produits,catégories,marques}`}</code> ou
              l'upsert <code className="rounded bg-surface px-1 py-0.5">PUT</code> qui s'appuie dessus
              (<code className="rounded bg-surface px-1 py-0.5">matchBy: externalRef</code>) ; également via l'éditeur
              (champ « Référence externe (ERP) ») ou l'import.
            </li>
          </ul>
        </div>
      </Section>
    </div>
  );
}

/* ── 3. API interne (server actions) ───────────────────────────────────────── */
export function InternalApiTab() {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    if (!q.trim()) return INTERNAL_API_CATALOG;
    const needle = q.trim().toLowerCase();
    return INTERNAL_API_CATALOG.map((g) => ({
      ...g,
      domains: g.domains
        .map((d) => ({
          ...d,
          actions: d.actions.filter(
            (a) => a.name.toLowerCase().includes(needle) || a.summary.toLowerCase().includes(needle) || d.label.toLowerCase().includes(needle),
          ),
        }))
        .filter((d) => d.actions.length > 0),
    })).filter((g) => g.domains.length > 0);
  }, [q]);

  return (
    <div className="space-y-5">
      <Section
        icon={Cog}
        title={`API interne — actions serveur (${INTERNAL_ACTION_COUNT})`}
        subtitle="L'API d'ÉCRITURE qu'utilise le frontend (React server actions). Détaillée par domaine, avec le type d'opération et le scope RBAC documentaire (le garde par action fait foi)."
      >
        <AdminSearch
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filtrer (nom d'action, domaine, description)…"
          aria-label="Filtrer les actions serveur"
          className="mb-3 w-full"
        />
        <div className="space-y-2">
          {groups.map((g) => {
            const total = g.domains.reduce((n, d) => n + d.actions.length, 0);
            const isOpen = open[g.group] ?? Boolean(q.trim());
            return (
              <div key={g.group} className="overflow-hidden rounded-[22px] border border-border">
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [g.group]: !isOpen }))}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between gap-2 bg-surface/40 px-4 py-2.5 text-left text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="inline-flex items-center gap-2">
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    {g.group}
                  </span>
                  <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">{total}</span>
                </button>
                {isOpen && (
                  <div className="divide-y divide-border">
                    {g.domains.map((d) => (
                      <div key={d.file} className="px-4 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-medium text-foreground">{d.label}</p>
                          <code className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-muted-foreground">{d.permission}</code>
                        </div>
                        <ul className="mt-2 space-y-1.5">
                          {d.actions.map((a) => (
                            <li key={a.name} className="flex items-start gap-2 text-[12px]">
                              <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${KIND_STYLE[a.kind]}`}>
                                {KIND_LABEL[a.kind]}
                              </span>
                              <span className="min-w-0">
                                <code className="text-[12px] text-foreground">{a.name}</code>
                                {a.summary && <span className="text-muted-foreground"> — {a.summary}</span>}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {groups.length === 0 && <p className="text-sm text-muted-foreground">Aucune action ne correspond.</p>}
        </div>
      </Section>
    </div>
  );
}

/* ── 4. Évènements ─────────────────────────────────────────────────────────── */
export function EventsTab() {
  const [q, setQ] = useState("");
  const domains = useMemo(() => {
    if (!q.trim()) return EVENT_CATALOG;
    const needle = q.trim().toLowerCase();
    return EVENT_CATALOG.map((d) => ({
      ...d,
      events: d.events.filter((e) => e.toLowerCase().includes(needle) || d.label.toLowerCase().includes(needle)),
    })).filter((d) => d.events.length > 0);
  }, [q]);
  return (
    <div className="space-y-5">
      <Section
        icon={Radio}
        title={`Évènements (${EVENT_COUNT})`}
        subtitle="Le bus d'évènements interne (pub/sub). Chaque action métier émet un évènement ; les abonnés persistent l'audit, invalident le cache, envoient des emails. La sévérité pilote la persistance du journal."
      >
        <AdminSearch
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filtrer un évènement…"
          aria-label="Filtrer les évènements"
          className="mb-3 w-full"
        />
        <div className="mb-3 flex flex-wrap gap-2 text-[10px]">
          {(["error", "warn", "info", "debug"] as Severity[]).map((s) => (
            <span key={s} className={`rounded border px-1.5 py-0.5 font-semibold ${SEV_STYLE[s]}`}>{s}</span>
          ))}
          <Link href="/admin/system/audit" className="ml-auto text-[11px] text-muted-foreground underline">Journal d'audit →</Link>
        </div>
        <div className="space-y-3">
          {domains.map((d) => (
            <div key={d.domain} className="rounded-[16px] border border-border p-3">
              <p className="text-sm font-medium text-foreground">{d.label} <span className="text-[11px] text-muted-foreground">({d.events.length})</span></p>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {d.events.map((e) => {
                  const sev = severityFor(e);
                  return (
                    <li key={e} className={`rounded border px-1.5 py-0.5 text-[11px] ${SEV_STYLE[sev]}`}>
                      <code className="text-[11px]">{e}</code>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {domains.length === 0 && <p className="text-sm text-muted-foreground">Aucun évènement ne correspond.</p>}
        </div>
      </Section>
    </div>
  );
}

/* ── 5. Webhooks & Cron ────────────────────────────────────────────────────── */
export function WebhooksCronTab({ cronConfigured }: { cronConfigured: boolean }) {
  const webhooks = ALL_HTTP_ENDPOINTS.filter((r) => r.domain === "webhooks");
  const crons = ALL_HTTP_ENDPOINTS.filter((r) => r.path.startsWith("/api/cron/"));
  return (
    <div className="space-y-5">
      <Section icon={Webhook} title="Webhooks entrants" subtitle="Callbacks de paiement — re-vérifiés côté serveur contre l'API du fournisseur (jamais de confiance aveugle).">
        <div className="overflow-x-auto rounded-[22px] border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                <th className="px-3 py-2 font-bold">Méthode</th>
                <th className="px-3 py-2 font-bold">Chemin</th>
                <th className="px-3 py-2 font-bold">Vérification</th>
                <th className="px-3 py-2 font-bold">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {webhooks.map((r) => (
                <tr key={r.id} className="transition hover:bg-[#fffbfb]">
                  <td className="px-3 py-2"><MethodBadge method={r.method} /></td>
                  <td className="px-3 py-2 font-mono text-[12px] text-foreground">{r.path}</td>
                  <td className="px-3 py-2 text-[11px] text-muted-foreground">{r.authLabel}</td>
                  <td className="px-3 py-2 text-[12px] text-muted-foreground">{r.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        icon={Clock3Icon}
        title="Tâches planifiées (cron)"
        subtitle="Déclenchées par un planificateur externe (Coolify) avec Bearer CRON_SECRET. Voir Système → Tâches planifiées pour les cadences + run-now."
      >
        {!cronConfigured && (
          <AdminCallout tone="warning" icon={AlertTriangle} className="mb-3">
            CRON_SECRET n'est pas configuré — les endpoints cron renvoient 503 (cron_not_configured) jusqu'à ce qu'il soit défini.
          </AdminCallout>
        )}
        <div className="overflow-x-auto rounded-[22px] border border-border">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-border">
              {crons.map((r) => (
                <tr key={r.id} className="transition hover:bg-[#fffbfb]">
                  <td className="px-3 py-2"><MethodBadge method={r.method} /></td>
                  <td className="px-3 py-2 font-mono text-[12px] text-foreground">{r.path}</td>
                  <td className="px-3 py-2 text-[12px] text-muted-foreground">{r.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Astuce : <Link href="/admin/system/jobs" className="underline">Système → Tâches planifiées</Link> centralise
          l'activation, les cadences et le « lancer maintenant ».
        </p>
      </Section>
    </div>
  );
}

/* ── 6. Découplage (read/write matrix) ─────────────────────────────────────── */
type Row = { domain: string; readHttp: string; writeHttp: string };
const DECOUPLING: Row[] = [
  { domain: "Catalogue (produits/catégories/marques/attributs)", readHttp: "Oui — /api/products, /api/categories, /api/brands, /api/attributes", writeHttp: "Oui — clé, POST/PUT/PATCH/DELETE (PUT = upsert par référence) ; pilote aussi l'éditeur admin" },
  { domain: "Stock", readHttp: "Oui — /api/stock", writeHttp: "Partiel — /api/stock (ERP) + actions serveur" },
  { domain: "Commandes", readHttp: "Oui — /api/orders, /api/orders/[id] (clé)", writeHttp: "Partiel — push de statut PATCH /api/orders/[id]/status (ERP) ; création = admin/action serveur" },
  { domain: "Panier & checkout", readHttp: "Non (RSC)", writeHttp: "Non — actions serveur (cart.ts) ; PAS de /api/cart" },
  { domain: "Promotions", readHttp: "Non — RSC + cookies", writeHttp: "Non — actions serveur (promotion.ts, segments.ts)" },
  { domain: "Contenu (blog/CMS/avis)", readHttp: "Oui — /api/blog, /api/content, /api/reviews", writeHttp: "Non — actions serveur" },
  { domain: "Recherche", readHttp: "Oui — /api/store/search (même origine)", writeHttp: "n/a" },
  { domain: "Auth & comptes", readHttp: "Better Auth — /api/auth/[...all]", writeHttp: "Better Auth (HTTP) + actions serveur (profil, 2FA, RBAC)" },
];
export function DecouplingTab() {
  return (
    <div className="space-y-5">
      <Section
        icon={Unplug}
        title="Découplage frontend ⇄ backend"
        subtitle="Ce qu'un nouveau frontend peut LIRE/ÉCRIRE via HTTP aujourd'hui, vs ce qui passe par les actions serveur (Next) ou le RSC. Guide complet : API.md."
      >
        <div className="overflow-x-auto rounded-[22px] border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                <th className="px-3 py-2 font-bold">Domaine</th>
                <th className="px-3 py-2 font-bold">Lecture HTTP</th>
                <th className="px-3 py-2 font-bold">Écriture HTTP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {DECOUPLING.map((r) => (
                <tr key={r.domain} className="align-top transition hover:bg-[#fffbfb]">
                  <td className="px-3 py-2 text-[12px] font-medium text-foreground">{r.domain}</td>
                  <td className={`px-3 py-2 text-[12px] ${r.readHttp.startsWith("Oui") ? "text-[#15803d]" : "text-muted-foreground"}`}>{r.readHttp}</td>
                  <td className={`px-3 py-2 text-[12px] ${r.writeHttp.startsWith("Oui") ? "text-[#15803d]" : "text-muted-foreground"}`}>{r.writeHttp}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-[12px] leading-relaxed text-muted-foreground">
          Lacunes connues pour un frontend 100 % headless : <strong>panier/checkout</strong> et{" "}
          <strong>promotions</strong> n'ont pas encore de contrat HTTP (écriture par action serveur uniquement). Un
          frontend Next.js réutilise directement les actions serveur ; un frontend non-Next devrait exposer ces domaines
          en HTTP. Détails + plan dans <code className="rounded bg-surface px-1 py-0.5">API.md</code> (dépôt).
        </p>
      </Section>
    </div>
  );
}

/* clock icon (avoid extra import churn) */
function Clock3Icon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6h4.5" />
    </svg>
  );
}

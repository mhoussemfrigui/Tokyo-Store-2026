"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { ChevronDown, ChevronRight, Download, Filter, Loader2, X } from "lucide-react";

import { NativeSelect } from "@/components/ui/select-field";
import { loadMoreAuditEntriesAction } from "@/lib/actions/audit-log";
import { STORE_TIME_ZONE } from "@/lib/time/store-tz";
import { severityBadge, severityLabel } from "./severity-style";

export type AuditRow = {
  id: string;
  eventName: string;
  severity: string;
  actorUserId: string | null;
  actorIp: string | null;
  targetType: string | null;
  targetId: string | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type AuditFilters = {
  event: string;
  domain: string;
  severity: string;
  targetType: string;
  targetId: string;
  actor: string;
  summary: string;
  from: string;
  to: string;
};

/** Curated domain list for the filter dropdown (event-name first segment). */
const DOMAIN_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Tous les domaines" },
  { value: "user", label: "Utilisateurs / auth" },
  { value: "rbac", label: "RBAC / rôles" },
  { value: "order", label: "Commandes" },
  { value: "payment", label: "Paiement" },
  { value: "webhook", label: "Webhooks paiement" },
  { value: "product", label: "Produits" },
  { value: "category", label: "Catégories" },
  { value: "brand", label: "Marques" },
  { value: "attribute", label: "Attributs" },
  { value: "attribute_value", label: "Valeurs d'attribut" },
  { value: "catalog", label: "Avis / IA catalogue" },
  { value: "customer", label: "Clients" },
  { value: "address", label: "Adresses" },
  { value: "segment", label: "Segments" },
  { value: "mailing", label: "Mailing" },
  { value: "newsletter", label: "Newsletter" },
  { value: "promotion", label: "Promotions" },
  { value: "currency", label: "Devises" },
  { value: "tax", label: "Taxes" },
  { value: "delivery", label: "Livraison" },
  { value: "redirect", label: "Redirections" },
  { value: "job", label: "Tâches planifiées" },
  { value: "api", label: "API" },
  { value: "api_key", label: "Clés API" },
  { value: "setting", label: "Réglages" },
  { value: "banner", label: "Bannières" },
  { value: "faq", label: "FAQ" },
  { value: "page", label: "Pages" },
  { value: "nav", label: "Navigation" },
  { value: "cms", label: "CMS (badges/annonce)" },
  { value: "showcase", label: "Vitrine" },
  { value: "blog", label: "Blog" },
  { value: "aid", label: "Aide" },
  { value: "media", label: "Médias" },
  { value: "import", label: "Import" },
  { value: "search_log", label: "Recherche" },
  { value: "audit", label: "Audit" },
  { value: "demo", label: "Démo" },
];

const SEVERITY_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Toutes les sévérités" },
  { value: "error", label: "Erreur" },
  { value: "warn", label: "Alerte" },
  { value: "info", label: "Info" },
  { value: "debug", label: "Debug" },
];

/**
 * Journal tab — the audit list with filters + CSV export + keyset "Charger plus".
 * Filters submit as a native GET form (Enter works, no JS needed, accessible);
 * "Charger plus" preserves the current filters and appends the id cursor.
 */
export function AuditJournal({
  items,
  nextCursor,
  filters,
  actorNames,
}: {
  items: AuditRow[];
  nextCursor: string | null;
  filters: AuditFilters;
  actorNames: Record<string, string>;
}) {
  const activeCount = Object.values(filters).filter((v) => v.length > 0).length;

  // Accumulate rows so "Charger plus" APPENDS (the page only ever delivers the
  // first page; subsequent pages come from the server action). Reset whenever
  // the filters change (a new server-rendered first page arrives).
  const [rows, setRows] = useState<AuditRow[]>(items);
  const [names, setNames] = useState<Record<string, string>>(actorNames);
  const [cursor, setCursor] = useState<string | null>(nextCursor);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  const filterSig = JSON.stringify(filters);
  useEffect(() => {
    setRows(items);
    setNames(actorNames);
    setCursor(nextCursor);
    setError(false);
    // Re-seed only when the filter set changes (new first page from the server).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterSig]);

  const exportHref = (() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    const qs = p.toString();
    return `/admin/system/audit/export${qs ? `?${qs}` : ""}`;
  })();

  const loadMore = () => {
    if (!cursor || pending) return;
    setError(false);
    startTransition(async () => {
      const res = await loadMoreAuditEntriesAction({ filters, cursor });
      if (res.ok) {
        setRows((prev) => [...prev, ...res.rows]);
        setNames((prev) => ({ ...prev, ...res.actorNames }));
        setCursor(res.nextCursor);
      } else {
        setError(true);
      }
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <a
          href={exportHref}
          className="inline-flex h-9 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-xs font-bold text-foreground transition hover:bg-surface"
        >
          <Download className="h-3.5 w-3.5" /> Exporter CSV
        </a>
      </div>

      <details
        className="group rounded-[22px] border border-border bg-card p-4"
        open={activeCount > 0}
      >
        <summary className="flex cursor-pointer items-center justify-between text-sm font-semibold">
          <span className="inline-flex items-center gap-2">
            <Filter className="h-4 w-4" /> Filtres
            {activeCount > 0 && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-bold text-primary">
                {activeCount} actif(s)
              </span>
            )}
          </span>
          <ChevronDown className="h-4 w-4 transition group-open:rotate-180" />
        </summary>

        {/* Native GET form → submits the filters as the page's query string
            (Enter-to-apply, no JS, resets the cursor to page 1). */}
        <form method="get" action="/admin/system/audit" className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <SelectInput name="domain" label="Domaine" defaultValue={filters.domain} options={DOMAIN_OPTIONS} />
            <SelectInput name="severity" label="Sévérité" defaultValue={filters.severity} options={SEVERITY_OPTIONS} />
            <TextInput name="event" label="Événement (exact)" placeholder="ex: product.updated" defaultValue={filters.event} />
            <TextInput name="actor" label="ID acteur" placeholder="user_id" defaultValue={filters.actor} />
            <TextInput name="targetType" label="Type cible" placeholder="ex: order, user" defaultValue={filters.targetType} />
            <TextInput name="targetId" label="ID cible" placeholder="uuid" defaultValue={filters.targetId} />
            <TextInput name="summary" label="Résumé contient" placeholder="texte libre" defaultValue={filters.summary} />
            <TextInput name="from" label="Du" type="date" defaultValue={filters.from} />
            <TextInput name="to" label="Au" type="date" defaultValue={filters.to} />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              className="inline-flex h-9 items-center rounded-full bg-foreground px-4 text-xs font-bold text-background"
            >
              Appliquer
            </button>
            {activeCount > 0 && (
              <a
                href="/admin/system/audit"
                className="inline-flex h-9 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" /> Réinitialiser
              </a>
            )}
          </div>
        </form>
      </details>

      {rows.length === 0 ? (
        <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
          Aucune entrée pour ces filtres.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-[22px] border border-border bg-card">
          {rows.map((e) => (
            <Row key={e.id} entry={e} actorName={e.actorUserId ? names[e.actorUserId] : undefined} />
          ))}
        </ul>
      )}

      {error && (
        <p className="text-center text-xs text-destructive">
          Impossible de charger la suite. Réessayez.
        </p>
      )}

      {cursor && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={pending}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-foreground px-5 text-sm font-bold text-background disabled:opacity-60"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            Charger plus
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ entry, actorName }: { entry: AuditRow; actorName?: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const hasMeta = entry.metadata != null && Object.keys(entry.metadata).length > 0;

  const meta = (
    <>
      <span
        className={`mt-0.5 inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${severityBadge(entry.severity)}`}
        title={`Sévérité : ${severityLabel(entry.severity)}`}
      >
        {severityLabel(entry.severity)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {entry.summary ?? entry.eventName}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          <code className="text-[10px]">{entry.eventName}</code>
          {entry.targetType ? ` · ${entry.targetType}${entry.targetId ? `:${entry.targetId.slice(0, 8)}…` : ""}` : ""}
          {entry.actorUserId
            ? ` · ${actorName ?? `acteur ${entry.actorUserId.slice(0, 8)}…`}`
            : " · système"}
          {entry.actorIp ? ` · ${entry.actorIp}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="whitespace-nowrap text-[11px] text-muted-foreground">
          {/* Store zone, not the runtime's: the SSR pass runs in the UTC container
              and hydration in the viewer's browser — pinning Africa/Tunis keeps
              both identical AND on the same day frame as the Du/Au filter. */}
          {new Date(entry.createdAt).toLocaleString("fr-FR", {
            dateStyle: "short",
            timeStyle: "short",
            timeZone: STORE_TIME_ZONE,
          })}
        </span>
        {hasMeta && (
          <ChevronRight className={`h-4 w-4 text-muted-foreground transition ${open ? "rotate-90" : ""}`} />
        )}
      </div>
    </>
  );

  return (
    <li className="p-4">
      {hasMeta ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex w-full cursor-pointer items-start gap-3 text-left"
        >
          {meta}
        </button>
      ) : (
        <div className="flex w-full items-start gap-3">{meta}</div>
      )}
      {open && hasMeta && (
        <pre
          id={panelId}
          className="mt-3 max-h-64 overflow-auto rounded-xl bg-surface p-3 text-[11px] leading-relaxed text-foreground"
        >
          {JSON.stringify(entry.metadata, null, 2)}
        </pre>
      )}
    </li>
  );
}

function TextInput({
  name,
  label,
  placeholder,
  defaultValue,
  type = "text",
}: {
  name: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  type?: string;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className="text-[12px] font-bold text-foreground">
        {label}
      </span>
      <input
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        autoComplete="off"
        className="h-9 rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-sm text-foreground transition focus:border-foreground focus:bg-white focus:outline-none"
      />
    </label>
  );
}

/** Native <select> (NativeSelect) so the GET filter form works with no JS. */
function SelectInput({
  name,
  label,
  defaultValue,
  options,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  options: { value: string; label: string }[];
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className="text-[12px] font-bold text-foreground">
        {label}
      </span>
      <NativeSelect id={id} name={name} defaultValue={defaultValue} options={options} size="sm" />
    </label>
  );
}

"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import {
  saveRedirectAction,
  deleteRedirectAction,
  toggleRedirectAction,
  importRedirectsCsvAction,
} from "@/lib/actions/redirects";
import { type ActionState } from "@/lib/actions/types";
import { EXAMPLE_REDIRECTS_CSV, redirectCoverageWarning } from "@/lib/redirects/normalize";
import { SelectField } from "@/components/ui/select-field";
import { AdminCallout, AdminSearch } from "@/components/admin/_components/filter-bar";

export type RedirectDTO = {
  id: string;
  source: string;
  destination: string;
  status: number;
  active: boolean;
  hits: number;
  notes: string;
};

const STATUS_OPTIONS = [
  { value: "301", label: "301 — Permanente" },
  { value: "302", label: "302 — Temporaire" },
  { value: "308", label: "308 — Permanente" },
  { value: "307", label: "307 — Temporaire" },
] as const;

/** A save can succeed WITH a caveat (source never resolved, off-site status
 *  downgraded) — the action appends it after « Attention : ». Split it off so the
 *  caveat renders as a warning instead of blending into the green confirmation. */
function splitWarning(message: string | undefined): { main: string; warning: string | null } {
  const text = message ?? "";
  const i = text.indexOf(" Attention : ");
  return i < 0
    ? { main: text, warning: null }
    : { main: text.slice(0, i), warning: text.slice(i + " Attention : ".length) };
}

const inputCls =
  "h-10 w-full rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-sm text-foreground placeholder:text-muted-foreground/60 transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]";

export function RedirectsManager({
  rows,
  total,
  page,
  pageSize,
  q,
  canManage,
}: {
  rows: RedirectDTO[];
  total: number;
  page: number;
  pageSize: number;
  q: string;
  /** system_redirects:manage — without it the create/edit form, CSV import,
   *  toggle and delete controls are hidden (their actions would 404 the page). */
  canManage: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const editing = editingId ? rows.find((r) => r.id === editingId) ?? null : null;

  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveRedirectAction,
    null,
  );
  // After a successful save, clear the form (remount via key) + exit edit mode.
  const lastHandled = useRef<ActionState | null>(null);
  useEffect(() => {
    if (state && state !== lastHandled.current) {
      lastHandled.current = state;
      if (state.ok) {
        setEditingId(null);
        setFormKey((k) => k + 1);
      }
    }
  }, [state]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageHref = (p: number) =>
    `/admin/system/redirects?tab=list&page=${p}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  return (
    <div className="space-y-6">
      {!canManage && (
        <AdminCallout tone="warning" icon={Lock}>
          Lecture seule — la permission « gérer » (Redirections &amp; 404) est requise pour
          ajouter, importer, activer ou supprimer des redirections.
        </AdminCallout>
      )}
      {canManage && (
        <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
          {/* ── Create / edit form ─────────────────────────────────────────── */}
          <form
            key={`${editingId ?? "new"}-${formKey}`}
            action={formAction}
            className="rounded-[22px] border border-border bg-card p-5"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">
                {editing ? "Modifier la redirection" : "Nouvelle redirection"}
              </h2>
              {editing && (
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" /> Annuler
                </button>
              )}
            </div>

            {editing && <input type="hidden" name="id" value={editing.id} />}

            <div className="space-y-3">
              <label className="block">
                <span className="text-[13px] font-bold text-foreground">
                  Ancienne URL (source)
                </span>
                <input
                  name="source"
                  defaultValue={editing?.source ?? ""}
                  placeholder="/ancienne-page"
                  required
                  className={`mt-1 font-mono ${inputCls}`}
                />
                {state && !state.ok && state.fieldErrors?.source && (
                  <span className="mt-1 block text-[11px] font-medium text-destructive">
                    {state.fieldErrors.source}
                  </span>
                )}
                <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                  S&apos;applique aux anciennes URL de contenu (produits, catégories, marques, pages,
                  blog, aide, y compris les chemins profonds). Sans effet sur la page d&apos;accueil,
                  les pages dédiées (<code>/about</code>, <code>/cgu</code>, <code>/login</code>…) et
                  les URL d&apos;une route applicative (<code>/order/…</code>,{" "}
                  <code>/account/orders/…</code>, <code>/admin/…</code>, <code>/api/…</code>, l&apos;ancien{" "}
                  <code>/product/slug</code>…) — signalées « Jamais appliquée ».
                </span>
              </label>
              <label className="block">
                <span className="text-[13px] font-bold text-foreground">
                  Destination
                </span>
                <input
                  name="destination"
                  defaultValue={editing?.destination ?? ""}
                  placeholder="/nouvelle-page ou https://…"
                  required
                  className={`mt-1 font-mono ${inputCls}`}
                />
                {state && !state.ok && state.fieldErrors?.destination && (
                  <span className="mt-1 block text-[11px] font-medium text-destructive">
                    {state.fieldErrors.destination}
                  </span>
                )}
                <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                  Une URL vers un autre domaine est réservée au super-administrateur et toujours
                  temporaire (307).
                </span>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <SelectField
                  label="Type"
                  name="status"
                  defaultValue={String(editing?.status ?? 301)}
                  triggerClassName="h-10"
                  options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                />
                <label className="mt-6 flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="active"
                    value="on"
                    defaultChecked={editing ? editing.active : true}
                    className="h-4 w-4 accent-[var(--primary)]"
                  />
                  <span className="text-sm">Active</span>
                </label>
              </div>
              <label className="block">
                <span className="text-[13px] font-bold text-foreground">
                  Note (optionnel)
                </span>
                <input
                  name="notes"
                  defaultValue={editing?.notes ?? ""}
                  placeholder="ex. migration ancien site"
                  className={`mt-1 ${inputCls}`}
                />
              </label>
            </div>

            {state && (() => {
              const { main, warning } = splitWarning(state.message);
              return (
                <>
                  <p className={`mt-3 text-sm ${state.ok ? "text-[#15803d]" : "text-destructive"}`}>
                    {main}
                  </p>
                  {warning && (
                    <p role="status" className="mt-1 text-xs text-[#b45309]">
                      Attention : {warning}
                    </p>
                  )}
                </>
              );
            })()}

            <div className="mt-4">
              <button
                type="submit"
                disabled={pending}
                className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
              >
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : editing ? (
                  <Save className="h-4 w-4" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {editing ? "Enregistrer" : "Ajouter"}
              </button>
            </div>
          </form>

          {/* ── CSV import ─────────────────────────────────────────────────── */}
          <CsvImport />
        </div>
      )}

      {/* ── List ─────────────────────────────────────────────────────────── */}
      <div className="rounded-[22px] border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">
            Redirections <span className="text-muted-foreground">({total})</span>
          </h2>
          <form method="get" action="/admin/system/redirects" className="flex items-center gap-2">
            <input type="hidden" name="tab" value="list" />
            <AdminSearch
              name="q"
              defaultValue={q}
              placeholder="Rechercher source / destination…"
              className="w-64"
            />
            <button
              type="submit"
              className="h-11 rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground transition hover:bg-surface"
            >
              Rechercher
            </button>
          </form>
        </div>

        {rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {q
              ? "Aucune redirection ne correspond."
              : canManage
                ? "Aucune redirection. Ajoutez-en une ci-dessus ou importez un CSV."
                : "Aucune redirection."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-[#fbf9f8] text-left text-[12px] uppercase tracking-[0.06em] text-[#8a857f]">
                  <th className="px-4 py-3 font-bold">Source → Destination</th>
                  <th className="px-4 py-3 font-bold">Type</th>
                  <th className="px-4 py-3 font-bold">Hits</th>
                  <th className="px-4 py-3 font-bold">État</th>
                  {canManage && <th className="px-4 py-3 text-right font-bold">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  // A rule on a source the storefront never resolves (home, a
                  // dedicated page, an application route) stays at 0 hits forever.
                  const neverFires = redirectCoverageWarning(r.source);
                  return (
                    <tr key={r.id} className="border-b border-border/60 transition hover:bg-[#fffbfb] last:border-0">
                      <td className="max-w-[420px] px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-mono text-xs text-foreground">{r.source}</span>
                          {neverFires && (
                            <span
                              title={neverFires}
                              className="shrink-0 rounded-full bg-[#fff4e0] px-2 py-0.5 text-[10px] font-semibold text-[#b45309]"
                            >
                              Jamais appliquée
                            </span>
                          )}
                        </div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">→ {r.destination}</div>
                        {r.notes && <div className="truncate text-[11px] text-muted-foreground/80">{r.notes}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold tabular-nums">
                          {r.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">{r.hits}</td>
                      <td className="px-4 py-3">
                        {canManage ? (
                          <RedirectToggle id={r.id} active={r.active} />
                        ) : (
                          <span
                            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                              r.active
                                ? "bg-[#eaf7ee] text-[#15803d]"
                                : "bg-muted text-muted-foreground"
                            }`}
                          >
                            {r.active ? "Active" : "Inactive"}
                          </span>
                        )}
                      </td>
                      {canManage && (
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(r.id);
                                window.scrollTo({ top: 0, behavior: "smooth" });
                              }}
                              aria-label="Modifier"
                              className="grid h-8 w-8 place-items-center rounded-[10px] border border-border text-muted-foreground transition hover:bg-surface hover:text-foreground"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <form
                              action={deleteRedirectAction}
                              onSubmit={(e) => {
                                if (!confirm(`Supprimer la redirection ${r.source} ?`)) e.preventDefault();
                              }}
                            >
                              <input type="hidden" name="id" value={r.id} />
                              <button
                                type="submit"
                                aria-label="Supprimer"
                                className="grid h-8 w-8 place-items-center rounded-[10px] border border-border text-muted-foreground transition hover:bg-[var(--accent)] hover:text-destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </form>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between gap-3 border-t border-border p-3 text-sm">
            <span className="text-muted-foreground">
              Page {page} / {totalPages}
            </span>
            <div className="flex items-center gap-2">
              {page > 1 ? (
                <Link href={pageHref(page - 1)} className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 hover:bg-surface">
                  <ChevronLeft className="h-4 w-4" /> Précédent
                </Link>
              ) : (
                <span className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 opacity-40">
                  <ChevronLeft className="h-4 w-4" /> Précédent
                </span>
              )}
              {page < totalPages ? (
                <Link href={pageHref(page + 1)} className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 hover:bg-surface">
                  Suivant <ChevronRight className="h-4 w-4" />
                </Link>
              ) : (
                <span className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 opacity-40">
                  Suivant <ChevronRight className="h-4 w-4" />
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The per-row active/inactive pill. Re-activating a staged rule can be REFUSED
 * server-side when it would close a redirect loop; this drives the toggle through
 * `useActionState` so that refusal (and any other failure) surfaces as an inline
 * message instead of the pill silently snapping back with no explanation.
 */
function RedirectToggle({ id, active }: { id: string; active: boolean }) {
  const [state, formAction] = useActionState<ActionState | null, FormData>(
    toggleRedirectAction,
    null,
  );
  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={(!active).toString()} />
      <button
        type="submit"
        className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
          active
            ? "bg-[#eaf7ee] text-[#15803d] hover:bg-[#d7f0e0]"
            : "bg-muted text-muted-foreground hover:bg-surface"
        }`}
      >
        {active ? "Active" : "Inactive"}
      </button>
      {state && !state.ok && (
        <p role="alert" className="max-w-[200px] text-[10px] font-medium leading-tight text-destructive">
          {state.message}
        </p>
      )}
    </form>
  );
}

function CsvImport() {
  const [csv, setCsv] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    importRedirectsCsvAction,
    null,
  );

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  function downloadExample() {
    const blob = new Blob([EXAMPLE_REDIRECTS_CSV], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "redirections-exemple.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <form action={formAction} className="rounded-[22px] border border-border bg-card p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">Import CSV en masse</h2>
        <button
          type="button"
          onClick={downloadExample}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
        >
          <Download className="h-3.5 w-3.5" /> Exemple
        </button>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        Colonnes : <code>source,destination,status</code> (une par ligne ; <code>status</code> optionnel,
        301 par défaut). Collez le contenu ou choisissez un fichier .csv. Les lignes existantes (même
        source) sont mises à jour. Les destinations vers un autre domaine sont réservées au
        super-administrateur et importées en 307 (temporaire).
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        onChange={onFile}
        className="mb-2 block w-full text-xs file:mr-3 file:rounded-full file:border-0 file:bg-surface file:px-3 file:py-1.5 file:text-xs file:font-semibold"
      />
      <textarea
        name="csv"
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        rows={5}
        placeholder={"source,destination,status\n/ancienne-page,/nouvelle-page,301"}
        className="w-full resize-y rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-3 py-2 font-mono text-xs text-foreground transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]"
      />
      {state && (() => {
        const { main, warning } = splitWarning(state.message);
        return (
          <>
            <p className={`mt-2 text-sm ${state.ok ? "text-[#15803d]" : "text-destructive"}`}>
              {main}
            </p>
            {warning && (
              <p role="status" className="mt-1 text-xs text-[#b45309]">
                Attention : {warning}
              </p>
            )}
          </>
        );
      })()}
      <button
        type="submit"
        disabled={pending || !csv.trim()}
        className="mt-3 inline-flex h-10 items-center gap-2 rounded-full bg-foreground px-5 text-sm font-semibold text-background disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        Importer
      </button>
    </form>
  );
}

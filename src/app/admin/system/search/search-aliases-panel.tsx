"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { AdminNote, AdminSearch } from "@/components/admin/_components/filter-bar";
import { useRefreshAction } from "@/hooks/use-refresh-action";
import { type ActionState } from "@/lib/actions/types";
import {
  createSearchAliasAction,
  deleteSearchAliasAction,
  seedDefaultSearchAliasesAction,
  toggleSearchAliasAction,
} from "@/lib/actions/search-aliases";
import type { SearchAliasRow } from "@/modules/search";

/**
 * Système → Recherche → Alias : manage the query-expansion synonym rules.
 *
 * A rule reads « quand on cherche TERME, chercher aussi ÉQUIVALENT » — so a
 * shopper typing « chrono » also finds « chronographe », « leather strap » finds
 * « bracelet cuir », etc. Rules are grouped by their ÉQUIVALENT (the canonical
 * target). Everything is gated by system_search:manage (the parent only renders
 * this when canManage).
 */
export function SearchAliasesPanel({
  aliases,
  counts,
  prefillTerm = "",
}: {
  aliases: SearchAliasRow[];
  counts: { total: number; defaults: number };
  /** Pre-fills the « terme » field — set by « Créer alias » on a zero-result query. */
  prefillTerm?: string;
}) {
  const [filter, setFilter] = useState("");

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const byExpansion = new Map<string, SearchAliasRow[]>();
    for (const a of aliases) {
      if (q && !a.term.includes(q) && !a.expansion.includes(q)) continue;
      const arr = byExpansion.get(a.expansion);
      if (arr) arr.push(a);
      else byExpansion.set(a.expansion, [a]);
    }
    return [...byExpansion.entries()]
      .map(([expansion, rows]) => ({
        expansion,
        rows: [...rows].sort((x, y) => x.term.localeCompare(y.term)),
      }))
      .sort((x, y) => x.expansion.localeCompare(y.expansion));
  }, [aliases, filter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <AdminNote className="max-w-2xl">
          Les <span className="font-semibold text-foreground">alias</span> élargissent la recherche
          sans toucher au catalogue : « quand on cherche un <span className="font-medium text-foreground">terme</span>,
          chercher aussi son <span className="font-medium text-foreground">équivalent</span> ». Ex. «&nbsp;earbuds&nbsp;»
          trouve «&nbsp;écouteurs&nbsp;», «&nbsp;powerbank&nbsp;» trouve «&nbsp;batterie externe&nbsp;». La
          correspondance se fait mot à mot, donc une règle «&nbsp;earbuds → écouteurs&nbsp;» s'applique
          partout dans la requête.
        </AdminNote>
        <SeedDefaultsButton counts={counts} />
      </div>

      <CreateAliasForm prefillTerm={prefillTerm} />

      {aliases.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border bg-card p-10 text-center">
          <Sparkles className="mx-auto h-7 w-7 text-muted-foreground" strokeWidth={1.5} />
          <p className="mt-3 font-semibold">Aucun alias pour le moment.</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Ajoutez-en un ci-dessus, ou chargez les alias par défaut pour l'high-tech
            (earbuds→écouteurs, powerbank→batterie externe, coque→étui, abréviations de marques…).
          </p>
        </div>
      ) : (
        <>
          <AdminSearch
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filtrer les alias…"
            className="max-w-sm"
          />

          <div className="space-y-3">
            {groups.length === 0 ? (
              <p className="rounded-[16px] border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                Aucun alias ne correspond à «&nbsp;{filter}&nbsp;».
              </p>
            ) : (
              groups.map((g) => (
                <div key={g.expansion} className="rounded-[22px] border border-border bg-card p-4">
                  <div className="mb-2.5 flex items-center gap-2 text-sm">
                    <span className="text-[13px] font-bold text-foreground">
                      chercher aussi
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={2} />
                    <span className="font-semibold text-foreground">{g.expansion}</span>
                  </div>
                  <ul className="flex flex-wrap gap-2">
                    {g.rows.map((a) => (
                      <AliasChip key={a.id} alias={a} />
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ───────────────────────────────────────────── create form ── */

function CreateAliasForm({ prefillTerm }: { prefillTerm: string }) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    createSearchAliasAction,
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const termRef = useRef<HTMLInputElement>(null);

  // Clear the fields after a successful create so the operator can add another.
  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      termRef.current?.focus();
    }
  }, [state]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="rounded-[22px] border border-border bg-surface/40 p-4"
    >
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end">
        <label className="flex-1">
          <span className="mb-1 block text-[13px] font-bold text-foreground">
            Quand on cherche
          </span>
          <input
            ref={termRef}
            name="term"
            required
            defaultValue={prefillTerm}
            placeholder="ex. chrono"
            className="h-10 w-full rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-sm text-foreground transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]"
          />
        </label>
        <ArrowRight className="mx-auto hidden h-4 w-4 shrink-0 text-muted-foreground sm:mb-3 sm:block" strokeWidth={2} />
        <label className="flex-1">
          <span className="mb-1 block text-[13px] font-bold text-foreground">
            Chercher aussi
          </span>
          <input
            name="expansion"
            required
            placeholder="ex. chronographe"
            className="h-10 w-full rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-sm text-foreground transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full bg-primary px-4 text-sm font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Créer
        </button>
      </div>
      {state?.message && (
        <p className={`mt-2 text-xs ${state.ok ? "text-primary" : "text-destructive"}`}>
          {state.message}
        </p>
      )}
    </form>
  );
}

/* ───────────────────────────────────────────── one rule chip ── */

function AliasChip({ alias }: { alias: SearchAliasRow }) {
  const { pending, run, router } = useRefreshAction();
  // A failed toggle used to make the chip silently snap back with no message
  // (useRefreshAction discards the returned state); surface it inline. A delete
  // goes through a confirm modal, which shows its own refusal inline.
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  return (
    <li
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm transition ${
        error
          ? "border-destructive/50 bg-destructive/5 text-destructive"
          : alias.is_active
            ? "border-border bg-background text-foreground"
            : "border-dashed border-border bg-surface/40 text-muted-foreground line-through"
      }`}
    >
      <span className="no-underline">{alias.term}</span>
      {alias.source === "default" && (
        <span className="rounded bg-muted/50 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground no-underline">
          déf.
        </span>
      )}
      {/* Activer / désactiver sans supprimer — un clic bascule l'état. */}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          run(async () => {
            setError(null);
            const res = await toggleSearchAliasAction(alias.id, !alias.is_active);
            if (!res.ok) {
              setError(res.message);
              return false;
            }
          })
        }
        title={alias.is_active ? "Désactiver" : "Activer"}
        className="grid h-5 w-5 place-items-center rounded-full text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:opacity-40"
      >
        <span className={`h-2 w-2 rounded-full ${alias.is_active ? "bg-[#15803d]" : "bg-muted-foreground/40"}`} />
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          setConfirmingDelete(true);
        }}
        title="Supprimer"
        className="grid h-5 w-5 place-items-center rounded-full text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
      >
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
      </button>
      {error && (
        <span className="max-w-[160px] truncate text-[10px] font-medium no-underline" title={error}>
          {error}
        </span>
      )}
      {confirmingDelete && (
        // The wrapper resets the chip's muted / destructive text colour, which
        // the (fixed-position) modal would otherwise inherit.
        <span className="text-foreground">
          <ConfirmDeleteModal
            title={`Supprimer l'alias « ${alias.term} » ?`}
            description={`La recherche « ${alias.term} » ne cherchera plus aussi « ${alias.expansion} ». Pour la suspendre sans la perdre, désactivez-la plutôt.`}
            onCancel={() => setConfirmingDelete(false)}
            onConfirm={async () => {
              const res = await deleteSearchAliasAction(alias.id);
              if (!res.ok) return res.message;
              router.refresh();
              return null;
            }}
          />
        </span>
      )}
    </li>
  );
}

/* ───────────────────────────────────────── seed defaults CTA ── */

function SeedDefaultsButton({ counts }: { counts: { total: number; defaults: number } }) {
  const { pending, run } = useRefreshAction();
  // Surface the seed result so "N alias ajoutés" vs "déjà présents" reaches the
  // operator instead of being discarded.
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          run(async () => {
            setMsg(null);
            const res = await seedDefaultSearchAliasesAction();
            if (res.message) setMsg({ ok: res.ok, text: res.message });
            if (!res.ok) return false;
          })
        }
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-3.5 py-2 text-xs font-semibold text-primary transition hover:bg-primary/10 disabled:opacity-60"
        title="Ajoute les alias par défaut pour l'high-tech (sans toucher aux vôtres)"
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        {counts.total === 0 ? "Charger les alias par défaut" : "Recharger les alias par défaut"}
      </button>
      {msg && (
        <span
          role={msg.ok ? "status" : "alert"}
          className={`text-[11px] font-medium ${msg.ok ? "text-primary" : "text-destructive"}`}
        >
          {msg.text}
        </span>
      )}
    </div>
  );
}

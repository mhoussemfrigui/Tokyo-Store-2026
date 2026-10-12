"use client";

import { useState } from "react";
import { Check, Loader2, PlusCircle, X } from "lucide-react";

import { useRefreshAction } from "@/hooks/use-refresh-action";
import { createSearchAliasAction } from "@/lib/actions/search-aliases";

/**
 * « Créer alias » on a zero-result query (Statistiques → Recherches sans résultat).
 * The failed term is pre-filled; the operator types the ÉQUIVALENT that DOES have
 * results (« chrono » → « chronographe ») and the rule is created in place. A tiny
 * popover so the stats table layout is untouched. Only rendered when the viewer can
 * manage (the parent gates on canManage); the action re-checks system_search:manage.
 */
export function ZeroResultCreateAlias({ term }: { term: string }) {
  const [open, setOpen] = useState(false);
  const [expansion, setExpansion] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { pending, run } = useRefreshAction();

  const submit = () => {
    if (!expansion.trim()) return;
    run(async () => {
      const fd = new FormData();
      fd.set("term", term);
      fd.set("expansion", expansion);
      const res = await createSearchAliasAction(null, fd);
      if (!res.ok) {
        setMsg({ ok: false, text: res.message });
        return false; // keep the popover open, no refresh
      }
      setMsg({ ok: true, text: "Alias créé" });
      setOpen(false);
      setExpansion("");
    });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setMsg(null);
        }}
        title="Créer un alias pour cette recherche"
        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
          msg?.ok
            ? "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]"
            : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"
        }`}
      >
        {msg?.ok ? <Check className="h-3 w-3" strokeWidth={2.5} /> : <PlusCircle className="h-3 w-3" strokeWidth={2} />}
        Alias
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-1.5 w-64 rounded-2xl border border-border bg-card p-3 shadow-lift">
          <p className="text-[11px] leading-snug text-muted-foreground">
            Quand on cherche «&nbsp;<span className="font-semibold text-foreground">{term}</span>&nbsp;»,
            chercher aussi&nbsp;:
          </p>
          <div className="mt-2 flex items-center gap-1.5">
            <input
              autoFocus
              value={expansion}
              onChange={(e) => setExpansion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
                if (e.key === "Escape") setOpen(false);
              }}
              placeholder="ex. chronographe"
              className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 text-xs focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <button
              type="button"
              onClick={submit}
              disabled={pending || !expansion.trim()}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
              title="Créer"
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground"
              title="Annuler"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {msg && !msg.ok && <p className="mt-1.5 text-[11px] text-destructive">{msg.text}</p>}
          <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
            Gérez tous les alias dans l&apos;onglet <span className="font-medium text-foreground">Alias</span>.
          </p>
        </div>
      )}
    </div>
  );
}

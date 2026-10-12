"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Globe, Lock, ExternalLink, Loader2, ChevronLeft, ChevronRight } from "lucide-react";

import {
  saveFavoritesPublicEnabledAction,
  forceFavoritesPrivateAction,
  liftFavoritesLockAction,
} from "@/lib/actions/wishlist";
import { AdminSearch, AdminNote } from "@/components/admin/_components/filter-bar";

export type PublicProfileRow = {
  id: string;
  slug: string | null;
  displayName: string | null;
  items: number;
  createdAt: string;
  isPublic: boolean;
  locked: boolean;
};

type Pagination = { page: number; pageSize: number; total: number };

/**
 * Admin control for public shareable favorites: the global feature toggle
 * (off by default) + a moderation list of public profiles with a force-private
 * action. Gated by favorites:manage server-side. The list is searched (slug /
 * pseudonym) and paged in SQL via the page's `?q=` / `?page=` params, so every
 * public profile — not just the newest page — can be found and moderated.
 */
export function FavoritesPublicAdmin({
  enabled,
  profiles,
  publicTotal,
  filters,
  pagination,
}: {
  enabled: boolean;
  /** Rows of the CURRENT page (after the search filter). */
  profiles: PublicProfileRow[];
  /** Every public profile, unfiltered — decides whether the list shows at all. */
  publicTotal: number;
  filters: { q: string };
  /** `total` = profiles matching the search. */
  pagination: Pagination;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [on, setOn] = useState(enabled);
  const [pending, start] = useTransition();
  const [navigating, startNav] = useTransition();
  const [search, setSearch] = useState(filters.q);
  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.pageSize));

  // This page's only URL params are the moderation list's own, so the next URL
  // is rebuilt from props. A new search restarts at page 1.
  const navigate = (patch: { q?: string; page?: number }) => {
    const next = new URLSearchParams();
    const q = (patch.q ?? filters.q).trim();
    if (q) next.set("q", q);
    if (patch.page && patch.page > 1) next.set("page", String(patch.page));
    const qs = next.toString();
    startNav(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };
  // Track ok vs error so a FAILED moderation action reads destructive-red instead
  // of the same muted grey as a success (they were indistinguishable before).
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const toggle = () =>
    start(async () => {
      const next = !on;
      const res = await saveFavoritesPublicEnabledAction(next);
      if (res.message) setMsg({ ok: res.ok, text: res.message });
      else setMsg(null);
      if (res.ok) {
        setOn(next);
        router.refresh();
      }
    });

  const forcePrivate = (id: string) =>
    start(async () => {
      const res = await forceFavoritesPrivateAction(id);
      if (res.message) setMsg({ ok: res.ok, text: res.message });
      else setMsg(null);
      if (res.ok) router.refresh();
    });

  const liftLock = (id: string) =>
    start(async () => {
      const res = await liftFavoritesLockAction(id);
      if (res.message) setMsg({ ok: res.ok, text: res.message });
      else setMsg(null);
      if (res.ok) router.refresh();
    });

  return (
    <section className="rounded-[28px] border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="inline-flex items-center gap-2 text-[18px] font-black">
            {on ? <Globe className="h-4 w-4 text-primary" /> : <Lock className="h-4 w-4 text-muted-foreground" />}
            Profils de favoris publics
          </h2>
          <AdminNote className="mt-1 max-w-prose">
            Permet aux clients de rendre leur liste de favoris publique et partageable (page{" "}
            <code className="rounded bg-surface px-1">/u/&lt;identifiant&gt;</code>). Désactivé par défaut.
          </AdminNote>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={toggle}
          className={`inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-4 text-[13px] font-bold transition disabled:opacity-60 ${
            on ? "bg-primary text-primary-foreground hover:bg-[#b8042a]" : "border-[1.5px] border-input bg-card text-foreground hover:bg-surface"
          }`}
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {on ? "Activé" : "Désactivé"}
        </button>
      </div>

      {(publicTotal > 0 || filters.q) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            navigate({ q: search });
          }}
          className="mt-4"
        >
          <AdminSearch
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher un identifiant ou un pseudo… (Entrée)"
            aria-label="Rechercher un profil public"
            className="w-full"
          />
        </form>
      )}

      {profiles.length === 0 && filters.q && (
        <AdminNote className="mt-3">Aucun profil public ne correspond à « {filters.q} ».</AdminNote>
      )}

      {profiles.length > 0 && (
        <div
          className={`mt-4 overflow-x-auto rounded-[22px] border border-border transition-opacity ${
            navigating ? "opacity-60" : ""
          }`}
        >
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
              <tr>
                <th className="px-4 py-3">Identifiant</th>
                <th className="px-4 py-3">Pseudo</th>
                <th className="px-4 py-3 text-right">Favoris</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {profiles.map((p) => (
                <tr key={p.id} className="hover:bg-[#fffbfb]">
                  <td className="px-4 py-3 font-mono text-[13px]">
                    {p.slug ? (
                      <a href={`/u/${p.slug}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                        /u/{p.slug} <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[14px] text-muted-foreground">{p.displayName ?? "—"}</td>
                  <td className="px-4 py-3 text-right text-[14px] tabular-nums">{p.items}</td>
                  <td className="px-4 py-3 text-right">
                    {p.locked ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => liftLock(p.id)}
                        title="Verrouillé par la modération — cliquer pour lever le verrou"
                        className="inline-flex h-8 items-center gap-1 rounded-[12px] border border-[#f3e3bd] bg-[#fff4e0] px-2.5 text-[11px] font-bold text-[#b45309] hover:bg-[#fbeccb] disabled:opacity-60"
                      >
                        <Lock className="h-3 w-3" /> Verrouillé · Débloquer
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => forcePrivate(p.id)}
                        className="inline-flex h-8 items-center gap-1 rounded-[12px] border-[1.5px] border-input bg-card px-2.5 text-[11px] font-bold text-muted-foreground hover:border-destructive/40 hover:text-destructive disabled:opacity-60"
                      >
                        <Lock className="h-3 w-3" /> Rendre privé
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pagination.total > pagination.pageSize && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 px-1">
          <p className="text-[11px] text-muted-foreground">
            {pagination.total} profil{pagination.total > 1 ? "s" : ""} · page {pagination.page} / {totalPages}
          </p>
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              disabled={pagination.page <= 1 || navigating}
              onClick={() => navigate({ page: pagination.page - 1 })}
              className="inline-flex h-8 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3 text-[11px] font-bold text-foreground hover:bg-surface disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Précédent
            </button>
            <button
              type="button"
              disabled={pagination.page >= totalPages || navigating}
              onClick={() => navigate({ page: pagination.page + 1 })}
              className="inline-flex h-8 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3 text-[11px] font-bold text-foreground hover:bg-surface disabled:opacity-40"
            >
              Suivant <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
      {msg && (
        <p
          role={msg.ok ? "status" : "alert"}
          className={`mt-2 text-[11px] font-medium ${msg.ok ? "text-primary" : "text-destructive"}`}
        >
          {msg.text}
        </p>
      )}
    </section>
  );
}

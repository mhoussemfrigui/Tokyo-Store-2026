"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { Loader2, SlidersHorizontal, X, ChevronLeft, ChevronRight, UserCheck } from "lucide-react";

import { searchGuestsAction, guestStatsAction } from "@/lib/actions/guests";
import { SelectField } from "@/components/ui/select-field";
import { DateField, todayYmd } from "@/components/ui/date-field";
import { AdminToolbar, AdminSearch } from "@/components/admin/_components/filter-bar";
import { formatMoney } from "@/lib/price";
import {
  EMPTY_GUEST_FILTER,
  TRI_OPTIONS,
  guestFilterToParams,
  isEmptyGuestFilter,
  type GuestFilter,
  type GuestStats,
  type GuestRow,
} from "@/lib/customers/guest-filter-shared";
import { ExportFieldPicker } from "@/components/admin/export-field-picker";
import { GUEST_EXPORT_FIELDS } from "@/lib/export/guest-fields";

const numCls =
  "h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-2.5 text-[13px] text-foreground focus:outline-none focus-visible:border-foreground focus-visible:bg-white";

const PAGE_SIZE = 30;
const TODAY = todayYmd();

/**
 * The Clients → Invités browser: a filterable statistics header (each card is a
 * quick-filter), a full filter panel (SelectField + DateField controls), the paginated
 * guest list (keyset Prev/Next), and a FILTERED CSV export. Stats + list + export all run
 * off the same server-side GuestFilter, so counts, rows and download always agree. A
 * guest whose email matches a registered account (the retro-link candidate) deep-links to
 * that customer's detail page.
 */
export function GuestsBrowser({
  initialItems,
  initialNextCursor,
  initialStats,
  canExport,
  canViewCustomers,
  canViewOrders,
}: {
  initialItems: GuestRow[];
  initialNextCursor: string | null;
  initialStats: GuestStats;
  canExport: boolean;
  /** Gate the account deep-link (/admin/customers/[id] needs customers:view). */
  canViewCustomers: boolean;
  /** Gate the « Commandes » deep-link (/admin/orders needs orders:view). */
  canViewOrders: boolean;
}) {
  const [filter, setFilter] = useState<GuestFilter>(EMPTY_GUEST_FILTER);
  const [rows, setRows] = useState(initialItems);
  const [stats, setStats] = useState(initialStats);
  const [panelOpen, setPanelOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const cursors = useRef<Array<string | undefined>>([undefined, initialNextCursor ?? undefined]);
  const [page, setPage] = useState(0);
  const [hasNext, setHasNext] = useState(initialNextCursor != null);
  const reqSeq = useRef(0);

  const load = (targetPage: number, f: GuestFilter, withStats: boolean) => {
    const mine = ++reqSeq.current;
    startTransition(async () => {
      const cursor = cursors.current[targetPage];
      const [list, s] = await Promise.all([
        searchGuestsAction({ filter: f, cursor }),
        withStats ? guestStatsAction(f) : Promise.resolve(null),
      ]);
      if (mine !== reqSeq.current) return; // superseded by a newer request
      setRows(list.items);
      cursors.current[targetPage + 1] = list.nextCursor ?? undefined;
      setHasNext(list.nextCursor != null);
      setPage(targetPage);
      if (s) setStats(s);
    });
  };

  const apply = (next: GuestFilter) => {
    setFilter(next);
    cursors.current = [undefined];
    load(0, next, true);
  };
  const patch = (p: Partial<GuestFilter>) => apply({ ...filter, ...p });

  const active = !isEmptyGuestFilter(filter);
  const filterKey = JSON.stringify(filter);

  const chips: Array<{ label: string; value: number; on: boolean; toggle: () => void }> = [
    { label: "Avec email", value: stats.withEmail, on: filter.hasEmail === "yes", toggle: () => patch({ hasEmail: filter.hasEmail === "yes" ? "any" : "yes" }) },
    { label: "Sans email", value: stats.withoutEmail, on: filter.hasEmail === "no", toggle: () => patch({ hasEmail: filter.hasEmail === "no" ? "any" : "no" }) },
    { label: "Avec téléphone", value: stats.withPhone, on: filter.hasPhone === "yes", toggle: () => patch({ hasPhone: filter.hasPhone === "yes" ? "any" : "yes" }) },
    { label: "Compte existant", value: stats.withAccount, on: filter.hasAccount === "yes", toggle: () => patch({ hasAccount: filter.hasAccount === "yes" ? "any" : "yes" }) },
    // "on" for ANY ordersMin ≥ 2 (min=5 is still repeat buyers), so toggling never
    // silently loosens a user-set value; off clears the range entirely.
    { label: "Commandes répétées", value: stats.repeat, on: Number(filter.ordersMin) >= 2, toggle: () => patch({ ordersMin: Number(filter.ordersMin) >= 2 ? "" : "2" }) },
  ];

  const shownFrom = rows.length > 0 ? page * PAGE_SIZE + 1 : 0;
  const shownTo = page * PAGE_SIZE + rows.length;

  return (
    <div className="space-y-4">
      {/* ── Statistics header — reflects the active filter; cards are quick-filters ── */}
      <div className="rounded-[28px] border border-border bg-card p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13px] font-black text-foreground">
            {active ? "Statistiques (filtrées)" : "Statistiques"}
            <span className="ml-2 rounded-full bg-foreground px-2 py-0.5 text-[11px] font-bold text-background tabular-nums">
              {stats.total.toLocaleString("fr-FR")} invité{stats.total === 1 ? "" : "s"}
            </span>
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {stats.totalOrders.toLocaleString("fr-FR")} commande{stats.totalOrders === 1 ? "" : "s"} · {formatMoney(stats.paidRevenueCents)} encaissés
            </span>
            {pending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={c.toggle}
              disabled={pending}
              className={`inline-flex items-baseline gap-1.5 rounded-full border px-3 py-1.5 text-left transition disabled:opacity-60 ${
                c.on ? "border-primary bg-[var(--accent)]" : "border-border bg-surface hover:bg-surface/70"
              }`}
            >
              <span className={`text-[13px] font-bold tabular-nums ${c.on ? "text-primary" : "text-foreground"}`}>
                {c.value.toLocaleString("fr-FR")}
              </span>
              <span className="text-[11px] text-muted-foreground">{c.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Search + controls row ── */}
      <AdminToolbar>
        <AdminSearch
          key={`${filterKey}:q`}
          defaultValue={filter.search}
          onKeyDown={(e) => {
            if (e.key === "Enter") patch({ search: (e.target as HTMLInputElement).value.trim() });
          }}
          placeholder="Rechercher par email, téléphone ou nom…"
          className="min-w-0 max-w-md flex-1"
        />
        <button
          type="button"
          onClick={() => setPanelOpen((v) => !v)}
          className={`inline-flex h-11 items-center gap-1.5 rounded-full border-[1.5px] px-4 text-[13px] font-bold transition ${
            active ? "border-primary bg-[var(--accent)] text-primary" : "border-input bg-card text-foreground hover:bg-surface"
          }`}
        >
          <SlidersHorizontal className="h-4 w-4" /> Filtres{active ? " · actifs" : ""}
        </button>
        {active && (
          <button
            type="button"
            onClick={() => apply(EMPTY_GUEST_FILTER)}
            className="inline-flex h-11 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[13px] font-bold text-muted-foreground hover:bg-surface"
          >
            <X className="h-3.5 w-3.5" /> Réinitialiser
          </button>
        )}
        <div className="ml-auto">
          {canExport && (
            <ExportFieldPicker
              baseUrl="/api/admin/customers/guests/export"
              fields={GUEST_EXPORT_FIELDS}
              extraParams={guestFilterToParams(filter)}
              label="Exporter (filtré)"
            />
          )}
        </div>
      </AdminToolbar>

      {/* ── Filter panel (controls disabled while a page/stats fetch is in flight) ── */}
      {panelOpen && (
        <div className="grid gap-4 rounded-[22px] border border-border bg-card p-5 sm:grid-cols-2 lg:grid-cols-3">
          <Tri label="A un email" value={filter.hasEmail} disabled={pending} onChange={(v) => patch({ hasEmail: v })} />
          <Tri label="A un téléphone" value={filter.hasPhone} disabled={pending} onChange={(v) => patch({ hasPhone: v })} />
          <Tri label="Compte existant" value={filter.hasAccount} disabled={pending} onChange={(v) => patch({ hasAccount: v })} />
          <Field label="Commandes">
            <div className="flex items-center gap-1.5">
              <input key={`${filterKey}:ordersMin`} className={numCls} type="number" min={0} placeholder="min" disabled={pending} defaultValue={filter.ordersMin}
                onBlur={(e) => { if (e.target.value !== filter.ordersMin) patch({ ordersMin: e.target.value }); }} />
              <span className="text-muted-foreground">–</span>
              <input key={`${filterKey}:ordersMax`} className={numCls} type="number" min={0} placeholder="max" disabled={pending} defaultValue={filter.ordersMax}
                onBlur={(e) => { if (e.target.value !== filter.ordersMax) patch({ ordersMax: e.target.value }); }} />
            </div>
          </Field>
          <Field label="Payé (DT)">
            <div className="flex items-center gap-1.5">
              <input key={`${filterKey}:spendMin`} className={numCls} type="number" min={0} placeholder="min" disabled={pending} defaultValue={filter.spendMin}
                onBlur={(e) => { if (e.target.value !== filter.spendMin) patch({ spendMin: e.target.value }); }} />
              <span className="text-muted-foreground">–</span>
              <input key={`${filterKey}:spendMax`} className={numCls} type="number" min={0} placeholder="max" disabled={pending} defaultValue={filter.spendMax}
                onBlur={(e) => { if (e.target.value !== filter.spendMax) patch({ spendMax: e.target.value }); }} />
            </div>
          </Field>
          <Field label="Dernière commande entre">
            <div className="flex items-center gap-1.5">
              <DateField ariaLabel="Dernière commande depuis" max={TODAY} disabled={pending} value={filter.lastFrom} onChange={(v) => patch({ lastFrom: v })} />
              <span className="text-muted-foreground">–</span>
              <DateField ariaLabel="Dernière commande jusqu'à" max={TODAY} disabled={pending} value={filter.lastTo} onChange={(v) => patch({ lastTo: v })} />
            </div>
          </Field>
        </div>
      )}

      {/* ── List ── */}
      {rows.length === 0 ? (
        <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-[14px] text-muted-foreground">
          {active ? "Aucun invité ne correspond à ces filtres." : "Aucune commande invité pour le moment."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[22px] border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
              <tr>
                <th className="px-4 py-3">Client</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Téléphone</th>
                <th className="px-4 py-3">Compte</th>
                <th className="px-4 py-3 text-right">Commandes</th>
                <th className="px-4 py-3 text-right">Payé</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3">Dernière</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((g) => {
                const ordersQ = g.email ?? g.phone ?? "";
                return (
                  <tr key={`${g.emailKey ?? ""}|${g.phone ?? ""}`} className="hover:bg-[#fffbfb]">
                    <td className="px-4 py-3 align-middle text-[14px] font-medium text-foreground">{g.name ?? "—"}</td>
                    <td className="px-4 py-3 align-middle text-[14px] text-muted-foreground">{g.email ?? "—"}</td>
                    <td className="px-4 py-3 align-middle text-[14px] text-muted-foreground">{g.phone ?? "—"}</td>
                    <td className="px-4 py-3 align-middle text-[14px]">
                      {g.accountProfileId && canViewCustomers ? (
                        <Link
                          href={`/admin/customers/${g.accountProfileId}`}
                          className="inline-flex items-center gap-1.5 rounded-full border border-[#cdebd6] bg-[#eaf7ee] px-2.5 py-1 text-[11px] font-bold text-[#15803d] hover:bg-[#d9f0e1]"
                          title={g.accountVerified ? "Compte vérifié" : "Compte non vérifié — commandes pas encore rattachées"}
                        >
                          <UserCheck className="h-3 w-3" /> {g.accountVerified ? "Compte" : "À vérifier"}
                        </Link>
                      ) : g.accountUserId ? (
                        <span
                          className="inline-flex items-center gap-1.5 rounded-full border border-[#cdebd6] bg-[#eaf7ee] px-2.5 py-1 text-[11px] font-bold text-[#15803d]"
                          title={g.accountVerified ? "Compte vérifié" : "Compte non vérifié — commandes pas encore rattachées"}
                        >
                          <UserCheck className="h-3 w-3" /> {g.accountVerified ? "Compte" : "À vérifier"}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 align-middle text-right text-[14px] tabular-nums">{g.orderCount}</td>
                    <td className="px-4 py-3 align-middle text-right text-[14px] tabular-nums">{formatMoney(g.paidSpendCents)}</td>
                    <td className="px-4 py-3 align-middle text-right text-[14px] tabular-nums text-muted-foreground">{formatMoney(g.totalSpendCents)}</td>
                    <td className="px-4 py-3 align-middle text-[14px] text-muted-foreground">
                      {g.lastOrderAt ? new Date(g.lastOrderAt).toLocaleDateString("fr-FR") : "—"}
                    </td>
                    <td className="px-4 py-3 align-middle text-right">
                      {ordersQ && canViewOrders ? (
                        <Link
                          href={`/admin/orders?q=${encodeURIComponent(ordersQ)}`}
                          className="inline-flex h-8 items-center rounded-full border-[1.5px] border-input bg-card px-3 text-[11px] font-bold text-foreground hover:bg-surface"
                        >
                          Commandes
                        </Link>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Pagination (keyset Prev/Next; total is in the header). ── */}
      {(page > 0 || hasNext) && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] text-muted-foreground">
            {shownFrom.toLocaleString("fr-FR")}–{shownTo.toLocaleString("fr-FR")} sur {stats.total.toLocaleString("fr-FR")}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => load(page - 1, filter, false)}
              disabled={pending || page === 0}
              className="inline-flex h-9 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3 text-[12px] font-bold text-foreground hover:bg-surface disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" /> Précédent
            </button>
            <span className="text-[12px] font-semibold tabular-nums text-muted-foreground">Page {page + 1}</span>
            <button
              type="button"
              onClick={() => load(page + 1, filter, false)}
              disabled={pending || !hasNext}
              className="inline-flex h-9 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3 text-[12px] font-bold text-foreground hover:bg-surface disabled:opacity-40"
            >
              Suivant <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-1 block text-[13px] font-bold text-foreground">{label}</span>
      {children}
    </div>
  );
}

function Tri({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: "any" | "yes" | "no";
  onChange: (v: "any" | "yes" | "no") => void;
  disabled?: boolean;
}) {
  return (
    <Field label={label}>
      <SelectField
        ariaLabel={label}
        size="sm"
        disabled={disabled}
        options={TRI_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        value={value}
        onChange={(v) => onChange(v as "any" | "yes" | "no")}
      />
    </Field>
  );
}

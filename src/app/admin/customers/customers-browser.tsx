"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { Loader2, SlidersHorizontal, X, ChevronLeft, ChevronRight } from "lucide-react";

import { searchCustomersAction, customerStatsAction } from "@/lib/actions/customers";
import { ExportFieldPicker } from "@/components/admin/export-field-picker";
import { CUSTOMER_EXPORT_FIELDS } from "@/lib/export/customer-fields";
import { SelectField } from "@/components/ui/select-field";
import { DateField, todayYmd } from "@/components/ui/date-field";
import { AdminToolbar, AdminSearch } from "@/components/admin/_components/filter-bar";
import { CUSTOMER_GENDER_LABELS } from "@/modules/customer/types";
import {
  EMPTY_CUSTOMER_FILTER,
  GENDER_FILTER_OPTIONS,
  TRI_OPTIONS,
  customerFilterToParams,
  isEmptyCustomerFilter,
  type CustomerFilter,
  type CustomerFilterStats,
  type FilteredCustomerRow,
} from "@/lib/customers/filter-shared";

const PAGE_SIZE = 30;
const MONTHS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
const TODAY = todayYmd(); // LOCAL-frame bound — matches the calendar's local default view

/**
 * The Clients → Clients browser: a filterable statistics header (each card is a
 * quick-filter), a full filter panel (design-system SelectField + DateField controls),
 * the paginated list (keyset Prev/Next — pages past any per-query cap; the total match
 * count is always shown in the header), and a FILTERED CSV export. Stats + list +
 * export all run off the same server-side CustomerFilter, so counts, rows and download
 * always agree.
 */
export function CustomersBrowser({
  initialRows,
  initialNextCursor,
  initialStats,
  canExport,
}: {
  initialRows: FilteredCustomerRow[];
  initialNextCursor: string | null;
  initialStats: CustomerFilterStats;
  canExport: boolean;
}) {
  const [filter, setFilter] = useState<CustomerFilter>(EMPTY_CUSTOMER_FILTER);
  const [rows, setRows] = useState(initialRows);
  const [stats, setStats] = useState(initialStats);
  const [panelOpen, setPanelOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // Keyset Prev/Next: cursors[p] is the start cursor for page p (cursors[0] =
  // undefined). Seed page 2's cursor from the server-rendered first page.
  const cursors = useRef<Array<string | undefined>>([undefined, initialNextCursor ?? undefined]);
  const [page, setPage] = useState(0);
  const [hasNext, setHasNext] = useState(initialNextCursor != null);
  // Monotonic request token: React async transitions are NOT auto-serialized, so a
  // slow page fetch can resolve AFTER a newer apply and clobber rows/stats or punch a
  // hole in the cursor stack. Every load stamps itself; only the latest applies.
  const reqSeq = useRef(0);

  /** Fetch one page; refresh stats only on a filter change (page 0 of a new filter). */
  const load = (targetPage: number, f: CustomerFilter, withStats: boolean) => {
    const mine = ++reqSeq.current;
    startTransition(async () => {
      const cursor = cursors.current[targetPage];
      const [list, s] = await Promise.all([
        searchCustomersAction({ filter: f, cursor }),
        withStats ? customerStatsAction(f) : Promise.resolve(null),
      ]);
      if (mine !== reqSeq.current) return; // a newer request superseded this one
      setRows(list.rows);
      cursors.current[targetPage + 1] = list.nextCursor ?? undefined;
      setHasNext(list.nextCursor != null);
      setPage(targetPage);
      if (s) setStats(s);
    });
  };

  /** Apply a filter: reset to page 1 + refresh the stat header. */
  const apply = (next: CustomerFilter) => {
    setFilter(next);
    cursors.current = [undefined];
    load(0, next, true);
  };
  const patch = (p: Partial<CustomerFilter>) => apply({ ...filter, ...p });

  const active = !isEmptyCustomerFilter(filter);
  // Remount key for the UNCONTROLLED search input: it only reads defaultValue at mount,
  // so without this a Réinitialiser / chip apply would leave stale text on screen (and a
  // later blur would silently re-apply it). Changing the key on every applied filter
  // forces it to re-init from the new filter.
  const filterKey = JSON.stringify(filter);

  const chips: Array<{ label: string; value: number; on: boolean; toggle: () => void }> = [
    { label: "Genre renseigné", value: stats.genderKnown, on: filter.gender === "known", toggle: () => patch({ gender: filter.gender === "known" ? "any" : "known" }) },
    { label: "Sans genre", value: stats.genderUnset, on: filter.gender === "unset", toggle: () => patch({ gender: filter.gender === "unset" ? "any" : "unset" }) },
    { label: "Avec panier", value: stats.withCart, on: filter.hasCart === "yes", toggle: () => patch({ hasCart: filter.hasCart === "yes" ? "any" : "yes" }) },
    { label: "Coupon utilisé", value: stats.usedCoupon, on: filter.usedCoupon === "yes", toggle: () => patch({ usedCoupon: filter.usedCoupon === "yes" ? "any" : "yes" }) },
    { label: "Abonnés marketing", value: stats.marketing, on: filter.marketing === "yes", toggle: () => patch({ marketing: filter.marketing === "yes" ? "any" : "yes" }) },
  ];

  const monthOptions = [{ value: "", label: "Tous" }, ...MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))];

  const shownFrom = rows.length > 0 ? page * PAGE_SIZE + 1 : 0;
  const shownTo = page * PAGE_SIZE + rows.length;

  return (
    <div className="space-y-4">
      {/* ── Statistics header — reflects the active filter; each card is a quick-filter ── */}
      <div className="rounded-[28px] border border-border bg-card p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-[13px] font-black text-foreground">
            {active ? "Statistiques (filtrées)" : "Statistiques"}
            <span className="ml-2 rounded-full bg-foreground px-2 py-0.5 text-[11px] font-bold text-background tabular-nums">
              {stats.total.toLocaleString("fr-FR")} client{stats.total === 1 ? "" : "s"}
            </span>
          </h2>
          {pending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
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
          placeholder="Rechercher par nom, email ou téléphone…"
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
            onClick={() => apply(EMPTY_CUSTOMER_FILTER)}
            className="inline-flex h-11 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[13px] font-bold text-muted-foreground hover:bg-surface"
          >
            <X className="h-3.5 w-3.5" /> Réinitialiser
          </button>
        )}
        <div className="ml-auto">
          {canExport && (
            <ExportFieldPicker
              baseUrl="/api/admin/customers/export"
              fields={CUSTOMER_EXPORT_FIELDS}
              extraParams={customerFilterToParams(filter)}
              label="Exporter (filtré)"
            />
          )}
        </div>
      </AdminToolbar>

      {/* ── Filter panel (controls disabled while a page/stats fetch is in flight) ── */}
      {panelOpen && (
        <div className="grid gap-4 rounded-[22px] border border-border bg-card p-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Genre">
            <SelectField ariaLabel="Genre" size="sm" disabled={pending} options={GENDER_FILTER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} value={filter.gender} onChange={(v) => patch({ gender: v as CustomerFilter["gender"] })} />
          </Field>
          <Tri label="A utilisé un coupon" value={filter.usedCoupon} disabled={pending} onChange={(v) => patch({ usedCoupon: v })} />
          <Tri label="A un panier" value={filter.hasCart} disabled={pending} onChange={(v) => patch({ hasCart: v })} />
          <Tri label="Abonné marketing" value={filter.marketing} disabled={pending} onChange={(v) => patch({ marketing: v })} />
          <Field label="Anniversaire (mois)">
            <SelectField ariaLabel="Mois d'anniversaire" size="sm" disabled={pending} options={monthOptions} value={filter.birthdayMonth} onChange={(v) => patch({ birthdayMonth: v })} />
          </Field>
          <Field label="Inscrit entre">
            <div className="flex items-center gap-1.5">
              <DateField ariaLabel="Inscrit depuis" max={TODAY} disabled={pending} value={filter.createdFrom} onChange={(v) => patch({ createdFrom: v })} />
              <span className="text-muted-foreground">–</span>
              <DateField ariaLabel="Inscrit jusqu'à" max={TODAY} disabled={pending} value={filter.createdTo} onChange={(v) => patch({ createdTo: v })} />
            </div>
          </Field>
        </div>
      )}

      {/* ── List ── */}
      {rows.length === 0 ? (
        <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-[14px] text-muted-foreground">
          Aucun client ne correspond à ces filtres.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[22px] border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
              <tr>
                <th className="px-4 py-3">Nom</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Téléphone</th>
                <th className="px-4 py-3">Genre</th>
                <th className="px-4 py-3">Inscrit le</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.profileId} className="hover:bg-[#fffbfb]">
                  <td className="px-4 py-3 align-middle text-[14px] font-medium text-foreground">{r.firstName} {r.lastName}</td>
                  <td className="px-4 py-3 align-middle text-[14px] text-muted-foreground">{r.email ?? "—"}</td>
                  <td className="px-4 py-3 align-middle text-[14px] text-muted-foreground">{r.phone ?? "—"}</td>
                  <td className="px-4 py-3 align-middle text-[14px] text-muted-foreground">
                    {r.gender ? (CUSTOMER_GENDER_LABELS[r.gender as keyof typeof CUSTOMER_GENDER_LABELS] ?? r.gender) : "—"}
                  </td>
                  <td className="px-4 py-3 align-middle text-[14px] text-muted-foreground">
                    {new Date(r.createdAt).toLocaleDateString("fr-FR")}
                  </td>
                  <td className="px-4 py-3 align-middle text-right">
                    <Link
                      href={`/admin/customers/${r.profileId}`}
                      className="inline-flex h-8 items-center rounded-full border-[1.5px] border-input bg-card px-3 text-[11px] font-bold text-foreground hover:bg-surface"
                    >
                      Voir
                    </Link>
                  </td>
                </tr>
              ))}
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

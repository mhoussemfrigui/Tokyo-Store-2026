"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Ban,
  Check,
  ChevronDown,
  Loader2,
  PackageCheck,
  Plus,
  Printer,
  Search,
  Truck,
  X,
} from "lucide-react";

import {
  createTransferAction,
  getTransferItemsAction,
  getTransferProductVariantsAction,
  listTransfersAction,
  transitionTransferAction,
} from "@/lib/actions/stock-transfers";
import { searchProductsForPickerAction } from "@/lib/actions/related-products";
import type { TransferStatus } from "@/modules/stock-transfer/schema";
import { TRANSFER_STATUS_META } from "@/modules/stock-transfer/status-meta";
import { SelectField } from "@/components/ui/select-field";
import { AdminCallout, AdminNote, SegmentedFilter } from "@/components/admin/_components/filter-bar";
import { StockReadOnlyBanner } from "./stock-read-only-banner";

type StatusCounts = Record<TransferStatus, number>;

/** Confirm copy for the two DEFINITIVE (terminal) transitions. */
const CONFIRM_COPY: Partial<Record<TransferStatus, string>> = {
  completed: "Réceptionner ce transfert ? Le stock sera déplacé (source → destination). Action définitive.",
  cancelled: "Annuler ce transfert ? Cette action est définitive.",
};

type LocationOpt = { id: string; name: string };

export type TransferRow = {
  id: string;
  ref: number;
  status: TransferStatus;
  fromName: string | null;
  toName: string | null;
  itemCount: number;
  totalQty: number;
  createdAt: string;
  orderId: string | null;
  note: string | null;
};

/** Forward actions offered per status (the service enforces the graph too). */
const NEXT_ACTIONS: Record<
  TransferStatus,
  Array<{ to: TransferStatus; label: string; icon: typeof Check; primary?: boolean }>
> = {
  requested: [
    { to: "accepted", label: "Accepter", icon: Check, primary: true },
    { to: "cancelled", label: "Annuler", icon: Ban },
  ],
  accepted: [
    { to: "in_transit", label: "Expédier", icon: Truck, primary: true },
    { to: "cancelled", label: "Annuler", icon: Ban },
  ],
  in_transit: [
    { to: "completed", label: "Réceptionner", icon: PackageCheck, primary: true },
    { to: "cancelled", label: "Annuler", icon: Ban },
  ],
  completed: [],
  cancelled: [],
};

const STATUS_FILTERS: Array<{ id: TransferStatus | "all"; label: string }> = [
  { id: "all", label: "Tous" },
  { id: "requested", label: "Demandés" },
  { id: "accepted", label: "Acceptés" },
  { id: "in_transit", label: "En transfert" },
  { id: "completed", label: "Transférés" },
  { id: "cancelled", label: "Annulés" },
];

/**
 * Print a transfer's Bon de transfert DIRECTLY — no navigation. Loads the bare
 * print route into a hidden iframe and prints IT, so the operator stays on the
 * Transferts tab and the browser print dialog opens in place. Cleans the iframe
 * up on afterprint (with a fallback timeout).
 */
function printTransferSlip(id: string) {
  const existing = document.getElementById("tk-transfer-print-frame");
  if (existing) existing.remove();
  const iframe = document.createElement("iframe");
  iframe.id = "tk-transfer-print-frame";
  iframe.setAttribute("aria-hidden", "true");
  Object.assign(iframe.style, {
    position: "fixed",
    right: "0",
    bottom: "0",
    width: "0",
    height: "0",
    border: "0",
    visibility: "hidden",
  });
  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) return;
    const cleanup = () => setTimeout(() => iframe.remove(), 500);
    win.onafterprint = cleanup;
    // Defer a tick so fonts/layout settle inside the frame before printing.
    setTimeout(() => {
      try {
        win.focus();
        win.print();
      } catch {
        cleanup();
      }
    }, 200);
    // Fallback: some browsers never fire afterprint.
    setTimeout(() => iframe.remove(), 60_000);
  };
  iframe.src = `/admin/catalog/stock/transfers/${id}/print`;
  document.body.appendChild(iframe);
}

function StatusPill({ status }: { status: TransferStatus }) {
  const m = TRANSFER_STATUS_META[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${m.cls}`}>
      {m.label}
    </span>
  );
}

export function TransfersPanel({
  canManage,
  enabled,
  locations,
  transfers,
  total,
  pageSize,
  counts,
}: {
  canManage: boolean;
  enabled: boolean;
  locations: LocationOpt[];
  transfers: TransferRow[];
  total: number;
  pageSize: number;
  counts: StatusCounts;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<TransferStatus | "all">("all");
  const [rows, setRows] = useState<TransferRow[]>(transfers);
  const [filterTotal, setFilterTotal] = useState(total); // total for the ACTIVE filter
  const [statusCounts, setStatusCounts] = useState<StatusCounts>(counts);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [showCreate, setShowCreate] = useState(false);

  if (!enabled) {
    return (
      <div className="rounded-[22px] border border-dashed border-border bg-[#fbf9f8] p-8 text-center">
        <p className="text-[14px] text-muted-foreground">
          Les transferts entre emplacements sont désactivés. Activez-les dans l&apos;onglet{" "}
          <span className="font-medium text-foreground">Réglages</span> (Transferts entre emplacements).
        </p>
      </div>
    );
  }

  const allCount = STATUS_FILTERS.reduce((s, f) => (f.id === "all" ? s : s + (statusCounts[f.id] ?? 0)), 0);
  const pageCount = Math.max(1, Math.ceil(filterTotal / pageSize));

  // Load a page of the given filter from the server (filter + paging are DB-side,
  // so counts and navigation stay correct beyond the first window).
  const load = (nextFilter: TransferStatus | "all", nextPage: number) => {
    setError(null);
    startTransition(async () => {
      // listTransfersAction only ever resolves ok:true; a DB error during
      // filter/pagination REJECTS (throws), so a try/catch — not a never-false
      // `!res.ok` branch — is what surfaces the inline error instead of letting
      // the rejection fall through (stale list / admin error boundary).
      try {
        const res = await listTransfersAction({ status: nextFilter, page: nextPage });
        // If a mutation emptied the last page, step back one.
        if (res.rows.length === 0 && res.page > 1) {
          const back = await listTransfersAction({ status: nextFilter, page: res.page - 1 });
          setRows(back.rows);
          setFilterTotal(back.total);
          setStatusCounts(back.counts);
          setFilter(nextFilter);
          setPage(back.page);
          return;
        }
        setRows(res.rows);
        setFilterTotal(res.total);
        setStatusCounts(res.counts);
        setFilter(nextFilter);
        setPage(res.page);
      } catch {
        setError("Chargement des transferts impossible.");
      }
    });
  };

  const runTransition = (id: string, to: TransferStatus) => {
    if (!canManage) return;
    const confirmMsg = CONFIRM_COPY[to];
    if (confirmMsg && typeof window !== "undefined" && !window.confirm(confirmMsg)) return;
    setError(null);
    startTransition(async () => {
      const res = await transitionTransferAction(id, to);
      if (!res.ok) {
        setError(res.message ?? "Échec.");
        return;
      }
      // Refresh the visible page (the row may have left the current filter) + the
      // parent server render (tab badge / other tabs). The transition already
      // committed server-side; the reload only ever resolves ok:true, so a DB
      // error here REJECTS — guard it so the failure shows the inline error
      // instead of silently leaving the list stale, and still refresh the parent.
      try {
        const reload = await listTransfersAction({ status: filter, page });
        const target = reload.rows.length === 0 && reload.page > 1 ? reload.page - 1 : reload.page;
        if (target !== reload.page) {
          load(filter, target);
        } else {
          setRows(reload.rows);
          setFilterTotal(reload.total);
          setStatusCounts(reload.counts);
          setPage(reload.page);
        }
      } catch {
        setError("Chargement des transferts impossible.");
      }
      router.refresh();
    });
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <AdminNote className="max-w-xl">
          Déplacez du stock entre vos emplacements. Un transfert est suivi (demandé → accepté → en
          transfert → transféré) ; le stock ne bouge qu&apos;à la réception. {allCount} transfert
          {allCount > 1 ? "s" : ""}.
        </AdminNote>
        {canManage && (
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
          >
            {showCreate ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {showCreate ? "Fermer" : "Nouveau transfert"}
          </button>
        )}
      </header>

      {!canManage && (
        <StockReadOnlyBanner suffix=" pour créer ou faire avancer un transfert." />
      )}

      {error && <AdminCallout tone="danger">{error}</AdminCallout>}

      {showCreate && canManage && (
        <CreateTransferForm
          locations={locations}
          onDone={() => {
            setShowCreate(false);
            load(filter, 1);
            router.refresh();
          }}
          onError={setError}
        />
      )}

      {/* Status filter (counts are all-data, from the server) */}
      <SegmentedFilter
        ariaLabel="Filtrer les transferts par statut"
        className={pending ? "pointer-events-none opacity-60" : undefined}
        value={filter}
        onChange={(f) => load(f, 1)}
        options={STATUS_FILTERS.map((f) => ({
          value: f.id,
          label: f.label,
          count: f.id === "all" ? allCount : (statusCounts[f.id] ?? 0),
        }))}
      />

      <div className="overflow-hidden rounded-[22px] border border-border bg-card">
        {rows.length === 0 ? (
          <p className="p-12 text-center text-[14px] text-muted-foreground">Aucun transfert.</p>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((t) => (
              <TransferRowView key={t.id} t={t} canManage={canManage} pending={pending} onTransition={runTransition} />
            ))}
          </div>
        )}
      </div>

      {/* Pagination — only when the active filter overflows one page */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="tabular-nums">
            Page {page} / {pageCount} · {filterTotal} transfert{filterTotal > 1 ? "s" : ""}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pending || page <= 1}
              onClick={() => load(filter, page - 1)}
              className="inline-flex h-8 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3 font-bold text-foreground transition hover:bg-surface disabled:opacity-40"
            >
              Précédent
            </button>
            <button
              type="button"
              disabled={pending || page >= pageCount}
              onClick={() => load(filter, page + 1)}
              className="inline-flex h-8 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-3 font-bold text-foreground transition hover:bg-surface disabled:opacity-40"
            >
              Suivant
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TransferRowView({
  t,
  canManage,
  pending,
  onTransition,
}: {
  t: TransferRow;
  canManage: boolean;
  pending: boolean;
  onTransition: (id: string, to: TransferStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<
    Array<{ id: string; qty: number; productName: string; variantLabel: string | null }> | null
  >(null);
  const [loadingItems, setLoadingItems] = useState(false);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && items === null && !loadingItems) {
      setLoadingItems(true);
      getTransferItemsAction(t.id)
        .then((res) => setItems(res.ok ? res.items : []))
        .finally(() => setLoadingItems(false));
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
        <button type="button" onClick={toggle} className="grid h-6 w-6 place-items-center rounded-[8px] text-muted-foreground hover:bg-secondary" aria-label="Détails">
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        <span className="font-mono text-xs font-semibold text-foreground">TR-{t.ref}</span>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <span className="truncate font-bold text-foreground">{t.fromName ?? "—"}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-bold text-foreground">{t.toName ?? "—"}</span>
        </div>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {t.itemCount} article{t.itemCount > 1 ? "s" : ""} · {t.totalQty} u.
        </span>
        {t.orderId && (
          <span className="hidden items-center rounded-full bg-[#f6f2ed] px-2.5 py-1 text-[11px] font-bold text-[#5b5d62] md:inline-flex">
            Commande liée
          </span>
        )}
        <StatusPill status={t.status} />
        <button
          type="button"
          onClick={() => printTransferSlip(t.id)}
          title="Imprimer le bon de transfert"
          aria-label="Imprimer le bon de transfert"
          className="grid h-8 w-8 place-items-center rounded-[11px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <Printer className="h-3.5 w-3.5" />
        </button>
        {canManage && (
          <div className="flex items-center gap-1.5">
            {NEXT_ACTIONS[t.status].map((a) => (
              <button
                key={a.to}
                type="button"
                disabled={pending}
                onClick={() => onTransition(t.id, a.to)}
                className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-bold transition disabled:opacity-50 ${
                  a.primary
                    ? "bg-primary text-primary-foreground hover:bg-[#b8042a]"
                    : "border-[1.5px] border-input bg-card text-foreground hover:bg-surface"
                }`}
              >
                <a.icon className="h-3.5 w-3.5" />
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {open && (
        <div className="border-t border-border bg-[#fbf9f8] px-12 py-3">
          {loadingItems ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Chargement…
            </p>
          ) : items && items.length > 0 ? (
            <ul className="space-y-1.5">
              {items.map((it) => (
                <li key={it.id} className="flex items-center justify-between text-sm">
                  <span className="text-foreground">
                    {it.productName}
                    {it.variantLabel ? <span className="text-muted-foreground"> · {it.variantLabel}</span> : null}
                  </span>
                  <span className="font-medium tabular-nums text-foreground">×{it.qty}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Aucune ligne.</p>
          )}
          {t.note && <p className="mt-2 text-xs text-muted-foreground">Note : {t.note}</p>}
        </div>
      )}
    </div>
  );
}

type DraftLine = {
  productId: string;
  variantId: string | null;
  name: string;
  variantLabel: string | null;
  qty: number;
};
/** A line's stable key — a product can appear once per variant (or once as pool). */
const lineKey = (productId: string, variantId: string | null) => `${productId}:${variantId ?? ""}`;

function CreateTransferForm({
  locations,
  onDone,
  onError,
}: {
  locations: LocationOpt[];
  onDone: () => void;
  onError: (msg: string | null) => void;
}) {
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  // Product search
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{ id: string; name: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [resolving, setResolving] = useState(false);
  // When a picked product tracks stock per variant, the operator must choose
  // WHICH variant — a pool-level transfer of it can never complete.
  const [variantPicker, setVariantPicker] = useState<
    { productId: string; name: string; variants: Array<{ id: string; label: string }> } | null
  >(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const query = q.trim();
    // Debounce; all setState happens inside the async callback (not synchronously
    // in the effect body) so there's no cascading-render on every keystroke.
    timer.current = setTimeout(() => {
      if (query.length < 2) {
        setResults([]);
        return;
      }
      setSearching(true);
      searchProductsForPickerAction(query)
        .then((hits) => setResults(hits.map((h) => ({ id: h.id, name: h.name }))))
        .finally(() => setSearching(false));
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q]);

  const pushLine = (line: DraftLine) => {
    setLines((prev) =>
      prev.some((l) => lineKey(l.productId, l.variantId) === lineKey(line.productId, line.variantId))
        ? prev
        : [...prev, line],
    );
    setQ("");
    setResults([]);
  };

  // Picking a search result: resolve whether the product needs a variant. A
  // simple / shared-variable product adds a pool line directly; a per-variant
  // product opens the variant chooser instead (so no un-completable line).
  const pickProduct = (p: { id: string; name: string }) => {
    onError(null);
    setResolving(true);
    getTransferProductVariantsAction(p.id)
      .then((res) => {
        if (!res.ok) {
          onError(res.message);
          return;
        }
        if (res.perVariant) {
          setVariantPicker({ productId: p.id, name: p.name, variants: res.variants });
          setResults([]);
        } else {
          pushLine({ productId: p.id, variantId: null, name: p.name, variantLabel: null, qty: 1 });
        }
      })
      .catch(() => onError("Impossible de charger les variantes du produit."))
      .finally(() => setResolving(false));
  };

  const addVariantLine = (v: { id: string; label: string }) => {
    if (!variantPicker) return;
    pushLine({
      productId: variantPicker.productId,
      variantId: v.id,
      name: variantPicker.name,
      variantLabel: v.label,
      qty: 1,
    });
    setVariantPicker(null);
    setQ("");
  };

  const setQty = (key: string, qty: number) =>
    setLines((prev) =>
      prev.map((l) => (lineKey(l.productId, l.variantId) === key ? { ...l, qty: Math.max(1, Math.floor(qty) || 1) } : l)),
    );
  const removeLine = (key: string) =>
    setLines((prev) => prev.filter((l) => lineKey(l.productId, l.variantId) !== key));

  const canSubmit = fromId !== "" && toId !== "" && fromId !== toId && lines.length > 0 && !pending;

  const submit = () => {
    if (!canSubmit) return;
    onError(null);
    startTransition(async () => {
      const res = await createTransferAction({
        fromLocationId: fromId,
        toLocationId: toId,
        items: lines.map((l) => ({ productId: l.productId, variantId: l.variantId, qty: l.qty })),
        note: note.trim() || null,
      });
      if (!res.ok) {
        onError(res.message ?? "Échec de la création.");
        return;
      }
      onDone();
    });
  };

  if (locations.length < 2) {
    return (
      <div className="rounded-[16px] border border-dashed border-border bg-[#fbf9f8] p-4 text-center text-[13px] text-muted-foreground">
        Il faut au moins deux emplacements actifs pour créer un transfert (onglet Emplacements).
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-[28px] border border-border bg-card p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Depuis"
          value={fromId}
          onChange={setFromId}
          placeholder="— Choisir —"
          size="sm"
          options={locations.map((l) => ({ value: l.id, label: l.name, disabled: l.id === toId }))}
        />
        <SelectField
          label="Vers"
          value={toId}
          onChange={setToId}
          placeholder="— Choisir —"
          size="sm"
          options={locations.map((l) => ({ value: l.id, label: l.name, disabled: l.id === fromId }))}
        />
      </div>

      {/* Product search */}
      <div className="relative">
        <div className="flex items-center gap-2 rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 focus-within:border-foreground focus-within:bg-white">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher un produit à transférer…"
            aria-label="Rechercher un produit à transférer"
            className="h-10 w-full bg-transparent text-[15px] focus:outline-none"
          />
          {(searching || resolving) && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        {results.length > 0 && (
          <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-[14px] border border-border bg-card shadow-lift">
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => pickProduct(r)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[14px] hover:bg-surface"
              >
                <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                {r.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Variant chooser — a per-variant product needs the exact variant picked. */}
      {variantPicker && (
        <div className="rounded-[14px] border-[1.5px] border-primary/40 bg-[var(--accent)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[14px] font-bold text-foreground">
              Choisir une variante — <span className="text-muted-foreground">{variantPicker.name}</span>
            </span>
            <button
              type="button"
              onClick={() => setVariantPicker(null)}
              aria-label="Annuler le choix de variante"
              className="grid h-7 w-7 place-items-center rounded-[10px] text-muted-foreground hover:bg-secondary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {variantPicker.variants.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => addVariantLine(v)}
                className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 py-1.5 text-xs font-bold hover:border-primary hover:bg-surface"
              >
                <Plus className="h-3 w-3 text-muted-foreground" />
                {v.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Lines */}
      {lines.length > 0 && (
        <ul className="space-y-2">
          {lines.map((l) => {
            const key = lineKey(l.productId, l.variantId);
            const label = l.variantLabel ? `${l.name} · ${l.variantLabel}` : l.name;
            return (
              <li key={key} className="flex items-center gap-3 rounded-[14px] border border-border bg-[#fbf9f8] px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {l.name}
                  {l.variantLabel ? <span className="text-muted-foreground"> · {l.variantLabel}</span> : null}
                </span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={l.qty}
                  onChange={(e) => setQty(key, Number(e.target.value))}
                  aria-label={`Quantité à transférer — ${label}`}
                  className="h-9 w-20 rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-2 text-right text-[14px] tabular-nums focus:border-foreground focus:bg-white focus:outline-none"
                />
                <button type="button" onClick={() => removeLine(key)} aria-label="Retirer" className="grid h-8 w-8 place-items-center rounded-[11px] bg-surface text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Note (facultatif)"
        aria-label="Note du transfert (facultatif)"
        className="w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] p-3 text-[14px] focus:border-foreground focus:bg-white focus:outline-none"
      />

      <div className="flex justify-end">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Créer le transfert
        </button>
      </div>
    </div>
  );
}

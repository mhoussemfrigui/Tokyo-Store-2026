"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Globe,
  Layers,
  Loader2,
  MapPin,
  Plug,
  Save,
  Search,
  X,
} from "lucide-react";

import { AdminCallout, AdminNote, SegmentedFilter } from "@/components/admin/_components/filter-bar";
import { StockReadOnlyBanner } from "./stock-read-only-banner";
import { bulkUpdateStockAction } from "@/lib/actions/catalog";
import { setLocationLevelsAction } from "@/lib/actions/stock-locations";
import { nextInStockForQty } from "@/lib/inventory/in-stock-rule";
import { isEffectivelyOutOfStock, isLowStock } from "@/lib/inventory/stock-state";
import { formatMoneyWithCurrency } from "@/lib/price";

type VariantRow = {
  id: string;
  label: string;
  sku: string | null;
  stockQty: number | null;
  inStock: boolean;
};

type Row = {
  id: string;
  slug: string;
  name: string;
  sku: string | null;
  /** Référence externe (ERP) — read-only ERP/PIM link, shown for reconciliation. */
  externalRef: string | null;
  priceCents: number;
  currency: string;
  inStock: boolean;
  stockQty: number | null;
  isPublished: boolean;
  productType: "simple" | "variable";
  /** Variable product in SHARED variant-stock mode → edits the single pool. */
  variantShared: boolean;
  /** Variants to edit per-variant (only populated for variable + NOT shared). */
  variants: VariantRow[];
};

type LocationCol = { id: string; name: string; code: string | null; isDefault: boolean };

type StockPanelProps = {
  /** `stock:update` — without it the table renders read-only (inputs disabled,
   *  no Enregistrer, variant-mode switch locked) instead of letting a viewer
   *  edit and then hit the action's permission wall. */
  canManage: boolean;
  /** Operator's configured low-stock line (`stock.low_threshold_qty`, via
   *  resolveLowStockConfig) — drives the « Bas » chip label + badges, and is the
   *  SAME value the server's `?filter=low` uses. ≤ 0 disables the tier. */
  lowThreshold: number;
  rows: Row[];
  currentQuery: string;
  currentFilter: string;
  total: number;
  page: number;
  pageSize: number;
  /** Multi-location mode (inventory.location_mode = per_location). */
  multiLocation: boolean;
  /** ERP is authoritative for stock (erp pull mode) — warn that edits here may be
   *  overwritten on the next sync. */
  erpAuthoritative: boolean;
  locations: LocationCol[];
  /** Server per-location levels, keyed `productId` or `productId:variantId`. */
  levels: Record<string, Record<string, number>>;
  /** INCOMING (in-transit) units per destination location, keyed
   *  `${productId}:${variantId ?? ""}:${locationId}` — shown as a « + N en transit »
   *  hint under the on-hand cell (not added to the level; completion relocates it). */
  incoming?: Record<string, number>;
};

/** A variable product whose stock is edited PER VARIANT (collapsible rows). */
const isExpandable = (r: Row) =>
  r.productType === "variable" && !r.variantShared && r.variants.length > 0;

/** Draft map key: the product id, or `productId::variantId` for a variant. */
const tkey = (productId: string, variantId?: string | null) =>
  variantId ? `${productId}::${variantId}` : productId;

/** Reverse of {@link tkey} — lets onSaveAll rebuild the target from a draft key
 *  ALONE, so drafts made on other pages/filters (not in the current `rows`) are
 *  still saved instead of being silently dropped. */
const parseKey = (key: string): { productId: string; variantId: string | null } => {
  const i = key.indexOf("::");
  return i === -1
    ? { productId: key, variantId: null }
    : { productId: key.slice(0, i), variantId: key.slice(i + 2) };
};

/** Reverse of the multi-location `dkey` (`${productId}|${variantId ?? ""}|${locationId}`). */
const parseDkey = (key: string): readonly [string, string | null, string] => {
  const [productId, variantId, locationId] = key.split("|");
  return [productId, variantId || null, locationId] as const;
};

type FilterId = "all" | "in_stock" | "out_of_stock" | "low" | "none";

const FILTERS: { id: FilterId; label: string }[] = [
  { id: "all", label: "Tous" },
  { id: "in_stock", label: "En stock" },
  { id: "low", label: "Bas" }, // label carries the configured threshold (Toolbar)
  { id: "out_of_stock", label: "Rupture" },
  { id: "none", label: "Non suivi" },
];

/** Shared URL navigation for search / filter / pagination. */
function useStockNav(currentQuery: string, currentFilter: string) {
  const router = useRouter();
  const buildUrl = (params: URLSearchParams) =>
    `/admin/catalog/stock${params.size ? `?${params}` : ""}`;
  const goToPage = (p: number) => {
    const params = new URLSearchParams();
    if (currentQuery) params.set("q", currentQuery);
    if (currentFilter !== "all") params.set("filter", currentFilter);
    if (p > 1) params.set("page", String(p));
    router.push(buildUrl(params));
  };
  const goFilter = (next: FilterId) => {
    const params = new URLSearchParams();
    if (currentQuery) params.set("q", currentQuery);
    if (next !== "all") params.set("filter", next);
    router.push(buildUrl(params));
  };
  const pushSearch = (term: string) => {
    const params = new URLSearchParams();
    if (term.trim()) params.set("q", term.trim());
    if (currentFilter !== "all") params.set("filter", currentFilter);
    router.push(buildUrl(params));
  };
  return { goToPage, goFilter, pushSearch };
}

/**
 * Global inventory editor. Single switch by inventory mode:
 *   - SINGLE POOL (default): the classic in_stock + qty table.
 *   - MULTI-LOCATION (inventory.location_mode = per_location): a quantity cell
 *     per active location, with the product column frozen so it scales to many
 *     locations on any screen.
 */
export function StockPanel(props: StockPanelProps) {
  const panel =
    props.multiLocation && props.locations.length > 0 ? (
      <MultiLocationPanel {...props} />
    ) : (
      <SinglePoolPanel {...props} />
    );
  return (
    <div className="space-y-4">
      {props.erpAuthoritative && (
        <AdminCallout tone="warning" icon={Plug}>
          Le stock est piloté par l&apos;ERP. Les modifications faites ici pourront être
          écrasées lors de la prochaine synchronisation (voir l&apos;onglet ERP).
        </AdminCallout>
      )}
      {panel}
    </div>
  );
}

// ════════════════════════════ Shared chrome ════════════════════════════════

function Toolbar({
  searchInput,
  setSearchInput,
  currentFilter,
  lowThreshold,
  onSubmit,
  onClear,
  goFilter,
}: {
  searchInput: string;
  setSearchInput: (v: string) => void;
  currentFilter: string;
  lowThreshold: number;
  onSubmit: (e: React.FormEvent) => void;
  onClear: () => void;
  goFilter: (f: FilterId) => void;
}) {
  // A disabled low tier (threshold ≤ 0) matches nothing — hide its chip unless
  // it's the active filter (so an old `?filter=low` link still shows why).
  const filters = FILTERS.filter(
    (f) => f.id !== "low" || lowThreshold > 0 || currentFilter === "low",
  );
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[22px] border border-border bg-card p-3">
      <form
        onSubmit={onSubmit}
        className="flex h-11 flex-1 items-center gap-2 rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 focus-within:border-foreground focus-within:bg-white"
      >
        <Search className="h-4 w-4 text-muted-foreground" strokeWidth={2} />
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Nom du produit…"
          className="h-full flex-1 bg-transparent text-[15px] focus:outline-none"
        />
        {searchInput && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Effacer"
            className="grid h-7 w-7 place-items-center rounded-[10px] text-muted-foreground hover:bg-secondary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </form>

      <SegmentedFilter
        ariaLabel="Filtrer le stock"
        value={currentFilter as FilterId}
        onChange={(f) => goFilter(f)}
        options={filters.map((f) => ({
          value: f.id,
          label:
            f.id === "low"
              ? lowThreshold > 0
                ? `Bas (≤ ${lowThreshold})`
                : "Bas (désactivé)"
              : f.label,
        }))}
      />
    </div>
  );
}

function Pager({
  page,
  totalPages,
  goToPage,
}: {
  page: number;
  totalPages: number;
  goToPage: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-3">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => goToPage(page - 1)}
        className="inline-flex h-9 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-xs font-bold text-foreground transition hover:bg-surface disabled:opacity-40"
      >
        Précédent
      </button>
      <span className="text-xs tabular-nums text-muted-foreground">
        Page {page} / {totalPages}
      </span>
      <button
        type="button"
        disabled={page >= totalPages}
        onClick={() => goToPage(page + 1)}
        className="inline-flex h-9 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-xs font-bold text-foreground transition hover:bg-surface disabled:opacity-40"
      >
        Suivant
      </button>
    </div>
  );
}

function SaveButton({
  pending,
  count,
  onClick,
}: {
  pending: boolean;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending || count === 0}
      className="inline-flex h-10 items-center gap-2 rounded-full bg-[#0e1218] px-5 text-xs font-extrabold text-white shadow-soft hover:bg-[#1a1e25] disabled:opacity-50"
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {pending ? "Enregistrement…" : count === 0 ? "Aucune modification" : `Enregistrer (${count})`}
    </button>
  );
}

/** Read-only Référence externe (ERP) line, shown on product rows for ERP
 *  reconciliation. Renders nothing when the product has no ERP ref. */
function ErpRef({ value }: { value: string | null }) {
  if (!value) return null;
  return (
    <p className="mt-0.5 text-[11px] text-muted-foreground/70" title="Référence externe (ERP)">
      ERP <span className="font-mono">{value}</span>
    </p>
  );
}

// ═══════════════════════════ Single-pool path ══════════════════════════════

type Draft = {
  inStock: boolean;
  stockQty: number | null;
};

const draftFromRow = (r: Row): Draft => ({
  inStock: r.inStock,
  stockQty: r.stockQty,
});

const sameDraft = (a: Draft, b: Draft): boolean =>
  a.inStock === b.inStock && a.stockQty === b.stockQty;

function SinglePoolPanel({
  canManage,
  lowThreshold,
  rows,
  currentQuery,
  currentFilter,
  total,
  page,
  pageSize,
}: StockPanelProps) {
  const router = useRouter();
  const { goToPage, goFilter, pushSearch } = useStockNav(currentQuery, currentFilter);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const [searchInput, setSearchInput] = useState(currentQuery);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // The server value each drafted key had WHEN THE OPERATOR STARTED EDITING it.
  // Captured once per key so a draft is self-contained and survives soft
  // navigation (pagination / filter / search) — its dirtiness and its optimistic
  // expected-qty no longer depend on the row being on the current page.
  const [baseline, setBaseline] = useState<Record<string, Draft>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // GLOBAL across every view: a key is dirty when its draft diverges from the
  // baseline captured at first edit — NOT from the current page's rows (which
  // would drop edits made on other pages and let the save wipe them).
  const dirtyKeys = useMemo(
    () =>
      Object.keys(drafts).filter((k) => {
        const b = baseline[k];
        return b != null && !sameDraft(drafts[k], b);
      }),
    [drafts, baseline],
  );

  // Rows whose Disponible box the operator clicked — saved as an EXPLICIT choice.
  // An untouched box follows the new quantity by the shared sold-out rule (same
  // rule the server applies): restocking a sold-out row ticks it (it's re-listed
  // on save instead of staying "Rupture"), emptying a row unticks it, a delisted
  // row with units stays unticked.
  const [touchedInStock, setTouchedInStock] = useState<Set<string>>(() => new Set());

  const updateDraft = (key: string, server: Draft, patch: Partial<Draft>) => {
    // Snapshot the baseline the FIRST time this key is edited, so its dirtiness +
    // optimistic expected-qty are self-contained (survive navigation).
    setBaseline((prev) => (key in prev ? prev : { ...prev, [key]: server }));
    // A fresh edit invalidates a lingering "saved" confirmation.
    setSavedAt(null);
    const touched = "inStock" in patch || touchedInStock.has(key);
    if ("inStock" in patch && !touchedInStock.has(key)) {
      setTouchedInStock((prev) => new Set(prev).add(key));
    }
    setDrafts((prev) => {
      const next = { ...(prev[key] ?? server), ...patch };
      if (!touched && "stockQty" in patch) {
        next.inStock = nextInStockForQty(server.stockQty, server.inStock, next.stockQty);
      }
      return { ...prev, [key]: next };
    });
  };

  const onSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    pushSearch(searchInput);
  };

  /** Drop the given keys from every draft map (used for the rows that committed). */
  const clearKeys = (keys: string[]) => {
    if (keys.length === 0) return;
    const drop = new Set(keys);
    setDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !drop.has(k))));
    setBaseline((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !drop.has(k))));
    setTouchedInStock((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.delete(k);
      return next;
    });
  };

  const onSaveAll = () => {
    if (!canManage || dirtyKeys.length === 0) return;
    setError(null);
    const keys = dirtyKeys;
    const updates = keys.map((key) => {
      const { productId, variantId } = parseKey(key);
      const d = drafts[key];
      const b = baseline[key];
      return {
        productId,
        variantId,
        inStock: d.inStock,
        stockQty: d.stockQty,
        inStockExplicit: touchedInStock.has(key),
        // Only a real qty edit writes the quantity (+ optimistic compare vs the
        // value the operator started from) — a Disponible-only toggle can't
        // clobber a stale qty, and a stale row is refused instead of resurrected.
        qtyExplicit: d.stockQty !== b.stockQty,
        expectedStockQty: b.stockQty,
      };
    });
    startTransition(async () => {
      const res = await bulkUpdateStockAction(updates);
      // Hard failure (validation / too many rows) with no per-row breakdown:
      // keep every draft so nothing is lost.
      if (!res.ok && !res.failures) {
        setError(res.message ?? "Échec de l'enregistrement.");
        return;
      }
      // Clear only the rows that COMMITTED; keep the failed rows dirty so the
      // operator can see + retry them (no silent loss, no blind re-save).
      const failedSet = new Set((res.failures ?? []).map((f) => tkey(f.productId, f.variantId)));
      clearKeys(keys.filter((k) => !failedSet.has(k)));
      if (res.failures && res.failures.length > 0) {
        setError(res.message ?? "Certaines lignes n'ont pas pu être enregistrées.");
      } else {
        setSavedAt(Date.now());
      }
      // Reconcile the surviving drafts + badges against server truth.
      router.refresh();
    });
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <AdminNote className="max-w-xl">
          Modifiez la disponibilité et les quantités, puis enregistrez par lots.{" "}
          {total} produit{total > 1 ? "s" : ""}
          {totalPages > 1 ? ` · page ${page}/${totalPages}` : ""}.
        </AdminNote>
        <div className="flex flex-wrap items-center gap-2">
          {savedAt && dirtyKeys.length === 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#eaf7ee] px-3 py-1.5 text-xs font-bold text-[#15803d]">
              <CheckCircle2 className="h-3.5 w-3.5" /> Modifications enregistrées
            </span>
          )}
          {canManage && <SaveButton pending={pending} count={dirtyKeys.length} onClick={onSaveAll} />}
        </div>
      </header>

      {!canManage && <StockReadOnlyBanner />}

      <Toolbar
        searchInput={searchInput}
        setSearchInput={setSearchInput}
        currentFilter={currentFilter}
        lowThreshold={lowThreshold}
        onSubmit={onSearchSubmit}
        onClear={() => {
          setSearchInput("");
          if (currentQuery) pushSearch("");
        }}
        goFilter={goFilter}
      />

      {error && (
        <AdminCallout tone="danger" icon={AlertTriangle}>
          {error}
        </AdminCallout>
      )}

      <div className="overflow-hidden rounded-[22px] border border-border bg-card">
        {rows.length === 0 ? (
          <p className="p-12 text-center text-[14px] text-muted-foreground">
            Aucun produit pour ces critères.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-[#fbf9f8] text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                <tr>
                  <th className="px-4 py-3 text-left">Produit</th>
                  <th className="px-4 py-3 text-left">SKU</th>
                  <th className="px-4 py-3 text-right">Prix</th>
                  <th className="px-4 py-3 text-center">Disponible</th>
                  <th className="px-4 py-3 text-right">Quantité</th>
                  <th className="px-4 py-3 text-right">Statut</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <StockRow
                    key={r.id}
                    row={r}
                    lowThreshold={lowThreshold}
                    readOnly={!canManage}
                    drafts={drafts}
                    onPatch={updateDraft}
                    expanded={!!expanded[r.id]}
                    onToggleExpand={() => setExpanded((e) => ({ ...e, [r.id]: !e[r.id] }))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pager page={page} totalPages={totalPages} goToPage={goToPage} />
    </div>
  );
}

/** A draft is "low" when sellable with a tracked quantity of 1–threshold
 *  (the shared `isLowStock` — same rule as the server's `?filter=low`). */
const lowQty = (d: Draft, threshold: number) => isLowStock(d.inStock, d.stockQty, threshold);

/** The editable Disponible + Quantité cells, shared by product + variant rows.
 *  `label` (the product/variant name) scopes the inputs' accessible names. */
function StockEditCells({
  draft: d,
  isLow,
  readOnly,
  onPatch,
  label,
}: {
  draft: Draft;
  isLow: boolean;
  readOnly: boolean;
  onPatch: (patch: Partial<Draft>) => void;
  label: string;
}) {
  return (
    <>
      <td className="px-4 py-3 text-center">
        <label className={`inline-flex items-center gap-2 ${readOnly ? "" : "cursor-pointer"}`}>
          <input
            type="checkbox"
            checked={d.inStock}
            disabled={readOnly}
            onChange={(e) => onPatch({ inStock: e.target.checked })}
            aria-label={`Disponible — ${label}`}
            className="h-4 w-4 accent-[var(--primary)] disabled:opacity-60"
          />
          <span className="sr-only">Disponible</span>
        </label>
      </td>
      <td className="px-4 py-3 text-right">
        <input
          type="number"
          min={0}
          value={d.stockQty ?? ""}
          disabled={readOnly}
          onChange={(e) => {
            const v = e.target.value.trim();
            // Floor to a non-negative integer (mirror the multi-location cell) so a
            // typed "2.5" can't reach the server and fail the whole batch.
            onPatch({ stockQty: v === "" ? null : Math.max(0, Math.floor(Number(v) || 0)) });
          }}
          step={1}
          placeholder="—"
          aria-label={`Quantité en stock — ${label}`}
          className={`h-9 w-24 rounded-[12px] border-[1.5px] bg-[#fbf9f8] px-3 text-right text-[14px] tabular-nums focus:outline-none focus:bg-white disabled:opacity-60 ${
            isLow
              ? "border-[#f3e3bd] focus:border-[#b45309]"
              : "border-input focus:border-foreground"
          }`}
        />
      </td>
    </>
  );
}

function StockRow({
  row: r,
  lowThreshold,
  readOnly,
  drafts,
  onPatch,
  expanded,
  onToggleExpand,
}: {
  row: Row;
  lowThreshold: number;
  readOnly: boolean;
  drafts: Record<string, Draft>;
  onPatch: (key: string, server: Draft, patch: Partial<Draft>) => void;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  // ── Simple / shared-variant product → edit the single product-level pool ──
  if (!isExpandable(r)) {
    const server = draftFromRow(r);
    const d = drafts[r.id] ?? server;
    const isDirty = !sameDraft(d, server);
    return (
      <tr className={isDirty ? "bg-[var(--accent)]" : "hover:bg-[#fffbfb]"}>
        <td className="px-4 py-3">
          <Link
            href={`/admin/catalog/products/${r.id}`}
            className="font-bold text-foreground hover:underline"
          >
            {r.name}
          </Link>
          <p className="mt-0.5 text-[11px] text-muted-foreground">/{r.slug}</p>
          <ErpRef value={r.externalRef} />
        </td>
        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{r.sku ?? "—"}</td>
        <td className="px-4 py-3 text-right tabular-nums">
          {formatMoneyWithCurrency(r.priceCents, r.currency)}
        </td>
        <StockEditCells
          draft={d}
          isLow={lowQty(d, lowThreshold)}
          readOnly={readOnly}
          onPatch={(patch) => onPatch(r.id, server, patch)}
          label={r.name}
        />
        <td className="px-4 py-3 text-right">
          <StatusBadge row={r} draft={d} isDirty={isDirty} isLow={lowQty(d, lowThreshold)} />
        </td>
      </tr>
    );
  }

  // ── Variable product in PER-VARIANT mode → collapsible variant rows ───────
  const states = r.variants.map((v) => {
    const key = tkey(r.id, v.id);
    const server: Draft = { inStock: v.inStock, stockQty: v.stockQty };
    const d = drafts[key] ?? server;
    return { v, key, server, d, dirty: !sameDraft(d, server) };
  });
  const totalQty = states.reduce<number | null>(
    (acc, s) => (s.d.stockQty == null ? acc : (acc ?? 0) + s.d.stockQty),
    null,
  );
  const anyInStock = states.some((s) => s.d.inStock && (s.d.stockQty == null || s.d.stockQty > 0));
  const anyDirty = states.some((s) => s.dirty);

  return (
    <>
      <tr className={anyDirty ? "bg-[var(--accent)]" : "hover:bg-[#fffbfb]"}>
        <td className="px-4 py-3">
          <button
            type="button"
            onClick={onToggleExpand}
            aria-expanded={expanded}
            className="inline-flex items-center gap-1.5 text-left font-bold text-foreground hover:text-primary"
          >
            <ChevronRight
              className={`h-4 w-4 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
            {r.name}
          </button>
          <p className="mt-0.5 inline-flex items-center gap-1.5 pl-[1.375rem] text-[11px] text-muted-foreground">
            <Layers className="h-3 w-3" /> {r.variants.length} variante
            {r.variants.length > 1 ? "s" : ""} · /{r.slug}
          </p>
          <div className="pl-[1.375rem]">
            <ErpRef value={r.externalRef} />
          </div>
        </td>
        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{r.sku ?? "—"}</td>
        <td className="px-4 py-3 text-right tabular-nums">
          {formatMoneyWithCurrency(r.priceCents, r.currency)}
        </td>
        <td className="px-4 py-3 text-center text-muted-foreground">{anyInStock ? "✓" : "—"}</td>
        <td
          className="px-4 py-3 text-right tabular-nums text-muted-foreground"
          title="Total des variantes (lecture seule)"
        >
          Σ {totalQty ?? "—"}
        </td>
        <td className="px-4 py-3 text-right">
          {anyDirty ? (
            <span className="inline-flex items-center rounded-full bg-[#eef2ff] px-2.5 py-1 text-[11px] font-bold uppercase text-[#3730a3]">
              Modifié
            </span>
          ) : (
            <button
              type="button"
              onClick={onToggleExpand}
              className="text-[11px] font-bold text-primary hover:underline"
            >
              {expanded ? "Réduire" : "Variantes"}
            </button>
          )}
        </td>
      </tr>
      {expanded &&
        states.map((s) => (
          <tr key={s.key} className={s.dirty ? "bg-[var(--accent)]" : "bg-[#fbf9f8]"}>
            <td className="px-4 py-2.5 pl-11">
              <span className="text-sm text-foreground">{s.v.label || "Variante"}</span>
            </td>
            <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{s.v.sku ?? "—"}</td>
            <td className="px-4 py-2.5" />
            <StockEditCells
              draft={s.d}
              isLow={lowQty(s.d, lowThreshold)}
              readOnly={readOnly}
              onPatch={(patch) => onPatch(s.key, s.server, patch)}
              label={s.v.label || "Variante"}
            />
            <td className="px-4 py-2.5 text-right">
              <VariantStatusBadge draft={s.d} isDirty={s.dirty} isLow={lowQty(s.d, lowThreshold)} />
            </td>
          </tr>
        ))}
    </>
  );
}

function VariantStatusBadge({
  draft,
  isDirty,
  isLow,
}: {
  draft: Draft;
  isDirty: boolean;
  isLow: boolean;
}) {
  if (isDirty) return <Pill tone="primary">Modifié</Pill>;
  // Effective, not the raw flag: a tracked qty 0 left « Disponible » is unbuyable.
  if (isEffectivelyOutOfStock(draft.inStock, draft.stockQty)) {
    return <Pill tone="destructive">Rupture</Pill>;
  }
  if (isLow) return <Pill tone="amber">Bas</Pill>;
  return <Pill tone="emerald">OK</Pill>;
}

function StatusBadge({
  row,
  draft,
  isDirty,
  isLow,
}: {
  row: Row;
  draft: Draft;
  isDirty: boolean;
  isLow: boolean;
}) {
  if (isDirty) return <Pill tone="primary">Modifié</Pill>;
  // Effective, not the raw flag: a tracked qty 0 left « Disponible » is unbuyable.
  if (isEffectivelyOutOfStock(draft.inStock, draft.stockQty)) {
    return <Pill tone="destructive">Rupture</Pill>;
  }
  if (isLow) return <Pill tone="amber">Bas</Pill>;
  return (
    <Pill tone={row.isPublished ? "emerald" : "muted"}>{row.isPublished ? "OK" : "Brouillon"}</Pill>
  );
}

// ═══════════════════════════ Multi-location path ═══════════════════════════

function MultiLocationPanel({
  canManage,
  lowThreshold,
  rows,
  currentQuery,
  currentFilter,
  total,
  page,
  pageSize,
  locations,
  levels,
  incoming = {},
}: StockPanelProps) {
  const router = useRouter();
  const { goToPage, goFilter, pushSearch } = useStockNav(currentQuery, currentFilter);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const [searchInput, setSearchInput] = useState(currentQuery);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Level drafts keyed `${productId}|${variantId ?? ""}|${locationId}`.
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  // Server level each drafted cell had at first edit — self-contained so edits
  // survive pagination/filter/search (see SinglePoolPanel's `baseline`).
  const [baseline, setBaseline] = useState<Record<string, number>>({});
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Server-level lookup uses the service's `productId` / `productId:variantId` key.
  const serverLevel = (productId: string, variantId: string | null, locationId: string) =>
    levels[variantId ? `${productId}:${variantId}` : productId]?.[locationId] ?? 0;
  const dkey = (productId: string, variantId: string | null, locationId: string) =>
    `${productId}|${variantId ?? ""}|${locationId}`;
  const getLevel = (productId: string, variantId: string | null, locationId: string) => {
    const k = dkey(productId, variantId, locationId);
    return drafts[k] ?? serverLevel(productId, variantId, locationId);
  };
  const setLevel = (productId: string, variantId: string | null, locationId: string, qty: number) => {
    const k = dkey(productId, variantId, locationId);
    setBaseline((prev) => (k in prev ? prev : { ...prev, [k]: serverLevel(productId, variantId, locationId) }));
    setSavedAt(null);
    setDrafts((prev) => ({ ...prev, [k]: qty }));
  };

  // Dirty cells = drafts that diverge from their captured baseline — GLOBAL, so
  // a cell edited on another page/filter is still saved (not silently dropped).
  const dirtyCells = useMemo(() => {
    const out: {
      productId: string;
      variantId: string | null;
      locationId: string;
      qty: number;
      expectedQty: number;
    }[] = [];
    for (const k of Object.keys(drafts)) {
      const b = baseline[k];
      if (b == null || drafts[k] === b) continue;
      const [productId, variantId, locationId] = parseDkey(k);
      // `b` is the level captured when the operator first edited the cell (the
      // page-load value) — sent as expectedQty so the server refuses the save if
      // a transfer/edit moved the level since (no silent clobber of the total).
      out.push({ productId, variantId, locationId, qty: drafts[k], expectedQty: b });
    }
    return out;
  }, [drafts, baseline]);

  const onSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    pushSearch(searchInput);
  };

  const clearCells = (keys: string[]) => {
    if (keys.length === 0) return;
    const drop = new Set(keys);
    setDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !drop.has(k))));
    setBaseline((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !drop.has(k))));
  };

  const onSaveAll = () => {
    if (!canManage || dirtyCells.length === 0) return;
    setError(null);
    const cells = dirtyCells;
    const sentKeys = cells.map((c) => dkey(c.productId, c.variantId, c.locationId));
    startTransition(async () => {
      const res = await setLocationLevelsAction(cells);
      // Hard failure with no per-cell breakdown: keep every draft.
      if (!res.ok && !res.failures) {
        setError(res.message ?? "Échec de l'enregistrement.");
        return;
      }
      // Clear only the cells that committed; keep failed cells dirty.
      const failedSet = new Set(
        (res.failures ?? []).map((f) => dkey(f.productId, f.variantId, f.locationId)),
      );
      clearCells(sentKeys.filter((k) => !failedSet.has(k)));
      if (res.failures && res.failures.length > 0) {
        setError(res.message ?? "Certaines lignes n'ont pas pu être enregistrées.");
      } else {
        setSavedAt(Date.now());
      }
      router.refresh();
    });
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <AdminNote className="max-w-xl">
          Stock par emplacement ({locations.length}). « Total » est le stock vendable (celui
          que lisent la boutique et les commandes) ; saisir une quantité le fait varier de la
          différence. Les ventes ne modifient que le total : « Écart » signale une somme
          d&apos;emplacements différente.
        </AdminNote>
        <div className="flex flex-wrap items-center gap-2">
          {savedAt && dirtyCells.length === 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#eaf7ee] px-3 py-1.5 text-xs font-bold text-[#15803d]">
              <CheckCircle2 className="h-3.5 w-3.5" /> Modifications enregistrées
            </span>
          )}
          {canManage && <SaveButton pending={pending} count={dirtyCells.length} onClick={onSaveAll} />}
        </div>
      </header>

      {!canManage && <StockReadOnlyBanner />}

      <Toolbar
        searchInput={searchInput}
        setSearchInput={setSearchInput}
        currentFilter={currentFilter}
        lowThreshold={lowThreshold}
        onSubmit={onSearchSubmit}
        onClear={() => {
          setSearchInput("");
          if (currentQuery) pushSearch("");
        }}
        goFilter={goFilter}
      />

      {error && (
        <AdminCallout tone="danger" icon={AlertTriangle}>
          {error}
        </AdminCallout>
      )}

      <div className="overflow-hidden rounded-[22px] border border-border bg-card">
        {rows.length === 0 ? (
          <p className="p-12 text-center text-[14px] text-muted-foreground">
            Aucun produit pour ces critères.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-[#fbf9f8] text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                <tr>
                  <th className="sticky left-0 z-20 min-w-[14rem] bg-[#fbf9f8] px-4 py-3 text-left shadow-[1px_0_0_0_var(--border)]">
                    Produit
                  </th>
                  {locations.map((loc) => (
                    <th
                      key={loc.id}
                      className={`min-w-[6.5rem] px-3 py-3 text-center align-bottom ${
                        loc.isDefault ? "bg-[#fdecef]" : ""
                      }`}
                      title={
                        loc.isDefault
                          ? `${loc.name} — dépôt de vente en ligne${loc.code ? ` · ${loc.code}` : ""}`
                          : loc.code
                            ? `${loc.name} · ${loc.code}`
                            : loc.name
                      }
                    >
                      <span className="flex flex-col items-center gap-0.5 leading-tight">
                        <span className="inline-flex items-center gap-1">
                          {loc.isDefault ? (
                            <Globe className="h-3 w-3 text-[#d40530]" />
                          ) : (
                            <MapPin className="h-3 w-3 opacity-60" />
                          )}
                          <span className="max-w-[7rem] truncate">{loc.name}</span>
                        </span>
                        {loc.isDefault ? (
                          <span className="rounded-full bg-[#d40530] px-1.5 py-px text-[9px] font-black uppercase tracking-wide text-white">
                            Site web
                          </span>
                        ) : loc.code ? (
                          <span className="font-mono text-[10px] font-normal normal-case text-muted-foreground/70">
                            {loc.code}
                          </span>
                        ) : null}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <MultiLocationRow
                    key={r.id}
                    row={r}
                    lowThreshold={lowThreshold}
                    readOnly={!canManage}
                    locations={locations}
                    incoming={incoming}
                    getLevel={getLevel}
                    setLevel={setLevel}
                    serverLevel={serverLevel}
                    expanded={!!expanded[r.id]}
                    onToggleExpand={() => setExpanded((e) => ({ ...e, [r.id]: !e[r.id] }))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pager page={page} totalPages={totalPages} goToPage={goToPage} />
    </div>
  );
}

/**
 * The numbers the matrix shows for ONE stock target (product pool or variant).
 * `stock_qty` is the AUTHORITATIVE sellable total — the storefront, checkout and
 * order paths read it, and sales, cancels, returns, the API and the product
 * editor move ONLY it (per-location decrement is a later phase). So the matrix
 * shows it as « Total » and derives the status from it; Σ(levels) is secondary:
 *   - projected: the total after saving the dirty cells — a level write moves a
 *     tracked total by the DELTA (Σ draft − Σ server) and makes an untracked one
 *     tracked at the sum of its active levels (nextTotalForLevelWrite);
 *   - drift: a tracked total that differs from its level sum (units sold since
 *     the last matrix edit, or stock edited outside this table).
 */
function targetNumbers(stockQty: number | null, server: number[], draft: number[]) {
  const serverSum = server.reduce((a, b) => a + b, 0);
  const draftSum = draft.reduce((a, b) => a + b, 0);
  const dirty = draft.some((q, i) => q !== server[i]);
  const projected = !dirty
    ? null
    : stockQty === null
      ? draftSum
      : Math.max(0, stockQty + draftSum - serverSum);
  return { draftSum, dirty, projected, drift: stockQty !== null && serverSum !== stockQty };
}

/** Status from the AUTHORITATIVE total (never from Σ levels): an untracked
 *  line is « Non suivi » (unlimited), not « Rupture 0 ». « Bas » uses the
 *  configured threshold (shared `isLowStock`), like the single-pool badges. */
function statusForTotal(
  stockQty: number | null,
  inStock: boolean,
  lowThreshold: number,
): { tone: PillTone; label: string } {
  if (isEffectivelyOutOfStock(inStock, stockQty)) return { tone: "destructive", label: "Rupture" };
  if (stockQty === null) return { tone: "muted", label: "Non suivi" };
  if (isLowStock(inStock, stockQty, lowThreshold)) return { tone: "amber", label: "Bas" };
  return { tone: "emerald", label: "OK" };
}

/** Sticky-left product cell content (frozen column) with the authoritative
 *  total + status, the on-save projection and the level-sum drift badge. */
function ProductSticky({
  children,
  total,
  projected,
  levelSum,
  drift,
  statusTone,
  statusLabel,
  dirty,
}: {
  children: React.ReactNode;
  /** Authoritative sellable total (stock_qty); null = untracked. */
  total: number | null;
  /** Total after saving the dirty cells (null when nothing is dirty). */
  projected: number | null;
  /** Σ of the active-location cells (drafts included). */
  levelSum: number;
  /** Tracked total ≠ its (saved) level sum. */
  drift: boolean;
  statusTone: PillTone;
  statusLabel: string;
  dirty: boolean;
}) {
  const showSum = drift || (total === null && levelSum > 0);
  return (
    <td
      className={`sticky left-0 z-10 min-w-[14rem] bg-card px-4 py-3 align-top shadow-[1px_0_0_0_var(--border)] ${
        dirty ? "border-l-2 border-l-primary" : ""
      }`}
    >
      {children}
      <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="tabular-nums" title="Stock vendable (total autoritatif)">
          Total&nbsp;{total ?? "—"}
          {projected !== null && projected !== total && (
            <span className="text-primary" title="Total après enregistrement">
              &nbsp;→&nbsp;{projected}
            </span>
          )}
        </span>
        <Pill tone={statusTone}>{statusLabel}</Pill>
        {drift && (
          <span title="La somme des emplacements diffère du stock vendable : les ventes, retours et saisies hors de ce tableau ne modifient que le total. Une saisie ici fait varier le total de la différence — alignez d'abord les cellules avant un recomptage.">
            <Pill tone="amber">Écart</Pill>
          </span>
        )}
      </p>
      {showSum && (
        <p className="mt-0.5 text-[10px] tabular-nums text-muted-foreground/80">
          Σ emplacements&nbsp;{levelSum}
        </p>
      )}
    </td>
  );
}

/** One number cell editing a (target, location) level. `highlight` tints the
 *  central/online-depot column so it reads as its own stock down every row. */
function LevelCell({
  value,
  server,
  readOnly,
  highlight = false,
  incoming = 0,
  onChange,
}: {
  value: number;
  server: number;
  readOnly: boolean;
  highlight?: boolean;
  /** In-transit units arriving at this location (shown as a hint, NOT in the input). */
  incoming?: number;
  onChange: (qty: number) => void;
}) {
  const dirty = value !== server;
  return (
    <td className={`px-2 py-2 text-center align-top ${dirty ? "bg-primary/5" : highlight ? "bg-[#fdecef]/50" : ""}`}>
      <input
        type="number"
        min={0}
        inputMode="numeric"
        value={value}
        disabled={readOnly}
        onChange={(e) => {
          const v = e.target.value.trim();
          onChange(v === "" ? 0 : Math.max(0, Math.floor(Number(v) || 0)));
        }}
        className={`h-9 w-16 rounded-[12px] border-[1.5px] bg-[#fbf9f8] px-2 text-center text-[14px] tabular-nums focus:outline-none focus:bg-white disabled:opacity-60 ${
          dirty ? "border-foreground" : "border-input focus:border-foreground"
        }`}
      />
      <IncomingHint qty={incoming} />
    </td>
  );
}

/** « + N en transit » — units arriving via a non-finalised transfer (not yet in the
 *  level; completion relocates them). Shown under the cell so on-hand stays exact. */
function IncomingHint({ qty }: { qty: number }) {
  if (qty <= 0) return null;
  return (
    <div
      className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-bold tabular-nums text-[#b8042a]"
      title={`${qty} unité(s) en transit vers cet emplacement (transfert en cours, non finalisé)`}
    >
      +{qty} en transit
    </div>
  );
}

/** A read-only per-location sum cell (parent rollup of its variants). */
function RollupCell({ total, highlight = false, incoming = 0 }: { total: number; highlight?: boolean; incoming?: number }) {
  return (
    <td
      className={`px-2 py-3 text-center align-top text-sm tabular-nums text-muted-foreground ${highlight ? "bg-[#fdecef]/50" : ""}`}
      title="Somme des variantes (lecture seule)"
    >
      {total}
      <IncomingHint qty={incoming} />
    </td>
  );
}

function MultiLocationRow({
  row: r,
  lowThreshold,
  readOnly,
  locations,
  incoming,
  getLevel,
  setLevel,
  serverLevel,
  expanded,
  onToggleExpand,
}: {
  row: Row;
  lowThreshold: number;
  readOnly: boolean;
  locations: LocationCol[];
  incoming: Record<string, number>;
  getLevel: (productId: string, variantId: string | null, locationId: string) => number;
  setLevel: (productId: string, variantId: string | null, locationId: string, qty: number) => void;
  serverLevel: (productId: string, variantId: string | null, locationId: string) => number;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const numbersFor = (variantId: string | null, stockQty: number | null) =>
    targetNumbers(
      stockQty,
      locations.map((loc) => serverLevel(r.id, variantId, loc.id)),
      locations.map((loc) => getLevel(r.id, variantId, loc.id)),
    );
  const incomingFor = (variantId: string | null, locationId: string) =>
    incoming[`${r.id}:${variantId ?? ""}:${locationId}`] ?? 0;

  // ── Simple / shared-variant product → edit the product-pool level per loc ──
  if (!isExpandable(r)) {
    const n = numbersFor(null, r.stockQty);
    const st = statusForTotal(r.stockQty, r.inStock, lowThreshold);
    return (
      <tr className="hover:bg-[#fffbfb]">
        <ProductSticky
          total={r.stockQty}
          projected={n.projected}
          levelSum={n.draftSum}
          drift={n.drift}
          statusTone={st.tone}
          statusLabel={st.label}
          dirty={n.dirty}
        >
          <Link
            href={`/admin/catalog/products/${r.id}`}
            className="font-bold text-foreground hover:underline"
          >
            {r.name}
          </Link>
          {r.sku && <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{r.sku}</p>}
          <ErpRef value={r.externalRef} />
        </ProductSticky>
        {locations.map((loc) => (
          <LevelCell
            key={loc.id}
            value={getLevel(r.id, null, loc.id)}
            server={serverLevel(r.id, null, loc.id)}
            readOnly={readOnly}
            highlight={loc.isDefault}
            incoming={incomingFor(null, loc.id)}
            onChange={(qty) => setLevel(r.id, null, loc.id, qty)}
          />
        ))}
      </tr>
    );
  }

  // ── Variable product in PER-VARIANT mode → collapsible variant rows ───────
  const parentPerLoc = locations.map((loc) =>
    r.variants.reduce((sum, v) => sum + getLevel(r.id, v.id, loc.id), 0),
  );
  const parentIncoming = locations.map((loc) =>
    r.variants.reduce((sum, v) => sum + incomingFor(v.id, loc.id), 0),
  );
  const variantNumbers = r.variants.map((v) => ({ v, n: numbersFor(v.id, v.stockQty) }));
  // Parent rollup from the variants' AUTHORITATIVE totals: Σ tracked stock_qty
  // (— when none is tracked); « Non suivi » while an untracked variant is on sale.
  const parentTotal = r.variants.reduce<number | null>(
    (acc, v) => (v.stockQty == null ? acc : (acc ?? 0) + v.stockQty),
    null,
  );
  const anyAvailable = r.variants.some((v) => v.inStock && (v.stockQty == null || v.stockQty > 0));
  const anyUntrackedAvailable = r.variants.some((v) => v.inStock && v.stockQty == null);
  const st = statusForTotal(anyUntrackedAvailable ? null : parentTotal, anyAvailable, lowThreshold);
  const anyDirty = variantNumbers.some(({ n }) => n.dirty);

  return (
    <>
      <tr className="hover:bg-[#fffbfb]">
        <ProductSticky
          total={parentTotal}
          projected={null}
          levelSum={parentPerLoc.reduce((a, b) => a + b, 0)}
          drift={variantNumbers.some(({ n }) => n.drift)}
          statusTone={st.tone}
          statusLabel={st.label}
          dirty={anyDirty}
        >
          <button
            type="button"
            onClick={onToggleExpand}
            aria-expanded={expanded}
            className="inline-flex items-center gap-1.5 text-left font-bold text-foreground hover:text-primary"
          >
            <ChevronRight className={`h-4 w-4 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
            {r.name}
          </button>
          <p className="mt-0.5 inline-flex items-center gap-1.5 pl-[1.375rem] text-[11px] text-muted-foreground">
            <Layers className="h-3 w-3" /> {r.variants.length} variante{r.variants.length > 1 ? "s" : ""}
          </p>
          <div className="pl-[1.375rem]">
            <ErpRef value={r.externalRef} />
          </div>
        </ProductSticky>
        {parentPerLoc.map((sum, i) => (
          <RollupCell key={locations[i].id} total={sum} highlight={locations[i].isDefault} incoming={parentIncoming[i]} />
        ))}
      </tr>
      {expanded &&
        variantNumbers.map(({ v, n }) => {
          const vst = statusForTotal(v.stockQty, v.inStock, lowThreshold);
          return (
            <tr key={v.id} className="bg-[#fbf9f8]">
              <ProductSticky
                total={v.stockQty}
                projected={n.projected}
                levelSum={n.draftSum}
                drift={n.drift}
                statusTone={vst.tone}
                statusLabel={vst.label}
                dirty={n.dirty}
              >
                <span className="block pl-6 text-sm text-foreground">{v.label || "Variante"}</span>
                {v.sku && <span className="block pl-6 font-mono text-[11px] text-muted-foreground">{v.sku}</span>}
              </ProductSticky>
              {locations.map((loc) => (
                <LevelCell
                  key={loc.id}
                  value={getLevel(r.id, v.id, loc.id)}
                  server={serverLevel(r.id, v.id, loc.id)}
                  readOnly={readOnly}
                  highlight={loc.isDefault}
                  incoming={incomingFor(v.id, loc.id)}
                  onChange={(qty) => setLevel(r.id, v.id, loc.id, qty)}
                />
              ))}
            </tr>
          );
        })}
    </>
  );
}

// ════════════════════════════════ Pill ═════════════════════════════════════

type PillTone = "primary" | "destructive" | "amber" | "emerald" | "muted";

const PILL_TONE: Record<PillTone, string> = {
  primary: "bg-[#eef2ff] text-[#3730a3]",
  destructive: "bg-[#fdecef] text-[#d40530]",
  amber: "bg-[#fff4e0] text-[#b45309]",
  emerald: "bg-[#eaf7ee] text-[#15803d]",
  muted: "bg-[#f6f2ed] text-[#5b5d62]",
};

function Pill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase ${PILL_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

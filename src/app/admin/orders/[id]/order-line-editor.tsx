"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Minus, Plus, Search, Trash2, PencilLine } from "lucide-react";

import { formatMoneyExact } from "@/lib/price";
import { editOrderItemsAction } from "@/lib/actions/order";
import {
  searchProductsForOrderAction,
  type ManualOrderProductHit,
} from "@/lib/actions/manual-order";
import { SelectField } from "@/components/ui/select-field";

export type EditableLine = {
  orderItemId: string;
  name: string;
  variantLabel: string | null;
  quantity: number;
  unitPriceCents: number;
  /** Units already shipped — qty can't go below this, line can't be removed. */
  shippedQty: number;
};

const inputCls =
  "h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[15px] transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]";

/**
 * Operator order-line editor — add a product, change a line quantity, or remove
 * a line on a PRE-SHIP order. Each change is one atomic editOrderItemsAction call
 * (stock + tax + totals reconciled server-side), then the page refreshes. A line
 * with shipped units can't drop below them / be removed (enforced server-side too).
 */
export function OrderLineEditor({ orderId, lines }: { orderId: string; lines: EditableLine[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Per-line draft quantity (only "Appliquer" commits it).
  const [qty, setQty] = useState<Record<string, number>>(() =>
    Object.fromEntries(lines.map((l) => [l.orderItemId, l.quantity])),
  );
  // Reseed when the COMMITTED lines change (an edit here or elsewhere, then the
  // refresh): a line whose committed quantity moved restarts from it, so a stale
  // draft never shows as a pending change; untouched lines keep their draft.
  const [seeded, setSeeded] = useState(lines);
  const sig = (ls: EditableLine[]) => ls.map((l) => `${l.orderItemId}:${l.quantity}`).join(",");
  if (sig(seeded) !== sig(lines)) {
    const before = new Map(seeded.map((l) => [l.orderItemId, l.quantity]));
    setSeeded(lines);
    setQty((prev) =>
      Object.fromEntries(
        lines.map((l) => [
          l.orderItemId,
          before.get(l.orderItemId) === l.quantity ? (prev[l.orderItemId] ?? l.quantity) : l.quantity,
        ]),
      ),
    );
  }

  // Add-line search.
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ManualOrderProductHit[]>([]);
  const [searching, startSearch] = useTransition();

  const run = (op: Parameters<typeof editOrderItemsAction>[0]["ops"][number], okText: string) =>
    start(async () => {
      const res = await editOrderItemsAction({ orderId, ops: [op] });
      setMsg({ ok: res.ok, text: res.ok ? okText : (res.message ?? "Erreur.") });
      if (res.ok) {
        setQuery("");
        setHits([]);
        router.refresh();
      }
    });

  const runSearch = (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    startSearch(async () => setHits(await searchProductsForOrderAction(q).catch(() => [])));
  };

  return (
    <section className="rounded-[28px] border border-border bg-card p-4">
      <h2 className="mb-1 inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
        <PencilLine className="h-4 w-4" /> Modifier les articles
      </h2>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        Possible avant expédition / facturation. Réduire une quantité ou retirer une ligne{" "}
        <strong>réintègre</strong> les unités au stock ; en ajouter en décompte. Une ligne déjà
        expédiée ne peut pas descendre sous les unités envoyées ni être retirée.
      </p>

      <ul className="space-y-2">
        {lines.map((l) => {
          const draft = qty[l.orderItemId] ?? l.quantity;
          const changed = draft !== l.quantity;
          const minQty = Math.max(1, l.shippedQty);
          return (
            <li key={l.orderItemId} className="flex flex-wrap items-center gap-2 rounded-[14px] border border-input bg-[#fbf9f8] px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{l.name}</p>
                {l.variantLabel && <p className="text-[11px] text-muted-foreground">{l.variantLabel}</p>}
                <p className="text-[11px] text-muted-foreground">
                  {formatMoneyExact(l.unitPriceCents)} / u.
                  {l.shippedQty > 0 && <span className="ml-1 text-[#b45309]">· {l.shippedQty} expédié(s)</span>}
                </p>
              </div>
              <div className="inline-flex items-center rounded-[10px] border border-input">
                <button
                  type="button"
                  disabled={pending || draft <= minQty}
                  onClick={() => setQty((s) => ({ ...s, [l.orderItemId]: Math.max(minQty, draft - 1) }))}
                  className="grid h-9 w-9 place-items-center text-muted-foreground disabled:opacity-40"
                  aria-label="Diminuer"
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
                <span className="w-9 text-center text-sm tabular-nums">{draft}</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setQty((s) => ({ ...s, [l.orderItemId]: draft + 1 }))}
                  className="grid h-9 w-9 place-items-center text-muted-foreground disabled:opacity-40"
                  aria-label="Augmenter"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              {changed && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run({ kind: "set_qty", orderItemId: l.orderItemId, quantity: draft }, "Quantité mise à jour.")}
                  className="inline-flex h-9 items-center gap-1 rounded-[10px] bg-primary px-2.5 text-[11px] font-bold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
                >
                  {pending && <Loader2 className="h-3 w-3 animate-spin" />} Appliquer
                </button>
              )}
              <button
                type="button"
                disabled={pending || l.shippedQty > 0}
                onClick={() => run({ kind: "remove", orderItemId: l.orderItemId }, "Ligne retirée.")}
                title={l.shippedQty > 0 ? "Des unités sont déjà expédiées" : "Retirer la ligne"}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-input text-muted-foreground hover:border-destructive/40 hover:text-destructive disabled:opacity-40"
                aria-label="Retirer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          );
        })}
      </ul>

      {/* Add a line */}
      <div className="relative mt-3">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input value={query} onChange={(e) => runSearch(e.target.value)} placeholder="Ajouter un article (nom ou SKU)…" className={inputCls} />
          {searching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        {hits.length > 0 && (
          <div className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-[14px] border border-border bg-card shadow-lg">
            {hits.map((hit) => (
              <AddHitRow key={hit.id} hit={hit} pending={pending} onAdd={(productId, variantId) => run({ kind: "add", productId, variantId: variantId || undefined, quantity: 1 }, "Article ajouté.")} />
            ))}
          </div>
        )}
      </div>

      {msg && <p className={`mt-2 text-[11px] ${msg.ok ? "text-primary" : "text-destructive"}`}>{msg.text}</p>}
    </section>
  );
}

function AddHitRow({
  hit,
  pending,
  onAdd,
}: {
  hit: ManualOrderProductHit;
  pending: boolean;
  onAdd: (productId: string, variantId: string) => void;
}) {
  const [variantId, setVariantId] = useState(hit.variants[0]?.id ?? "");
  return (
    <div className="flex items-center gap-2 border-b border-border/60 p-2 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{hit.name}</p>
        <p className="text-[11px] text-muted-foreground">
          {hit.sku ? `${hit.sku} · ` : ""}
          {formatMoneyExact(hit.priceCents)}
        </p>
      </div>
      {hit.isVariable && hit.variants.length > 0 && (
        <SelectField
          size="sm"
          ariaLabel="Variante"
          value={variantId}
          onChange={setVariantId}
          options={hit.variants.map((v) => ({ value: v.id, label: v.label }))}
          className="w-[8rem] shrink-0"
          triggerClassName="h-8"
        />
      )}
      <button
        type="button"
        disabled={pending || (hit.isVariable && !variantId)}
        onClick={() => onAdd(hit.id, hit.isVariable ? variantId : "")}
        className="inline-flex h-8 items-center gap-1 rounded-[10px] bg-primary px-2.5 text-[11px] font-bold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-50"
      >
        <Plus className="h-3 w-3" /> Ajouter
      </button>
    </div>
  );
}

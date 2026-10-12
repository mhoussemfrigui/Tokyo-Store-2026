"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Printer, Truck, PackagePlus } from "lucide-react";

import { createShipmentAction } from "@/lib/actions/order";

export type ShipLine = {
  orderItemId: string;
  name: string;
  variantLabel: string | null;
  remaining: number;
};
export type ExistingShipment = {
  id: string;
  number: string;
  createdAt: string;
  tracking: string | null;
  lines: Array<{ name: string; qty: number }>;
};

/**
 * Partial-shipment panel — lists the order's bons de livraison (each printable
 * by BL number) and composes a new parcel: pick per-line quantities (≤ remaining
 * to ship), an optional tracking ref, and "marquer expédié" to flip the order to
 * shipped once everything has left. The over-ship guard is enforced
 * server-side.
 */
export function ShipmentsPanel({
  orderId,
  lines,
  shipments,
  canCompose,
  lockedReason = null,
}: {
  orderId: string;
  lines: ShipLine[];
  shipments: ExistingShipment[];
  canCompose: boolean;
  /** Why composing is refused (e.g. fully refunded) — replaces the status hint. */
  lockedReason?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const shippable = lines.filter((l) => l.remaining > 0);
  const seedQty = () => Object.fromEntries(shippable.map((l) => [l.orderItemId, l.remaining]));
  const [qty, setQty] = useState<Record<string, number>>(seedQty);
  // Reseed the per-line quantities whenever the server's remaining-to-ship
  // changes — a line added / edited in the line editor, or a parcel just created
  // (this tab stays mounted across the refresh, so a new line used to default to
  // 0 and a shipped one kept its stale quantity). The message is kept.
  const shippableSig = shippable.map((l) => `${l.orderItemId}:${l.remaining}`).join(",");
  const [seededSig, setSeededSig] = useState(shippableSig);
  if (seededSig !== shippableSig) {
    setSeededSig(shippableSig);
    setQty(seedQty());
  }
  const [tracking, setTracking] = useState("");
  const [markShipped, setMarkShipped] = useState(true);

  const base = `/admin/orders/${orderId}`;
  const picked = shippable
    .map((l) => ({ orderItemId: l.orderItemId, quantity: Math.min(Math.max(qty[l.orderItemId] ?? 0, 0), l.remaining) }))
    .filter((l) => l.quantity > 0);

  const submit = () =>
    start(async () => {
      if (picked.length === 0) {
        setMsg({ ok: false, text: "Sélectionnez au moins une ligne à expédier." });
        return;
      }
      const res = await createShipmentAction({
        orderId,
        lines: picked,
        trackingRef: tracking.trim() || undefined,
        markShipped,
      });
      setMsg({ ok: res.ok, text: res.message ?? (res.ok ? "Bon de livraison créé." : "Erreur.") });
      if (res.ok) router.refresh();
    });

  return (
    <section className="rounded-[28px] border border-border bg-card p-4">
      <h2 className="mb-3 inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
        <Truck className="h-4 w-4" /> Expéditions (bons de livraison)
      </h2>

      {shipments.length > 0 && (
        <ul className="mb-3 space-y-2">
          {shipments.map((s) => (
            <li key={s.id} className="rounded-[14px] border border-input bg-[#fbf9f8] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-mono text-[12px] font-semibold text-foreground">{s.number}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {new Date(s.createdAt).toLocaleDateString("fr-FR")}
                    {s.tracking ? ` · suivi ${s.tracking}` : ""}
                  </p>
                </div>
                <a
                  href={`${base}/delivery-note?shipment=${s.id}&autoprint=1`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-8 items-center gap-1 rounded-[10px] border-[1.5px] border-input bg-card px-2.5 text-[11px] font-bold text-foreground hover:border-primary/40"
                >
                  <Printer className="h-3 w-3" /> Imprimer
                </a>
              </div>
              <ul className="mt-1.5 text-[11px] text-muted-foreground">
                {s.lines.map((ln, i) => (
                  <li key={i} className="truncate">
                    {ln.name} × {ln.qty}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {!canCompose ? (
        lockedReason ? (
          <p className="rounded-[14px] border border-dashed border-border bg-surface/40 p-3 text-[11px] text-muted-foreground">
            {lockedReason}
          </p>
        ) : (
          shipments.length === 0 && (
            <p className="rounded-[14px] border border-dashed border-border bg-surface/40 p-3 text-[11px] text-muted-foreground">
              Les bons de livraison se créent quand la commande est payée / en préparation.
            </p>
          )
        )
      ) : shippable.length === 0 ? (
        <p className="rounded-[14px] border border-dashed border-border bg-surface/40 p-3 text-[11px] text-muted-foreground">
          Tout est expédié — rien à ajouter à un bon de livraison.
        </p>
      ) : (
        <div className="space-y-2 rounded-[14px] border border-input bg-[#fbf9f8] p-3">
          <p className="text-[13px] font-bold text-foreground">Nouveau bon de livraison</p>
          {shippable.map((l) => (
            <div key={l.orderItemId} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {l.name}
                {l.variantLabel ? ` — ${l.variantLabel}` : ""} <span className="text-muted-foreground">(reste {l.remaining})</span>
              </span>
              <input
                type="number"
                min={0}
                max={l.remaining}
                value={qty[l.orderItemId] ?? 0}
                onChange={(e) => setQty((s) => ({ ...s, [l.orderItemId]: Math.min(Math.max(Number(e.target.value) || 0, 0), l.remaining) }))}
                className="h-9 w-16 rounded-[10px] border border-input bg-[#fbf9f8] px-2 text-sm tabular-nums focus:border-foreground focus:bg-white focus:outline-none"
                aria-label={`Quantité à expédier ${l.name}`}
              />
            </div>
          ))}
          <input
            value={tracking}
            onChange={(e) => setTracking(e.target.value)}
            placeholder="N° de suivi (optionnel)…"
            className="h-9 w-full rounded-[10px] border border-input bg-[#fbf9f8] px-2 text-[12px] focus:border-foreground focus:bg-white focus:outline-none"
          />
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={markShipped} onChange={(e) => setMarkShipped(e.target.checked)} className="h-4 w-4 accent-[var(--primary)]" />
            Marquer la commande expédiée si tout est parti
          </label>
          <button
            type="button"
            disabled={pending || picked.length === 0}
            onClick={submit}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
          >
            {pending && <Loader2 className="h-3 w-3 animate-spin" />}
            <PackagePlus className="h-3.5 w-3.5" /> Créer le bon de livraison
          </button>
        </div>
      )}

      {msg && <p className={`mt-2 text-[11px] ${msg.ok ? "text-primary" : "text-destructive"}`}>{msg.text}</p>}
    </section>
  );
}

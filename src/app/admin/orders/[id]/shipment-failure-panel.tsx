"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PackageX } from "lucide-react";

import { SelectField } from "@/components/ui/select-field";
import {
  SHIPMENT_RETURN_REASON_CODES,
  SHIPMENT_RETURN_REASON_LABELS,
} from "@/modules/order/returns-reasons";
import { createReturnAction } from "@/lib/actions/returns";
import type { ReturnableItem } from "./returns-panel";

const REASON_OPTIONS = SHIPMENT_RETURN_REASON_CODES.map((c) => ({
  value: c,
  label: SHIPMENT_RETURN_REASON_LABELS[c],
}));

/**
 * « Retour d'expédition » declaration — shown on a SHIPPED order whose parcel
 * never reached the customer (unreachable / wrong address / refused). It opens a
 * PENDING shipment return over the shipped lines; confirming its receipt later
 * (in the Retours panel above) restocks the goods AND cancels the order. For a
 * parcel reported LOST, tick « colis perdu » so the goods are NOT restocked.
 *
 * Separate from the SAV ReturnsPanel on purpose: it's a distinct flow (no
 * per-line picking — the whole shipped parcel bounces) with carrier metadata.
 */
export function ShipmentFailurePanel({
  orderId,
  items,
}: {
  orderId: string;
  /** The shipped/returnable lines (remaining > 0) — the whole set bounces back. */
  items: ReturnableItem[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [reasonCode, setReasonCode] = useState("");
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [attempts, setAttempts] = useState("");
  const [lost, setLost] = useState(false);
  const [note, setNote] = useState("");

  const returnable = items.filter((i) => i.remaining > 0);

  const submit = () =>
    start(async () => {
      const lines = returnable.map((i) => ({
        orderItemId: i.orderItemId,
        quantity: i.remaining,
        // « colis perdu » → not restockable (goods gone); otherwise they return.
        restockable: !lost,
      }));
      if (lines.length === 0) {
        setMsg({ ok: false, text: "Aucune ligne expédiée à retourner." });
        return;
      }
      const attemptsNum = attempts.trim() === "" ? undefined : Math.max(0, Math.trunc(Number(attempts)));
      const res = await createReturnAction({
        orderId,
        kind: "shipment",
        reasonCode: reasonCode || undefined,
        reason: note.trim() || undefined,
        carrierName: carrier.trim() || undefined,
        trackingRef: tracking.trim() || undefined,
        deliveryAttempts: Number.isFinite(attemptsNum as number) ? attemptsNum : undefined,
        lines,
      });
      setMsg({ ok: res.ok, text: res.message ?? (res.ok ? "Fait." : "Erreur.") });
      if (res.ok) {
        setReasonCode("");
        setCarrier("");
        setTracking("");
        setAttempts("");
        setLost(false);
        setNote("");
        router.refresh();
      }
    });

  return (
    <section className="rounded-[28px] border border-border bg-card p-4">
      <h2 className="mb-3 inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
        <PackageX className="h-4 w-4" /> Retour d&apos;expédition (non livré)
      </h2>
      <p className="mb-3 rounded-[14px] border border-dashed border-border bg-surface/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
        Pour un colis <strong className="text-foreground">expédié mais non livré</strong> (client
        injoignable, adresse incorrecte, refusé…). Enregistre un retour en attente du colis ; sa
        <strong className="text-foreground"> réception</strong> (panneau Retours ci-dessus)
        réintègre le stock et <strong className="text-foreground">annule la commande</strong>.
      </p>

      {returnable.length === 0 ? (
        <p className="rounded-[14px] border border-dashed border-border bg-surface/40 p-3 text-[11px] text-muted-foreground">
          Aucune ligne expédiée à retourner (tout est déjà retourné).
        </p>
      ) : (
        <div className="space-y-2">
          <SelectField
            ariaLabel="Motif de l'échec de livraison"
            options={REASON_OPTIONS}
            value={reasonCode}
            onChange={setReasonCode}
            placeholder="Motif de l'échec…"
            size="sm"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input
              type="text"
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
              placeholder="Transporteur (optionnel)"
              className="h-9 rounded-[10px] border border-input bg-[#fbf9f8] px-2 text-[12px] focus:border-foreground focus:bg-white focus:outline-none"
              aria-label="Transporteur"
            />
            <input
              type="text"
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              placeholder="N° de suivi (optionnel)"
              className="h-9 rounded-[10px] border border-input bg-[#fbf9f8] px-2 text-[12px] focus:border-foreground focus:bg-white focus:outline-none"
              aria-label="Numéro de suivi"
            />
            <input
              type="number"
              min={0}
              value={attempts}
              onChange={(e) => setAttempts(e.target.value)}
              placeholder="Tentatives"
              className="h-9 rounded-[10px] border border-input bg-[#fbf9f8] px-2 text-[12px] tabular-nums focus:border-foreground focus:bg-white focus:outline-none"
              aria-label="Nombre de tentatives de livraison"
            />
          </div>
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={lost}
              onChange={(e) => setLost(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--primary)]"
            />
            Colis perdu — ne pas réintégrer le stock à la réception
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Note interne (optionnel)…"
            className="w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] p-2 text-sm focus:border-foreground focus:bg-white focus:outline-none"
          />
          <button
            type="button"
            disabled={pending}
            onClick={submit}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
          >
            {pending && <Loader2 className="h-3 w-3 animate-spin" />}
            Déclarer le retour d&apos;expédition
          </button>
        </div>
      )}

      {msg && <p className={`mt-2 text-[11px] ${msg.ok ? "text-primary" : "text-destructive"}`}>{msg.text}</p>}
    </section>
  );
}

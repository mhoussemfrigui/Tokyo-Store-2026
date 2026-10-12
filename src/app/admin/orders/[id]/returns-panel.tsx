"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Undo2, Check, X, Info } from "lucide-react";

import { SelectField } from "@/components/ui/select-field";
import { AdminCallout } from "@/components/admin/_components/filter-bar";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
// The pure taxonomy module — NOT returns.schema (drizzle table defs, server-side).
import {
  RETURN_REASON_CODES,
  RETURN_REASON_LABELS,
  shipmentReturnReasonLabel,
} from "@/modules/order/returns-reasons";
import { createReturnAction, receiveReturnAction, rejectReturnAction } from "@/lib/actions/returns";

export type ReturnableItem = {
  orderItemId: string;
  name: string;
  variantLabel: string | null;
  remaining: number;
};
export type ExistingReturnItem = {
  name: string;
  quantity: number;
  restockable: boolean;
  restocked: boolean;
  conditionNote: string | null;
};
export type ExistingReturn = {
  id: string;
  /** after_sale = classic SAV; shipment = « Retour d'expédition » (RTO). */
  kind: "after_sale" | "shipment";
  status: "pending" | "received" | "rejected";
  reasonCode: string | null;
  reason: string | null;
  comment: string | null;
  carrierName: string | null;
  trackingRef: string | null;
  deliveryAttempts: number | null;
  createdAt: string;
  items: ExistingReturnItem[];
};

const REASON_OPTIONS = RETURN_REASON_CODES.map((c) => ({ value: c, label: RETURN_REASON_LABELS[c] }));

const STATUS_LABEL: Record<ExistingReturn["status"], string> = {
  pending: "En attente",
  received: "Reçu (réintégré)",
  rejected: "Rejeté",
};
const STATUS_CLS: Record<ExistingReturn["status"], string> = {
  pending: "border-[#f3e3bd] bg-[#fff4e0] text-[#b45309]",
  received: "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]",
  rejected: "border-[#efe9e3] bg-[#f6f2ed] text-[#5b5d62]",
};

export function ReturnsPanel({
  orderId,
  items,
  returns,
  emptyMessage,
}: {
  orderId: string;
  items: ReturnableItem[];
  returns: ExistingReturn[];
  /** Why nothing is returnable, when it isn't "already returned" (the order's
   *  status refuses returns, its goods never left, or a full refund already
   *  restocked it) — replaces the create form with this explanation. */
  emptyMessage?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // The return awaiting the « Recevoir & réintégrer » confirmation (restocks —
  // irreversible, so never on a single misclick).
  const [confirmReceive, setConfirmReceive] = useState<ExistingReturn | null>(null);
  // Per-line draft: included? qty? restockable? condition note?
  const [draft, setDraft] = useState<Record<string, { on: boolean; qty: number; restock: boolean; note: string }>>(
    Object.fromEntries(items.map((i) => [i.orderItemId, { on: false, qty: i.remaining, restock: true, note: "" }])),
  );
  const [reasonCode, setReasonCode] = useState("");
  const [comment, setComment] = useState("");

  const returnable = items.filter((i) => i.remaining > 0);
  const selected = returnable.filter((i) => draft[i.orderItemId]?.on);

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      const res = await fn();
      setMsg({ ok: res.ok, text: res.message ?? (res.ok ? "Fait." : "Erreur.") });
      // The actions call revalidatePath server-side, but this panel is invoked as a
      // direct async call (not a <form action>), so the fresh RSC payload only reaches
      // the mounted tree after a client refresh. Without this the status badge stays
      // "En attente" and the receive/reject buttons linger until a manual reload.
      // Mirrors order-status-controls.tsx / shipments-panel.tsx.
      if (res.ok) router.refresh();
    });

  const submitCreate = () =>
    run(async () => {
      const lines = selected.map((i) => {
        const d = draft[i.orderItemId];
        return {
          orderItemId: i.orderItemId,
          quantity: Math.min(Math.max(d.qty, 1), i.remaining),
          restockable: d.restock,
          conditionNote: d.note.trim() || undefined,
        };
      });
      if (lines.length === 0) return { ok: false, message: "Sélectionnez au moins une ligne." };
      return createReturnAction({
        orderId,
        reasonCode: reasonCode || undefined,
        comment: comment.trim() || undefined,
        lines,
      });
    });

  return (
    <section className="rounded-[28px] border border-border bg-card p-4">
      <h2 className="mb-3 inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
        <Undo2 className="h-4 w-4" /> Retours (SAV / RMA)
      </h2>

      {/* Operators don't always know the jargon — spell out what receiving a
          return does to stock, and the two exceptions. */}
      <AdminCallout tone="info" icon={Info} className="mb-3">
        <strong className="text-foreground">Réintégration</strong> = remettre les unités
        retournées en stock vendable. « Recevoir &amp; réintégrer » enregistre le retour et
        remet en stock les lignes cochées « réintégrable ». Décochez « réintégrable » pour un
        article endommagé (il reste hors stock).
      </AdminCallout>

      {/* Existing returns */}
      {returns.length > 0 && (
        <div className="mb-4 space-y-2">
          {returns.map((r) => (
            <div key={r.id} className="rounded-[14px] border border-border bg-[#fbf9f8] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-wrap items-center gap-1.5">
                  {r.kind === "shipment" && (
                    <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                      Retour d&apos;expédition
                    </span>
                  )}
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_CLS[r.status]}`}>
                    {STATUS_LABEL[r.status]}
                  </span>
                </span>
                {r.status === "pending" && (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => setConfirmReceive(r)}
                      className="inline-flex h-8 items-center gap-1 rounded-[10px] border border-[#cdebd6] bg-[#eaf7ee] px-2.5 text-[11px] font-bold text-[#15803d] disabled:opacity-60"
                    >
                      <Check className="h-3 w-3" />{" "}
                      {r.kind === "shipment" ? "Confirmer réception & annuler" : "Recevoir & réintégrer"}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => rejectReturnAction(r.id, orderId))}
                      className="inline-flex h-8 items-center gap-1 rounded-[10px] border-[1.5px] border-input bg-card px-2.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground disabled:opacity-60"
                    >
                      <X className="h-3 w-3" /> {r.kind === "shipment" ? "Classer (livré)" : "Rejeter"}
                    </button>
                  </div>
                )}
              </div>
              {r.kind === "shipment" && (r.carrierName || r.trackingRef || r.deliveryAttempts != null) && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {r.carrierName && <>Transporteur : {r.carrierName}</>}
                  {r.trackingRef && <> · Suivi : {r.trackingRef}</>}
                  {r.deliveryAttempts != null && <> · {r.deliveryAttempts} tentative(s)</>}
                </p>
              )}
              <ul className="mt-2 space-y-0.5 text-[12px] text-foreground">
                {r.items.map((it, idx) => (
                  <li key={idx} className="flex flex-col">
                    <span className="flex justify-between gap-2">
                      <span className="truncate">
                        {it.name} × {it.quantity}
                        {!it.restockable && <span className="ml-1 text-muted-foreground">(non réintégrable)</span>}
                      </span>
                      {it.restocked && <span className="shrink-0 text-[#15803d]">réintégré</span>}
                    </span>
                    {it.conditionNote && <span className="text-[10px] text-muted-foreground">État : {it.conditionNote}</span>}
                  </li>
                ))}
              </ul>
              {(r.reasonCode || r.reason) && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Motif :{" "}
                  {r.reasonCode
                    ? r.kind === "shipment"
                      ? shipmentReturnReasonLabel(r.reasonCode)
                      : RETURN_REASON_LABELS[r.reasonCode as keyof typeof RETURN_REASON_LABELS] ?? r.reasonCode
                    : r.reason}
                  {r.reasonCode && r.reason ? ` — ${r.reason}` : ""}
                </p>
              )}
              {r.comment && <p className="mt-0.5 text-[11px] italic text-muted-foreground">Note interne : {r.comment}</p>}
            </div>
          ))}
        </div>
      )}

      {/* Create a return */}
      {returnable.length === 0 ? (
        <AdminCallout tone="info" icon={Info}>
          {emptyMessage ?? "Aucune ligne retournable (tout est déjà retourné)."}
        </AdminCallout>
      ) : (
        <div className="space-y-2">
          <p className="text-[13px] font-bold text-foreground">Créer un retour</p>
          {returnable.map((i) => {
            const d = draft[i.orderItemId];
            return (
              <div key={i.orderItemId} className="flex flex-wrap items-center gap-2 rounded-[14px] border border-input bg-[#fbf9f8] px-3 py-2">
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={d.on}
                    onChange={(e) => setDraft((s) => ({ ...s, [i.orderItemId]: { ...s[i.orderItemId], on: e.target.checked } }))}
                    className="h-4 w-4 accent-[var(--primary)]"
                  />
                  <span className="min-w-0 truncate text-sm text-foreground">
                    {i.name}
                    {i.variantLabel ? ` — ${i.variantLabel}` : ""}{" "}
                    <span className="text-muted-foreground">(reste {i.remaining})</span>
                  </span>
                </label>
                <input
                  type="number"
                  min={1}
                  max={i.remaining}
                  value={d.qty}
                  disabled={!d.on}
                  onChange={(e) => setDraft((s) => ({ ...s, [i.orderItemId]: { ...s[i.orderItemId], qty: Number(e.target.value) } }))}
                  className="h-9 w-16 rounded-[10px] border border-input bg-[#fbf9f8] px-2 text-sm tabular-nums disabled:opacity-50"
                  aria-label={`Quantité retournée pour ${i.name}`}
                />
                <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={d.restock}
                    disabled={!d.on}
                    onChange={(e) => setDraft((s) => ({ ...s, [i.orderItemId]: { ...s[i.orderItemId], restock: e.target.checked } }))}
                    className="h-3.5 w-3.5 accent-[var(--primary)]"
                  />
                  réintégrable
                </label>
                {d.on && (
                  <input
                    type="text"
                    value={d.note}
                    onChange={(e) => setDraft((s) => ({ ...s, [i.orderItemId]: { ...s[i.orderItemId], note: e.target.value } }))}
                    placeholder="État (ex : écran rayé)…"
                    className="h-9 w-full rounded-[10px] border border-input bg-[#fbf9f8] px-2 text-[12px] focus:outline-none focus:border-foreground focus:bg-white"
                    aria-label={`État de la ligne ${i.name}`}
                  />
                )}
              </div>
            );
          })}
          <SelectField
            ariaLabel="Motif du retour"
            options={REASON_OPTIONS}
            value={reasonCode}
            onChange={setReasonCode}
            placeholder="Motif du retour (taxonomie)…"
            size="sm"
          />
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            placeholder="Note interne (optionnel) — pour l'étude SAV…"
            className="w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] p-2 text-sm focus:border-foreground focus:bg-white focus:outline-none"
          />
          <button
            type="button"
            disabled={pending || selected.length === 0}
            onClick={submitCreate}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
          >
            {pending && <Loader2 className="h-3 w-3 animate-spin" />}
            Créer le retour ({selected.length})
          </button>
        </div>
      )}

      {msg && <p className={`mt-2 text-[11px] ${msg.ok ? "text-primary" : "text-destructive"}`}>{msg.text}</p>}

      {confirmReceive && (
        <ConfirmDeleteModal
          title={
            confirmReceive.kind === "shipment"
              ? "Confirmer la réception du colis retourné ?"
              : "Recevoir ce retour et réintégrer le stock ?"
          }
          description={
            confirmReceive.kind === "shipment"
              ? "Les lignes « réintégrables » sont remises en stock vendable ET la commande est annulée (non livrée). Action définitive."
              : "Les lignes « réintégrables » sont remises en stock vendable. Action définitive : un retour reçu ne peut plus être rejeté."
          }
          preview={
            <ul className="space-y-0.5 rounded-[14px] border border-border bg-surface/40 p-3 text-[12px] text-foreground">
              {confirmReceive.items.map((it, idx) => (
                <li key={idx} className="flex justify-between gap-2">
                  <span className="truncate">
                    {it.name} × {it.quantity}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {it.restockable ? "réintégré" : "hors stock"}
                  </span>
                </li>
              ))}
            </ul>
          }
          confirmLabel={confirmReceive.kind === "shipment" ? "Confirmer & annuler" : "Recevoir & réintégrer"}
          variant="neutral"
          onCancel={() => setConfirmReceive(null)}
          onConfirm={async () => {
            const res = await receiveReturnAction(confirmReceive.id, orderId);
            if (!res.ok) return res.message ?? "Erreur.";
            setMsg({ ok: true, text: res.message ?? "Retour reçu." });
            router.refresh();
            return null;
          }}
        />
      )}
    </section>
  );
}

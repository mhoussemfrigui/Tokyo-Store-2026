"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Printer, ReceiptText, Truck, Loader2 } from "lucide-react";

import { issueInvoiceAction, issueCreditNoteAction, issueDeliveryNoteAction } from "@/lib/actions/documents";

/**
 * Documents panel (order detail) — issue + print the fiscal/logistics papers.
 * Issuing stamps a gapless number ONCE (idempotent server-side); once issued the
 * row shows the number + a print link.
 *
 * `scope` splits the documents by operator intent so each lives in the right
 * tab: the FISCAL papers (Facture + Avoir) belong in Finances, while the
 * Bon de livraison is a FULFILMENT document (auto-issued on shipment by the
 * `issue-bl-on-ship` subscriber) and belongs in Traitement, next to shipments.
 */
export function DocumentsPanel({
  orderId,
  invoiceNumber,
  creditNoteNumber,
  deliveryNoteNumber,
  hasRefund,
  deliveryNoteBlockedReason = null,
  scope = "financial",
}: {
  orderId: string;
  invoiceNumber: string | null;
  creditNoteNumber: string | null;
  deliveryNoteNumber: string | null;
  hasRefund: boolean;
  /** Why a whole-order BL must NOT be issued (parcel BLs already exist, or a
      full refund before shipping) — hides « Émettre » and shows this instead.
      The server action refuses the same cases. */
  deliveryNoteBlockedReason?: string | null;
  /** Which papers to render — `financial` = Facture + Avoir (Finances tab);
      `fulfilment` = Bon de livraison (Traitement tab). */
  scope?: "financial" | "fulfilment";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Numbers issued from THIS panel, bridging until the refreshed props carry
  // them. The server props always win once set, so a document issued elsewhere
  // (e.g. the BL auto-issued by a shipment) shows here too instead of a stale
  // « Émettre ».
  const [issuedInvoice, setInvoice] = useState<string | null>(null);
  const [issuedCredit, setCredit] = useState<string | null>(null);
  const [issuedBl, setBl] = useState<string | null>(null);
  const invoice = invoiceNumber ?? issuedInvoice;
  const credit = creditNoteNumber ?? issuedCredit;
  const bl = deliveryNoteNumber ?? issuedBl;

  const base = `/admin/orders/${orderId}`;

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, onOk: (m?: string) => void) =>
    start(async () => {
      const res = await fn();
      setMsg({ ok: res.ok, text: res.message ?? (res.ok ? "Fait." : "Erreur.") });
      if (res.ok) {
        onOk(res.message);
        // An invoice locks line editing (and the tax form) — refresh the page
        // so the other panels reflect it at once.
        router.refresh();
      }
    });

  // The action returns the number in `message` ("Facture émise : FA-2026-000001").
  const numFromMsg = (m?: string) => m?.split(":").pop()?.trim() ?? null;

  const isFulfilment = scope === "fulfilment";

  return (
    <section className="rounded-[28px] border border-border bg-card p-4 sm:p-5">
      <h2 className="mb-3 inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
        {isFulfilment ? <Truck className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
        {isFulfilment ? "Bon de livraison" : "Documents"}
      </h2>

      <div className="space-y-2.5">
        {!isFulfilment && (
          <>
            {/* Facture */}
            <DocRow
              label="Facture"
              number={invoice}
              printHref={`${base}/invoice?autoprint=1`}
              onIssue={
                invoice
                  ? null
                  : () => run(() => issueInvoiceAction(orderId), (m) => setInvoice(numFromMsg(m)))
              }
              pending={pending}
            />

            {/* Avoir (credit note) — only meaningful once a refund exists */}
            {hasRefund ? (
              <DocRow
                label="Avoir"
                number={credit}
                printHref={`${base}/invoice?doc=avoir&autoprint=1`}
                onIssue={
                  credit
                    ? null
                    : () => run(() => issueCreditNoteAction(orderId), (m) => setCredit(numFromMsg(m)))
                }
                pending={pending}
              />
            ) : (
              <p className="px-3 text-[11px] text-muted-foreground">
                Avoir : disponible après l&apos;enregistrement d&apos;un remboursement.
              </p>
            )}
          </>
        )}

        {/* Bon de livraison (price-free logistics note) — fulfilment scope */}
        {isFulfilment && (
          <>
            <DocRow
              label="Bon de livraison"
              number={bl}
              printHref={`${base}/delivery-note?autoprint=1`}
              onIssue={
                bl || deliveryNoteBlockedReason
                  ? null
                  : () => run(() => issueDeliveryNoteAction(orderId), (m) => setBl(numFromMsg(m)))
              }
              pending={pending}
            />
            {!bl && deliveryNoteBlockedReason && (
              <p className="px-3 text-[11px] text-muted-foreground">{deliveryNoteBlockedReason}</p>
            )}
          </>
        )}
      </div>

      {msg && <p className={`mt-2 text-[11px] ${msg.ok ? "text-primary" : "text-destructive"}`}>{msg.text}</p>}
    </section>
  );
}

function DocRow({
  label,
  number,
  printHref,
  onIssue,
  pending,
}: {
  label: string;
  number: string | null;
  printHref: string;
  onIssue: (() => void) | null;
  pending: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-input bg-[#fbf9f8] px-3 py-2">
      <div className="min-w-0">
        <p className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
          <ReceiptText className="h-3.5 w-3.5 text-muted-foreground" /> {label}
        </p>
        {number ? (
          <p className="font-mono text-[11px] text-muted-foreground">{number}</p>
        ) : (
          <p className="text-[11px] text-muted-foreground">Non émis</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {onIssue && (
          <button
            type="button"
            disabled={pending}
            onClick={onIssue}
            className="inline-flex h-8 items-center gap-1 rounded-[10px] bg-primary px-2.5 text-[11px] font-bold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
          >
            {pending && <Loader2 className="h-3 w-3 animate-spin" />} Émettre
          </button>
        )}
        <a
          href={printHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 items-center gap-1 rounded-[10px] border-[1.5px] border-input bg-card px-2.5 text-[11px] font-bold text-foreground hover:border-primary/40"
        >
          <Printer className="h-3 w-3" /> Imprimer
        </a>
      </div>
    </div>
  );
}

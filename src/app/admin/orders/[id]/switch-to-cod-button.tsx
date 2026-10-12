"use client";

import { useState } from "react";
import { Truck } from "lucide-react";

import { switchOrderToCodAction } from "@/lib/actions/order";
import { useRefreshAction } from "@/hooks/use-refresh-action";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";

/**
 * « Basculer en paiement à la livraison » — for a stuck pending online order whose
 * gateway payment never completed. Converts it to COD so it can be prepared and
 * settled at delivery instead of being cancelled by the abandoned-orders sweep.
 *
 * The action re-verifies the gateway fail-closed: if the payment was actually
 * captured (or a session is still live) the switch is REFUSED — so this can never
 * silently downgrade a paid order. A confirm modal spells that out.
 */
export function SwitchToCodButton({ orderId }: { orderId: string }) {
  const { router } = useRefreshAction();
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => {
          setErr(null);
          setConfirming(true);
        }}
        className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[11.5px] font-bold text-foreground transition hover:border-primary/40 hover:text-primary"
      >
        <Truck className="h-3.5 w-3.5" />
        Basculer en paiement à la livraison
      </button>
      {err && (
        <p className="mt-2 rounded-[14px] border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          {err}
        </p>
      )}

      {confirming && (
        <ConfirmDeleteModal
          title="Basculer en paiement à la livraison ?"
          description="Le paiement en ligne de cette commande n'a pas abouti. Elle sera encaissée à la livraison (COD) et pourra être préparée normalement."
          preview={
            <ul className="list-disc space-y-1 rounded-[14px] border border-border bg-surface/40 py-2.5 pl-7 pr-3 text-[11px] leading-relaxed text-muted-foreground">
              <li>La commande reste « En attente » puis suit le parcours COD (préparation → expédition → livraison).</li>
              <li>Le paiement est vérifié une dernière fois : si un règlement en ligne est détecté, la bascule est refusée (aucun risque de double encaissement).</li>
              <li>La référence de paiement en ligne (session abandonnée) est effacée.</li>
            </ul>
          }
          confirmLabel="Basculer en COD"
          icon={Truck}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            const res = await switchOrderToCodAction(orderId);
            if (!res.ok) {
              setConfirming(false);
              setErr(res.message);
              return null; // close the modal; the error shows below the button
            }
            router.refresh(); // reflect the new COD method + transition graph
            return null;
          }}
        />
      )}
    </div>
  );
}

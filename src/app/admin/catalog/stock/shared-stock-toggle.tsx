"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";

import { setVariantStockDefaultAction } from "@/lib/actions/catalog";

/**
 * The GLOBAL default variant-stock mode toggle (partagé ↔ par variante). Each
 * variable product can still override it; this sets the default for those that
 * don't. Lives in the Stock → Réglages tab. Optimistic with a confirm prompt +
 * revert on failure.
 */
export function SharedStockToggle({
  initial,
  disabled = false,
}: {
  initial: boolean;
  disabled?: boolean;
}) {
  const [shared, setShared] = useState(initial);
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending || disabled}
      onClick={() => {
        const next = !shared;
        // Important setting → confirm before switching (it changes how EVERY
        // variable product without its own override tracks stock).
        const msg = next
          ? "Définir le stock des variantes sur PARTAGÉ par défaut ?\n\nLes produits variables sans réglage propre partageront un seul pool de stock (au lieu d'un stock par variante)."
          : "Définir le stock des variantes sur PAR VARIANTE par défaut ?\n\nChaque variante des produits variables suivra son propre stock (au lieu d'un pool partagé).";
        if (!window.confirm(msg)) return;
        start(async () => {
          setShared(next);
          try {
            const res = await setVariantStockDefaultAction(next);
            if (!res.ok) setShared(!next); // revert on failure
          } catch {
            setShared(!next); // a thrown action (e.g. permission) must not leave the pill wrong
          }
        });
      }}
      title={
        disabled
          ? "Mode de stock par défaut des variantes — lecture seule"
          : "Mode de stock par défaut des variantes (surchargé par produit)"
      }
      className={`inline-flex h-10 items-center gap-2 rounded-full px-4 text-xs font-bold transition ${
        disabled ? "cursor-not-allowed opacity-60" : ""
      } ${
        shared
          ? "bg-[#fdecef] text-[#d40530]"
          : "border-[1.5px] border-input bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      Stock variantes : {shared ? "partagé" : "par variante"} (défaut)
    </button>
  );
}

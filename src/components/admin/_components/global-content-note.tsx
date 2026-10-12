import Link from "next/link";
import { Info } from "lucide-react";

/**
 * Inline signpost for the category / brand editors: the trust badges (livraison /
 * retours / garantie) shown at the top of the landing page are GLOBAL checkout
 * settings — not per-entity. This tells the operator where the content they see
 * actually lives (it IS editable, just elsewhere), resolving the "this isn't
 * editable" confusion.
 */
export function GlobalContentNote() {
  return (
    <div className="flex items-start gap-2 rounded-2xl border border-dashed border-border bg-surface/40 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        Les <span className="font-medium text-foreground">badges de confiance</span> (livraison,
        retours, garantie) affichés en haut de cette page sont des réglages{" "}
        <span className="font-medium">globaux</span> partagés par toutes les pages — modifiez-les
        dans{" "}
        <Link href="/admin/system/checkout" className="font-medium text-primary hover:underline">
          Réglages → Caisse
        </Link>
        .
      </span>
    </div>
  );
}

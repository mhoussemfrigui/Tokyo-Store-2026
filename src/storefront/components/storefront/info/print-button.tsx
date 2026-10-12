"use client";

import { Printer } from "lucide-react";

/** The legal pages' « Imprimer » action (hero). Client-only (window.print). */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="flex h-11 items-center gap-2 rounded-full border-[1.5px] border-border bg-card px-4 text-sm font-bold text-foreground transition-colors hover:border-foreground"
    >
      <Printer aria-hidden className="size-[15px]" strokeWidth={2} />
      Imprimer
    </button>
  );
}

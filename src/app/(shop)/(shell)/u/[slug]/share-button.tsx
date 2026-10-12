"use client";

import { useState } from "react";
import { Share2, Check } from "lucide-react";

/**
 * Medusa-style "Partager" pill for the public profile hero. Copies the current
 * profile URL to the clipboard (with a transient "Lien copié" confirmation).
 * Falls back to the Web Share sheet on devices that support it.
 */
export function ShareProfileButton({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    const url = `${window.location.origin}/u/${slug}`;
    try {
      if (navigator.share) {
        await navigator.share({ url });
        return;
      }
    } catch {
      /* user dismissed the share sheet — fall through to copy */
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  return (
    <button
      type="button"
      onClick={handleShare}
      className="group mt-5 inline-flex items-center gap-2 rounded-full border border-border/80 bg-background/60 px-4 py-2.5 transition-all duration-300 hover:border-border hover:bg-background active:scale-95 sm:mt-6 sm:py-2"
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-olive" strokeWidth={2} />
          <span className="text-[0.65rem] uppercase tracking-[0.18em] text-foreground/80">
            Lien copié
          </span>
        </>
      ) : (
        <>
          <Share2
            className="h-3.5 w-3.5 text-foreground/60 transition-colors group-hover:text-foreground"
            strokeWidth={1.5}
          />
          <span className="text-[0.65rem] uppercase tracking-[0.18em] text-foreground/80">
            Partager
          </span>
        </>
      )}
    </button>
  );
}

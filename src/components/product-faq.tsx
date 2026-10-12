"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

/**
 * Product FAQ accordion — DB-driven, embedded by the CMS/landing blocks
 * (the home + page composers, the boutique and marques pages).
 *
 * `ProductFaqAccordion` is the bare accordion (no section shell, no heading),
 * exported for embedding inside a block, an admin preview, or a future help
 * centre.
 *
 * FAQs are fetched server-side (`faqService.listByProductId`) and passed in
 * as a prop, keeping this client component free of any DB/settings access.
 */

export type ProductFaqItem = { question: string; answer: string };

/** Accent for the open/hover state of the toggle. `olive` is the PDP's native tone (the
 *  default, so the product page is untouched); the home composer passes `gold` or `ink`
 *  to match the block's chosen title accent, with a slightly firmer answer contrast. */
type FaqAccent = "olive" | "gold" | "ink";
const FAQ_ACCENT: Record<FaqAccent, { on: string; hover: string }> = {
  olive: { on: "text-olive", hover: "group-hover:text-olive/70" },
  gold: { on: "text-gold", hover: "group-hover:text-gold/70" },
  ink: { on: "text-foreground", hover: "group-hover:text-foreground/60" },
};

/**
 * Pure accordion — no surrounding section, no heading. Embed inside a tab,
 * an admin preview, the home FAQ block, etc.
 */
export function ProductFaqAccordion({ faqs, accent = "olive" }: { faqs: ProductFaqItem[]; accent?: FaqAccent }) {
  const [open, setOpen] = useState<number | null>(null);

  if (faqs.length === 0) return null;
  const mark = FAQ_ACCENT[accent] ?? FAQ_ACCENT.olive;
  // The home variants read on an open ivory ground — a touch more contrast than the PDP's
  // boxed /60 keeps the answers legible.
  const answerTone = accent === "olive" ? "text-foreground/60" : "text-foreground/75";

  return (
    <ul className="border-t border-border/30">
      {faqs.map((f, i) => {
        const isOpen = open === i;
        return (
          <li key={`${f.question}-${i}`} className="border-b border-border/30">
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : i)}
              aria-expanded={isOpen}
              className="group flex min-h-[44px] w-full items-center justify-between gap-4 py-5 text-left"
            >
              <span
                className={`font-serif text-base tracking-wide transition-colors duration-300 sm:text-lg ${
                  isOpen ? "text-foreground" : "text-foreground/80 group-hover:text-foreground"
                }`}
              >
                {f.question}
              </span>
              <Plus
                className={`h-4 w-4 shrink-0 transition-[rotate,color] duration-300 ${
                  isOpen ? `rotate-45 ${mark.on}` : `text-muted-foreground/60 ${mark.hover}`
                }`}
                strokeWidth={1.75}
              />
            </button>
            {/* Grid-rows collapse so the answer height animates open/closed
                with CSS only (no framer-motion). */}
            <div
              className={`grid transition-all duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] ${
                isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
              }`}
            >
              <div className="overflow-hidden">
                <p className={`pb-5 text-[0.9rem] leading-[1.8] tracking-wide ${answerTone}`}>
                  {f.answer}
                </p>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

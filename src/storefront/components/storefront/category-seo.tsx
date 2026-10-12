"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  CreditCard,
  Plus,
  RefreshCw,
  ShieldCheck,
  Store,
  Truck,
  Wrench,
} from "lucide-react";

import { SectionHeading } from "@/storefront/components/storefront/section-heading";
import {
  btn,
  card,
  chip,
  panel,
  panelPad,
  promise,
  rhythm,
} from "@/storefront/components/storefront/ui-classes";
import { getCategoryFaq, getCategoryIntro } from "@/storefront/lib/categorySeo";
import { cn } from "@/storefront/lib/utils";

const COLLAPSED_INTRO = 140;

const guarantees = [
  {
    icon: ShieldCheck,
    title: "Garantie jusqu'à 24 mois",
    text: "Neuf sous garantie constructeur, reconditionné garanti par Tokyo Store.",
  },
  {
    icon: Truck,
    title: "Livraison 24h en Tunisie",
    text: "Expédition le jour même pour toute commande validée avant 15h.",
  },
  {
    icon: Store,
    title: "3 boutiques en Tunisie",
    text: "Lac 2 · La Marsa · Menzah 5 — retrait gratuit et essai sur place.",
  },
  {
    icon: RefreshCw,
    title: "Reprise immédiate",
    text: "Estimation gratuite de votre ancien appareil, déduite de votre achat.",
  },
  {
    icon: Wrench,
    title: "Atelier Tokyo Repair",
    text: "Réparation smartphones, tablettes, PC, consoles et objets connectés.",
  },
  {
    icon: CreditCard,
    title: "Paiement à la livraison",
    text: "Payez à la réception, par carte bancaire ou directement en boutique.",
  },
];

const relatedLinks = [
  { to: "/iphone", label: "iPhone" },
  { to: "/smartphone", label: "Smartphones" },
  { to: "/apple", label: "Univers Apple" },
  { to: "/audio", label: "Audio & Casques" },
  { to: "/gaming", label: "Consoles & Gaming" },
  { to: "/accessoires", label: "Accessoires" },
];

/**
 * The listing's editorial tail: a collapsible intro island, the guarantees,
 * the FAQ and the related links. Each block is a top-level section on the
 * site rhythm (56 / 64 / 80px apart, the same gap as the results above), with
 * the site's section heading, and every surface is an island or a card.
 */
export function CategorySeo({ label }: { label: string }) {
  const intro = getCategoryIntro(label);
  const faq = getCategoryFaq(label);
  const [open, setOpen] = useState<number | null>(null);

  const [openIntro, setOpenIntro] = useState(false);
  const introRef = useRef<HTMLDivElement>(null);
  const [introHeight, setIntroHeight] = useState(COLLAPSED_INTRO);
  const measureIntro = () => {
    if (introRef.current) setIntroHeight(introRef.current.getBoundingClientRect().height);
  };
  useLayoutEffect(measureIntro, [label]);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || !introRef.current) return;
    const ro = new ResizeObserver(measureIntro);
    ro.observe(introRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div className={rhythm.section}>
      {/* Editorial intro, collapsible. The copy is capped at 72ch: at full
          width it ran to ~170 characters a line on desktop. */}
      <section aria-labelledby="cat-intro-title" className={cn(panel, panelPad)}>
        <h2 id="cat-intro-title" className="title-block text-foreground">
          {label} en Tunisie — Tokyo Store
        </h2>

        {/* mt-4: the in-panel title-block → content step, as in the related
            links panel below. */}
        <div className="relative mt-4 max-w-[72ch] text-[15px] leading-relaxed">
          <div
            id="cat-intro-text"
            className="overflow-hidden transition-[height] duration-[420ms] ease-soft"
            style={{ height: openIntro ? introHeight : COLLAPSED_INTRO }}
            onTransitionEnd={() => {
              if (openIntro) measureIntro();
            }}
          >
            <div ref={introRef} className="space-y-3 pb-2">
              <p className="text-foreground">{intro.lead}</p>
              {intro.paragraphs.map((p) => (
                <p key={p} className="text-muted-foreground">
                  {p}
                </p>
              ))}
            </div>
          </div>
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background via-background/85 to-transparent transition-opacity duration-[420ms] ease-soft",
              openIntro ? "opacity-0" : "opacity-100",
            )}
          />
        </div>

        <button
          type="button"
          onClick={() => setOpenIntro((v) => !v)}
          aria-expanded={openIntro}
          aria-controls="cat-intro-text"
          className={cn(btn.base, btn.md, btn.outline, "mt-3")}
        >
          {openIntro ? "Réduire" : "Lire la suite"}
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 transition-transform duration-[420ms] ease-soft",
              openIntro && "rotate-180",
            )}
          />
        </button>
      </section>

      {/* Garanties & services — the shared reassurance tile (disc on the
          left, as on home and the product page). Six of them: three columns
          from lg keep two full, short rows at every width. Six across from
          2xl left 129px of text beside the disc at 1536 (5-line tiles). */}
      <section aria-labelledby="cat-guarantees-title" className={rhythm.section}>
        <SectionHeading id="cat-guarantees-title" title="Nos garanties & services" />
        <ul
          className={cn("grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3", rhythm.gap, rhythm.head)}
        >
          {guarantees.map((g) => (
            <li key={g.title} className={cn(card, promise.tile)}>
              <span className={promise.disc}>
                <g.icon aria-hidden className="size-5" />
              </span>
              <div className="min-w-0">
                <h3 className={promise.title}>{g.title}</h3>
                <p className={promise.copy}>{g.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* FAQ — one full-width island (owner choice); answers capped at 72ch. */}
      <section aria-labelledby="cat-faq-title" className={rhythm.section}>
        <SectionHeading id="cat-faq-title" title="Questions fréquentes" />
        <div className={cn(panel, "divide-y divide-border overflow-hidden", rhythm.head)}>
          {faq.map((f, i) => {
            const isOpen = open === i;
            return (
              <div
                key={f.q}
                className={cn(
                  "transition-colors duration-200 first:rounded-t-island",
                  isOpen ? "bg-surface-warm/60" : "last:rounded-b-island",
                )}
              >
                {/* The island clips its rows, so the ring is drawn inside,
                    following the island's corners on the first and last row. */}
                <button
                  type="button"
                  id={`cat-faq-q-${i}`}
                  onClick={() => setOpen(isOpen ? null : i)}
                  aria-expanded={isOpen}
                  aria-controls={`cat-faq-a-${i}`}
                  className="flex w-full items-center gap-3 rounded-[inherit] px-4 py-4 text-left transition-colors duration-200 hover:text-primary focus-visible:-outline-offset-2 lg:px-5"
                >
                  <span
                    className={cn(
                      "grid size-7 shrink-0 place-items-center rounded-full border transition-colors duration-200",
                      isOpen
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-primary",
                    )}
                  >
                    <Plus
                      aria-hidden
                      className={cn(
                        "size-3.5 transition-transform duration-[420ms] ease-soft",
                        isOpen && "rotate-45",
                      )}
                    />
                  </span>
                  <span className="min-w-0 flex-1 text-[15px] font-semibold leading-snug">
                    {f.q}
                  </span>
                </button>
                <div
                  id={`cat-faq-a-${i}`}
                  role="region"
                  aria-labelledby={`cat-faq-q-${i}`}
                  aria-hidden={!isOpen}
                  className={cn(
                    "grid transition-[grid-template-rows,opacity] duration-[420ms] ease-soft",
                    isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                  )}
                >
                  <div className="overflow-hidden">
                    {/* Row padding + the 28px disc + the 12px gap: the answer
                        starts on the question's text line. */}
                    <div className="pb-4 pl-[3.5rem] pr-4 lg:pl-[3.75rem] lg:pr-5">
                      <p className="max-w-[72ch] text-[15px] leading-relaxed text-muted-foreground">
                        {f.a}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Related links — the same block as the product page's "Recherches
          associées". */}
      <section aria-labelledby="cat-links-title" className={cn(panel, panelPad, rhythm.section)}>
        <h2 id="cat-links-title" className="title-block text-foreground">
          Continuer vos achats
        </h2>
        <ul className="mt-4 flex flex-wrap gap-x-2 gap-y-3">
          {relatedLinks.map((c) => (
            <li key={c.to}>
              <Link href={c.to} className={cn(chip.base, chip.sm, chip.neutral, "hit-44")}>
                {c.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

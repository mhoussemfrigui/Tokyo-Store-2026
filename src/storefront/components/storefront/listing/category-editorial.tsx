"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Phone } from "lucide-react";

import { getCategoryFaq, getCategoryIntro } from "@/storefront/lib/categorySeo";
import { cn } from "@/storefront/lib/utils";

const COLLAPSED = 200;
const SERVICE_PHONE = "50059160";

/**
 * The category editorial tail (Normal V1): a collapsible "about" block and a
 * master-detail FAQ (vertical tablist + cross-fading answer panel). Copy is the
 * real per-category SEO content (`getCategoryIntro` / `getCategoryFaq`).
 */
export function CategoryEditorial({ label }: { label: string }) {
  const intro = getCategoryIntro(label);
  const faq = getCategoryFaq(label);
  const paras = [intro.lead, ...intro.paragraphs];

  /* About — measured collapse with a bottom fade. */
  const [open, setOpen] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const innerRef = useRef<HTMLDivElement>(null);
  const measure = () => {
    const el = innerRef.current;
    if (el) setCanExpand(el.scrollHeight > COLLAPSED + 20);
  };
  useLayoutEffect(measure, [label]);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || !innerRef.current) return;
    const ro = new ResizeObserver(measure);
    ro.observe(innerRef.current);
    return () => ro.disconnect();
  }, []);

  /* FAQ — selected question (master-detail). */
  const [active, setActive] = useState(0);

  return (
    <>
      {/* About */}
      <section
        aria-labelledby="cat-about-title"
        className="flex flex-col gap-7 rounded-[36px] bg-background p-7 sm:p-10 lg:p-14"
      >
        <h2
          id="cat-about-title"
          className="text-[clamp(28px,3vw,44px)] font-extrabold tracking-[-0.03em] text-foreground"
        >
          {label} en Tunisie — Tokyo Store
        </h2>
        <div className="relative max-w-[820px]">
          <div
            className="overflow-hidden transition-[max-height] duration-500 ease-out"
            style={{ maxHeight: open || !canExpand ? 4000 : COLLAPSED }}
          >
            <div ref={innerRef} className="space-y-4">
              {paras.map((p, i) => (
                <p
                  key={i}
                  className={cn(
                    "text-[17px] leading-relaxed text-pretty",
                    i === 0 ? "text-foreground" : "text-graphite",
                  )}
                >
                  {p}
                </p>
              ))}
            </div>
          </div>
          {canExpand && !open && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-[90px] bg-gradient-to-t from-background to-transparent"
            />
          )}
        </div>
        {canExpand && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex h-[46px] w-fit items-center gap-2 rounded-full border-[1.5px] border-foreground bg-background px-5 text-[14px] font-bold text-foreground transition-colors duration-200 hover:bg-foreground hover:text-background"
          >
            {open ? "Réduire" : "Lire la suite"}
            <ChevronDown
              aria-hidden
              className={cn("size-3.5 transition-transform duration-300", open && "rotate-180")}
              strokeWidth={2.4}
            />
          </button>
        )}
      </section>

      {/* FAQ — master / detail */}
      {faq.length > 0 && (
        <section aria-labelledby="cat-faq-title" className="flex flex-col gap-6 px-1 pb-10 pt-6">
          <h2
            id="cat-faq-title"
            className="text-[clamp(28px,3vw,44px)] font-extrabold tracking-[-0.03em] text-foreground"
          >
            Questions fréquentes
          </h2>
          <div className="grid items-stretch gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr))]">
            {/* Tablist */}
            <div role="tablist" aria-label="Questions" className="flex flex-col gap-2">
              {faq.map((f, i) => {
                const on = active === i;
                return (
                  <button
                    key={f.q}
                    role="tab"
                    aria-selected={on}
                    onClick={() => setActive(i)}
                    className={cn(
                      "grid min-h-[72px] grid-cols-[32px_minmax(0,1fr)_16px] items-center gap-4 rounded-[24px] py-3 pl-5 pr-6 text-left transition-colors duration-200",
                      on ? "bg-foreground text-background" : "bg-background text-foreground hover:bg-surface-warm",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-8 place-items-center rounded-full text-[12px] font-extrabold tabular-nums transition-colors duration-200",
                        on ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
                      )}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="line-clamp-2 text-[15px] font-bold leading-5">{f.q}</span>
                    <ChevronRight
                      aria-hidden
                      className={cn("size-4 transition-opacity duration-200", on ? "opacity-100" : "opacity-30")}
                      strokeWidth={2.2}
                    />
                  </button>
                );
              })}
            </div>
            {/* Detail panel (cross-fade) */}
            <div
              role="tabpanel"
              className="grid min-h-[312px] rounded-[24px] bg-background p-8"
            >
              {faq.map((f, i) => {
                const on = active === i;
                return (
                  <div
                    key={f.q}
                    aria-hidden={!on}
                    className={cn(
                      "col-start-1 row-start-1 flex flex-col transition-opacity duration-300",
                      on ? "opacity-100" : "pointer-events-none opacity-0",
                    )}
                  >
                    <span className="text-[12px] font-extrabold uppercase leading-4 tracking-[0.16em] text-primary">
                      Question {String(i + 1).padStart(2, "0")}
                    </span>
                    <h3 className="mt-3 text-[24px] font-extrabold leading-8 tracking-[-0.02em] text-balance">
                      {f.q}
                    </h3>
                    <p className="mt-4 max-w-[60ch] text-[16px] leading-relaxed text-graphite text-pretty">
                      {f.a}
                    </p>
                    <div className="mt-auto pt-6">
                      <a
                        href={`tel:+216${SERVICE_PHONE}`}
                        className="flex h-12 items-center justify-between gap-4 rounded-full bg-secondary py-0 pl-5 pr-2 text-[14px] text-foreground transition-colors duration-200 hover:bg-primary/10"
                      >
                        <span>Une autre question&nbsp;?</span>
                        <span className="flex h-8 items-center gap-2 rounded-full bg-foreground px-3.5 font-bold text-background">
                          <Phone aria-hidden className="size-3.5" strokeWidth={2} />
                          50&nbsp;059&nbsp;160
                        </span>
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}
    </>
  );
}

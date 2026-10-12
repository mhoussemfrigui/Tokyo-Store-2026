"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ShieldAlert } from "lucide-react";

import { cn } from "@/storefront/lib/utils";

import { SectionHead } from "./info-kit";

/**
 * LegalDoc — the crimson « info pages » legal article: an amber draft note, a
 * facts grid, numbered sections with a sticky Sommaire (scroll-spy), and a
 * local-state cookie-preferences panel with ON/OFF switches. All demo state,
 * no backend. Built on the storefront theme tokens so it stays themeable.
 */
export function LegalDoc(props: {
  header: { eyebrow?: string; title?: string; subtitle?: string };
  draftNote: string;
  facts: { label: string; value: string; pending: boolean }[];
  sections: { heading: string; body: string[] }[];
  cookiePrefs: { key: string; label: string; description: string; locked: boolean }[];
  showToc: boolean;
  email: string;
}) {
  const { header, draftNote, facts, sections, cookiePrefs, showToc, email } = props;

  const twoCol = showToc && sections.length > 1;
  const hasHead = Boolean(header.eyebrow || header.title || header.subtitle);

  // Cookie-preferences local state: locked categories default on, others off.
  const [prefs, setPrefs] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(cookiePrefs.map((c) => [c.key, c.locked])),
  );
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashSaved = () => {
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1800);
  };
  const toggle = (key: string, locked: boolean) => {
    if (locked) return;
    setPrefs((p) => ({ ...p, [key]: !p[key] }));
    setSaved(false);
  };
  const rejectAll = () => {
    setPrefs((p) => {
      const next: Record<string, boolean> = { ...p };
      for (const c of cookiePrefs) if (!c.locked) next[c.key] = false;
      return next;
    });
    flashSaved();
  };
  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  // Scroll-spy: active = the last section whose top has passed 160px.
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!twoCol) return;
    const onScroll = () => {
      let current = 0;
      for (let i = 0; i < sections.length; i += 1) {
        const el = document.getElementById(`s${i}`);
        if (el && el.getBoundingClientRect().top < 160) current = i;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [twoCol, sections.length]);

  const numbers = useMemo(
    () => sections.map((_, i) => String(i + 1).padStart(2, "0")),
    [sections],
  );

  return (
    <div className="flex flex-col gap-6">
      {hasHead && <SectionHead header={header} />}

      <div
        className={cn(
          "grid items-start gap-5",
          twoCol && "min-[1180px]:grid-cols-[minmax(0,1fr)_260px]",
        )}
      >
        <article className="flex min-w-0 flex-col gap-[clamp(28px,3vw,40px)] rounded-[clamp(22px,4vw,52px)] bg-card p-[clamp(22px,4vw,52px)]">
          {/* 1. Amber draft note */}
          {draftNote && (
            <div className="flex items-start gap-3 rounded-[20px] border border-[#f5e0b3] bg-[#fff7e6] p-[16px_18px] text-[14px] leading-[1.55] text-[#6b4e12]">
              <ShieldAlert aria-hidden className="shrink-0" size={18} color="#b7791f" />
              <span>{draftNote}</span>
            </div>
          )}

          {/* 2. Facts grid */}
          {facts.length > 0 && (
            <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))]">
              {facts.map((fact, i) => (
                <div
                  key={i}
                  className="flex min-w-0 flex-col gap-1.5 rounded-[20px] border border-border bg-muted p-[16px_18px]"
                >
                  <span className="text-[12px] font-extrabold uppercase tracking-[0.1em] text-muted-foreground">
                    {fact.label}
                  </span>
                  <span
                    className={cn(
                      "text-[15px] font-bold [overflow-wrap:anywhere]",
                      fact.pending ? "text-[#b7791f]" : "text-foreground",
                    )}
                  >
                    {fact.value}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* 3. Numbered sections */}
          {sections.map((section, i) => (
            <div key={i} id={`s${i}`} className="flex scroll-mt-24 flex-col gap-3.5">
              <h2 className="m-0 flex items-baseline gap-3.5 text-[clamp(20px,2vw,26px)] font-black leading-[1.2] tracking-[-0.02em]">
                <span className="shrink-0 text-[14px] font-black text-primary tabular-nums">
                  {numbers[i]}
                </span>
                {section.heading}
              </h2>
              {section.body.map((para, j) => (
                <p
                  key={j}
                  className="m-0 max-w-[74ch] text-[16px] leading-[1.7] text-graphite text-pretty"
                >
                  {para}
                </p>
              ))}
            </div>
          ))}

          {/* 4. Cookie-preferences panel */}
          {cookiePrefs.length > 0 && (
            <div className="flex flex-col gap-3 rounded-[28px] bg-muted p-[clamp(18px,2.4vw,26px)]">
              <h3 className="m-0 text-[20px] font-black">Vos préférences</h3>
              {cookiePrefs.map((category) => {
                const on = prefs[category.key] ?? false;
                return (
                  <div
                    key={category.key}
                    className="flex items-center gap-4 rounded-[20px] bg-card p-[16px_18px]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] font-extrabold">{category.label}</div>
                      <div className="text-[13px] leading-[1.5] text-muted-foreground">
                        {category.description}
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={category.label}
                      disabled={category.locked}
                      onClick={() => toggle(category.key, category.locked)}
                      className={cn(
                        "flex h-[30px] w-[52px] shrink-0 rounded-full p-[3px] transition-colors",
                        on ? "bg-success" : "bg-muted-foreground/40",
                        category.locked && "cursor-not-allowed opacity-60",
                      )}
                    >
                      <span
                        className={cn(
                          "size-6 rounded-full bg-card shadow transition-transform",
                          on && "translate-x-[22px]",
                        )}
                      />
                    </button>
                  </div>
                );
              })}
              <div className="flex flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={flashSaved}
                  className={cn(
                    "inline-flex h-14 w-max max-w-full items-center justify-center gap-2.5 rounded-full px-6 text-[15px] font-bold text-primary-foreground transition-[filter] hover:brightness-95",
                    saved ? "bg-success" : "bg-primary",
                  )}
                >
                  {saved && <Check aria-hidden size={18} />}
                  {saved ? "Préférences enregistrées" : "Enregistrer mes choix"}
                </button>
                <button
                  type="button"
                  onClick={rejectAll}
                  className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-foreground bg-transparent px-[18px] text-sm font-bold text-foreground"
                >
                  Tout refuser
                </button>
              </div>
            </div>
          )}

          {/* 5. Footer note */}
          <div className="flex flex-wrap items-center justify-between gap-3.5 border-t border-border pt-6 text-sm text-muted-foreground">
            <span>
              Une question sur ce document ?{" "}
              <a href={`mailto:${email}`} className="font-bold text-primary">
                {email}
              </a>
            </span>
            <span>tokyostores.tn</span>
          </div>
        </article>

        {/* Sommaire (TOC) with scroll-spy */}
        {twoCol && (
          <nav
            aria-label="Sommaire"
            className="sticky top-3 flex flex-col gap-0.5 rounded-[28px] bg-card p-[18px]"
          >
            <span className="px-2.5 pb-2.5 text-[11px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground">
              Sommaire
            </span>
            {sections.map((section, i) => (
              <button
                key={i}
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(`s${i}`)?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
                }}
                className={cn(
                  "flex items-baseline gap-2.5 rounded-[14px] p-[9px_10px] text-left text-sm font-semibold leading-[1.35] hover:bg-muted",
                  active === i ? "bg-primary/10 text-primary" : "",
                )}
              >
                <span className="shrink-0 text-[12px] font-black text-primary">{numbers[i]}</span>
                {section.heading}
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}

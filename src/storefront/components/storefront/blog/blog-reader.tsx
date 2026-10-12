"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/storefront/lib/utils";

type Section = { id: string; label: string };

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function scrollToSection(id: string, offset: number) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const el = document.getElementById(id);
  if (!el) return;
  window.scrollTo({
    top: el.getBoundingClientRect().top + window.scrollY + offset,
    behavior: "smooth",
  });
}

function useArticleProgress(sections: Section[] = []) {
  const [state, setState] = useState<{ progress: number; active: number }>({
    progress: 0,
    active: 0,
  });
  // Keep the latest sections in a ref so the effect can run ONCE (a fresh `[]`
  // default or a new array prop each render must never re-subscribe — that would
  // loop setState → render → effect).
  const sectionsRef = useRef<Section[]>(sections);
  sectionsRef.current = sections;

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    let frame = 0;
    let last = { progress: -1, active: -1 };

    const measure = () => {
      frame = 0;
      const article = document.querySelector("article");
      let progress = 0;
      if (article) {
        const r = article.getBoundingClientRect();
        const total = r.height - window.innerHeight * 0.6;
        progress = clamp(-r.top / Math.max(1, total), 0, 1);
      }

      let active = 0;
      const secs = sectionsRef.current;
      for (let i = 0; i < secs.length; i++) {
        const el = document.getElementById(secs[i]!.id);
        if (el && el.getBoundingClientRect().top < 180) active = i;
      }

      const rounded = Math.round(progress * 1000);
      if (rounded !== last.progress || active !== last.active) {
        last = { progress: rounded, active };
        setState({ progress, active });
      }
    };

    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    measure();

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return state;
}

export function BlogProgressBar() {
  const { progress } = useArticleProgress();

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[60] h-1 w-full"
    >
      <span
        className="block h-full origin-left rounded-r bg-primary"
        style={{ transform: "scaleX(" + progress + ")" }}
      />
    </div>
  );
}

export function BlogToc(props: { sections: Section[] }) {
  const { sections } = props;
  const { progress, active } = useArticleProgress(sections);

  return (
    <nav
      aria-label="Sommaire"
      className="sticky top-16 flex flex-col gap-0.5 rounded-[28px] bg-card p-[18px]"
    >
      <div className="flex items-center justify-between px-2.5 pb-2.5">
        <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground">
          Sommaire
        </span>
        <span className="tabular-nums text-primary">
          {Math.round(progress * 100) + " %"}
        </span>
      </div>

      {sections.map((s, i) => {
        const isActive = i === active;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => scrollToSection(s.id, -20)}
            className={cn(
              "flex items-baseline gap-2.5 rounded-[14px] p-[9px_10px] text-left text-sm font-semibold leading-[1.35] hover:bg-muted",
              isActive ? "bg-primary/10 text-primary" : "text-graphite",
            )}
          >
            <span className="w-[22px] shrink-0 text-[12px] font-black text-primary">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span>{s.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

export function BlogTocMobile(props: { sections: Section[] }) {
  const { sections } = props;
  const { progress, active } = useArticleProgress(sections);
  const [open, setOpen] = useState(false);

  return (
    <div className="sticky top-2 z-20 overflow-hidden rounded-[24px] bg-card shadow-[0_10px_30px_rgba(14,18,24,0.08)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[60px] w-full items-center gap-3 p-[10px_14px]"
      >
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
          style={{
            background:
              "conic-gradient(var(--primary) " +
              Math.round(progress * 360) +
              "deg, #ece6df 0)",
          }}
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-card text-[10px] font-black text-primary">
            {Math.round(progress * 100) + "%"}
          </span>
        </span>

        <span className="flex min-w-0 flex-1 flex-col text-left">
          <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground">
            Sommaire
          </span>
          <span className="truncate text-[15px] font-extrabold text-foreground">
            {sections[active]?.label}
          </span>
        </span>

        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
          <ChevronDown
            className={cn(
              "h-4 w-4 text-graphite transition-transform",
              open && "rotate-180",
            )}
          />
        </span>
      </button>

      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-0.5 p-[10px_14px]">
            {sections.map((s, i) => {
              const isActive = i === active;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    scrollToSection(s.id, -90);
                  }}
                  className={cn(
                    "flex min-h-[46px] items-baseline gap-2.5 rounded-[14px] p-[9px_10px] text-left text-sm font-semibold leading-[1.35] hover:bg-muted",
                    isActive ? "bg-primary/10 text-primary" : "text-graphite",
                  )}
                >
                  <span className="w-[22px] shrink-0 text-[12px] font-black text-primary">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>{s.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { ArrowRight, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "@/storefront/lib/utils";

import { INFO_BODY, InfoSection, SectionHead } from "./info-kit";

/** Title-case a raw topic value for a derived chip label ("sav garantie" → "Sav Garantie"). */
function titleCase(value: string): string {
  return value.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

type FaqItem = { question: string; answer: string; topic: string; linkLabel: string; linkHref: string };
type FaqTopic = { key: string; label: string };

/** « Questions fréquentes » — a filterable FAQ master/detail (topic chips + search + list/panel). */
export function FaqHelp(props: {
  header: { eyebrow?: string; title?: string; subtitle?: string };
  items: FaqItem[];
  topics: FaqTopic[];
  search: boolean;
}) {
  const [q, setQ] = useState("");
  const [topic, setTopic] = useState("all");
  const [faq, setFaq] = useState(0);

  // Chips = "all" + provided topics, or topics derived from the distinct item.topic values.
  const chips = useMemo<FaqTopic[]>(() => {
    const base: FaqTopic[] = [{ key: "all", label: "Tout" }];
    if (props.topics.length > 0) return [...base, ...props.topics];
    const seen = new Set<string>();
    const derived: FaqTopic[] = [];
    for (const item of props.items) {
      const value = item.topic.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      derived.push({ key: value, label: titleCase(value) });
    }
    return [...base, ...derived];
  }, [props.topics, props.items]);

  const filtered = useMemo<FaqItem[]>(() => {
    const query = q.trim().toLowerCase();
    return props.items.filter((item) => {
      const topicOk = topic === "all" || item.topic === topic;
      const searchOk = query === "" || `${item.question} ${item.answer}`.toLowerCase().includes(query);
      return topicOk && searchOk;
    });
  }, [props.items, topic, q]);

  // Reset the selected question whenever the filter changes.
  useEffect(() => {
    setFaq(0);
  }, [topic, q]);

  const sel = filtered.length > 0 ? Math.min(faq, filtered.length - 1) : 0;
  const active = filtered[sel];

  return (
    <InfoSection>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionHead header={props.header} className="min-w-0" />
        {props.search && (
          <div className="flex h-[54px] min-w-[min(100%,280px)] flex-1 items-center gap-2.5 rounded-full border-[1.5px] border-border bg-muted px-[18px] sm:max-w-[320px] sm:flex-none">
            <Search aria-hidden className="size-[18px] shrink-0 text-muted-foreground" strokeWidth={2.2} />
            <input
              type="search"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Livraison, retour, garantie…"
              aria-label="Rechercher une question"
              className="h-full w-full border-none bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2.5">
        {chips.map((chip) => {
          const selected = topic === chip.key;
          return (
            <button
              key={chip.key}
              type="button"
              onClick={() => setTopic(chip.key)}
              aria-pressed={selected}
              className={cn(
                "h-10 rounded-full border-[1.5px] px-4 text-sm font-bold transition-colors",
                selected
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-foreground hover:border-foreground",
              )}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {active ? (
        <div className="grid gap-5 [grid-template-columns:minmax(0,1fr)] lg:[grid-template-columns:minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="flex min-w-0 flex-col gap-2.5">
            {filtered.map((item, index) => {
              const selected = index === sel;
              return (
                <button
                  key={`${item.topic}-${item.question}-${index}`}
                  type="button"
                  onClick={() => setFaq(index)}
                  aria-pressed={selected}
                  className={cn(
                    "flex min-h-[60px] items-center gap-3.5 rounded-[20px] p-[12px_16px] text-left transition-colors",
                    selected ? "bg-foreground text-background" : "bg-muted text-foreground hover:bg-muted/70",
                  )}
                >
                  <span
                    className={cn(
                      "shrink-0 text-[15px] font-black tabular-nums",
                      selected ? "text-[#ff8aa0]" : "text-primary",
                    )}
                  >
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 text-[15px] font-bold leading-[1.35]">{item.question}</span>
                </button>
              );
            })}
          </div>

          <div className="flex min-w-0 flex-col gap-3.5 self-start rounded-[28px] bg-muted p-[clamp(20px,2.6vw,30px)] lg:sticky lg:top-3">
            <span className="text-[12px] font-extrabold uppercase tracking-[0.14em] text-primary">
              Question {String(sel + 1).padStart(2, "0")}
            </span>
            <h3 className="m-0 text-[22px] font-black leading-[1.2] tracking-[-0.02em] text-foreground text-balance">
              {active.question}
            </h3>
            <p className="m-0 text-[16px] leading-[1.65] text-graphite text-pretty">{active.answer}</p>
            {active.linkLabel && active.linkHref && (
              <a
                href={active.linkHref}
                className="mt-auto inline-flex items-center gap-2 text-[15px] font-bold text-primary"
              >
                {active.linkLabel}
                <ArrowRight aria-hidden className="size-[18px]" strokeWidth={2.2} />
              </a>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-[28px] bg-muted p-7">
          <p className={cn("m-0", INFO_BODY)}>
            Aucune question ne correspond à «&nbsp;{q}&nbsp;». Écrivez-nous ci-dessous, nous vous répondons sous 24h
            ouvrées.
          </p>
        </div>
      )}
    </InfoSection>
  );
}

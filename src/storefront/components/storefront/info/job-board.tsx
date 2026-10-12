"use client";

import { useState } from "react";
import { ArrowRight, Plus } from "lucide-react";

import { cn } from "@/storefront/lib/utils";

import { INFO_MUTED, InfoSection, SectionHead } from "./info-kit";

/**
 * « Postes ouverts » — the crimson careers accordion for the info/CMS pages.
 * Each job is a collapsible card (one open at a time, first open by default)
 * revealing Missions / Profil columns and a crimson « Postuler » CTA; an
 * optional spontaneous-application note closes the list. Pure presentation —
 * the apply CTA is a mailto/href link, no backend submit.
 */
export function JobBoard(props: {
  header: { eyebrow?: string; title?: string; subtitle?: string };
  jobs: {
    title: string;
    team: string;
    location: string;
    contract: string;
    summary: string;
    missions: string;
    profile: string;
    applyHref: string;
  }[];
  emptyText: string;
  applyEmail: string;
  spontaneous: { title: string; body: string; ctaLabel: string } | null;
}) {
  const { header, jobs, emptyText, applyEmail, spontaneous } = props;
  const [open, setOpen] = useState(0);

  return (
    <InfoSection>
      <div className="flex flex-col gap-3">
        <SectionHead header={header} />
        {jobs.length > 0 && (
          <p className={cn("m-0", INFO_MUTED)}>
            {jobs.length} poste{jobs.length > 1 ? "s" : ""} ouvert{jobs.length > 1 ? "s" : ""}
          </p>
        )}
      </div>

      {jobs.length === 0 ? (
        <div className="rounded-[28px] bg-muted p-7 text-graphite">{emptyText}</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {jobs.map((job, i) => {
            const isOpen = i === open;
            const applyHref =
              job.applyHref ||
              (applyEmail ? `mailto:${applyEmail}?subject=Candidature : ${job.title}` : "#candidature");
            const tags = [job.location, job.contract, job.team].filter((t): t is string => Boolean(t));
            return (
              <div
                key={`${job.title}-${i}`}
                className={cn(
                  "overflow-hidden rounded-[28px] border-[1.5px]",
                  isOpen ? "border-foreground bg-muted" : "border-border bg-card",
                )}
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? -1 : i)}
                  className="flex w-full flex-wrap items-center gap-x-5 gap-y-3 p-[20px_22px] text-left"
                >
                  <span className="flex min-w-[260px] flex-1 flex-col gap-1.5">
                    <span className="text-[19px] font-extrabold tracking-[-0.01em] text-foreground">
                      {job.title}
                    </span>
                    {tags.length > 0 && (
                      <span className="flex flex-wrap gap-1.5">
                        {tags.map((tag, ti) => (
                          <span
                            key={`${tag}-${ti}`}
                            className="rounded-full border border-border bg-card px-2.5 py-1 text-[12px] font-bold text-graphite"
                          >
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-foreground text-background">
                    <Plus
                      aria-hidden
                      strokeWidth={2.4}
                      className={cn("size-5 transition-transform", isOpen && "rotate-45")}
                    />
                  </span>
                </button>

                <div
                  className={cn(
                    "grid transition-[grid-template-rows] duration-300 ease-out",
                    isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                  )}
                >
                  <div className="overflow-hidden">
                    <div className="grid gap-[18px_28px] p-[0_22px_22px] [grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))]">
                      <div className="flex min-w-0 flex-col gap-2">
                        <span className="text-[13px] font-extrabold uppercase tracking-[0.1em] text-muted-foreground">
                          Missions
                        </span>
                        <p className="m-0 text-[15px] leading-[1.6] text-graphite">{job.missions}</p>
                      </div>
                      <div className="flex min-w-0 flex-col gap-2">
                        <span className="text-[13px] font-extrabold uppercase tracking-[0.1em] text-muted-foreground">
                          Profil
                        </span>
                        <p className="m-0 text-[15px] leading-[1.6] text-graphite">{job.profile}</p>
                      </div>
                      <a
                        href={applyHref}
                        className="col-[1/-1] inline-flex h-14 w-max max-w-full items-center justify-center gap-2.5 rounded-full bg-primary px-6 text-[15px] font-bold text-primary-foreground transition-[filter] hover:brightness-95"
                      >
                        Postuler à ce poste
                        <ArrowRight aria-hidden strokeWidth={2.2} className="size-[18px]" />
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {spontaneous && (
        <div className="flex flex-col gap-3 rounded-[28px] bg-muted p-7">
          <h3 className="m-0 text-[20px] font-black tracking-[-0.02em] text-foreground">{spontaneous.title}</h3>
          <p className="m-0 text-[15px] leading-[1.6] text-graphite">{spontaneous.body}</p>
          <a
            href={applyEmail ? `mailto:${applyEmail}?subject=Candidature spontanée` : "#candidature"}
            className="inline-flex h-11 w-max items-center gap-2 rounded-full border-[1.5px] border-foreground bg-transparent px-[18px] text-sm font-bold text-foreground"
          >
            {spontaneous.ctaLabel}
            <ArrowRight aria-hidden strokeWidth={2.2} className="size-4" />
          </a>
        </div>
      )}
    </InfoSection>
  );
}

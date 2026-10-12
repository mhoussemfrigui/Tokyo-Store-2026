"use client";

import { useId, useState } from "react";
import { ChevronDown, Clock, MapPin } from "lucide-react";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

export type BoardJob = {
  title: string;
  team: string;
  location: string;
  contract: string;
  summary: string;
  missions: string;
  profile: string;
  applyHref: string;
};

/**
 * « Le Registre des talents » — open positions as full-width editorial rows (no cards):
 * title + summary, team / place / contract meta, and an e-mail application. A team filter
 * appears when there are at least two teams; each row expands to its missions + profile.
 * A spontaneous-application row closes the list (and stands in when nothing is open).
 */
export type SpontaneousPanel = { title: string; body: string; ctaLabel: string };

export function JobBoard({
  jobs,
  emptyText,
  spontaneousHref,
  spontaneous,
}: {
  jobs: BoardJob[];
  emptyText: string;
  /** "" hides the panel (disabled by the operator, or no application e-mail). */
  spontaneousHref: string;
  spontaneous?: SpontaneousPanel;
}) {
  const teams = [...new Set(jobs.map((j) => j.team).filter(Boolean))];
  const [team, setTeam] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const base = useId();
  const list = jobs.map((j, i) => ({ j, i })).filter(({ j }) => !team || j.team === team);

  return (
    <div>
      {teams.length > 1 && (
        <div role="group" aria-label="Filtrer par équipe" className="mb-6 flex flex-wrap gap-2">
          {[null, ...teams].map((t) => {
            const on = team === t;
            return (
              <button
                key={t ?? "__all"}
                type="button"
                aria-pressed={on}
                onClick={() => setTeam(t)}
                className={cn(
                  "rounded-full border px-4 py-2 font-body text-[0.68rem] uppercase tracking-[0.18em] transition-colors",
                  on
                    ? "border-foreground bg-foreground text-background"
                    : "border-border text-muted-foreground hover:border-olive/50 hover:text-foreground",
                )}
              >
                {t ?? "Tous les postes"}
              </button>
            );
          })}
        </div>
      )}

      {jobs.length > 0 ? (
        <ul className="divide-y divide-border/70 border-y border-border/70">
          {list.map(({ j, i }) => {
            const isOpen = Boolean(open[i]);
            const panelId = `${base}-job-${i}`;
            const hasDetail = Boolean(j.missions || j.profile);
            return (
              <li key={`${j.title}-${i}`} className="group/job">
                <div className="grid gap-4 py-7 lg:grid-cols-12 lg:items-center lg:gap-x-8">
                  <div className="lg:col-span-5">
                    <h3 className="font-serif text-2xl leading-tight tracking-tight text-foreground md:text-[1.7rem]">
                      {j.title}
                    </h3>
                    {j.summary && (
                      <p className="mt-2 max-w-xl font-body text-sm leading-relaxed text-muted-foreground">{j.summary}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2 font-body text-[0.7rem] uppercase tracking-[0.14em] text-muted-foreground lg:col-span-4">
                    {j.team && <span className="rounded-full border border-border px-3 py-1 text-foreground">{j.team}</span>}
                    {j.location && (
                      <span className="inline-flex items-center gap-1.5">
                        <MapPin className="h-3.5 w-3.5 text-gold" strokeWidth={1.6} aria-hidden /> {j.location}
                      </span>
                    )}
                    {j.contract && (
                      <span className="inline-flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5 text-gold" strokeWidth={1.6} aria-hidden /> {j.contract}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 lg:col-span-3 lg:justify-end">
                    {hasDetail && (
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={panelId}
                        onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}
                        className={buttonVariants({ variant: "ghost", size: "sm" })}
                      >
                        <span className="btn__label">
                          Détails
                          <ChevronDown
                            className={cn("h-3.5 w-3.5 transition-[rotate] duration-300", isOpen && "rotate-180")}
                            aria-hidden
                          />
                        </span>
                      </button>
                    )}
                    {j.applyHref && (
                      <a
                        href={j.applyHref}
                        // An external posting/form (http) opens in a new tab; a mailto:/anchor stays put.
                        {...(/^https?:/i.test(j.applyHref) ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                        className={buttonVariants({ variant: "primary", size: "sm" })}
                      >
                        <span className="btn__label">Postuler</span>
                      </a>
                    )}
                  </div>
                </div>
                {hasDetail && (
                  <div id={panelId} hidden={!isOpen} className="grid gap-8 pb-9 lg:grid-cols-12 lg:gap-x-8">
                    {j.missions && (
                      <div className="lg:col-span-5">
                        <p className="mb-2 font-body text-[0.65rem] uppercase tracking-[0.28em] text-olive">Missions</p>
                        <p className="whitespace-pre-line font-body text-sm leading-relaxed text-foreground/85">{j.missions}</p>
                      </div>
                    )}
                    {j.profile && (
                      <div className="lg:col-span-4">
                        <p className="mb-2 font-body text-[0.65rem] uppercase tracking-[0.28em] text-olive">Profil</p>
                        <p className="whitespace-pre-line font-body text-sm leading-relaxed text-foreground/85">{j.profile}</p>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-[1.5rem] border border-border/60 bg-card/60 px-6 py-8 font-body text-sm text-muted-foreground">
          {emptyText || "Aucun poste n'est ouvert pour le moment — les candidatures spontanées restent les bienvenues."}
        </p>
      )}

      {spontaneousHref && (
        <div className="mt-8 flex flex-col gap-5 rounded-[1.5rem] border border-dashed border-border px-6 py-7 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div>
            <p className="font-serif text-xl text-foreground">{spontaneous?.title || "Candidature spontanée"}</p>
            <p className="mt-1 font-body text-sm text-muted-foreground">
              {spontaneous?.body ||
                "Votre profil ne correspond à aucun poste ? Écrivez-nous — chaque candidature est lue avec attention."}
            </p>
          </div>
          <a href={spontaneousHref} className={cn(buttonVariants({ variant: "secondary", size: "md" }), "shrink-0")}>
            <span className="btn__label">{spontaneous?.ctaLabel || "Envoyer ma candidature"}</span>
          </a>
        </div>
      )}
    </div>
  );
}

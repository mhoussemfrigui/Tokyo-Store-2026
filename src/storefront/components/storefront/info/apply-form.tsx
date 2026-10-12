"use client";

import { Check, ChevronDown, RotateCcw, Upload } from "lucide-react";
import { useState } from "react";

import { cn } from "@/storefront/lib/utils";

import { INFO_BODY, InfoSection, SectionHead, SectionTitle } from "./info-kit";

/**
 * « Candidature » — the info-pages job application form. Demo only: no backend;
 * on submit we swap the form for a crimson-system success panel. All state is
 * local. Built on the storefront theme tokens so it stays themeable while
 * reproducing the mockup's spacing / grid / copy exactly.
 */

const FIELD =
  "h-[54px] w-full rounded-[18px] border-[1.5px] border-border bg-muted px-[18px] text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground focus:bg-card";
const TEXTAREA =
  "min-h-[120px] w-full rounded-[18px] border-[1.5px] border-border bg-muted px-[18px] py-4 text-[16px] text-foreground outline-none transition-colors resize-y placeholder:text-muted-foreground focus:border-foreground focus:bg-card";
const LABEL = "flex flex-col gap-2 text-sm font-bold text-foreground min-w-0";
const PRIMARY_BTN =
  "inline-flex h-14 w-max max-w-full items-center justify-center gap-2.5 rounded-full bg-primary px-6 text-[15px] font-bold text-primary-foreground transition-[filter] hover:brightness-95";
const OUTLINE_BTN =
  "inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-foreground bg-transparent px-[18px] text-sm font-bold text-foreground";
const AUTOFIT = "[grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))]";

const CV_PLACEHOLDER = "Ajouter votre CV";
const CONSENT_FALLBACK =
  "J'accepte que Tokyo Store traite mes données pour ma candidature, conformément à la loi organique n° 2004-63 du 27 juillet 2004. Elles sont conservées 2 ans au maximum.";

export function ApplyForm(props: {
  header: { eyebrow?: string; title?: string; subtitle?: string };
  jobOptions: string[];
  consentText: string;
  successTitle: string;
  successBody: string;
}) {
  const options = [...props.jobOptions, "Candidature spontanée"];
  const [submitted, setSubmitted] = useState(false);
  const [job, setJob] = useState(options[0] ?? "Candidature spontanée");
  const [cv, setCv] = useState(CV_PLACEHOLDER);
  const hasCv = cv !== CV_PLACEHOLDER;

  return (
    <InfoSection>
      <SectionHead header={props.header} />

      {submitted ? (
        <div className="flex flex-col items-start gap-5 rounded-[28px] bg-success/10 p-[clamp(22px,3.4vw,40px)]">
          <span className="grid size-[46px] shrink-0 place-items-center rounded-full bg-success text-white">
            <Check aria-hidden className="size-[22px]" strokeWidth={2.6} />
          </span>
          <div className="flex flex-col gap-2">
            <SectionTitle as="h3">{props.successTitle}</SectionTitle>
            <p className={cn("m-0", INFO_BODY)}>{props.successBody}</p>
          </div>
          <button
            type="button"
            className={OUTLINE_BTN}
            onClick={() => {
              setSubmitted(false);
              setCv(CV_PLACEHOLDER);
            }}
          >
            <RotateCcw aria-hidden className="size-4" strokeWidth={2.4} />
            Nouvelle candidature
          </button>
        </div>
      ) : (
        <form
          className={cn("grid gap-4", AUTOFIT)}
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
          }}
        >
          <label className={LABEL}>
            Nom complet
            <input className={FIELD} type="text" name="name" required autoComplete="name" placeholder="Flen Ben Foulen" />
          </label>

          <label className={LABEL}>
            Téléphone
            <input className={FIELD} type="tel" name="phone" required inputMode="tel" placeholder="22 345 678" />
          </label>

          <label className={LABEL}>
            E-mail
            <input className={FIELD} type="email" name="email" required placeholder="nom@mail.tn" />
          </label>

          <label className={LABEL}>
            Poste visé
            <div className="relative">
              <select
                className={cn(FIELD, "appearance-none pr-11")}
                value={job}
                onChange={(e) => setJob(e.target.value)}
              >
                {options.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute right-[18px] top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
                strokeWidth={2.2}
              />
            </div>
          </label>

          <label
            className={cn(
              "flex cursor-pointer items-center gap-4 rounded-[22px] border-[1.5px] border-dashed bg-muted p-[18px] transition-colors hover:border-foreground [grid-column:1/-1]",
              hasCv ? "border-success" : "border-border",
            )}
          >
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-foreground text-background">
              <Upload aria-hidden className="size-5" strokeWidth={2.2} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[15px] font-extrabold text-foreground">{cv}</span>
              <span className="text-[13px] text-muted-foreground">PDF ou Word · 5 Mo maximum</span>
            </span>
            <input
              className="hidden"
              type="file"
              name="cv"
              accept=".pdf,.doc,.docx"
              onChange={(e) => setCv(e.target.files?.[0]?.name ?? CV_PLACEHOLDER)}
            />
          </label>

          <label className={cn(LABEL, "[grid-column:1/-1]")}>
            <span className="flex items-baseline gap-2">
              Message
              <span className="text-[13px] font-medium text-muted-foreground">Facultatif</span>
            </span>
            <textarea className={TEXTAREA} name="message" rows={4} placeholder="Parlez-nous de vous en quelques lignes" />
          </label>

          <label className="flex items-start gap-3 text-[13px] leading-[1.55] text-muted-foreground [grid-column:1/-1]">
            <input className="mt-0.5 size-5 shrink-0 accent-primary" type="checkbox" name="consent" required />
            <span>{props.consentText || CONSENT_FALLBACK}</span>
          </label>

          <button type="submit" className={cn(PRIMARY_BTN, "[grid-column:1/-1]")}>
            Envoyer ma candidature
          </button>
        </form>
      )}
    </InfoSection>
  );
}

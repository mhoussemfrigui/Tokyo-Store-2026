"use client";

import { useState, type JSX } from "react";
import { Check } from "lucide-react";

import { cn } from "@/storefront/lib/utils";

import { InfoSection, SectionHead } from "./info-kit";

/** Field recipe — soft #fbf9f8 pill input that lifts to white on focus. */
const FIELD =
  "h-[54px] w-full rounded-[18px] border-[1.5px] border-border bg-muted px-[18px] text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground focus:bg-card";
/** Textarea recipe — same as FIELD but taller + resizable. */
const TEXTAREA =
  "min-h-[120px] w-full resize-y rounded-[18px] border-[1.5px] border-border bg-muted px-[18px] py-4 text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground focus:bg-card";
/** Label-wraps-input recipe. */
const LABEL = "flex min-w-0 flex-col gap-2 text-sm font-bold text-foreground";
/** Primary crimson pill button. */
const PRIMARY_BTN =
  "inline-flex h-14 w-max max-w-full items-center justify-center gap-2.5 rounded-full bg-primary px-6 text-[15px] font-bold text-primary-foreground transition-[filter] hover:brightness-95";
/** Ghost outline pill button. */
const OUTLINE_BTN =
  "inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-foreground bg-transparent px-[18px] text-sm font-bold text-foreground";

/** « Nous écrire » — a demo (no-backend) contact form that flips to a success panel on submit. */
export function ContactForm(props: {
  header: { eyebrow?: string; title?: string; subtitle?: string };
  subjects: string[];
  showOrderField: boolean;
  successTitle: string;
  successBody: string;
}) {
  const { header, subjects, showOrderField, successTitle, successBody } = props;
  const [submitted, setSubmitted] = useState(false);
  const [subject, setSubject] = useState<string>(subjects[0] ?? "");

  return (
    <InfoSection>
      <SectionHead header={header} />

      {submitted ? (
        <div className="flex flex-wrap items-center gap-4 rounded-[28px] bg-success/10 p-[22px]">
          <span className="grid size-[46px] place-items-center rounded-full bg-success text-white">
            <Check aria-hidden className="size-[22px]" strokeWidth={2.4} />
          </span>
          <div className="min-w-[240px] flex-1">
            <p className="m-0 text-[18px] font-extrabold text-foreground">{successTitle}</p>
            <p className="m-0 mt-1 text-sm text-graphite">{successBody}</p>
          </div>
          <button type="button" onClick={() => setSubmitted(false)} className={OUTLINE_BTN}>
            Nouveau message
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
          }}
          className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))]"
        >
          {subjects.length > 0 && (
            <div style={{ gridColumn: "1 / -1" }} className="flex min-w-0 flex-col gap-2">
              <span className="text-sm font-bold text-foreground">Sujet</span>
              <div className="flex flex-wrap gap-2">
                {subjects.map((s) => {
                  const active = s === subject;
                  return (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setSubject(s)}
                      className={cn(
                        "h-11 rounded-full border-[1.5px] px-4 text-sm font-bold transition-colors",
                        active
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-card text-foreground",
                      )}
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <label className={LABEL}>
            Nom complet
            <input className={FIELD} name="name" required autoComplete="name" placeholder="Flen Ben Foulen" />
          </label>

          <label className={LABEL}>
            Téléphone
            <input className={FIELD} name="phone" required inputMode="tel" placeholder="22 345 678" />
          </label>

          <label className={LABEL}>
            E-mail
            <input className={FIELD} name="email" type="email" required placeholder="nom@mail.tn" />
          </label>

          {showOrderField && (
            <label className={LABEL}>
              <span>
                N° de commande
                <span className="font-normal text-muted-foreground">{" · si concerné"}</span>
              </span>
              <input className={FIELD} name="order" placeholder="CMD-7K9P2X" />
            </label>
          )}

          <label className={LABEL} style={{ gridColumn: "1 / -1" }}>
            Message
            <textarea className={TEXTAREA} name="message" required rows={5} placeholder="Décrivez votre demande" />
          </label>

          <div style={{ gridColumn: "1 / -1" }}>
            <button type="submit" className={PRIMARY_BTN}>
              Envoyer le message
            </button>
          </div>
        </form>
      )}
    </InfoSection>
  );
}

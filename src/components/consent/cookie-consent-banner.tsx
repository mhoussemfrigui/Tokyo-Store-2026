"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CONSENT_CATEGORIES, isCategoryOffered } from "@/lib/consent/categories";
import { useConsent } from "./consent-provider";

/**
 * GDPR consent UI, re-skinned to the Tokyo Store luxury aesthetic
 * (ivory / onyx / olive, Playfair eyebrow + Montserrat body). Non-modal fixed
 * bottom bar shown on first visit (and after a revision bump), plus a granular
 * preferences dialog re-openable any time from the footer. "Tout refuser" keeps
 * equal prominence to "Tout accepter" (ePrivacy / CNIL requirement). Renders
 * nothing when consent management is disabled by the admin.
 *
 * Styling only — every consent handler, category, settings-driven copy, and the
 * provider wiring are preserved exactly.
 */
export function CookieConsentBanner() {
  const consent = useConsent();
  if (!consent || !consent.config.enabled) return null;

  const { config, bannerVisible, preferencesOpen } = consent;

  return (
    <>
      {bannerVisible && !preferencesOpen && (
        <div
          role="region"
          aria-label="Consentement aux cookies"
          className="fixed inset-x-0 bottom-0 z-[100] flex justify-center px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-0 sm:px-4"
        >
          <div className="lux-consent-enter relative w-full max-w-[1100px] overflow-hidden rounded-2xl border border-[color-mix(in_oklab,var(--olive)_22%,transparent)] bg-[color-mix(in_oklab,var(--card)_94%,transparent)] shadow-[0_24px_60px_-24px_rgba(33,30,26,0.5)] backdrop-blur-md">
            {/* Hairline gold/olive accent along the top edge. */}
            <div
              aria-hidden
              className="h-px w-full bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--gold)_55%,transparent),color-mix(in_oklab,var(--olive)_45%,transparent),transparent)]"
            />
          <div className="flex flex-col gap-5 px-5 py-6 md:flex-row md:items-center md:justify-between md:gap-10 md:px-8">
            <div className="min-w-0 space-y-2">
              <p className="font-[family-name:var(--font-heading)] text-[0.65rem] uppercase tracking-[0.32em] text-[var(--olive)]">
                Confidentialité
              </p>
              <p className="font-[family-name:var(--font-heading)] text-lg leading-snug text-foreground">
                {config.title}
              </p>
              <p className="max-w-2xl text-[0.8rem] leading-relaxed text-muted-foreground">
                {config.description}{" "}
                <Link
                  href={config.policyUrl}
                  className="font-medium text-foreground underline decoration-[color-mix(in_oklab,var(--olive)_50%,transparent)] underline-offset-4 transition hover:text-[var(--olive)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--olive)_45%,transparent)] focus-visible:ring-offset-2"
                >
                  Politique des cookies
                </Link>
              </p>
            </div>
            <div className="flex shrink-0 flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3">
              <button
                type="button"
                onClick={() => consent.openPreferences()}
                className="btn-ghost-luxury min-h-[44px] w-full px-6 py-2.5 text-[0.7rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--olive)_45%,transparent)] focus-visible:ring-offset-2 sm:w-auto"
              >
                Personnaliser
              </button>
              {/* Reject + Accept share comparable weight — CNIL requires refusing
                  to be as easy/prominent as accepting. Refuser uses the ghost
                  treatment, Accepter the solid olive CTA. */}
              <button
                type="button"
                onClick={() => consent.rejectAll()}
                className="btn-ghost-luxury min-h-[44px] w-full px-6 py-2.5 text-[0.7rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--olive)_45%,transparent)] focus-visible:ring-offset-2 sm:w-auto"
              >
                Tout refuser
              </button>
              <button
                type="button"
                onClick={() => consent.acceptAll()}
                className="btn-solid min-h-[44px] w-full px-7 py-2.5 text-[0.7rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--olive)_55%,transparent)] focus-visible:ring-offset-2 sm:w-auto"
              >
                Tout accepter
              </button>
            </div>
          </div>
          </div>
        </div>
      )}

      <PreferencesDialog />

      {/* Scoped entrance for the bar (CSS only, honours reduced-motion). */}
      <style>{`
        @keyframes lux-consent-rise {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: none; }
        }
        .lux-consent-enter {
          animation: lux-consent-rise 0.42s cubic-bezier(0.25, 0.46, 0.45, 0.94) both;
        }
        @media (prefers-reduced-motion: reduce) {
          .lux-consent-enter { animation: none; }
        }
      `}</style>
    </>
  );
}

function PreferencesDialog() {
  const consent = useConsent();
  const [choices, setChoices] = useState({
    functional: false,
    analytics: false,
    marketing: false,
  });

  // Seed the toggles from the current decision each time the dialog opens.
  useEffect(() => {
    if (consent?.preferencesOpen) {
      setChoices({
        functional: consent.state.functional,
        analytics: consent.state.analytics,
        marketing: consent.state.marketing,
      });
    }
  }, [consent?.preferencesOpen, consent?.state]);

  if (!consent) return null;
  const { config } = consent;

  return (
    <Dialog
      open={consent.preferencesOpen}
      onOpenChange={(open) => (open ? consent.openPreferences() : consent.closePreferences())}
    >
      <DialogContent className="max-h-[90vh] gap-6 overflow-y-auto border-[color-mix(in_oklab,var(--olive)_18%,transparent)] bg-[var(--card)] sm:rounded-[var(--radius)] sm:max-w-lg">
        <DialogHeader className="space-y-2 text-left">
          <span className="font-[family-name:var(--font-heading)] text-[0.65rem] uppercase tracking-[0.32em] text-[var(--olive)]">
            Confidentialité
          </span>
          <DialogTitle className="font-[family-name:var(--font-heading)] text-xl font-medium text-foreground">
            {config.title}
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] leading-relaxed text-muted-foreground">
            {config.description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {CONSENT_CATEGORIES.map((cat) => {
            const isNecessary = cat.key === "necessary";
            const offered = isNecessary || isCategoryOffered(config, cat.key);
            if (!offered) return null;
            const k = cat.key as "functional" | "analytics" | "marketing";
            const checked = isNecessary ? true : choices[k];
            return (
              <label
                key={cat.key}
                className={`group flex items-start gap-3.5 rounded-[var(--radius)] border px-4 py-3.5 transition ${
                  isNecessary
                    ? "border-[color-mix(in_oklab,var(--border)_70%,transparent)] bg-[color-mix(in_oklab,var(--muted)_60%,transparent)] opacity-90"
                    : "cursor-pointer border-[color-mix(in_oklab,var(--border)_70%,transparent)] bg-card has-[:checked]:border-[color-mix(in_oklab,var(--olive)_45%,transparent)] has-[:checked]:bg-[color-mix(in_oklab,var(--olive)_7%,transparent)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[color-mix(in_oklab,var(--olive)_45%,transparent)] has-[:focus-visible]:ring-offset-2"
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--olive)] focus-visible:outline-none"
                  checked={checked}
                  disabled={isNecessary}
                  onChange={(e) =>
                    !isNecessary && setChoices((c) => ({ ...c, [k]: e.target.checked }))
                  }
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 text-[0.8rem] font-semibold text-foreground">
                    {cat.label}
                    {isNecessary && (
                      <span className="rounded-full border border-[color-mix(in_oklab,var(--olive)_30%,transparent)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.15em] text-[var(--olive)]">
                        Toujours actif
                      </span>
                    )}
                  </p>
                  <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
                    {cat.description}
                  </p>
                </div>
              </label>
            );
          })}
        </div>

        <DialogFooter className="flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Link
            href={config.privacyUrl}
            className="text-[0.72rem] text-muted-foreground underline decoration-[color-mix(in_oklab,var(--olive)_40%,transparent)] underline-offset-4 transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--olive)_45%,transparent)] focus-visible:ring-offset-2"
          >
            Politique de confidentialité
          </Link>
          {/* Reject + Accept share comparable weight; "Enregistrer" (the granular
              save) sits between them as the considered, ghost action. */}
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={() => consent.rejectAll()}
              className="btn-ghost-luxury px-5 py-2.5 text-[0.68rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--olive)_45%,transparent)] focus-visible:ring-offset-2"
            >
              Tout refuser
            </button>
            <button
              type="button"
              onClick={() => consent.savePreferences(choices)}
              className="btn-ghost-luxury px-5 py-2.5 text-[0.68rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--olive)_45%,transparent)] focus-visible:ring-offset-2"
            >
              Enregistrer mes choix
            </button>
            <button
              type="button"
              onClick={() => consent.acceptAll()}
              className="btn-solid px-6 py-2.5 text-[0.68rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--olive)_55%,transparent)] focus-visible:ring-offset-2"
            >
              Tout accepter
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

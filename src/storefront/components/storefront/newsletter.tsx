"use client";

import { useActionState } from "react";
import { Check } from "lucide-react";

import { subscribeNewsletterAction, type NewsletterState } from "@/lib/actions/newsletter";
import { btn, field, panel } from "@/storefront/components/storefront/ui-classes";
import { cn } from "@/storefront/lib/utils";

/**
 * Home page newsletter: the last section of <main>, on the page column like
 * every other home section. Submits the REAL public `subscribeNewsletterAction`
 * server action (same one as the footer signup) — no fake success. The action
 * is rate-limited and returns one generic message for every outcome so it never
 * leaks whether an address is already subscribed.
 */
export function Newsletter() {
  const [state, formAction, pending] = useActionState<NewsletterState | null, FormData>(
    subscribeNewsletterAction,
    null,
  );
  const done = state?.ok === true;

  return (
    <section aria-labelledby="newsletter-title" className="pt-14 sm:pt-16 lg:pt-20">
      <div className="page-container">
        <div className={cn(panel, "px-4 py-10 sm:py-12 lg:px-5")}>
          <div className="grid gap-6 md:grid-cols-[1.2fr_1fr] md:items-end lg:gap-12 xl:grid-cols-[minmax(0,1fr)_minmax(0,32rem)]">
            <div className="text-center md:text-left">
              <p className="eyebrow text-primary-ink">Newsletter</p>
              <h2 id="newsletter-title" className="title-section mt-2 text-foreground">
                Restez au courant des bons plans Tokyo Store
              </h2>
              <p className="mx-auto mt-3 max-w-lg text-[15px] leading-relaxed text-graphite md:mx-0">
                Nouveautés Apple, offres flash et promos exclusives — directement dans votre boîte
                mail.
              </p>
            </div>

            <div className="text-center md:text-left">
              <form
                action={formAction}
                className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] md:grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto]"
              >
                <input type="hidden" name="source" value="home" />
                <label htmlFor="newsletter-email" className="sr-only">
                  Adresse e-mail
                </label>
                <input
                  id="newsletter-email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  required
                  maxLength={255}
                  placeholder="votre@email.com"
                  aria-describedby="newsletter-status"
                  className={field}
                />
                <button
                  type="submit"
                  disabled={pending || done}
                  className={cn(btn.base, btn.lg, btn.primary)}
                >
                  {done ? (
                    <>
                      <Check aria-hidden className="size-4" /> Inscrit
                    </>
                  ) : pending ? (
                    "…"
                  ) : (
                    "S'abonner"
                  )}
                </button>
              </form>
              {/* Announced when it changes: the server action's message. */}
              <div id="newsletter-status" aria-live="polite">
                {state && (
                  <p
                    className={cn(
                      "mt-3 text-[12px]",
                      state.ok ? "text-muted-foreground" : "font-medium text-destructive",
                    )}
                  >
                    {state.message}
                  </p>
                )}
              </div>
              <p className="mt-3 text-[12px] text-muted-foreground">
                Pas de spam. Désinscription en un clic.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

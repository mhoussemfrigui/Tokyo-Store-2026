"use client";

import { useState, type FormEvent } from "react";
import { Check } from "lucide-react";

import { btn, field, panel } from "@/storefront/components/storefront/ui-classes";
import { cn } from "@/storefront/lib/utils";

/**
 * Home page newsletter: the last section of <main>, on the page column like
 * every other home section. It used to live in the footer (outside every
 * landmark) behind a pathname check; main's bottom padding now gives the
 * section → footer rhythm.
 */
export function Newsletter() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubscribe = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError("Adresse e-mail invalide");
      return;
    }
    setError(null);
    setSubmitted(true);
    setEmail("");
  };

  return (
    <section aria-labelledby="newsletter-title" className="pt-14 sm:pt-16 lg:pt-20">
      <div className="page-container">
        {/* A panel on the content column, so it pads like the pill (px-4 /
            lg:px-5): the copy and field land on the logo line with the store
            cards above (gutter + 1 + 16 = 29 / 45, 28 + 1 + 20 = 49). The
            vertical air stays banner-generous. */}
        <div className={cn(panel, "px-4 py-10 sm:py-12 lg:px-5")}>
          {/* The form column stops at a readable measure on wide screens
              instead of stretching a 700px e-mail field. */}
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

            {/* Field and button share a row except at md, where the column is
                ~280px and a row left a 150px field: there they stack. */}
            <div className="text-center md:text-left">
              <form
                onSubmit={handleSubscribe}
                noValidate
                className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] md:grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto]"
              >
                <label htmlFor="newsletter-email" className="sr-only">
                  Adresse e-mail
                </label>
                <input
                  id="newsletter-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  required
                  maxLength={255}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (submitted) setSubmitted(false);
                    if (error) setError(null);
                  }}
                  placeholder="votre@email.com"
                  aria-invalid={error ? true : undefined}
                  aria-describedby="newsletter-status"
                  className={field}
                />
                <button type="submit" className={cn(btn.base, btn.lg, btn.primary)}>
                  {submitted ? (
                    <>
                      <Check aria-hidden className="size-4" /> Inscrit
                    </>
                  ) : (
                    "S'abonner"
                  )}
                </button>
              </form>
              {/* Announced when it changes: the error, or the confirmation. */}
              <div id="newsletter-status" aria-live="polite">
                {error && <p className="mt-3 text-[12px] font-medium text-destructive">{error}</p>}
                {submitted && !error && (
                  <p className="mt-3 text-[12px] text-muted-foreground">
                    Merci ! Vous êtes bien inscrit.
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

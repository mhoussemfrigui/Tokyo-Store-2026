"use client";

import { useActionState } from "react";
import { ArrowRight, Check, Loader2 } from "lucide-react";

import {
  subscribeNewsletterAction,
  type NewsletterState,
} from "@/lib/actions/newsletter";

/**
 * Footer newsletter form — luxury "dark" pill variant (olive submit button on
 * the onyx footer). Submits the public `subscribeNewsletterAction` Server Action
 * (rate-limited + anti-enumeration; created / reactivated / already-active all
 * collapse to one friendly success). Invalid input surfaces inline, no reload.
 *
 * Rendered by {@link SiteFooter} only when an admin `footer`-placement banner
 * exists, so the heading/eyebrow/subtitle copy live in the footer; this
 * component is just the field + button + status line.
 */
export function NewsletterSignup({ cta = "S'inscrire" }: { cta?: string }) {
  const [state, formAction, pending] = useActionState<NewsletterState | null, FormData>(
    subscribeNewsletterAction,
    null,
  );

  return (
    <div className="flex w-full flex-col items-center md:w-auto md:items-stretch">
      {/* One seamless pill: the field flows into the olive CTA, a hairline border
          that warms to GOLD on focus — a single premium unit on the onyx footer. */}
      <form
        action={formAction}
        aria-label="Inscription à la newsletter"
        className="mx-auto flex w-full max-w-sm items-center gap-1 rounded-full border border-background/15 bg-background/[0.04] p-1 pl-5 transition-all duration-500 focus-within:border-gold/40 focus-within:bg-background/[0.07] md:mx-0 md:w-[27rem]"
      >
        <input type="hidden" name="source" value="footer" />
        <input
          type="email"
          name="email"
          required
          disabled={pending}
          placeholder="Votre adresse email"
          aria-label="Adresse email"
          className="min-w-0 flex-1 bg-transparent py-2.5 text-sm tracking-wide text-background outline-none placeholder:text-background/25 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={pending}
          aria-label={cta}
          className="group inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-olive px-5 py-3 text-[0.68rem] uppercase tracking-[0.14em] text-olive-foreground transition-all duration-500 hover:bg-olive/85 disabled:cursor-not-allowed disabled:opacity-60 sm:px-6 sm:text-xs"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : state?.ok ? (
            <>
              Merci
              <Check className="h-3.5 w-3.5" strokeWidth={2.2} />
            </>
          ) : (
            <>
              {cta}
              <ArrowRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5" />
            </>
          )}
        </button>
      </form>
      {state && (
        <p
          role="status"
          className={`mt-2.5 px-5 text-center text-[11px] tracking-wide md:text-left ${
            state.ok ? "text-olive" : "text-destructive"
          }`}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}

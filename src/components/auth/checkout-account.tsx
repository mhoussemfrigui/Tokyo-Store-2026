"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { LogIn, UserPlus } from "lucide-react";

import { SocialAuthButtons } from "@/components/auth/social-buttons";
import { signoutAction } from "@/lib/actions/auth";

/**
 * Checkout account-choice block — sits at the TOP of the "Vos coordonnées"
 * (contact) section so a shopper isn't forced to type their identity as a
 * stranger every time.
 *
 *  • GUEST: offers three paths — "Se connecter" / "Créer un compte" (links that
 *    preserve the checkout return via `?from=/checkout`) and "Continuer en tant
 *    qu'invité" (collapses the chooser; the email/phone fields below stay the
 *    identification). The admin-gated Google button is rendered here too (same
 *    `<SocialAuthButtons>` the auth pages use), so social sign-in is one click
 *    from checkout when enabled.
 *  • SIGNED-IN: shows the resolved identity (name + email) with a discreet
 *    "Ce n'est pas vous ?" → `signoutAction` (the same server action the
 *    account page uses) so they can switch accounts.
 *
 * Purely presentational on top of the existing checkout form: it adds NO new
 * form fields and never touches `placeOrderFromCartAction`. The guest email
 * field remains the required identification field, owned by the form below.
 */

type SocialFlags = { google: boolean; facebook: boolean };

export function CheckoutAccount({
  isSignedIn,
  accountName,
  accountEmail,
  social,
  /** Same-origin return path used by the login/register links + social flow. */
  returnTo = "/checkout",
}: {
  isSignedIn: boolean;
  accountName?: string;
  accountEmail?: string;
  social: SocialFlags;
  returnTo?: string;
}) {
  // Guests start with the chooser shown; "Continuer en tant qu'invité"
  // collapses it so the email/phone fields below take over.
  const [guestMode, setGuestMode] = useState(false);
  // Sign-out runs as a plain button (NOT a nested <form>): this block renders
  // INSIDE the checkout <form>, and a <form> may not descend from a <form>
  // (invalid HTML → the browser auto-closes the outer form → hydration mismatch).
  // Calling the server action from a transition works with or without an outer form.
  const [isSigningOut, startSignout] = useTransition();

  if (isSignedIn) {
    // Discreet one-liner — the shopper is already identified, so this is a quiet
    // confirmation + a switch-account affordance, not a prominent card.
    const who = accountEmail || accountName?.trim() || "votre compte";
    return (
      <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 font-body text-[0.72rem] leading-relaxed text-muted-foreground/70">
        <span>
          Connecté&nbsp;:{" "}
          <span className="text-foreground/80">{who}</span>
        </span>
        {/* Same server action the account page uses; redirects to "/". A button
            (not a nested <form>) so the outer checkout <form> stays valid HTML. */}
        <button
          type="button"
          disabled={isSigningOut}
          onClick={() => startSignout(async () => { await signoutAction(); })}
          className="font-medium text-primary/80 underline underline-offset-2 transition-colors hover:text-primary disabled:opacity-60"
        >
          Ce n&apos;est pas vous&nbsp;?
        </button>
      </p>
    );
  }

  const loginHref = `/login?from=${encodeURIComponent(returnTo)}`;
  const registerHref = `/register?from=${encodeURIComponent(returnTo)}`;

  // Guest collapsed the chooser — show only a discreet "se connecter" hint so
  // the contact fields below own the flow.
  if (guestMode) {
    return (
      <p className="font-body text-[0.7rem] leading-relaxed text-muted-foreground/70">
        Vous continuez en tant qu&apos;invité.{" "}
        <Link
          href={loginHref}
          className="font-medium text-primary underline underline-offset-2 transition-colors hover:text-foreground"
        >
          Se connecter
        </Link>{" "}
        pour retrouver vos informations.
      </p>
    );
  }

  return (
    <div className="rounded-2xl border border-border/40 bg-accent/[0.12] p-4 sm:p-5">
      <p className="font-body text-[0.7rem] leading-relaxed text-muted-foreground/80">
        Déjà client&nbsp;? Connectez-vous pour pré-remplir vos informations, ou
        continuez en tant qu&apos;invité.
      </p>

      <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
        <Link
          href={loginHref}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-primary/40 bg-card px-4 font-body text-[0.7rem] uppercase tracking-[0.12em] text-primary transition-colors duration-300 hover:bg-primary/10"
        >
          <LogIn className="h-3.5 w-3.5" strokeWidth={1.6} /> Se connecter
        </Link>
        <Link
          href={registerHref}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-border/50 bg-card px-4 font-body text-[0.7rem] uppercase tracking-[0.12em] text-foreground transition-colors duration-300 hover:border-primary/40 hover:text-primary"
        >
          <UserPlus className="h-3.5 w-3.5" strokeWidth={1.6} /> Créer un compte
        </Link>
      </div>

      <button
        type="button"
        onClick={() => setGuestMode(true)}
        className="mt-2.5 inline-flex min-h-[44px] w-full items-center justify-center rounded-xl border border-dashed border-border/50 px-4 font-body text-[0.7rem] uppercase tracking-[0.12em] text-muted-foreground transition-colors duration-300 hover:border-primary/40 hover:text-foreground"
      >
        Continuer en tant qu&apos;invité
      </button>

      {/* Admin-gated social block — leads with its "ou continuer avec" divider
          (which introduces the Google/Facebook buttons), or renders nothing when
          both providers are off. The guest contact fields follow below. Lands on
          /checkout. */}
      <SocialAuthButtons
        google={social.google}
        facebook={social.facebook}
        callbackURL={returnTo}
        label="login"
      />
    </div>
  );
}

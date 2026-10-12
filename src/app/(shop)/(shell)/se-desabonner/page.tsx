import type { Metadata } from "next";
import Link from "next/link";

import { unsubscribeByTokenAction } from "@/lib/actions/newsletter-unsubscribe";

export const metadata: Metadata = {
  title: "Se désabonner",
  robots: { index: false, follow: false },
};

/**
 * Public unsubscribe page reached from the {{ unsubscribe_url }} footer of any
 * marketing email. POST-confirm (a button, not a bare GET) so email scanners /
 * link prefetch can't unsubscribe on open. The action verifies the HMAC token,
 * unsubscribes, and redirects here with ?done=1. Always shows the same success
 * state (anti-enumeration).
 */
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; done?: string }>;
}) {
  const { token, done } = await searchParams;

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-4 py-16 text-center">
      <div className="w-full rounded-3xl border border-border bg-card p-8">
        {done ? (
          <>
            <h1 className="font-display text-2xl font-bold">Vous êtes désabonné</h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Vous ne recevrez plus d&apos;emails marketing de Tokyo Store (offres, promotions,
              anniversaire). Les emails liés à vos commandes — confirmations, expéditions,
              livraisons — continueront de vous parvenir.
            </p>
            <Link
              href="/"
              className="mt-6 inline-flex h-11 items-center rounded-full bg-foreground px-6 text-sm font-semibold text-background"
            >
              Retour à la boutique
            </Link>
          </>
        ) : !token ? (
          <>
            <h1 className="font-display text-2xl font-bold">Lien invalide</h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Ce lien de désabonnement est incomplet. Vous pouvez gérer vos préférences depuis
              votre compte.
            </p>
            <Link
              href="/account"
              className="mt-6 inline-flex h-11 items-center rounded-full border border-border px-6 text-sm font-semibold"
            >
              Mon compte
            </Link>
          </>
        ) : (
          <>
            <h1 className="font-display text-2xl font-bold">Se désabonner</h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Confirmez pour ne plus recevoir d&apos;emails marketing (offres, promotions,
              anniversaire). Vous continuerez à recevoir les emails liés à vos commandes.
            </p>
            <form action={unsubscribeByTokenAction} className="mt-6">
              <input type="hidden" name="token" value={token} />
              <button
                type="submit"
                className="inline-flex h-11 items-center rounded-full bg-foreground px-6 text-sm font-semibold text-background"
              >
                Confirmer le désabonnement
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}

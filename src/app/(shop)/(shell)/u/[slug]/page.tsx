import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Heart } from "lucide-react";

import { wishlistService } from "@/modules/wishlist/service";
import { favoritesPublicEnabled } from "@/lib/wishlist/config";
import { listProductsByIds } from "@/lib/api/products";
import { ProductGrid } from "@/components/storefront/product-grid";
import { ShareProfileButton } from "./share-button";

export const metadata: Metadata = {
  title: "Favoris partagés",
  // A personal collection — discoverable only via its shared link, not indexed.
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Public shared-favorites page `/u/<slug>` — the medusa PublicProfile design
 * (centered hero: eyebrow → avatar → pseudonym → ornament divider → membership
 * pill → share, then the Wishlist section). 404s — never 403 (no enumeration)
 * — when the feature is globally disabled, the slug doesn't exist, or the owner
 * has set it private. The owner's real name is never shown; only their chosen
 * pseudonym (or a generic label).
 */
export default async function PublicFavoritesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // Feature-gated (off by default) + must resolve to a PUBLIC list.
  if (!(await favoritesPublicEnabled())) notFound();
  const wl = await wishlistService.findPublicBySlug(slug).catch(() => null);
  if (!wl) notFound();

  const ids = await wishlistService.listProductIds(wl.id).catch(() => []);
  const products = ids.length > 0 ? await listProductsByIds(ids).catch(() => []) : [];
  const name = wl.public_display_name?.trim() || "Collection de favoris";
  const initial = name.charAt(0).toUpperCase();

  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-accent/30 to-transparent"
        />
        <div className="relative mx-auto max-w-4xl px-4 pb-8 pt-8 sm:px-6 sm:pb-10 sm:pt-12 md:px-8 md:pb-14 md:pt-20">
          <div className="tk-fade-in-up flex flex-col items-center text-center">
            {/* Eyebrow */}
            <div className="mb-4 text-[0.6rem] uppercase tracking-[0.32em] text-muted-foreground/60 sm:mb-6">
              Profil membre
            </div>

            {/* Avatar (pseudonym initial — real identity never exposed) */}
            <div className="mb-4 grid h-20 w-20 place-items-center rounded-full bg-card font-serif text-2xl text-foreground/80 ring-1 ring-border/60 ring-offset-2 ring-offset-background sm:mb-5 sm:h-24 sm:w-24 sm:text-3xl sm:ring-offset-4 md:h-28 md:w-28 md:text-4xl">
              {initial}
            </div>

            {/* Name (pseudonym) */}
            <h1 className="font-serif text-2xl tracking-tight text-foreground sm:text-3xl md:text-4xl">
              {name}
            </h1>

            {/* Ornament divider */}
            <div className="my-3 flex items-center gap-2 sm:my-4">
              <span className="block h-px w-8 bg-border/80 sm:w-10" />
              <span className="font-serif text-[0.6rem] leading-none text-olive/70">◆</span>
              <span className="block h-px w-8 bg-border/80 sm:w-10" />
            </div>

            {/* Membership pill */}
            <div className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-3 py-1 sm:mb-5">
              <Heart className="h-3 w-3 fill-olive/80 text-olive/80" strokeWidth={1.5} />
              <span className="text-[0.65rem] uppercase tracking-[0.18em] text-foreground/70">
                Favoris partagés
              </span>
            </div>

            {/* Slug echo */}
            <p className="mt-1 font-mono text-[0.6rem] tracking-wide text-muted-foreground/50 sm:text-[0.65rem]">
              /u/{slug}
            </p>

            <ShareProfileButton slug={slug} />
          </div>
        </div>
      </section>

      {/* Wishlist */}
      <section className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6 sm:pb-20 md:px-8 md:pb-28">
        <div className="mb-6 flex items-center justify-between gap-4 border-b border-border/40 pb-3 sm:mb-8 sm:pb-4">
          <div className="flex items-center gap-2.5 sm:gap-3">
            <Heart className="h-4 w-4 text-olive/80" strokeWidth={1.5} />
            <h2 className="font-serif text-lg text-foreground sm:text-xl md:text-2xl">Wishlist</h2>
          </div>
          {products.length > 0 && (
            <span className="whitespace-nowrap text-[0.6rem] uppercase tracking-[0.18em] text-muted-foreground sm:text-[0.65rem]">
              {products.length} pièce{products.length > 1 ? "s" : ""}
            </span>
          )}
        </div>

        {products.length === 0 ? (
          <div className="flex flex-col items-center rounded-2xl border border-dashed border-border/60 bg-card/30 px-5 py-12 text-center sm:px-6 sm:py-16 md:py-20">
            <div className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-full bg-accent/40">
              <Heart className="h-5 w-5 text-foreground/40" strokeWidth={1.5} />
            </div>
            <h3 className="mb-2 font-serif text-base text-foreground sm:text-lg">
              Aucune pièce pour le moment
            </h3>
            <p className="max-w-sm px-2 text-xs text-muted-foreground sm:text-sm">
              {name} n&apos;a pas encore ajouté d&apos;article à sa collection.
            </p>
          </div>
        ) : (
          <ProductGrid products={products} />
        )}
      </section>
    </div>
  );
}

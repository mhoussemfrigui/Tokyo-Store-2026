"use client";

import { ProductCard } from "@/components/product-card";
import type { Product } from "@/types/catalog";

/**
 * "Vous aimerez aussi" — the PDP cross-sell section. Presentational only: the
 * RSC parent (`renderProductView`) resolves the related set through the
 * `listRelatedProducts` facade (same primary category → brand → recent) and
 * passes the médiathèque-resolved `Product[]` straight in.
 *
 * Luxury header voice (olive eyebrow + serif title + the olive `luxury-divider`)
 * above a responsive product grid that reuses the existing storefront
 * `<ProductCard>` verbatim, so cart wiring / money formatting / wishlist /
 * funnel tracking all stay intact. Renders null when the set is empty so the
 * PDP never shows an empty rail.
 */
export function RelatedProducts({
  products,
  title = "Vous aimerez aussi",
}: {
  products: Product[];
  title?: string;
}) {
  if (products.length === 0) return null;

  return (
    <section className="mx-auto max-w-[1400px] px-5 pb-14 sm:pb-20 md:px-8 lg:px-12">
      {/* Subtle top separation from the section above. */}
      <div className="border-t border-border/40 pt-10 sm:pt-16">
      {/* Luxury header — olive eyebrow, serif title, olive divider. */}
      <div className="tk-fade-in-up flex flex-col items-center text-center">
        <p className="mb-2 font-body text-[0.5rem] uppercase tracking-[0.35em] text-olive/70 md:mb-3 md:text-[0.6rem]">
          Notre sélection
        </p>
        <h2 className="font-serif text-2xl text-foreground md:text-3xl lg:text-4xl">
          {title}
        </h2>
        <div className="luxury-divider mt-4 max-w-[60px] md:mt-5" />
      </div>

      {/* Responsive product grid — same gutters/columns as the category grid. */}
        <div className="mt-8 grid grid-cols-2 gap-x-3 gap-y-6 sm:mt-12 sm:gap-x-6 sm:gap-y-10 lg:grid-cols-4">
          {products.map((p) => (
            <ProductCard key={p.slug} product={p} listName="related" />
          ))}
        </div>
      </div>
    </section>
  );
}

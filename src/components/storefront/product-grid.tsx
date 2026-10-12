import { ProductCard } from "@/components/product-card";
import type { Product } from "@/types/catalog";
import { cn } from "@/lib/utils";

/**
 * Responsive product grid used by the showcase redesigns. Defaults to the
 * storefront's standard responsive column counts; pass `className` to override
 * (e.g. a leaderboard that wants different breakpoints).
 */
export function ProductGrid({
  products,
  className,
}: {
  products: Product[];
  className?: string;
}) {
  if (products.length === 0) return null;
  return (
    <div
      className={cn(
        // Two columns on phones; from `sm` up the column COUNT auto-fills based
        // on available width (≈190px min) so it tracks the monitor size instead
        // of fixed breakpoints.
        "grid grid-cols-2 gap-x-3 gap-y-6 sm:gap-x-5 sm:gap-y-8 sm:[grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]",
        className,
      )}
    >
      {products.map((p) => (
        <ProductCard key={p.slug} product={p} />
      ))}
    </div>
  );
}

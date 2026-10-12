import { Star } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Shared read-only star-rating display.
 *
 * Renders `outOf` lucide <Star> icons; the first `Math.round(value)` are
 * filled with the canonical amber fill, the remainder are drawn empty. This
 * is the single source of truth for the hand-rolled star loops that used to
 * live in product-card, product-reviews, the PDP and the admin reviews panel.
 *
 * Pure (no hooks / browser APIs) so it is safe in both server and client
 * components — no `"use client"` needed.
 */
const SIZE_CLASSES = {
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
  lg: "h-5 w-5",
} as const;

export function StarRating({
  value,
  outOf = 5,
  size = "sm",
  className,
}: {
  value: number;
  outOf?: number;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const filled = Math.round(value);
  return (
    <span
      className={cn("inline-flex items-center gap-0.5", className)}
      aria-label={`${value} sur ${outOf}`}
    >
      {Array.from({ length: outOf }, (_, i) => (
        <Star
          key={i}
          className={cn(
            SIZE_CLASSES[size],
            i < filled
              ? "fill-amber-400 text-amber-400"
              : "fill-transparent text-muted-foreground/30",
          )}
          strokeWidth={1.5}
        />
      ))}
    </span>
  );
}

import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge only knows Tailwind's default scale names. Without this, the
 * theme's semantic tokens are misread: `shadow-island` / `shadow-cta` count as
 * shadow *colours* (so cn("shadow-cta", "shadow-primary/20") would drop the
 * shadow), and `rounded-island` / `rounded-card` are unknown, so
 * cn("rounded-full", "rounded-inner") would keep both. Registering them makes
 * overrides predictable. Keep in sync with the @theme block in globals.css.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      radius: ["island", "card", "inner", "media"],
      shadow: ["card", "soft", "pop", "float", "pill", "island", "overlay", "cta"],
      ease: ["soft"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

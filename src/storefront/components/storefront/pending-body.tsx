import { rhythm } from "@/storefront/components/storefront/ui-classes";
import { cn } from "@/storefront/lib/utils";

/**
 * Holds a localStorage-backed page body's place under its PageTop until the
 * client knows the stored state (see useHydrated), so the footer doesn't flash
 * up under the page top.
 */
export function PendingBody() {
  return <div aria-hidden className={cn("page-container min-h-[60svh]", rhythm.island)} />;
}

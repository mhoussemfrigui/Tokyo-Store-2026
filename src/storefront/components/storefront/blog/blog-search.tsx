import { Search } from "lucide-react";

/**
 * Blog search — a no-JS native GET form (crawlable, works pre-hydration). Submits
 * `?q=` to /blog (the index enters search mode at q.length >= 2). Styled as the
 * mockup's header search pill.
 */
export function BlogSearch({ defaultValue = "", action = "/blog" }: { defaultValue?: string; action?: string }) {
  return (
    <form
      action={action}
      method="get"
      role="search"
      className="flex h-14 min-w-0 flex-[0_1_360px] items-center gap-2.5 rounded-full border-[1.5px] border-border bg-muted px-5 transition-colors focus-within:border-foreground focus-within:bg-card"
    >
      <Search aria-hidden className="size-[18px] shrink-0 text-muted-foreground" strokeWidth={2} />
      <input
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder="Rechercher un article"
        aria-label="Rechercher un article"
        className="min-w-0 flex-1 border-none bg-transparent text-[16px] text-foreground outline-none placeholder:text-muted-foreground"
      />
    </form>
  );
}

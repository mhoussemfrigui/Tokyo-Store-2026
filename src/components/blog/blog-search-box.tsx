import { Search } from "lucide-react";

/**
 * Blog search field — a native GET form that navigates to `/blog?q=…` (no JS, so
 * it works before hydration and is crawlable). Two variants: `hero` sits on the
 * dark blog-index band; `sidebar` is the compact card in the article aside.
 */
export function BlogSearchBox({
  defaultValue = "",
  variant = "hero",
}: {
  defaultValue?: string;
  variant?: "hero" | "sidebar";
}) {
  const id = `blog-search-${variant}`;

  if (variant === "sidebar") {
    return (
      <form action="/blog" method="get" role="search" className="rounded-3xl border border-border bg-card p-5">
        <label htmlFor={id} className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Rechercher
        </label>
        <div className="mt-3 flex items-center gap-2 rounded-full border border-border bg-background px-3 py-2 focus-within:border-primary/50">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            id={id}
            name="q"
            type="search"
            defaultValue={defaultValue}
            placeholder="Un modèle, un sujet…"
            className="w-full bg-transparent text-sm focus:outline-none"
          />
        </div>
        <button
          type="submit"
          className="mt-3 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-full bg-primary text-xs font-semibold text-primary-foreground transition hover:opacity-90"
        >
          <Search className="h-3.5 w-3.5" />
          Rechercher
        </button>
      </form>
    );
  }

  return (
    <form action="/blog" method="get" role="search" className="mt-6 max-w-md">
      <label htmlFor={id} className="sr-only">
        Rechercher un article
      </label>
      <div className="flex items-center gap-2 rounded-full border border-background/25 bg-background/10 px-4 py-2.5 transition focus-within:border-background/50">
        <Search className="h-4 w-4 shrink-0 text-background/60" />
        <input
          id={id}
          name="q"
          type="search"
          defaultValue={defaultValue}
          placeholder="Rechercher un article…"
          className="w-full bg-transparent text-sm text-background placeholder:text-background/50 focus:outline-none"
        />
        <button
          type="submit"
          className="shrink-0 rounded-full bg-background px-4 py-1.5 text-xs font-semibold text-foreground transition hover:opacity-90"
        >
          Rechercher
        </button>
      </div>
    </form>
  );
}

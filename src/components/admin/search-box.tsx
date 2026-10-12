"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";

/**
 * Server-driven search input for admin list pages. On submit it navigates to
 * `hrefFor(query)` (the parent builds the URL, preserving its other params + resetting
 * the page), so the results + total come from the server — no client-side cap.
 */
export function SearchBox({
  defaultValue,
  hrefFor,
  placeholder = "Rechercher…",
}: {
  defaultValue: string;
  hrefFor: (query: string) => string;
  placeholder?: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState(defaultValue);

  const go = (value: string) => router.push(hrefFor(value.trim()));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        go(q);
      }}
      className="relative w-full sm:w-72"
      role="search"
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" strokeWidth={1.6} />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        aria-label="Rechercher"
        className="h-9 w-full rounded-full border border-border bg-card pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/15"
      />
      {q && (
        <button
          type="button"
          onClick={() => {
            setQ("");
            go("");
          }}
          aria-label="Effacer la recherche"
          className="absolute right-2.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full text-muted-foreground/60 hover:bg-surface hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </form>
  );
}

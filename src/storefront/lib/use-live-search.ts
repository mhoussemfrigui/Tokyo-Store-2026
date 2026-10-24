"use client";

import { useEffect, useRef, useState } from "react";

/**
 * One product hit from the live autocomplete endpoint (`/api/store/search`),
 * flattened for the dropdown UI. Prices are major-unit dinars (the endpoint
 * returns millimes; `/1000` here). All data is LIVE from Postgres (promo-enriched
 * prices + real `in_stock`) — no bundled `products.json` snapshot.
 */
export type LiveProductHit = {
  id: string;
  slug: string;
  title: string;
  href: string;
  image: string | null;
  price: number;
  oldPrice: number | null;
  inStock: boolean;
};

type Options = { limit?: number; debounceMs?: number };

/**
 * Debounced live product search for the header + search-page autocomplete.
 * Hits the first-party `/api/store/search` route (edge-cached 10s, rate-limited,
 * fail-safe to []). Returns `[]` for queries under 2 chars and aborts the inflight
 * request on each new keystroke so only the latest result wins.
 */
export function useLiveSearch(
  query: string,
  { limit = 8, debounceMs = 180 }: Options = {},
): { hits: LiveProductHit[]; loading: boolean } {
  const [hits, setHits] = useState<LiveProductHit[]>([]);
  const [loading, setLoading] = useState(false);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      ctrlRef.current?.abort();
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      fetch(
        `/api/store/search?q=${encodeURIComponent(q)}&kinds=product&limit=${limit}`,
        { signal: ctrl.signal },
      )
        .then((r) => (r.ok ? r.json() : { hits: [] }))
        .then((data: { hits?: Array<Record<string, unknown>> }) => {
          const mapped: LiveProductHit[] = (data.hits ?? [])
            .filter((h) => h.kind === "product")
            .map((h) => ({
              id: String(h.id ?? ""),
              slug: String(h.slug ?? ""),
              title: String(h.title ?? ""),
              href: typeof h.href === "string" && h.href ? h.href : `/${String(h.slug ?? "")}`,
              image: typeof h.imageUrl === "string" ? h.imageUrl : null,
              price: typeof h.priceCents === "number" ? h.priceCents / 1000 : 0,
              oldPrice: typeof h.oldPriceCents === "number" ? h.oldPriceCents / 1000 : null,
              inStock: h.inStock !== false,
            }));
          setHits(mapped);
          setLoading(false);
        })
        .catch((e: unknown) => {
          if ((e as Error)?.name === "AbortError") return;
          setHits([]);
          setLoading(false);
        });
    }, debounceMs);
    return () => clearTimeout(t);
  }, [query, limit, debounceMs]);

  return { hits, loading };
}

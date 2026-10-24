"use client";

import { useEffect, useState } from "react";

import type { Product } from "@/storefront/types/catalog";

/**
 * Client hooks that fetch LIVE catalogue cards from the first-party
 * `/api/store/products` endpoint (Postgres via catalogSource), replacing the former
 * bundled `products.json` snapshot that client surfaces (favorites, cart, home shelves)
 * used to read. `ready` flips true once the first response lands (so callers can show a
 * skeleton meanwhile); it fails safe to an empty list, never throwing.
 */

async function fetchProducts(query: string, signal: AbortSignal): Promise<Product[]> {
  const res = await fetch(`/api/store/products?${query}`, { signal });
  if (!res.ok) return [];
  const data = (await res.json()) as { products?: Product[] };
  return data.products ?? [];
}

/** Resolve specific products by slug (order preserved; missing slugs dropped). */
export function useLiveProductsBySlugs(slugs: string[]): { products: Product[]; ready: boolean } {
  const key = slugs.join(",");
  const [products, setProducts] = useState<Product[]>([]);
  const [ready, setReady] = useState(key === "");

  useEffect(() => {
    if (key === "") {
      setProducts([]);
      setReady(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    const ctrl = new AbortController();
    fetchProducts(`slugs=${encodeURIComponent(key)}`, ctrl.signal)
      .then((p) => {
        if (!cancelled) {
          setProducts(p);
          setReady(true);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled && (e as Error)?.name !== "AbortError") {
          setProducts([]);
          setReady(true);
        }
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [key]);

  return { products, ready };
}

/** All products in a category (rolled up to descendants). */
export function useLiveProductsByCategory(category: string | null): { products: Product[]; ready: boolean } {
  const cat = category ?? "";
  const [products, setProducts] = useState<Product[]>([]);
  const [ready, setReady] = useState(cat === "");

  useEffect(() => {
    if (cat === "") {
      setProducts([]);
      setReady(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    const ctrl = new AbortController();
    fetchProducts(`category=${encodeURIComponent(cat)}`, ctrl.signal)
      .then((p) => {
        if (!cancelled) {
          setProducts(p);
          setReady(true);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled && (e as Error)?.name !== "AbortError") {
          setProducts([]);
          setReady(true);
        }
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [cat]);

  return { products, ready };
}

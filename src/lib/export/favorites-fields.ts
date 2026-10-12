import { type CsvField, fieldChoices } from "@/lib/csv/fields";
import type { FavoritedProductRow } from "@/lib/wishlist/favorites-filter-shared";

/**
 * Favoris demand-export column catalog — ONE source of truth. `FAVORITES_CSV_FIELDS`
 * carries the value accessors (used by the export route); `FAVORITES_EXPORT_FIELDS` is the
 * derived {key,label} list for the client field-picker, so the picker and the route can
 * never drift. FavoritedProductRow is already enriched, so the accessors are pure — safe
 * to pull into the client bundle. Price is in millimes (matching the other admin exports).
 */
export const FAVORITES_CSV_FIELDS: ReadonlyArray<CsvField<FavoritedProductRow>> = [
  { key: "product", label: "Produit", value: (r) => r.name ?? "" },
  { key: "slug", label: "Slug", value: (r) => r.slug ?? "" },
  { key: "favorites", label: "Favoris", value: (r) => r.count },
  { key: "recent30", label: "Favoris (30j)", value: (r) => r.recent30 },
  { key: "stock", label: "Stock", value: (r) => (r.inStock ? "en stock" : "en rupture") },
  { key: "stockQty", label: "Quantité", value: (r) => (r.stockQty == null ? "" : r.stockQty) },
  { key: "price", label: "Prix (millimes)", value: (r) => r.priceCents },
  { key: "category", label: "Catégorie", value: (r) => r.categoryName ?? "" },
  { key: "published", label: "Publié", value: (r) => (r.isPublished ? "oui" : "non") },
  { key: "lastAdded", label: "Dernier ajout", value: (r) => r.lastAddedAt?.slice(0, 10) ?? "" },
];

/** {key,label}[] for the client field-picker (no accessors). */
export const FAVORITES_EXPORT_FIELDS = fieldChoices(FAVORITES_CSV_FIELDS);

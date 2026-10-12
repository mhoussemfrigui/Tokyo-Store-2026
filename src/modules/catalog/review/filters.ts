import { REVIEW_SOURCES, REVIEW_STATUSES } from "./schema";

/**
 * Moderation-list filter vocabularies — the canonical review status / source
 * unions plus the "all" sentinel the admin UI adds. DERIVED from
 * REVIEW_STATUSES / REVIEW_SOURCES so they can never drift from the schema, and
 * single-sourced here so the SERVER page (which parses + validates ?status /
 * ?source) and the CLIENT panel (which renders the chips and rebuilds the
 * querystring) always agree on the same round-trip vocabulary. The per-chip
 * display labels (incl. the "all" sentinel wording) stay a filter-UI concern in
 * the panel — only the tuples are shared here.
 *
 * Client-safe: `./schema` pulls in nothing server-only (pure drizzle table
 * metadata + a type import), so both the server page and the "use client"
 * panel can import these.
 */
export const STATUS_FILTERS = [...REVIEW_STATUSES, "all"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const SOURCE_FILTERS = ["all", ...REVIEW_SOURCES] as const;
export type SourceFilter = (typeof SOURCE_FILTERS)[number];

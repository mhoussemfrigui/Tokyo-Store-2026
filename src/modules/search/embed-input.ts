import { createHash } from "node:crypto";

/**
 * PURE embedding-input construction — no DB, no "server-only", so it's unit-tested
 * directly. Turns a product's human-meaningful text into the ONE string we embed, and
 * hashes it so the pipeline re-embeds a product ONLY when that text actually changed
 * (an embeddings API call per save on unrelated edits — price, stock — would be pure
 * waste + cost). Kept deliberately small + deterministic: same product text ⇒ same
 * input ⇒ same hash ⇒ no re-embed.
 */

export type EmbeddingSource = {
  name: string;
  /** Short marketing description (plain text — strip HTML before passing). */
  shortDesc?: string | null;
  /** Full description (plain text — strip HTML before passing). Adds the richest
   *  meaning signal; capped so a runaway description can't dominate the vector. */
  description?: string | null;
  /** Category display name(s) the product belongs to — adds domain context so
   *  « chrono » embeds near other « Chronographes » even without shared words. */
  categoryNames?: (string | null | undefined)[];
  /** Brand display name. */
  brandName?: string | null;
  /** Caractéristiques — attribute "Name : Value" pairs (Mouvement : Automatique,
   *  Matière : Acier, Étanchéité : 100 m…). Structured, high-signal text that lets a
   *  query match by SPEC/meaning even when the words aren't in the name/description. */
  attributes?: (string | null | undefined)[];
};

/** Bump when buildEmbeddingInput's COMPOSITION changes (fields added/reordered) — it is
 *  part of the fingerprint prefix, so bumping it re-selects every product for the
 *  backfill (coverage flips to « needing ») WITHOUT a model change. v2 = added
 *  caractéristiques (attributes) + full description. */
export const EMBEDDING_INPUT_VERSION = "v2";

/** Cap the embedded text so an adversarial / runaway description can't blow the
 *  embeddings request (the model truncates ~8k tokens anyway; product text is short). */
const MAX_INPUT_CHARS = 3000;
/** Sub-cap for the free-text description so it can't crowd out identity/spec signal.
 *  Exported so the pipeline's HTML-strip uses the SAME bound (no silent drift). */
export const MAX_DESC_CHARS = 800;

function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Build the canonical embedding input for a product. Order = identity first (name),
 * then taxonomy (brand, categories), then CARACTÉRISTIQUES (attribute specs), then the
 * short + full description — most-salient text first so truncation drops the least-
 * important tail. Empty parts are omitted so a product with no description/specs hashes
 * stably (adding them later changes the hash and triggers a re-embed, as intended).
 */
export function buildEmbeddingInput(src: EmbeddingSource): string {
  const parts: string[] = [];
  const name = clean(src.name);
  if (name) parts.push(name);

  const brand = clean(src.brandName);
  if (brand) parts.push(`Marque : ${brand}`);

  const cats = [...new Set((src.categoryNames ?? []).map(clean).filter((c) => c.length > 0))];
  if (cats.length > 0) parts.push(`Catégorie : ${cats.join(", ")}`);

  // Caractéristiques — deduped "Name : Value" pairs (order-stable via the SQL sort).
  const attrs = [...new Set((src.attributes ?? []).map(clean).filter((a) => a.length > 0))];
  if (attrs.length > 0) parts.push(`Caractéristiques : ${attrs.join(", ")}`);

  const shortDesc = clean(src.shortDesc);
  if (shortDesc) parts.push(shortDesc);

  // Full description last (least-salient tail) + sub-capped so it can't dominate.
  const desc = clean(src.description).slice(0, MAX_DESC_CHARS);
  if (desc && desc !== shortDesc) parts.push(desc);

  return parts.join("\n").slice(0, MAX_INPUT_CHARS);
}

/**
 * Content fingerprint of an embedding input, stored in `products.embedding_input_hash`
 * as `"<model>|<inputVersion>|<sha256(input)>"`. The pipeline re-embeds only when the
 * freshly-built fingerprint differs from the stored one — so an unrelated edit (price,
 * stock) is a no-op, a TEXT change re-embeds, a MODEL change re-embeds every product,
 * and an INPUT-SCHEMA change ({@link EMBEDDING_INPUT_VERSION} bump) re-embeds every
 * product too. The model + version are a READABLE prefix (not hashed in) so the
 * backfill's SQL can cheaply find rows off the current model/version with a
 * `LIKE '<model>|<version>|%'` test, without rebuilding every input in the DB.
 */
export function hashEmbeddingInput(input: string, model: string): string {
  return `${embeddingHashPrefix(model)}${createHash("sha256").update(input).digest("hex")}`;
}

/** The `"<model>|<version>|"` prefix of a stored fingerprint — a stable SQL `LIKE`
 *  anchor for "is this row on the current embedding model AND input schema?". `|` is
 *  stripped from the model id (embedding model names never contain it) so the delimiter
 *  stays unambiguous. */
export function embeddingHashPrefix(model: string): string {
  return `${model.replace(/\|/g, "")}|${EMBEDDING_INPUT_VERSION}|`;
}

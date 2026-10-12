/**
 * PURE (no server-only / db import) so it can be unit-tested under `test:pure`:
 * the field vocabulary that decides whether a product.updated event invalidates the
 * semantic embedding. `reembed-product.ts` (server-only) imports + re-exports these.
 *
 * ⚠️ MUST stay in sync with:
 *   - buildEmbeddingInput's inputs (src/modules/search/embed-input.ts): the text that
 *     actually feeds the vector — name + short desc + description + brand + categories
 *     + attribute name:value pairs;
 *   - the changedFields strings pushed by updateProductWorkflow (create-product.ts).
 * A field embedded but MISSING here silently returns false → the product's vector is
 * never refreshed and drifts permanently stale (no error, no log). Hence the test.
 */

/** Product changedFields whose change invalidates the embedding input. */
export const EMBEDDING_TEXT_FIELDS = [
  "name",
  "short_desc",
  "shortDesc",
  "description",
  "categories",
  "category",
  "brand",
  "attributes",
  "attribute_scalars",
];

/** Whether a product.updated's changedFields touch the embedded text. */
export function changedFieldsAffectEmbedding(changedFields: string[] | undefined | null): boolean {
  return !!changedFields?.some((f) => EMBEDDING_TEXT_FIELDS.includes(f));
}

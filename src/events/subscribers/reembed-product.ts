import "server-only";

import { bus } from "../bus";
import { getSearchConfig } from "@/modules/search/config";
import {
  embedProductsByIds,
  backfillPendingEmbeddings,
  markProductsNeedEmbedding,
  markBrandProductsNeedEmbedding,
  markCategoryProductsNeedEmbedding,
  markAttributeProductsNeedEmbedding,
} from "@/modules/search/embedding.service";

/**
 * Keep product semantic embeddings fresh as the catalogue changes.
 *
 * A product's embedding input (embed-input.ts) is its name + short description + FULL
 * description + BRAND name + CATEGORY names + CARACTÉRISTIQUES (attribute name : value
 * pairs), so it goes stale on a product edit OR on a brand / category / attribute /
 * value RENAME. This subscriber reacts to all of them:
 *
 *   • product.created / product.updated — an embedded TEXT field changed (name,
 *     short_desc, description, categories, brand, attributes, attribute_scalars) →
 *     re-embed the product (semantic on) / mark it needing (semantic off).
 *   • brand.updated / category.updated / attribute.* / attribute_value.* — every linked
 *     product's input changed → mark them NEEDING (NULL fingerprint, one bulk UPDATE, no
 *     API burst on the bus path); the next « Vectoriser » run heals them.
 *
 * When semantic is OFF, an edit still marks the product NEEDING (a cheap fingerprint
 * NULL, no paid API call) so the one-time backfill after enabling truly covers
 * everything changed while the switch was off — the definition of "needing" is
 * fingerprint-based, so a stale row must be visibly un-fingerprinted, not silently
 * left matching the current-model prefix.
 *
 * ⚠️ STUCK-BUTTON RULE (bus.emit awaits subscribers): every network/DB call here is
 * DETACHED — the emitting admin action returns instantly. Best-effort throughout
 * (errors swallowed + logged).
 */

// The embedded-field vocabulary + the changedFields gate live in the PURE
// ./reembed-fields sibling (unit-tested under test:pure); re-exported here so existing
// importers of this subscriber are unchanged.
export { EMBEDDING_TEXT_FIELDS, changedFieldsAffectEmbedding } from "./reembed-fields";
import { changedFieldsAffectEmbedding } from "./reembed-fields";

async function semanticOn(): Promise<boolean> {
  const cfg = await getSearchConfig().catch(() => null);
  return cfg?.semanticEnabled ?? false;
}

export function registerReembedProductSubscriber() {
  bus.on("product.created", (env) => {
    const { productId } = env.payload;
    // A brand-new product has no embedding + no fingerprint → it is ALREADY in the
    // needing-set, so when semantic is off we do nothing; when on we embed it now.
    void (async () => {
      if (!(await semanticOn())) return;
      await embedProductsByIds([productId], { actorUserId: env.actorUserId });
    })().catch((err) => console.error("[search] embed on product.created failed", err));
  });

  bus.on("product.updated", (env) => {
    const { productId, changedFields } = env.payload;
    if (!changedFieldsAffectEmbedding(changedFields)) return;
    void (async () => {
      if (await semanticOn()) await embedProductsByIds([productId], { actorUserId: env.actorUserId });
      else await markProductsNeedEmbedding([productId]);
    })().catch((err) => console.error("[search] reembed on product.updated failed", err));
  });

  // Entity RENAME cascade — a brand/category name is part of every linked product's
  // embedding input. Mark those products NEEDING (bounded bulk UPDATE); the backfill
  // re-embeds them. Gated on a NAME change (slug/meta/editorial fields aren't embedded).
  bus.on("brand.updated", (env) => {
    if (!env.payload.changedFields?.includes("name")) return;
    void markBrandProductsNeedEmbedding(env.payload.brandId).catch((err) =>
      console.error("[search] mark brand products needing failed", err),
    );
  });

  bus.on("category.updated", (env) => {
    if (!env.payload.changedFields?.includes("name")) return;
    void markCategoryProductsNeedEmbedding(env.payload.categoryId).catch((err) =>
      console.error("[search] mark category products needing failed", err),
    );
  });

  // Entity SOFT-DELETE cascade — the embedding input's brand/category joins filter
  // `deleted_at IS NULL`, so soft-deleting a brand/category DROPS its name from every
  // linked product's input (the product_brands/product_categories link is left intact
  // on soft-delete). Mark those products NEEDING so the next Vectoriser run heals the
  // now-stale vectors (which would otherwise keep matching the removed brand/category).
  bus.on("brand.deleted", (env) => {
    void markBrandProductsNeedEmbedding(env.payload.brandId).catch((err) =>
      console.error("[search] mark brand products needing (deleted) failed", err),
    );
  });

  bus.on("category.deleted", (env) => {
    void markCategoryProductsNeedEmbedding(env.payload.categoryId).catch((err) =>
      console.error("[search] mark category products needing (deleted) failed", err),
    );
  });

  // Attribute / value cascade — attribute NAMES + value LABELS are embedded in the
  // « Caractéristiques » segment, so a rename / deactivation / deletion staled every
  // linked product's vector. attribute.updated is gated on a name change (other attribute
  // edits — display_order, kind — aren't embedded); value updates/deletes always cascade
  // (a label edit is the common case and the payload carries no changedFields).
  bus.on("attribute.updated", (env) => {
    const { attributeId, changedFields } = env.payload;
    if (changedFields && !changedFields.includes("name")) return;
    void markAttributeProductsNeedEmbedding(attributeId).catch((err) =>
      console.error("[search] mark attribute products needing failed", err),
    );
  });
  bus.on("attribute.deleted", (env) => {
    void markAttributeProductsNeedEmbedding(env.payload.attributeId).catch((err) =>
      console.error("[search] mark attribute products needing (deleted) failed", err),
    );
  });
  bus.on("attribute_value.updated", (env) => {
    void markAttributeProductsNeedEmbedding(env.payload.attributeId).catch((err) =>
      console.error("[search] mark attribute-value products needing failed", err),
    );
  });
  bus.on("attribute_value.deleted", (env) => {
    void markAttributeProductsNeedEmbedding(env.payload.attributeId).catch((err) =>
      console.error("[search] mark attribute-value products needing (deleted) failed", err),
    );
  });

  // Bulk IMPORT auto-vectorise — the importer inserts products via raw writes and emits
  // import.products_completed (NOT product.created per row), so the per-product handlers
  // above never fire for imported rows. Run a full background backfill so newly-imported
  // products are embedded automatically (semantic on). DETACHED (long loop) + gated on
  // semantic; the loop's stuck-guard stops cheaply if no embedding provider is configured.
  bus.on("import.products_completed", (env) => {
    void (async () => {
      if (!(await semanticOn())) return;
      await backfillPendingEmbeddings({ actorUserId: env.actorUserId });
    })().catch((err) => console.error("[search] auto-embed after import failed", err));
  });
}

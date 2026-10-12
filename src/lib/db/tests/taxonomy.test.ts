import "server-only";

/**
 * Taxonomy & tax integrity — DB-backed invariants for the catalog tree, the
 * attribute write paths and the TVA / warranty category tier:
 *
 *  1. FULL ancestor chain: a TVA rate / warranty set on the ROOT reaches a product
 *     filed three levels down (loadCategoryChains → categoryChainTaxBps /
 *     categoryWarrantyFromChain → the order-line snapshot). Cycle-safe.
 *  2. Category delete clears its category_attribute_filters links IN the delete
 *     tx, and the attribute-side picker never loads a soft-deleted category (so
 *     its save can't be bricked); a legacy orphan self-heals on the next save.
 *     Children are promoted to the grandparent.
 *  3. Attribute create is ATOMIC: seed values deduped by slug, an unslug-able
 *     label rejected before any write, a failed seed insert rolls the attribute
 *     back (no row, no event); the value-slug unique maps to a friendly message.
 *  4. Kind change value-list → scalar is blocked while assignments / tax rules
 *     exist (value-list → value-list stays free).
 *  6. Bulk TVA editors: 0–100 % validated before any write, only changed rows
 *     written (one tx) with a per-entity *.updated event; brand schema capped.
 *     A soft-deleted brand's rate stops applying (brandTaxBpsForProducts).
 *  7. « Remises autorisées » opt-out stops applying once its category is deleted.
 *
 * Self-cleaning (`zztest-taxo-*` slugs). Run ONLY against a disposable DB:
 *   DATABASE_URL=… pnpm exec tsx --conditions=react-server \
 *     --env-file-if-exists=.env.local src/lib/db/tests/taxonomy.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { categories } from "@/modules/catalog/category/schema";
import { brands } from "@/modules/catalog/brand/schema";
import { products } from "@/modules/catalog/product/schema";
import {
  category_attribute_filters,
  product_attribute_assignments,
  product_attribute_values,
  product_attributes,
} from "@/modules/catalog/attribute/schema";
import { tax_rules } from "@/modules/tax/schema";
import { product_categories } from "@/associations/product-category";
import { product_brands } from "@/associations/product-brand";
import { attributeService } from "@/modules/catalog/attribute/service";
import { categoryService } from "@/modules/catalog/category/service";
import { categoryQueries } from "@/modules/catalog/category";
import { mapActiveSubcategoryTree, getApiCategoryByRef } from "@/lib/api/categories";
import { brandService } from "@/modules/catalog/brand/service";
import { taxQueries, taxService } from "@/modules/tax";
import { listNonDiscountableProductIds, getActiveDiscountForProduct } from "@/modules/promotion";
import { getApiBrandByRef } from "@/lib/api/brands";
import {
  productBrandLink,
  productCategoryLinks,
} from "@/associations/catalog.service";
import { loadCategoryChains } from "@/lib/catalog/category-chain";
import { categoryChainTaxBps } from "@/lib/tax";
import { categoryWarrantyFromChain } from "@/lib/warranty";
import { buildAddLineSnapshots } from "@/lib/order/build-line-snapshot";
import { uniqueViolationFail } from "@/workflows/shared";
import {
  createCategoryWorkflow,
  deleteCategoryWorkflow,
  reorderCategoriesWorkflow,
  setCategoryTaxRatesWorkflow,
  updateCategoryWorkflow,
} from "@/workflows/catalog/create-category";
import {
  createBrandWorkflow,
  deleteBrandWorkflow,
  reorderBrandsWorkflow,
  setBrandTaxRatesWorkflow,
  updateBrandWorkflow,
} from "@/workflows/catalog/create-brand";
import {
  createAttributeWorkflow,
  setAttributeCategoriesWorkflow,
  setCategoryFiltersWorkflow,
  updateAttributeWorkflow,
} from "@/workflows/catalog/manage-attributes";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const TAG = "zztest-taxo";
const ACTOR = { actorUserId: "zztest-taxo-actor" };

// Capture every emitted event (no subscribers are registered in a test process).
const events: { name: string; payload: Record<string, unknown> }[] = [];
bus.onAny((env) => {
  events.push({ name: env.name, payload: env.payload as Record<string, unknown> });
});
const eventsNamed = (name: string) => events.filter((e) => e.name === name);

async function mustCategory(input: Parameters<typeof createCategoryWorkflow>[0]): Promise<string> {
  const r = await createCategoryWorkflow(input, ACTOR);
  if (!r.ok) throw new Error(`category fixture failed: ${r.message}`);
  return r.data.categoryId;
}

async function mustBrand(input: Parameters<typeof createBrandWorkflow>[0]): Promise<string> {
  const r = await createBrandWorkflow(input, ACTOR);
  if (!r.ok) throw new Error(`brand fixture failed: ${r.message}`);
  return r.data.brandId;
}

async function makeProduct(suffix: string): Promise<string> {
  const [row] = await db
    .insert(products)
    .values({
      slug: `${TAG}-p-${suffix}`,
      name: `${TAG} produit ${suffix}`,
      price_cents: 100000,
      in_stock: true,
      is_published: true,
      published_at: sql`now()`,
    } as never)
    .returning({ id: products.id });
  return row.id;
}

async function cleanup() {
  const prodIds = (
    await db.select({ id: products.id }).from(products).where(like(products.slug, `${TAG}-%`))
  ).map((r) => r.id);
  const attrIds = (
    await db
      .select({ id: product_attributes.id })
      .from(product_attributes)
      .where(like(product_attributes.slug, `${TAG}-%`))
  ).map((r) => r.id);
  const catIds = (
    await db.select({ id: categories.id }).from(categories).where(like(categories.slug, `${TAG}-%`))
  ).map((r) => r.id);
  const valueIds = attrIds.length
    ? (
        await db
          .select({ id: product_attribute_values.id })
          .from(product_attribute_values)
          .where(inArray(product_attribute_values.attribute_id, attrIds))
      ).map((r) => r.id)
    : [];
  if (valueIds.length) {
    await db.delete(tax_rules).where(inArray(tax_rules.attribute_value_id, valueIds));
    await db
      .delete(product_attribute_assignments)
      .where(inArray(product_attribute_assignments.attribute_value_id, valueIds));
  }
  if (attrIds.length) {
    await db.delete(category_attribute_filters).where(inArray(category_attribute_filters.attribute_id, attrIds));
    await db.delete(product_attribute_values).where(inArray(product_attribute_values.attribute_id, attrIds));
    await db.delete(product_attributes).where(inArray(product_attributes.id, attrIds));
  }
  if (catIds.length) {
    await db.delete(category_attribute_filters).where(inArray(category_attribute_filters.category_id, catIds));
  }
  if (prodIds.length) {
    await db.delete(product_brands).where(inArray(product_brands.product_id, prodIds));
    await db.delete(product_categories).where(inArray(product_categories.product_id, prodIds));
    await db.delete(products).where(inArray(products.id, prodIds));
  }
  // Break any test-made parent loop before the delete (the self-FK is SET NULL).
  await db.update(categories).set({ parent_id: null }).where(like(categories.slug, `${TAG}-%`));
  await db.delete(categories).where(like(categories.slug, `${TAG}-%`));
  await db.delete(brands).where(like(brands.slug, `${TAG}-%`));
}

async function main() {
  await cleanup();

  // ── 1. Full ancestor chain: TVA + warranty from the ROOT at depth 3 ─────────
  console.log("category chain (depth 3):");
  const rootId = await mustCategory({
    name: `${TAG} root`,
    slug: `${TAG}-root`,
    taxRateBps: 700,
    warrantyMonths: 24,
  });
  const midId = await mustCategory({ name: `${TAG} mid`, slug: `${TAG}-mid`, parentId: rootId });
  const leafId = await mustCategory({ name: `${TAG} leaf`, slug: `${TAG}-leaf`, parentId: midId });

  const chains = await loadCategoryChains([leafId]);
  const chain = chains.get(leafId) ?? [];
  check(
    "chain is leaf → mid → root",
    chain.map((c) => c.id).join(",") === [leafId, midId, rootId].join(","),
  );
  check("root TVA reaches the depth-3 leaf", categoryChainTaxBps(chain.map((c) => c.tax_rate_bps)) === 700);
  check("root warranty reaches the depth-3 leaf", categoryWarrantyFromChain(chain)?.months === 24);
  const leafRow = await categoryService.findById(leafId);
  const seeded = await loadCategoryChains([leafId], { seed: leafRow ? [leafRow] : [], lookedUp: [leafId] });
  check("seeded walk still resolves the full chain", (seeded.get(leafId) ?? []).length === 3);
  const unknownId = randomUUID();
  check("unknown id → empty chain", (await loadCategoryChains([unknownId])).get(unknownId)?.length === 0);

  // Order-line snapshot (the post-sale "add line" path mirrors place-order).
  const pChain = await makeProduct("chain");
  await productCategoryLinks.set(pChain, [leafId, midId, rootId], leafId);
  const [snap] = await buildAddLineSnapshots([{ productId: pChain, quantity: 1 }], {
    mode: "ht",
    defaultRateBps: 1900,
  });
  check("snapshot: category-tier TVA from the root (700 bps), not global", snap?.values.tax_rate_bps === 700);
  check("snapshot: tax computed at 7 %", snap?.values.tax_cents === 7000);
  check("snapshot: warranty inherited from the root (24 mois)", snap?.values.warranty_months === 24);

  // Cycle safety — a pre-existing parent loop must not hang the walk.
  const cycA = await mustCategory({ name: `${TAG} cyc a`, slug: `${TAG}-cyc-a` });
  const cycB = await mustCategory({ name: `${TAG} cyc b`, slug: `${TAG}-cyc-b`, parentId: cycA });
  await db.update(categories).set({ parent_id: cycB }).where(eq(categories.id, cycA));
  const cyc = await loadCategoryChains([cycA]);
  check("parent loop terminates (chain of 2)", (cyc.get(cycA) ?? []).length === 2);
  await db.update(categories).set({ parent_id: null }).where(inArray(categories.id, [cycA, cycB]));

  // ── 2. Category delete clears attribute-filter links; picker stays saveable ─
  console.log("category delete ↔ attribute picker:");
  const attrRes = await createAttributeWorkflow(
    { name: `${TAG} Matière`, slug: `${TAG}-matiere`, kind: "multiselect", values: [{ label: "Acier" }] },
    ACTOR,
  );
  check("filter attribute created", attrRes.ok);
  const attrId = attrRes.ok ? attrRes.data.attributeId : "";
  const linkRes = await setAttributeCategoriesWorkflow({ attributeId: attrId, categoryIds: [leafId, midId] }, ACTOR);
  check("attribute linked to leaf + mid", linkRes.ok);

  const delLeaf = await deleteCategoryWorkflow({ categoryId: leafId }, ACTOR);
  check("delete leaf ok", delLeaf.ok);
  const leftovers = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(category_attribute_filters)
    .where(eq(category_attribute_filters.category_id, leafId));
  check("deleted category's filter links are cleared", Number(leftovers[0]?.n ?? -1) === 0);
  const loaded = await attributeService.listCategoriesForAttribute(attrId);
  check("picker loads only live categories", loaded.length === 1 && loaded[0] === midId);

  // Legacy orphan (a delete from before the fix): soft-delete bypassing the workflow.
  const orphanId = await mustCategory({ name: `${TAG} orphan`, slug: `${TAG}-orphan` });
  await attributeService.setAttributeCategories(attrId, [midId, orphanId]);
  await categoryService.softDelete(orphanId);
  const loaded2 = await attributeService.listCategoriesForAttribute(attrId);
  check("orphan link to a soft-deleted category is not loaded", !loaded2.includes(orphanId));
  const resave = await setAttributeCategoriesWorkflow({ attributeId: attrId, categoryIds: loaded2 }, ACTOR);
  check("attribute-side save with the loaded ids succeeds", resave.ok);
  const orphanRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(category_attribute_filters)
    .where(eq(category_attribute_filters.category_id, orphanId));
  check("that save self-heals the orphan link", Number(orphanRows[0]?.n ?? -1) === 0);

  // Child promotion on delete (mid's children → root).
  const kidId = await mustCategory({ name: `${TAG} kid`, slug: `${TAG}-kid`, parentId: midId });
  const delMid = await deleteCategoryWorkflow({ categoryId: midId }, ACTOR);
  check("delete mid ok", delMid.ok);
  check("mid's child promoted to the grandparent", (await categoryService.findById(kidId))?.parent_id === rootId);
  check("mid's filter links cleared too", (await attributeService.listCategoriesForAttribute(attrId)).length === 0);

  // ── 3. Attribute create atomicity ──────────────────────────────────────────
  console.log("attribute create:");
  const dup = await createAttributeWorkflow(
    {
      name: `${TAG} Couleur`,
      slug: `${TAG}-couleur`,
      kind: "multiselect",
      values: [{ label: "Rouge" }, { label: "rouge" }, { label: "Bleu" }],
    },
    ACTOR,
  );
  check("near-duplicate seed labels don't fail the create", dup.ok);
  const dupValues = dup.ok ? await attributeService.listValuesForAttribute(dup.data.attributeId) : [];
  check("seed values deduped by slug (rouge, bleu)", dupValues.map((v) => v.slug).sort().join(",") === "bleu,rouge");

  const createdBefore = eventsNamed("attribute.created").length;
  const bad = await createAttributeWorkflow(
    { name: `${TAG} Vide`, slug: `${TAG}-vide`, kind: "select", values: [{ label: "Ok" }, { label: "—" }] },
    ACTOR,
  );
  check("unslug-able seed label rejected (validation)", !bad.ok && bad.error === "validation");
  check("…and nothing was written", (await attributeService.findAttributeBySlug(`${TAG}-vide`)) === null);

  const origInsertValue = attributeService.insertValue;
  let calls = 0;
  attributeService.insertValue = async function (...args: Parameters<typeof origInsertValue>) {
    calls += 1;
    if (calls === 2) throw new Error("zztest: simulated seed-value failure");
    return origInsertValue.apply(attributeService, args);
  };
  let rolled: Awaited<ReturnType<typeof createAttributeWorkflow>>;
  try {
    rolled = await createAttributeWorkflow(
      { name: `${TAG} Rollback`, slug: `${TAG}-rollback`, kind: "select", values: [{ label: "A" }, { label: "B" }] },
      ACTOR,
    );
  } finally {
    attributeService.insertValue = origInsertValue;
  }
  check("a failed seed insert fails the create", !rolled.ok);
  check("…and rolls the attribute back (retry won't hit « Slug déjà utilisé »)", (await attributeService.findAttributeBySlug(`${TAG}-rollback`)) === null);
  check("no attribute.created for failed creates", eventsNamed("attribute.created").length === createdBefore);
  const friendly = uniqueViolationFail({ code: "23505", constraint: "product_attribute_values_attribute_slug_unique" });
  check(
    "value-slug unique maps to a friendly field error",
    friendly?.error === "conflict" && friendly.fieldErrors?.slug === "Ce slug de valeur est déjà utilisé pour cet attribut.",
  );

  // ── 4. Kind change value-list → scalar guard ──────────────────────────────
  console.log("attribute kind change:");
  const kindRes = await createAttributeWorkflow(
    { name: `${TAG} Mouvement`, slug: `${TAG}-mouvement`, kind: "select", values: [{ label: "Auto" }, { label: "Quartz" }] },
    ACTOR,
  );
  const kindAttrId = kindRes.ok ? kindRes.data.attributeId : "";
  const kindValues = await attributeService.listValuesForAttribute(kindAttrId);
  const pKind = await makeProduct("kind");
  await attributeService.setProductAttributeValues(pKind, [kindValues[0].id]);

  const toMulti = await updateAttributeWorkflow({ attributeId: kindAttrId, kind: "multiselect" }, ACTOR);
  check("value-list → value-list stays allowed while in use", toMulti.ok);
  const toNumber = await updateAttributeWorkflow({ attributeId: kindAttrId, kind: "number" }, ACTOR);
  check("→ number blocked while products carry a value", !toNumber.ok && toNumber.error === "in_use");
  check("…kind unchanged", (await attributeService.findAttributeById(kindAttrId))?.kind === "multiselect");

  await attributeService.setProductAttributeValues(pKind, []);
  await taxService.upsert(kindValues[1].id, 1300);
  const toText = await updateAttributeWorkflow({ attributeId: kindAttrId, kind: "text" }, ACTOR);
  check("→ text blocked while a TVA rule targets a value", !toText.ok && toText.error === "in_use");
  await taxService.deleteByAttributeValueId(kindValues[1].id);
  const freed = await updateAttributeWorkflow({ attributeId: kindAttrId, kind: "number" }, ACTOR);
  check("→ number allowed once unused", freed.ok && (await attributeService.findAttributeById(kindAttrId))?.kind === "number");

  // ── 6. Bulk TVA editors ─────────────────────────────────────────────────────
  console.log("bulk TVA editors:");
  const siblingId = await mustCategory({ name: `${TAG} sib`, slug: `${TAG}-sib`, parentId: rootId });
  const tooHigh = await setCategoryTaxRatesWorkflow(
    { rates: [{ categoryId: siblingId, taxRateBps: 1300 }, { categoryId: kidId, taxRateBps: 15000 }] },
    ACTOR,
  );
  check("category rate > 100 % rejected", !tooHigh.ok && tooHigh.error === "validation");
  check("…and NO row written (not even the valid one)", (await categoryService.findById(siblingId))?.tax_rate_bps === null);

  const rootBefore = await categoryService.findById(rootId);
  const catUpdBefore = eventsNamed("category.updated").length;
  const catSave = await setCategoryTaxRatesWorkflow(
    {
      rates: [
        { categoryId: rootId, taxRateBps: 700 }, // unchanged
        { categoryId: siblingId, taxRateBps: 1300 },
        { categoryId: kidId, taxRateBps: null }, // unchanged (already inherits)
      ],
    },
    ACTOR,
  );
  check("valid bulk save ok", catSave.ok);
  check("only the changed row is written", catSave.ok && catSave.data.changedIds.join(",") === siblingId);
  check("changed rate stored", (await categoryService.findById(siblingId))?.tax_rate_bps === 1300);
  const rootAfter = await categoryService.findById(rootId);
  check(
    "unchanged row not rewritten (updated_at intact)",
    rootBefore?.updated_at?.getTime() === rootAfter?.updated_at?.getTime(),
  );
  const catUpdEvents = eventsNamed("category.updated").slice(catUpdBefore);
  check(
    "one category.updated for the changed category",
    catUpdEvents.length === 1 && catUpdEvents[0].payload.categoryId === siblingId,
  );

  const brandRes = await createBrandWorkflow({ name: `${TAG} marque`, slug: `${TAG}-brand` }, ACTOR);
  const brandId = brandRes.ok ? brandRes.data.brandId : "";
  const brandBad = await setBrandTaxRatesWorkflow({ rates: [{ brandId, taxRateBps: 15000 }] }, ACTOR);
  check("brand rate > 100 % rejected (no DB CHECK on brands)", !brandBad.ok);
  check("…brand rate untouched", (await brandService.findById(brandId))?.tax_rate_bps === null);
  const brUpdBefore = eventsNamed("brand.updated").length;
  const brandOk = await setBrandTaxRatesWorkflow({ rates: [{ brandId, taxRateBps: 1200 }] }, ACTOR);
  check("brand bulk save ok", brandOk.ok && brandOk.data.changedIds.join(",") === brandId);
  check("brand rate stored", (await brandService.findById(brandId))?.tax_rate_bps === 1200);
  const brandNoop = await setBrandTaxRatesWorkflow({ rates: [{ brandId, taxRateBps: 1200 }] }, ACTOR);
  check("re-saving the same rate writes nothing", brandNoop.ok && brandNoop.data.changedIds.length === 0);
  check("exactly one brand.updated emitted", eventsNamed("brand.updated").length === brUpdBefore + 1);
  const brandPatchBad = await updateBrandWorkflow({ brandId, taxRateBps: 20000 }, ACTOR);
  check("updateBrand rejects an out-of-range taxRateBps", !brandPatchBad.ok && brandPatchBad.error === "validation");

  // Brand tier only from LIVE brands (a soft delete keeps the product_brands link).
  const pBrand = await makeProduct("brand");
  await productBrandLink.set(pBrand, brandId);
  check("live brand rate applies to its products", (await taxQueries.brandTaxBpsForProducts([pBrand])).get(pBrand) === 1200);
  await deleteBrandWorkflow({ brandId }, ACTOR);
  check(
    "deleted brand's rate no longer outranks the category tier",
    !(await taxQueries.brandTaxBpsForProducts([pBrand])).has(pBrand),
  );

  // ── 7. « Remises autorisées » opt-out from a deleted category ───────────────
  console.log("discountable opt-out:");
  const ndId = await mustCategory({ name: `${TAG} nd`, slug: `${TAG}-nd`, isDiscountable: false });
  const pNd = await makeProduct("nd");
  await productCategoryLinks.set(pNd, [ndId], ndId);
  check("live non-discountable category blocks discounts", (await listNonDiscountableProductIds([pNd])).includes(pNd));
  await deleteCategoryWorkflow({ categoryId: ndId }, ACTOR);
  check(
    "deleted non-discountable category no longer blocks them",
    !(await listNonDiscountableProductIds([pNd])).includes(pNd),
  );
  const ndLinks = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(product_categories)
    .where(and(eq(product_categories.product_id, pNd), eq(product_categories.category_id, ndId)));
  check("(the product link itself survives the soft delete)", Number(ndLinks[0]?.n ?? 0) === 1);

  // ── 8. updateCategory sparse-patch reactivation guard ───────────────────────
  // Zod KEEPS `.default()` through `.partial()`, so a sparse patch (e.g. from an
  // ERP PATCH) parses isActive/isDiscountable back to `true` and noindex to
  // `false`. The `provided`-key guard must stop those injected defaults from
  // silently re-activating an archived category / re-enabling discounts /
  // clearing noindex on a name-only rename.
  console.log("updateCategory sparse-patch guard:");
  const guardId = await mustCategory({
    name: `${TAG} guard`,
    slug: `${TAG}-guard`,
    isActive: false,
    isDiscountable: false,
    noindex: true,
  });
  const sparse = await updateCategoryWorkflow(
    { categoryId: guardId, name: `${TAG} guard renamed` },
    ACTOR,
  );
  check("sparse name-only patch ok", sparse.ok);
  const guardAfter = await categoryService.findById(guardId);
  check("…name applied", guardAfter?.name === `${TAG} guard renamed`);
  check("…is_active preserved (Zod default did NOT reactivate)", guardAfter?.is_active === false);
  check("…is_discountable preserved", guardAfter?.is_discountable === false);
  check("…noindex preserved", guardAfter?.noindex === true);
  const react = await updateCategoryWorkflow({ categoryId: guardId, isActive: true }, ACTOR);
  check(
    "explicit isActive:true still flips it (guard doesn't over-block)",
    react.ok && (await categoryService.findById(guardId))?.is_active === true,
  );

  // ── 9. updateCategory re-parent cycle guard ─────────────────────────────────
  console.log("updateCategory re-parent cycle guard:");
  const cgRoot = await mustCategory({ name: `${TAG} cg root`, slug: `${TAG}-cg-root` });
  const cgMid = await mustCategory({ name: `${TAG} cg mid`, slug: `${TAG}-cg-mid`, parentId: cgRoot });
  const cgLeaf = await mustCategory({ name: `${TAG} cg leaf`, slug: `${TAG}-cg-leaf`, parentId: cgMid });
  const selfParent = await updateCategoryWorkflow({ categoryId: cgRoot, parentId: cgRoot }, ACTOR);
  check("self-parent rejected", !selfParent.ok && selfParent.error === "validation");
  const descCycle = await updateCategoryWorkflow({ categoryId: cgRoot, parentId: cgLeaf }, ACTOR);
  check("re-parent under own descendant rejected", !descCycle.ok && descCycle.error === "validation");
  check("…root parent unchanged (still a root)", (await categoryService.findById(cgRoot))?.parent_id === null);
  const missingParent = await updateCategoryWorkflow({ categoryId: cgMid, parentId: randomUUID() }, ACTOR);
  check("re-parent under a nonexistent target rejected", !missingParent.ok && missingParent.error === "validation");
  const legal = await updateCategoryWorkflow({ categoryId: cgLeaf, parentId: cgRoot }, ACTOR);
  check(
    "legal re-parent (leaf → root) succeeds",
    legal.ok && (await categoryService.findById(cgLeaf))?.parent_id === cgRoot,
  );

  // ── 10. Sibling reorder scoped to one parent ────────────────────────────────
  console.log("category reorder:");
  // cgRoot now has children [cgMid, cgLeaf]. Reverse their order.
  const roBefore = await categoryService.listChildren(cgRoot);
  const roIds = roBefore.map((c) => c.id);
  check("reorder fixture has ≥2 siblings", roIds.length >= 2);
  const reversed = [...roIds].reverse();
  const ro = await reorderCategoriesWorkflow({ parentId: cgRoot, orderedIds: reversed }, ACTOR);
  check("reorder ok", ro.ok);
  const roAfter = await categoryService.listChildren(cgRoot);
  check(
    "children now in the requested order",
    roAfter.map((c) => c.id).join(",") === reversed.join(","),
  );
  const foreign = await reorderCategoriesWorkflow({ parentId: cgRoot, orderedIds: [cgRoot] }, ACTOR);
  check(
    "reorder ignores ids not in the sibling set (no cross-branch renumber)",
    foreign.ok && foreign.data.changed.length === 0,
  );
  // Dedupe: a duplicated id must not skip an index — live siblings stay
  // contiguous 0..n.
  const dupIds = (await categoryService.listChildren(cgRoot)).map((c) => c.id);
  const roDup = await reorderCategoriesWorkflow(
    { parentId: cgRoot, orderedIds: [dupIds[0], dupIds[0], ...dupIds.slice(1)] },
    ACTOR,
  );
  check("reorder with a duplicate id ok", roDup.ok);
  const dupAfter = await categoryService.listChildren(cgRoot);
  check(
    "…siblings stay contiguous 0..n (no gap from the duplicate)",
    dupAfter.every((c, i) => c.display_order === i),
  );
  // A soft-deleted sibling id in the list is ignored (never renumbered).
  const delId = dupIds[dupIds.length - 1];
  await db.update(categories).set({ deleted_at: new Date() }).where(eq(categories.id, delId));
  const liveAfterDelete = (await categoryService.listChildren(cgRoot)).map((c) => c.id);
  const roDel = await reorderCategoriesWorkflow(
    { parentId: cgRoot, orderedIds: [delId, ...liveAfterDelete] },
    ACTOR,
  );
  check("reorder ignores a soft-deleted id", roDel.ok && !roDel.data.changed.includes(delId));
  await db.update(categories).set({ deleted_at: null }).where(eq(categories.id, delId));

  // ── 11. countProductsForCategoryTrees: DISTINCT roll-up + live/published gate ─
  // Drives the mega-menu counts, getSubcategoryCounts AND the category-page
  // noindex decision — a refactor losing DISTINCT / the published filter / per-root
  // attribution would silently corrupt all three. (No test covered it before.)
  console.log("countProductsForCategoryTrees:");
  const cntRoot = await mustCategory({ name: `${TAG} cnt root`, slug: `${TAG}-cnt-root` });
  const cntChild = await mustCategory({ name: `${TAG} cnt child`, slug: `${TAG}-cnt-child`, parentId: cntRoot });
  const cntGrand = await mustCategory({ name: `${TAG} cnt grand`, slug: `${TAG}-cnt-grand`, parentId: cntChild });
  const cntRoot2 = await mustCategory({ name: `${TAG} cnt root2`, slug: `${TAG}-cnt-root2` });
  // p1 linked to BOTH the root and a deep descendant → must count ONCE for the root.
  const cp1 = await makeProduct("cnt1");
  await productCategoryLinks.set(cp1, [cntRoot, cntGrand], cntGrand);
  // p2 filed only on the deep leaf → must roll up to the root.
  const cp2 = await makeProduct("cnt2");
  await productCategoryLinks.set(cp2, [cntGrand], cntGrand);
  // p3 on the OTHER root → separate per-root count.
  const cp3 = await makeProduct("cnt3");
  await productCategoryLinks.set(cp3, [cntRoot2], cntRoot2);
  // p4 UNPUBLISHED on the leaf → excluded.
  const [cp4Row] = await db
    .insert(products)
    .values({ slug: `${TAG}-p-cnt4`, name: `${TAG} cnt4`, price_cents: 1000, in_stock: true, is_published: false } as never)
    .returning({ id: products.id });
  await productCategoryLinks.set(cp4Row.id, [cntGrand], cntGrand);
  // p5 SOFT-DELETED on the leaf → excluded.
  const cp5 = await makeProduct("cnt5");
  await productCategoryLinks.set(cp5, [cntGrand], cntGrand);
  await db.update(products).set({ deleted_at: new Date() }).where(eq(products.id, cp5));

  const treeCounts = await productCategoryLinks.countProductsForCategoryTrees([cntRoot, cntRoot2]);
  check(
    "root count DEDUPES a product linked to both parent+descendant AND excludes unpublished/soft-deleted (p1+p2 = 2)",
    treeCounts.get(cntRoot) === 2,
  );
  check("a distinct second root is counted separately (p3 = 1)", treeCounts.get(cntRoot2) === 1);
  // Leaf-level roll-up: counting the leaf directly sees p1 + p2 (its two live links),
  // proving the deep node's own products roll into any ancestor's tree count.
  const leafCounts = await productCategoryLinks.countProductsForCategoryTrees([cntGrand]);
  check("leaf tree count is its own live/published products (p1+p2 = 2)", leafCounts.get(cntGrand) === 2);

  // ── 12. getCategorySubtreeChildren (full nested) + active-pruning ────────────
  // The hub-page "Catégorie" facet needs the FULL descendant tree, then prunes
  // inactive branches for the storefront. Neither had test coverage.
  console.log("getCategorySubtreeChildren + active-pruning:");
  const stRoot = await mustCategory({ name: `${TAG} st root`, slug: `${TAG}-st-root` });
  const stA = await mustCategory({ name: `${TAG} st A`, slug: `${TAG}-st-a`, parentId: stRoot });
  const stAX = await mustCategory({ name: `${TAG} st AX`, slug: `${TAG}-st-ax`, parentId: stA });
  const stB = await mustCategory({ name: `${TAG} st B`, slug: `${TAG}-st-b`, parentId: stRoot, isActive: false });
  const stBY = await mustCategory({ name: `${TAG} st BY`, slug: `${TAG}-st-by`, parentId: stB }); // active leaf under inactive B
  const rawTree = await categoryQueries.getCategorySubtreeChildren(stRoot);
  check("subtree returns BOTH direct children (active + inactive)", rawTree.length === 2);
  const rawA = rawTree.find((n) => n.id === stA);
  const rawB = rawTree.find((n) => n.id === stB);
  check("subtree nests grandchildren (AX under A)", (rawA?.children ?? []).some((c) => c.id === stAX));
  check("subtree includes the inactive branch raw (BY under B)", (rawB?.children ?? []).some((c) => c.id === stBY));
  const pruned = mapActiveSubcategoryTree(rawTree);
  check("active-pruning keeps the active branch (A)", pruned.some((s) => s.slug === `${TAG}-st-a`));
  check("active-pruning nests A's active child (AX)", pruned.find((s) => s.slug === `${TAG}-st-a`)?.children?.some((c) => c.slug === `${TAG}-st-ax`) === true);
  check(
    "active-pruning drops the inactive branch B AND its active descendant BY",
    !pruned.some((s) => s.slug === `${TAG}-st-b` || s.slug === `${TAG}-st-by`),
  );
  void stBY;

  // ── 13. getSubcategoryBySlug contract: UNGATED (callers pre-gate) ────────────
  // getSubcategoryBySlug is a low-level resolver with NO active/ancestor gate —
  // the storefront /[slug]/[sub] route pre-gates (getCategoryBySlug + activeOnly)
  // before it. Pin the ungated contract so any future gating is a deliberate change.
  console.log("getSubcategoryBySlug contract:");
  const gsRoot = await mustCategory({ name: `${TAG} gs root`, slug: `${TAG}-gs-root` });
  const gsSub = await mustCategory({ name: `${TAG} gs sub`, slug: `${TAG}-gs-sub`, parentId: gsRoot, isActive: false });
  const resolved = await categoryQueries.getSubcategoryBySlug(`${TAG}-gs-root`, `${TAG}-gs-sub`);
  check("getSubcategoryBySlug returns an INACTIVE child (ungated by design)", resolved?.id === gsSub);
  check("…unknown sub slug → null", (await categoryQueries.getSubcategoryBySlug(`${TAG}-gs-root`, "zztest-nope")) === null);

  // ── 14. ApiCategory (ERP) round-trip completeness ────────────────────────────
  // Every field the create/update write path accepts must be READ back by
  // getApiCategoryByRef (toApiCategory), incl. the value-prop cards / editorial /
  // media links — a keyed ERP caller round-trips + reconciles what it PUT.
  console.log("ApiCategory ERP round-trip:");
  const apiParent = await mustCategory({ name: `${TAG} api parent`, slug: `${TAG}-api-parent` });
  const heroMid = randomUUID();
  const boutiqueMid = randomUUID();
  const ogMid = randomUUID();
  const iconMid = randomUUID();
  const apiFull = {
    name: `${TAG} api full`,
    slug: `${TAG}-api-full`,
    tagline: "Tag",
    description: "<p>desc</p>",
    externalRef: `${TAG}-EXT-1`,
    parentId: apiParent,
    warrantyMonths: 12,
    warrantyLabel: "12 mois",
    taxRateBps: 700,
    displayOrder: 3,
    metaTitle: "MT",
    metaDescription: "MD",
    canonicalUrl: "https://x.test/c",
    noindex: true,
    ogImageMediaId: ogMid,
    heroMediaId: heroMid,
    boutiqueImageMediaId: boutiqueMid,
    icon: "watch",
    iconMediaId: iconMid,
    isActive: true,
    isDiscountable: false,
    editorialEyebrow: "EB",
    editorialTitle: "ET",
    editorialBody: "<p>body</p>",
    valueProps: [{ icon: "truck", iconMediaId: null, title: "Livraison", body: "rapide" }],
  };
  const apiId = await mustCategory(apiFull);
  const byId = await getApiCategoryByRef({ categoryId: apiId });
  check("read by id resolves", byId !== null);
  const byRef = await getApiCategoryByRef({ externalRef: `${TAG}-EXT-1` });
  check("read by externalRef resolves the SAME row", byRef?.id === apiId);
  // Every writable field reads back.
  check("round-trip: externalRef", byId?.externalRef === `${TAG}-EXT-1`);
  check("round-trip: parentId", byId?.parentId === apiParent);
  check("round-trip: isDiscountable=false preserved", byId?.isDiscountable === false);
  check("round-trip: taxRateBps", byId?.taxRateBps === 700);
  check("round-trip: warrantyMonths + label", byId?.warrantyMonths === 12 && byId?.warrantyLabel === "12 mois");
  check(
    "round-trip: hero / boutique / og / icon media ids",
    byId?.heroMediaId === heroMid &&
      byId?.boutiqueImageMediaId === boutiqueMid &&
      byId?.ogImageMediaId === ogMid &&
      byId?.iconMediaId === iconMid &&
      byId?.icon === "watch",
  );
  check("round-trip: displayOrder + noindex + canonicalUrl", byId?.displayOrder === 3 && byId?.noindex === true && byId?.canonicalUrl === "https://x.test/c");
  check(
    "round-trip: editorial block",
    byId?.editorialEyebrow === "EB" && byId?.editorialTitle === "ET" && byId?.editorialBody === "<p>body</p>",
  );
  check(
    "round-trip: value_props (icon/title/body)",
    Array.isArray(byId?.valueProps) &&
      byId!.valueProps!.length === 1 &&
      byId!.valueProps![0].title === "Livraison" &&
      byId!.valueProps![0].body === "rapide",
  );
  // Sparse PATCH (name only) must NOT wipe value_props / editorial (provided-key guard).
  await updateCategoryWorkflow({ categoryId: apiId, name: `${TAG} api renamed` }, ACTOR);
  const afterPatch = await getApiCategoryByRef({ categoryId: apiId });
  check("sparse name-only PATCH keeps value_props", (afterPatch?.valueProps?.length ?? 0) === 1);
  check("sparse name-only PATCH keeps editorialBody", afterPatch?.editorialBody === "<p>body</p>");
  // Explicitly clearing value_props works.
  await updateCategoryWorkflow({ categoryId: apiId, valueProps: [] }, ACTOR);
  check("explicit valueProps:[] clears them", (await getApiCategoryByRef({ categoryId: apiId }))?.valueProps?.length === 0);

  // ── 15. Category create lands at the END of its sibling group ────────────────
  console.log("create display_order (end of group):");
  const ordRoot = await mustCategory({ name: `${TAG} ord root`, slug: `${TAG}-ord-root` });
  const ordA = await mustCategory({ name: `${TAG} ord A`, slug: `${TAG}-ord-a`, parentId: ordRoot });
  const ordB = await mustCategory({ name: `${TAG} ord B`, slug: `${TAG}-ord-b`, parentId: ordRoot });
  const ordC = await mustCategory({ name: `${TAG} ord C`, slug: `${TAG}-ord-c`, parentId: ordRoot });
  const ordChildren = await categoryService.listChildren(ordRoot);
  check(
    "successive creates get 0,1,2 (each lands at the end, not all 0)",
    ordChildren.find((c) => c.id === ordA)?.display_order === 0 &&
      ordChildren.find((c) => c.id === ordB)?.display_order === 1 &&
      ordChildren.find((c) => c.id === ordC)?.display_order === 2,
  );

  // ── 16. setCategoryFilters: valid succeeds + emits; dead attribute id rejected ─
  console.log("setCategoryFilters (category → attribute):");
  const sfCat = await mustCategory({ name: `${TAG} sf cat`, slug: `${TAG}-sf-cat` });
  const sfAttr = await createAttributeWorkflow(
    { name: `${TAG} SF`, slug: `${TAG}-sf-attr`, kind: "select", values: [{ label: "X" }] },
    ACTOR,
  );
  const sfAttrId = sfAttr.ok ? sfAttr.data.attributeId : "";
  const sfBefore = eventsNamed("category.filter_attributes.updated").length;
  const sfOk = await setCategoryFiltersWorkflow({ categoryId: sfCat, attributeIds: [sfAttrId] }, ACTOR);
  check("valid attribute id → succeeds", sfOk.ok);
  check(
    "…emits category.filter_attributes.updated once",
    eventsNamed("category.filter_attributes.updated").length === sfBefore + 1,
  );
  check("…link persisted", (await attributeService.listCategoryFilters(sfCat)).includes(sfAttrId));
  const sfDead = await setCategoryFiltersWorkflow({ categoryId: sfCat, attributeIds: [randomUUID()] }, ACTOR);
  check("a nonexistent attribute id is rejected before write", !sfDead.ok && sfDead.error === "validation");
  check(
    "…and the existing link is untouched (rejected before the replace)",
    (await attributeService.listCategoryFilters(sfCat)).includes(sfAttrId),
  );

  // ── 17. Brand is_discountable tier (per-brand "never discountable" opt-out) ───
  console.log("brand is_discountable tier:");
  const ndBrand = await mustBrand({ name: `${TAG} nd brand`, slug: `${TAG}-nd-brand`, isDiscountable: false });
  const okBrand = await mustBrand({ name: `${TAG} ok brand`, slug: `${TAG}-ok-brand`, isDiscountable: true });
  const pNdBrand = await makeProduct("ndbrand");
  await productBrandLink.set(pNdBrand, ndBrand);
  const pOkBrand = await makeProduct("okbrand");
  await productBrandLink.set(pOkBrand, okBrand);
  check(
    "non-discountable brand blocks its products (bulk guard)",
    (await listNonDiscountableProductIds([pNdBrand, pOkBrand])).includes(pNdBrand),
  );
  check(
    "…a discountable brand does NOT block its products",
    !(await listNonDiscountableProductIds([pNdBrand, pOkBrand])).includes(pOkBrand),
  );
  check(
    "getActiveDiscountForProduct short-circuits to null for a non-discountable brand",
    (await getActiveDiscountForProduct({
      productId: pNdBrand,
      unitPriceCents: 100000,
      categoryIds: [],
      brandIds: [ndBrand],
    })) === null,
  );
  await deleteBrandWorkflow({ brandId: ndBrand }, ACTOR);
  check(
    "a soft-deleted non-discountable brand no longer blocks (live-only)",
    !(await listNonDiscountableProductIds([pNdBrand])).includes(pNdBrand),
  );

  // ── 18. Brand reorder (flat display_order) ───────────────────────────────────
  console.log("brand reorder:");
  const rbA = await mustBrand({ name: `${TAG} rb A`, slug: `${TAG}-rb-a` });
  const rbB = await mustBrand({ name: `${TAG} rb B`, slug: `${TAG}-rb-b` });
  const rbC = await mustBrand({ name: `${TAG} rb C`, slug: `${TAG}-rb-c` });
  const orderOf = async (id: string) => (await brandService.findById(id))?.display_order;
  const reordered = await reorderBrandsWorkflow({ orderedIds: [rbC, rbB, rbA] }, ACTOR);
  check("reorder ok", reordered.ok);
  check(
    "brands renumbered 0..n in the requested order (C,B,A → 0,1,2)",
    (await orderOf(rbC)) === 0 && (await orderOf(rbB)) === 1 && (await orderOf(rbA)) === 2,
  );
  const roForeign = await reorderBrandsWorkflow({ orderedIds: [randomUUID()] }, ACTOR);
  check("reorder ignores ids not in the live brand set", roForeign.ok && roForeign.data.changed.length === 0);

  // ── 19. Brand create lands at the END of the flat group (max order + 1) ───────
  console.log("brand create display_order:");
  // rbA/rbB/rbC above already exercised end-of-group; assert a fresh create lands last.
  const maxBefore = (await brandService.listAll()).reduce((m, b) => Math.max(m, b.display_order), -1);
  const rbEnd = await mustBrand({ name: `${TAG} rb end`, slug: `${TAG}-rb-end` });
  check("a new brand lands at the end (max order + 1)", (await orderOf(rbEnd)) === maxBefore + 1);

  // ── 20. ApiBrand ERP round-trip completeness ─────────────────────────────────
  console.log("ApiBrand ERP round-trip:");
  const apiBrandId = await mustBrand({
    name: `${TAG} api brand`,
    slug: `${TAG}-api-brand`,
    externalRef: `${TAG}-BEXT-1`,
    tagline: "Tag",
    description: "<p>d</p>",
    logoMediaId: randomUUID(),
    heroMediaId: randomUUID(),
    ogImageMediaId: randomUUID(),
    icon: "watch",
    iconMediaId: randomUUID(),
    isDiscountable: false,
    taxRateBps: 700,
    editorialEyebrow: "EB",
    editorialTitle: "ET",
    editorialBody: "<p>b</p>",
    valueProps: [{ icon: "truck", iconMediaId: null, title: "Livraison", body: "rapide" }],
    metaTitle: "MT",
    metaDescription: "MD",
    canonicalUrl: "https://x.test/b",
    noindex: true,
  });
  const apiBrand = await getApiBrandByRef({ brandId: apiBrandId });
  const apiByRef = await getApiBrandByRef({ externalRef: `${TAG}-BEXT-1` });
  check("read by externalRef resolves the SAME brand", apiByRef?.id === apiBrandId);
  check("round-trip: icon + iconMediaId", apiBrand?.icon === "watch" && !!apiBrand?.iconMediaId);
  check("round-trip: taxRateBps", apiBrand?.taxRateBps === 700);
  check("round-trip: isDiscountable=false preserved", apiBrand?.isDiscountable === false);
  check(
    "round-trip: editorial block",
    apiBrand?.editorialEyebrow === "EB" && apiBrand?.editorialTitle === "ET" && apiBrand?.editorialBody === "<p>b</p>",
  );
  check(
    "round-trip: value_props",
    Array.isArray(apiBrand?.valueProps) && apiBrand!.valueProps!.length === 1 && apiBrand!.valueProps![0].title === "Livraison",
  );
  check(
    "round-trip: hero/og media + noindex + canonical + displayOrder present",
    !!apiBrand?.heroMediaId && !!apiBrand?.ogImageMediaId && apiBrand?.noindex === true && apiBrand?.canonicalUrl === "https://x.test/b" && typeof apiBrand?.displayOrder === "number",
  );

  // brand.updated changedFields emits the real DB column name for the logo.
  const brUpd0 = eventsNamed("brand.updated").length;
  await updateBrandWorkflow({ brandId: apiBrandId, logoMediaId: randomUUID() }, ACTOR);
  const brUpdEv = eventsNamed("brand.updated").slice(brUpd0);
  check(
    "brand.updated reports logo_media_id (not the 'logo' alias)",
    brUpdEv.length === 1 && (brUpdEv[0].payload.changedFields as string[]).includes("logo_media_id"),
  );

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));

import "server-only";

/**
 * Deactivated-attribute product-save regression (A–Z 2026-09-23, taxonomy).
 *
 * `validateAttributeRefs` used to accept only value ids of ACTIVE attributes.
 * Deactivating an attribute is a normal "hide this filter" operation
 * (docs/modules.md: deactivation only governs the category-filter UI), but the
 * product editor re-submits EVERY assigned value id on every save — so each
 * product carrying one of its values became unsaveable ("Valeur d'attribut
 * inconnue : <uuid>"), and an ERP GET→PUT round-trip on /attributes 400'd.
 *
 * The rule is now LIVE = the value exists and its attribute is not deleted
 * (active or inactive), matching the scalar branch (findAttributeById) and the
 * variant path (findExistingValueIds). This pins it on the helper AND through the
 * real updateProduct workflow; unknown / soft-deleted / malformed ids still fail.
 *
 * Run: pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *        src/lib/db/tests/attribute-validation.test.ts
 */
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { validateAttributeRefs } from "@/lib/api/attribute-validation";
import { products } from "@/modules/catalog/product/schema";
import { product_attributes } from "@/modules/catalog/attribute/schema";
import { attributeService } from "@/modules/catalog/attribute/service";
import { workflows } from "@/workflows";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "zztest-attrval";
const UNKNOWN = "00000000-0000-4000-8000-00000000abcd";

async function cleanup() {
  await db.execute(sql`delete from product_attribute_assignments where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from product_attribute_scalars where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from stock_movements where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
  // Values cascade with their attribute (ON DELETE CASCADE).
  await db.execute(sql`delete from product_attributes where slug like ${TAG + "%"}`);
}

async function main() {
  await cleanup();

  // ── Setup: a list attribute (2 values), a number attribute, a product carrying v1.
  const list = await attributeService.insertAttribute({ slug: `${TAG}-list`, name: `${TAG} Liste`, kind: "multiselect" });
  const v1 = await attributeService.insertValue({ attribute_id: list.id, slug: `${TAG}-v1`, label: "V1" });
  const v2 = await attributeService.insertValue({ attribute_id: list.id, slug: `${TAG}-v2`, label: "V2" });
  const num = await attributeService.insertAttribute({ slug: `${TAG}-num`, name: `${TAG} Nombre`, kind: "number" });
  const [p] = await db
    .insert(products)
    .values({ slug: `${TAG}-p`, name: `${TAG} P`, price_cents: 100_000, stock_qty: 3, in_stock: true } as never)
    .returning({ id: products.id });
  await attributeService.setProductAttributeValues(p.id, [v1.id]);

  console.log("active attribute:");
  check("assigned value id → valid", (await validateAttributeRefs([v1.id], null)) === null);
  check("unknown well-formed uuid → rejected", (await validateAttributeRefs([UNKNOWN], null)) !== null);
  check("malformed id → rejected (no uuid-cast throw)", (await validateAttributeRefs(["pas-un-uuid"], null)) !== null);
  check("non-string id → left to the zod layer (not flagged here)", (await validateAttributeRefs([42], null)) === null);
  check("empty list → valid", (await validateAttributeRefs([], null)) === null);
  check("upper-cased uuid of a live value → valid", (await validateAttributeRefs([v1.id.toUpperCase()], null)) === null);

  // ── Deactivate the attribute (the "hide this filter" operation).
  await attributeService.updateAttribute(list.id, { is_active: false });
  await attributeService.updateAttribute(num.id, { is_active: false });

  console.log("after deactivating the attribute:");
  check("already-assigned value of an INACTIVE attribute → valid (the regression)", (await validateAttributeRefs([v1.id], null)) === null);
  check("other value of the inactive attribute → valid (deactivation only hides filters)", (await validateAttributeRefs([v1.id, v2.id], null)) === null);
  check("mixed with an unknown id → still rejected", (await validateAttributeRefs([v1.id, UNKNOWN], null)) !== null);
  check(
    "scalar on an inactive number attribute → valid (same rule as value ids)",
    (await validateAttributeRefs(null, [{ attributeId: num.id, numericValue: 42 }])) === null,
  );

  console.log("updateProduct workflow (the admin editor's full re-submit):");
  const r = await workflows.catalog.updateProduct(
    { productId: p.id, name: `${TAG} P renommé`, attributeValueIds: [v1.id] },
    { actorUserId: `${TAG}-actor` },
  );
  check("save with the inactive attribute's value re-submitted → ok", r.ok === true);
  const [after] = await db.select({ name: products.name }).from(products).where(eq(products.id, p.id));
  check("the edit was persisted", after?.name === `${TAG} P renommé`);
  check("the assignment is kept", (await attributeService.listValueIdsForProduct(p.id)).includes(v1.id));

  const rBad = await workflows.catalog.updateProduct(
    { productId: p.id, attributeValueIds: [v1.id, UNKNOWN] },
    { actorUserId: `${TAG}-actor` },
  );
  check("save with an unknown value id → validation failure", rBad.ok === false);

  // ── Soft-delete the attribute: its values are no longer live.
  await db.update(product_attributes).set({ deleted_at: new Date() }).where(eq(product_attributes.id, list.id));
  console.log("after soft-deleting the attribute:");
  check("value of a SOFT-DELETED attribute → rejected", (await validateAttributeRefs([v2.id], null)) !== null);

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try { await cleanup(); } catch { /* best-effort */ }
    process.exit(1);
  })
  .then(() => process.exit(0));

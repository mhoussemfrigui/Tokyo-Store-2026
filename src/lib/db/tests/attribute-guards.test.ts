import "server-only";

/**
 * Attribute mutation guards (Catalogue → Attributs) — the in-use / validation
 * rules in `workflows/catalog/manage-attributes.ts` that stop an operator (or the
 * ERP API) from stranding data:
 *
 *   A. SLUG VALIDATION — a name / value label that slugifies to nothing
 *      (punctuation-only, no explicit slug) is refused, not persisted with an
 *      empty slug.
 *   B. KIND CHANGE — a SCALAR kind (number/text) can't flip to a value-list /
 *      boolean kind while `product_attribute_scalars` rows exist (they'd become
 *      invisible dead data); scalar→scalar (number↔text) is allowed; once the
 *      scalars are cleared the conversion is allowed.
 *   C. DELETE — a soft-delete is blocked while the attribute's values are used as
 *      a product facet; an unused attribute deletes cleanly.
 *
 * Self-cleaning (`__atg…`). Writes products / attributes / values / scalars /
 * assignments — run ONLY against a throwaway test DB:
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… EMAIL_PROVIDER=console \
 *     pnpm exec tsx --conditions=react-server src/lib/db/tests/attribute-guards.test.ts
 */
import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { attributeService } from "@/modules/catalog/attribute/service";
import {
  createAttributeWorkflow,
  updateAttributeWorkflow,
  deleteAttributeWorkflow,
  createValueWorkflow,
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

const TAG = "__atg";
const ctx = { actorUserId: `${TAG}-admin` };

async function cleanup() {
  // Attributes are matched on NAME, not slug: createAttributeWorkflow slugifies
  // the name and strips the leading "__" of the TAG, so the persisted slug is
  // "atg-…", never "__atg-…" — a slug-based filter would delete NOTHING, leak the
  // rows, and make the next run collide on the unique slug. The `name` column
  // keeps the literal "__atg …" tag. (Products are inserted with an explicit
  // "__atg-…" slug, so they still match by slug.)
  const mineAttr = sql`(select id from product_attributes where name like ${TAG + "%"})`;
  const mineProd = sql`(select id from products where slug like ${TAG + "%"})`;
  await db.execute(
    sql`delete from product_attribute_scalars where attribute_id in ${mineAttr} or product_id in ${mineProd}`,
  );
  await db.execute(
    sql`delete from product_attribute_assignments where product_id in ${mineProd}
        or attribute_value_id in (select id from product_attribute_values where attribute_id in ${mineAttr})`,
  );
  await db.execute(sql`delete from product_attribute_values where attribute_id in ${mineAttr}`);
  await db.execute(sql`delete from product_attributes where name like ${TAG + "%"}`);
  await db.delete(products).where(like(products.slug, `${TAG}%`));
}

async function makeProduct(suffix: string): Promise<string> {
  const [row] = await db
    .insert(products)
    .values({
      slug: `${TAG}-${suffix}-${randomUUID().slice(0, 6)}`,
      name: `${TAG} Produit ${suffix}`,
      price_cents: 100_000,
      is_published: true,
    } as never)
    .returning({ id: products.id });
  return row.id;
}

// ── A. slug validation ─────────────────────────────────────────────────────────
async function slugValidation() {
  console.log("A. slug validation");
  const emptyName = await createAttributeWorkflow({ name: "!!! ???", kind: "select" }, ctx);
  check(
    "attribute name slugifying to empty → refused (validation)",
    !emptyName.ok && emptyName.error === "validation",
  );

  const attr = await createAttributeWorkflow(
    { name: `${TAG} Matière`, kind: "select" },
    ctx,
  );
  check("baseline attribute create succeeds", attr.ok);
  if (!attr.ok) return;
  const emptyValue = await createValueWorkflow(
    { attributeId: attr.data.attributeId, label: "———" },
    ctx,
  );
  check(
    "value label slugifying to empty → refused (validation)",
    !emptyValue.ok && emptyValue.error === "validation",
  );
}

// ── B. kind-change scalar guard ────────────────────────────────────────────────
async function kindChangeGuard() {
  console.log("B. kind-change scalar guard");
  const created = await createAttributeWorkflow({ name: `${TAG} Poids`, kind: "number" }, ctx);
  check("number attribute create succeeds", created.ok);
  if (!created.ok) return;
  const attrId = created.data.attributeId;
  const pid = await makeProduct("kind");
  await attributeService.setScalar(pid, attrId, { numericValue: 42 });
  check("precondition: one scalar row exists", (await attributeService.countScalarsForAttribute(attrId)) === 1);

  const toSelect = await updateAttributeWorkflow({ attributeId: attrId, kind: "select" }, ctx);
  check("number → select blocked while scalars exist (in_use)", !toSelect.ok && toSelect.error === "in_use");
  const toBool = await updateAttributeWorkflow({ attributeId: attrId, kind: "boolean" }, ctx);
  check("number → boolean blocked while scalars exist (in_use)", !toBool.ok && toBool.error === "in_use");
  const toText = await updateAttributeWorkflow({ attributeId: attrId, kind: "text" }, ctx);
  check("number → text allowed (scalar → scalar, values kept)", toText.ok);

  // Clear the scalar → the conversion the guard blocked is now allowed.
  await attributeService.setScalar(pid, attrId, { numericValue: null, textValue: null });
  check("scalar cleared", (await attributeService.countScalarsForAttribute(attrId)) === 0);
  const nowSelect = await updateAttributeWorkflow({ attributeId: attrId, kind: "select" }, ctx);
  check("text → select allowed once no scalars remain", nowSelect.ok);
}

// ── C. delete guard ────────────────────────────────────────────────────────────
async function deleteGuard() {
  console.log("C. delete guard");
  // Attribute whose value is used as a product facet → delete blocked.
  const used = await createAttributeWorkflow({ name: `${TAG} Couleur`, kind: "select" }, ctx);
  const free = await createAttributeWorkflow({ name: `${TAG} Finition`, kind: "select" }, ctx);
  check("two select attributes created", used.ok && free.ok);
  if (!used.ok || !free.ok) return;

  const val = await createValueWorkflow({ attributeId: used.data.attributeId, label: "Or" }, ctx);
  check("value created", val.ok);
  if (!val.ok) return;
  const pid = await makeProduct("facet");
  await attributeService.addProductAttributeValues(pid, [val.data.valueId]);

  const blocked = await deleteAttributeWorkflow({ attributeId: used.data.attributeId }, ctx);
  check("delete blocked while a product filters on its value (in_use)", !blocked.ok && blocked.error === "in_use");

  const ok = await deleteAttributeWorkflow({ attributeId: free.data.attributeId }, ctx);
  check("an unused attribute deletes cleanly", ok.ok);
  const gone = await attributeService.findAttributeById(free.data.attributeId);
  check("…and is no longer live (soft-deleted)", gone === null);
}

async function main() {
  try {
    await cleanup();
    await slugValidation();
    await kindChangeGuard();
    await deleteGuard();
  } finally {
    await cleanup();
  }
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

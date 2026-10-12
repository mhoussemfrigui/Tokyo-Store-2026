import "server-only";

/**
 * Migration 0125 (src/lib/db/migrations/0125_drop_redundant_indexes.sql).
 *
 *   A. PURE — the Drizzle schema no longer declares the two dropped indexes and
 *      still declares the composites that cover them.
 *   B. The file's statements, run exactly as the drizzle migrator splits them
 *      (on `--> statement-breakpoint`), against a LEGACY tombstone — a product
 *      soft-deleted before deleteProductWorkflow released its variants:
 *        - its live variants are released like replaceVariants(id, []) does:
 *          sku/gtin freed, is_default cleared, stock 0 / in_stock false, and
 *          soft-deleted with the PRODUCT's deleted_at;
 *        - an already soft-deleted variant is left untouched;
 *        - every stock_levels row + attribute assignment of the tombstone is gone;
 *        - a LIVE control product (variant, levels, assignment) is untouched;
 *        - the freed SKU/GTIN is reusable by a new live variant (the user-visible
 *          bug: « Ce SKU de variante est déjà utilisé »).
 *   C. Idempotent — a second run changes nothing (no error, same state, the
 *      variant tombstone is not re-stamped).
 *   D. The redundant indexes are gone; the covering composites remain.
 *
 * Everything runs inside ONE transaction that is ROLLED BACK at the end (DDL is
 * transactional in Postgres), so the database is left exactly as found — no
 * cleanup needed. Run ONLY against a throwaway DB migrated to >= 0124:
 *   DATABASE_URL=… pnpm exec tsx --conditions=react-server \
 *     src/lib/db/tests/migration-0125-backfill.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { db } from "@/lib/db/client";
import { products, product_variants } from "@/modules/catalog/product/schema";
import {
  product_attributes,
  product_attribute_values,
  product_attribute_assignments,
} from "@/modules/catalog/attribute/schema";
import { stock_levels, stock_locations } from "@/modules/stock-location/schema";
import { promotion_redemptions } from "@/modules/promotion/schema";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "zztest-m0125";
const DROPPED = ["promotion_redemptions_promo_idx"];
const COVERING = [
  "promotion_redemptions_user_idx",
  "promotion_redemptions_promo_created_idx",
];
/** Sentinel thrown to roll the whole test transaction back. */
class Rollback extends Error {}

const MIGRATION = readFileSync(
  join(process.cwd(), "src", "lib", "db", "migrations", "0125_drop_redundant_indexes.sql"),
  "utf8",
);
// Same split as drizzle's readMigrationFiles (breakpoints: true).
const statements = MIGRATION.split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

async function main() {
  // ── A. schema parity (pure) ──────────────────────────────────────────────
  const schemaIdx = getTableConfig(promotion_redemptions).indexes.map((i) => i.config.name);
  check("A: schema no longer declares the dropped indexes", DROPPED.every((n) => !schemaIdx.includes(n)));
  check("A: schema still declares the covering composites", COVERING.every((n) => schemaIdx.includes(n)));
  check(`A: migration splits into 5 statements (${statements.length})`, statements.length === 5);

  try {
    await db.transaction(async (tx) => {
      // ── fixtures ─────────────────────────────────────────────────────────
      const [loc] = await tx
        .insert(stock_locations)
        .values({ name: `${TAG}-loc` })
        .returning({ id: stock_locations.id });
      const [attr] = await tx
        .insert(product_attributes)
        .values({ slug: `${TAG}-attr`, name: `${TAG} attr` })
        .returning({ id: product_attributes.id });
      const [val] = await tx
        .insert(product_attribute_values)
        .values({ attribute_id: attr.id, slug: `${TAG}-val`, label: `${TAG} val` })
        .returning({ id: product_attribute_values.id });

      const tombstoneAt = new Date("2026-01-02T03:04:05.000Z");
      const oldVariantAt = new Date("2025-12-01T00:00:00.000Z");
      const mkProduct = async (suffix: string, deletedAt: Date | null) => {
        const [row] = await tx
          .insert(products)
          .values({
            slug: `${TAG}-${suffix}`,
            name: `${TAG} ${suffix}`,
            price_cents: 100_000,
            product_type: "variable",
            deleted_at: deletedAt,
          } as never)
          .returning({ id: products.id });
        return row.id;
      };
      const mkVariant = async (
        productId: string,
        v: { sku: string; gtin: string | null; isDefault: boolean; stockQty: number | null; deletedAt?: Date },
      ) => {
        const [row] = await tx
          .insert(product_variants)
          .values({
            product_id: productId,
            label: v.sku,
            sku: v.sku,
            gtin: v.gtin,
            price_cents: 50_000,
            stock_qty: v.stockQty,
            in_stock: true,
            is_default: v.isDefault,
            deleted_at: v.deletedAt ?? null,
          })
          .returning({ id: product_variants.id });
        return row.id;
      };

      const gtinBase = String(Date.now()).slice(-11);
      // Legacy tombstone: soft-deleted BEFORE the delete workflow released anything.
      const dead = await mkProduct("dead", tombstoneAt);
      const d1 = await mkVariant(dead, { sku: `${TAG}-d1`, gtin: `8${gtinBase}1`, isDefault: true, stockQty: 3 });
      const d2 = await mkVariant(dead, { sku: `${TAG}-d2`, gtin: null, isDefault: false, stockQty: null });
      const d3 = await mkVariant(dead, {
        sku: `${TAG}-d3`,
        gtin: null,
        isDefault: false,
        stockQty: 7,
        deletedAt: oldVariantAt,
      });
      // Live control product.
      const live = await mkProduct("live", null);
      const l1 = await mkVariant(live, { sku: `${TAG}-l1`, gtin: `8${gtinBase}2`, isDefault: true, stockQty: 5 });

      await tx.insert(stock_levels).values([
        { location_id: loc.id, product_id: dead, variant_id: null, qty: 2 },
        { location_id: loc.id, product_id: dead, variant_id: d1, qty: 3 },
        { location_id: loc.id, product_id: live, variant_id: null, qty: 4 },
        { location_id: loc.id, product_id: live, variant_id: l1, qty: 5 },
      ]);
      await tx.insert(product_attribute_assignments).values([
        { product_id: dead, attribute_value_id: val.id },
        { product_id: live, attribute_value_id: val.id },
      ]);

      const variant = async (id: string) =>
        (await tx.select().from(product_variants).where(eq(product_variants.id, id)))[0];
      const levelsOf = async (productId: string) =>
        (await tx.select().from(stock_levels).where(eq(stock_levels.product_id, productId))).length;
      const assignmentsOf = async (productId: string) =>
        (
          await tx
            .select()
            .from(product_attribute_assignments)
            .where(eq(product_attribute_assignments.product_id, productId))
        ).length;

      const assertState = async (pass: string) => {
        const v1 = await variant(d1);
        const v2 = await variant(d2);
        const v3 = await variant(d3);
        const c1 = await variant(l1);
        check(
          `${pass}: tombstone's live default variant released (sku/gtin null, not default, stock 0, out of stock)`,
          v1.sku === null && v1.gtin === null && v1.is_default === false && v1.stock_qty === 0 && v1.in_stock === false,
        );
        check(
          `${pass}: …and soft-deleted with the PRODUCT's deleted_at`,
          v1.deleted_at?.toISOString() === tombstoneAt.toISOString(),
        );
        check(
          `${pass}: untracked live variant also released (stock 0, soft-deleted)`,
          v2.sku === null && v2.stock_qty === 0 && v2.in_stock === false &&
            v2.deleted_at?.toISOString() === tombstoneAt.toISOString(),
        );
        check(
          `${pass}: an already soft-deleted variant is untouched`,
          v3.sku === `${TAG}-d3` && v3.stock_qty === 7 && v3.in_stock === true &&
            v3.deleted_at?.toISOString() === oldVariantAt.toISOString(),
        );
        check(`${pass}: tombstone's stock_levels (pool + variant) dropped`, (await levelsOf(dead)) === 0);
        check(`${pass}: tombstone's attribute assignments dropped`, (await assignmentsOf(dead)) === 0);
        check(
          `${pass}: live control variant untouched`,
          c1.sku === `${TAG}-l1` && c1.gtin === `8${gtinBase}2` && c1.is_default === true &&
            c1.stock_qty === 5 && c1.in_stock === true && c1.deleted_at === null,
        );
        check(`${pass}: live control keeps its stock_levels`, (await levelsOf(live)) === 2);
        check(`${pass}: live control keeps its assignment`, (await assignmentsOf(live)) === 1);
      };

      // ── B. first run ─────────────────────────────────────────────────────
      for (const s of statements) await tx.execute(sql.raw(s));
      await assertState("B");

      // The freed codes are reusable by a new LIVE variant (partial uniques).
      const again = await mkProduct("again", null);
      let reused = true;
      try {
        await tx.transaction(async (sp) => {
          await sp.insert(product_variants).values({
            product_id: again,
            label: "reuse",
            sku: `${TAG}-d1`,
            gtin: `8${gtinBase}1`,
            price_cents: 50_000,
            is_default: true,
          });
        });
      } catch {
        reused = false;
      }
      check("B: the freed SKU/GTIN can be reused by a new live variant", reused);

      // ── C. idempotent re-run ─────────────────────────────────────────────
      let rerunOk = true;
      try {
        for (const s of statements) await tx.execute(sql.raw(s));
      } catch (err) {
        rerunOk = false;
        console.error(err);
      }
      check("C: a second run raises no error", rerunOk);
      await assertState("C");

      // ── D. indexes ───────────────────────────────────────────────────────
      const idx = await tx.execute<{ indexname: string }>(sql`
        select indexname from pg_indexes
        where tablename = 'promotion_redemptions'
      `);
      const names = idx.rows.map((r) => r.indexname);
      check("D: redundant indexes dropped", DROPPED.every((n) => !names.includes(n)));
      check("D: covering composites still present", COVERING.every((n) => names.includes(n)));

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }

  // The rollback left the database exactly as found.
  const [{ n }] = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from products where slug like ${TAG + "%"}`)
  ).rows;
  check("rolled back: no fixture rows remain", n === 0);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));

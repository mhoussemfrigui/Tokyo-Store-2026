import "server-only";

/**
 * evacuateLocation (A-Z re-audit Phase 8) — the location-delete stock move must
 * be ATOMIC per line: a "transfer" adds each level to the destination AND zeroes
 * the source in ONE transaction, so a crash between them can't double-count
 * (units at both stores → inflated cached total). A "writeoff" zeroes the source
 * and drops the total. Exercises the real service against a live DB.
 *
 * Location (de)activation (A–Z 09-23, P2) — setLocationActive moves the cached
 * totals by DELTA (−level on deactivate, +level on reactivate, floored at 0),
 * ledgered, idempotent, and NEVER recomputes Σ(levels) (which would resurrect
 * units sold since the last matrix edit). It is SYMMETRIC: a level above the
 * total is clamped on deactivation to what was removed, so a deactivate →
 * reactivate cycle never brings sold units back. Deleting an INACTIVE location
 * that still holds units neither throws nor double-subtracts. setDefault only
 * promotes an ACTIVE location (atomic, rolls the default-clear back).
 *
 * Self-cleaning (`__evac…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/stock-location-transfer.test.ts
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { applyStockDelta, StockConflictError } from "@/lib/inventory/adjust";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { stock_levels, stock_locations } from "@/modules/stock-location/schema";
import { stockLocationService } from "@/modules/stock-location/service";
import { stock_movements } from "@/modules/stock-movement/schema";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__evac";

async function cleanup() {
  await db.execute(sql`delete from stock_movements where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from stock_levels where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from stock_locations where name like ${TAG + "%"}`);
  await db.execute(sql`delete from product_variants where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

async function mkVariant(productId: string, sku: string) {
  const [v] = await db
    .insert(product_variants)
    .values({ product_id: productId, sku: `${TAG}-${sku}`, label: sku, price_cents: 10_000, stock_qty: 0, in_stock: true } as never)
    .returning({ id: product_variants.id });
  return v.id;
}
async function variantTotalOf(variantId: string): Promise<number | null> {
  const [r] = await db.select({ s: product_variants.stock_qty }).from(product_variants).where(eq(product_variants.id, variantId));
  return r?.s ?? null;
}
async function variantLevelAt(productId: string, variantId: string, locationId: string): Promise<number> {
  const [r] = await db
    .select({ q: stock_levels.qty })
    .from(stock_levels)
    .where(and(eq(stock_levels.product_id, productId), eq(stock_levels.variant_id, variantId), eq(stock_levels.location_id, locationId)));
  return r?.q ?? 0;
}

async function mkProduct(slug: string) {
  const [p] = await db
    .insert(products)
    .values({ slug: `${TAG}-${slug}`, name: `${TAG} ${slug}`, price_cents: 1000, stock_qty: 0, in_stock: true, is_published: true } as never)
    .returning({ id: products.id });
  return p.id;
}
async function totalOf(productId: string): Promise<number | null> {
  const [r] = await db.select({ s: products.stock_qty }).from(products).where(eq(products.id, productId));
  return r?.s ?? null;
}
async function levelAt(productId: string, locationId: string): Promise<number> {
  const [r] = await db
    .select({ q: stock_levels.qty })
    .from(stock_levels)
    .where(and(eq(stock_levels.product_id, productId), eq(stock_levels.location_id, locationId), isNull(stock_levels.variant_id)));
  return r?.q ?? 0;
}
async function inStockOf(productId: string): Promise<boolean> {
  const [r] = await db.select({ s: products.in_stock }).from(products).where(eq(products.id, productId));
  return r?.s ?? false;
}
async function isActive(locationId: string): Promise<boolean> {
  const [r] = await db.select({ a: stock_locations.is_active }).from(stock_locations).where(eq(stock_locations.id, locationId));
  return r?.a ?? false;
}
/** Ledger rows the (de)activation wrote for a product (note-scoped). */
async function flipRows(productId: string) {
  return db
    .select({ delta: stock_movements.delta, resultingQty: stock_movements.resulting_qty, reason: stock_movements.reason, locationId: stock_movements.location_id, note: stock_movements.note, variantId: stock_movements.variant_id })
    .from(stock_movements)
    .where(and(eq(stock_movements.product_id, productId), sql`${stock_movements.note} like 'Emplacement %'`))
    .orderBy(stock_movements.created_at);
}
/** An order-style sale: moves ONLY the total (per-location decrement is deferred). */
async function sell(productId: string, qty: number) {
  const r = await applyStockDelta({ kind: "product", rowId: productId, productId }, -qty, { reason: "order" });
  if (!r.ok) throw new Error(`sale failed: ${r.code}`);
}

async function main() {
  await cleanup();

  // ── Transfer: 10 @ src + 3 @ dest → evacuate src → 0 @ src, 13 @ dest, total 13 ──
  {
    const p = await mkProduct("t");
    const src = await stockLocationService.create({ name: `${TAG}-src`, is_active: true } as never);
    const dest = await stockLocationService.create({ name: `${TAG}-dest`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, src.id, 10);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, dest.id, 3);
    check("pre-transfer cached total = 13 (10 + 3)", (await totalOf(p)) === 13);

    const res = await stockLocationService.evacuateLocation(src.id, { mode: "transfer", destinationId: dest.id });
    check("transfer moved 1 line", res.moved === 1);
    check("source level zeroed", (await levelAt(p, src.id)) === 0);
    check("destination level = 13 (3 + 10)", (await levelAt(p, dest.id)) === 13);
    check("cached total UNCHANGED at 13 (stock just moved)", (await totalOf(p)) === 13);
  }

  // ── Writeoff: 5 @ src → evacuate writeoff → 0 @ src, total drops to 0 ──
  {
    const p = await mkProduct("w");
    const src = await stockLocationService.create({ name: `${TAG}-wsrc`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, src.id, 5);
    check("pre-writeoff cached total = 5", (await totalOf(p)) === 5);

    const res = await stockLocationService.evacuateLocation(src.id, { mode: "writeoff" });
    check("writeoff moved 1 line", res.moved === 1);
    check("source level zeroed", (await levelAt(p, src.id)) === 0);
    check("cached total dropped to 0 (stock written off)", (await totalOf(p)) === 0);
  }

  // ── S4: VARIANT transfer — per-variant net-zero (isVariant paths) ────────────
  {
    const p = await mkProduct("s4");
    const v = await mkVariant(p, "s4v");
    const src = await stockLocationService.create({ name: `${TAG}-s4src`, is_active: true } as never);
    const dest = await stockLocationService.create({ name: `${TAG}-s4dest`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: v }, src.id, 10);
    await stockLocationService.setLocationLevel({ productId: p, variantId: v }, dest.id, 3);
    check("S4: pre-transfer variant total = 13", (await variantTotalOf(v)) === 13);

    const res = await stockLocationService.evacuateLocation(src.id, { mode: "transfer", destinationId: dest.id });
    check("S4: transfer moved 1 variant line", res.moved === 1);
    check("S4: source variant level zeroed", (await variantLevelAt(p, v, src.id)) === 0);
    check("S4: dest variant level = 13", (await variantLevelAt(p, v, dest.id)) === 13);
    check("S4: variant cached total UNCHANGED at 13", (await variantTotalOf(v)) === 13);
  }

  // ── S5: MULTI-LINE evacuation moves every line ───────────────────────────────
  {
    const pa = await mkProduct("s5a");
    const pb = await mkProduct("s5b");
    const src = await stockLocationService.create({ name: `${TAG}-s5src`, is_active: true } as never);
    const dest = await stockLocationService.create({ name: `${TAG}-s5dest`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: pa, variantId: null }, src.id, 4);
    await stockLocationService.setLocationLevel({ productId: pb, variantId: null }, src.id, 6);

    const res = await stockLocationService.evacuateLocation(src.id, { mode: "transfer", destinationId: dest.id });
    check("S5: both lines moved (moved === 2)", res.moved === 2);
    check("S5: A src 0 / dest 4", (await levelAt(pa, src.id)) === 0 && (await levelAt(pa, dest.id)) === 4);
    check("S5: B src 0 / dest 6", (await levelAt(pb, src.id)) === 0 && (await levelAt(pb, dest.id)) === 6);
    check("S5: totals unchanged (A=4, B=6)", (await totalOf(pa)) === 4 && (await totalOf(pb)) === 6);
  }

  // ── D1: deactivate / reactivate AFTER a sale moves the total by the level
  // (Main=10, Annexe=5 → 15; 3 sold → 12; deactivate Annexe → 7, NOT the stale
  // Σ(active levels)=10; reactivate → 12, NOT 15 — the sold units stay sold). ──
  {
    const p = await mkProduct("d1");
    const main = await stockLocationService.create({ name: `${TAG}-d1main`, is_active: true } as never);
    const annexe = await stockLocationService.create({ name: `${TAG}-d1annexe`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, main.id, 10);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, annexe.id, 5);
    await sell(p, 3);
    check("D1: after the sale total = 12 (levels untouched: 10 + 5)", (await totalOf(p)) === 12);

    const off = await stockLocationService.setLocationActive(annexe.id, false, { actorUserId: `${TAG}-actor` });
    check("D1: deactivation reported changed + the touched product", off.changed && off.touchedProductIds.includes(p));
    check("D1: location is now inactive", (await isActive(annexe.id)) === false);
    check("D1: total = 12 − 5 = 7 (sale preserved, not the Σ-levels 10)", (await totalOf(p)) === 7);
    check("D1: levels are NOT touched by the flip (Annexe still 5)", (await levelAt(p, annexe.id)) === 5);
    const rowsOff = await flipRows(p);
    check(
      "D1: one admin ledger row −5 @ Annexe, resulting 7, note « Emplacement désactivé »",
      rowsOff.length === 1 && rowsOff[0].delta === -5 && rowsOff[0].resultingQty === 7 && rowsOff[0].reason === "admin" &&
        rowsOff[0].locationId === annexe.id && rowsOff[0].note === "Emplacement désactivé",
    );

    const again = await stockLocationService.setLocationActive(annexe.id, false);
    check("D1: a repeated deactivation is a no-op (changed=false)", again.changed === false && again.touchedProductIds.length === 0);
    check("D1: …and never double-subtracts (total still 7, no extra ledger row)", (await totalOf(p)) === 7 && (await flipRows(p)).length === 1);

    let rejected = false;
    try {
      await stockLocationService.setLocationLevel({ productId: p, variantId: null }, annexe.id, 8);
    } catch {
      rejected = true;
    }
    check("D1: a level write at the inactive location is rejected", rejected && (await levelAt(p, annexe.id)) === 5);

    const on = await stockLocationService.setLocationActive(annexe.id, true);
    check("D1: reactivation changed + active again", on.changed && (await isActive(annexe.id)) === true);
    check("D1: total = 7 + 5 = 12 — the 3 sold units are NOT resurrected (was 15)", (await totalOf(p)) === 12);
    const rowsOn = await flipRows(p);
    check(
      "D1: reactivation ledger row +5 → 12, « Emplacement réactivé »",
      rowsOn.length === 2 && rowsOn[1].delta === 5 && rowsOn[1].resultingQty === 12 && rowsOn[1].note === "Emplacement réactivé",
    );
  }

  // ── D2: the floor at 0 + SYMMETRY + availability. Total 3 with 5 units at the
  // location (sales drained the total): deactivate → 0 (ledger −3, de-listed)
  // and the overstated level is clamped to the 3 removed; reactivate → 3 (NOT 5
  // — the 2 sold units stay sold), re-listed and reported as restocked. ───────
  {
    const p = await mkProduct("d2");
    const loc = await stockLocationService.create({ name: `${TAG}-d2loc`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, loc.id, 5);
    await sell(p, 2);
    check("D2: total 3 after the sale", (await totalOf(p)) === 3);
    await stockLocationService.setLocationActive(loc.id, false);
    const rows = await flipRows(p);
    check("D2: deactivation floors the total at 0 (ledger delta −3, not −5)", (await totalOf(p)) === 0 && rows.length === 1 && rows[0].delta === -3 && rows[0].resultingQty === 0);
    check("D2: an emptied total is de-listed (in_stock=false)", (await inStockOf(p)) === false);
    check("D2: the overstated level is clamped to what was removed (5 → 3)", (await levelAt(p, loc.id)) === 3);
    const on = await stockLocationService.setLocationActive(loc.id, true);
    check("D2: reactivation → total 3 (not 5 — no sold unit resurrected), re-listed", (await totalOf(p)) === 3 && (await inStockOf(p)) === true);
    const rowsOn = await flipRows(p);
    check("D2: reactivation ledger row +3 → 3", rowsOn.length === 2 && rowsOn[1].delta === 3 && rowsOn[1].resultingQty === 3);
    check("D2: reactivation reports the sold-out → available flip (product.restocked)", on.restockedProductIds.includes(p));
  }

  // ── D2b: SOLD-OUT total (0) with 5 units still at the location. The
  // deactivation moves no total (delta 0) but must still clamp the level to 0,
  // otherwise the reactivation would add 5 sold units back. ───────────────────
  {
    const p = await mkProduct("d2b");
    const loc = await stockLocationService.create({ name: `${TAG}-d2bloc`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, loc.id, 5);
    await sell(p, 5);
    check("D2b: total 0 after selling out (level still 5)", (await totalOf(p)) === 0 && (await levelAt(p, loc.id)) === 5);
    await stockLocationService.setLocationActive(loc.id, false);
    check("D2b: deactivation clamps the level to 0, total stays 0, no ledger row", (await levelAt(p, loc.id)) === 0 && (await totalOf(p)) === 0 && (await flipRows(p)).length === 0);
    const on = await stockLocationService.setLocationActive(loc.id, true);
    check("D2b: reactivation keeps the total at 0 (was 0 → 5)", (await totalOf(p)) === 0 && (await levelAt(p, loc.id)) === 0);
    check("D2b: …no ledger row and no restock reported", (await flipRows(p)).length === 0 && !on.restockedProductIds.includes(p));
  }

  // ── D2c: deleting (TRANSFER) an inactive location whose level was clamped
  // moves only what the deactivation removed — not the stale pre-sale level. ──
  {
    const p = await mkProduct("d2c");
    const dest = await stockLocationService.create({ name: `${TAG}-d2cdest`, is_active: true } as never);
    const src = await stockLocationService.create({ name: `${TAG}-d2csrc`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, src.id, 5);
    await sell(p, 2);
    await stockLocationService.setLocationActive(src.id, false);
    check("D2c: total 0 + source level clamped to 3 after deactivation", (await totalOf(p)) === 0 && (await levelAt(p, src.id)) === 3);
    await stockLocationService.evacuateLocation(src.id, { mode: "transfer", destinationId: dest.id });
    check("D2c: transfer moves 3 (not 5): dest 3, total 3", (await levelAt(p, dest.id)) === 3 && (await totalOf(p)) === 3 && (await levelAt(p, src.id)) === 0);
  }

  // ── D2d: setDefault refuses an INACTIVE location atomically — returns false
  // and rolls the default-clear back (the current default stays the default). ─
  {
    const before = (await stockLocationService.listAll()).find((l) => l.is_default);
    const off = await stockLocationService.create({ name: `${TAG}-d2doff`, is_active: false } as never);
    const promoted = await stockLocationService.setDefault(off.id);
    const [row] = await db.select({ d: stock_locations.is_default, a: stock_locations.is_active }).from(stock_locations).where(eq(stock_locations.id, off.id));
    check("D2d: setDefault on an inactive location returns false, stays inactive + non-default", promoted === false && row?.d === false && row?.a === false);
    const after = (await stockLocationService.listAll()).find((l) => l.is_default);
    check("D2d: the previous default is untouched (clear rolled back)", (before?.id ?? null) === (after?.id ?? null));
  }

  // ── D3: a per-VARIANT level moves the VARIANT total (not the product pool);
  // an UNTRACKED product holding a level is skipped (NULL = unlimited). ────────
  {
    const p = await mkProduct("d3");
    const v = await mkVariant(p, "d3v");
    const loc = await stockLocationService.create({ name: `${TAG}-d3loc`, is_active: true } as never);
    const keep = await stockLocationService.create({ name: `${TAG}-d3keep`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: v }, loc.id, 4);
    await stockLocationService.setLocationLevel({ productId: p, variantId: v }, keep.id, 6);
    const untracked = await mkProduct("d3u");
    await stockLocationService.setLocationLevel({ productId: untracked, variantId: null }, loc.id, 2);
    await db.update(products).set({ stock_qty: null } as never).where(eq(products.id, untracked));

    await stockLocationService.setLocationActive(loc.id, false);
    check("D3: variant total 10 → 6", (await variantTotalOf(v)) === 6);
    const vRows = await flipRows(p);
    check("D3: variant ledger row carries the variant id", vRows.length === 1 && vRows[0].variantId === v && vRows[0].delta === -4);
    check("D3: untracked product left untracked, no ledger row", (await totalOf(untracked)) === null && (await flipRows(untracked)).length === 0);
    await stockLocationService.setLocationActive(loc.id, true);
    check("D3: variant total back to 10 on reactivation", (await variantTotalOf(v)) === 10);
  }

  // ── D4: the DEFAULT location can never be deactivated (service guard). ─────
  {
    const def = (await stockLocationService.listAll()).find((l) => l.is_default);
    if (def) {
      const res = await stockLocationService.setLocationActive(def.id, false);
      check("D4: deactivating the default is a no-op, it stays active", res.changed === false && (await isActive(def.id)) === true);
    } else {
      check("D4: (no default location on this DB — guard not exercised)", true);
    }
  }

  // ── D5: deleting an INACTIVE location that still holds units. Its units are
  // already out of the totals, so a WRITEOFF must not subtract them again and a
  // TRANSFER must add them back as sellable — and neither may throw « inactif ». ─
  {
    // Writeoff: keep=4 + gone=6 → 10; deactivate gone → 4; writeoff → still 4.
    const p = await mkProduct("d5w");
    const keep = await stockLocationService.create({ name: `${TAG}-d5keep`, is_active: true } as never);
    const gone = await stockLocationService.create({ name: `${TAG}-d5gone`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, keep.id, 4);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, gone.id, 6);
    await stockLocationService.setLocationActive(gone.id, false);
    check("D5: total 4 once the location is deactivated", (await totalOf(p)) === 4);
    let threw = false;
    try {
      await stockLocationService.evacuateLocation(gone.id, { mode: "writeoff" });
    } catch {
      threw = true;
    }
    check("D5: writeoff of an inactive location does not throw", !threw);
    check("D5: its level is zeroed", (await levelAt(p, gone.id)) === 0);
    check("D5: total UNCHANGED at 4 (no double-subtract)", (await totalOf(p)) === 4);

    // Transfer: dest=3 + src=5 → 8; deactivate src → 3; transfer → dest 8, total 8.
    const q = await mkProduct("d5t");
    const dest = await stockLocationService.create({ name: `${TAG}-d5dest`, is_active: true } as never);
    const src = await stockLocationService.create({ name: `${TAG}-d5src`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: q, variantId: null }, dest.id, 3);
    await stockLocationService.setLocationLevel({ productId: q, variantId: null }, src.id, 5);
    await stockLocationService.setLocationActive(src.id, false);
    check("D5: transfer case — total 3 after deactivating the source", (await totalOf(q)) === 3);
    threw = false;
    try {
      await stockLocationService.evacuateLocation(src.id, { mode: "transfer", destinationId: dest.id });
    } catch {
      threw = true;
    }
    check("D5: transfer out of an inactive location does not throw", !threw);
    check("D5: source zeroed, destination 3 + 5 = 8", (await levelAt(q, src.id)) === 0 && (await levelAt(q, dest.id)) === 8);
    check("D5: the moved units are sellable again (total 3 → 8)", (await totalOf(q)) === 8);
  }

  // ── D6: RACE — level writes at a location racing its deactivation. Level
  // writers take FOR SHARE on the location and the flip row-locks it, so each
  // write either lands before the flip (and the flip subtracts the FRESH level)
  // or is rejected after it. With no sales, the invariant total = Σ(ACTIVE
  // levels) must therefore hold whatever the interleaving. ───────────────────
  {
    let ok = true;
    for (let i = 0; i < 5; i++) {
      const p = await mkProduct(`d6-${i}`);
      const keep = await stockLocationService.create({ name: `${TAG}-d6keep${i}`, is_active: true } as never);
      const loc = await stockLocationService.create({ name: `${TAG}-d6loc${i}`, is_active: true } as never);
      await stockLocationService.setLocationLevel({ productId: p, variantId: null }, keep.id, 4);
      await stockLocationService.setLocationLevel({ productId: p, variantId: null }, loc.id, 6);
      await Promise.allSettled([
        stockLocationService.setLocationLevel({ productId: p, variantId: null }, loc.id, 9),
        stockLocationService.setLocationActive(loc.id, false),
        stockLocationService.setLocationLevel({ productId: p, variantId: null }, loc.id, 2),
        stockLocationService.setLocationLevel({ productId: p, variantId: null }, keep.id, 5),
      ]);
      const active = await isActive(loc.id);
      const expected = (await levelAt(p, keep.id)) + (active ? await levelAt(p, loc.id) : 0);
      if (active || (await totalOf(p)) !== expected) ok = false;
    }
    check("D6: racing level writes vs deactivation keep total = Σ(active levels)", ok);
  }

  // ── S6: adjustLevelOnly (ship decrement) — drops ONE location's physical level
  // WITHOUT touching the cached TOTAL (which already dropped at order placement),
  // clamped at 0, ledgered as an `order` per-location leg. ────────────────────
  {
    const p = await mkProduct("s6");
    const depot = await stockLocationService.create({ name: `${TAG}-s6depot`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, depot.id, 5);
    check("S6: setup — level 5, total 5", (await levelAt(p, depot.id)) === 5 && (await totalOf(p)) === 5);

    await stockLocationService.adjustLevelOnly({ productId: p, variantId: null }, depot.id, -3, { reason: "order", note: "ship" });
    check("S6: level 5 → 2 (level-only)", (await levelAt(p, depot.id)) === 2);
    check("S6: cached TOTAL untouched at 5 (it moved at placement, not at ship)", (await totalOf(p)) === 5);
    const legs = await db
      .select({ delta: stock_movements.delta, reason: stock_movements.reason, locationId: stock_movements.location_id })
      .from(stock_movements)
      .where(and(eq(stock_movements.product_id, p), eq(stock_movements.reason, "order")));
    check("S6: one `order` ledger leg −3 at the depot", legs.length === 1 && legs[0].delta === -3 && legs[0].locationId === depot.id);

    await stockLocationService.adjustLevelOnly({ productId: p, variantId: null }, depot.id, -5, { reason: "order", note: "ship2" });
    check("S6: clamped at 0 (2 − 5 → 0), total still 5", (await levelAt(p, depot.id)) === 0 && (await totalOf(p)) === 5);
  }

  // ── S7: CONCURRENCY — a transfer completing INTO the depot must not clobber a
  // simultaneous ship-decrement on it. Both writers now take the TOTAL FOR UPDATE,
  // so whatever the interleaving: store 5−3=2, depot 10+3(transfer)−3(ship)=10,
  // total invariant 15. (Pre-fix, moveStockTx's stale absolute could resurrect the
  // shipped units → depot 13 / total 18.) ────────────────────────────────────────
  {
    let raceOk = true;
    for (let i = 0; i < 6; i++) {
      const p = await mkProduct(`s7-${i}`);
      const store = await stockLocationService.create({ name: `${TAG}-s7store${i}`, is_active: true } as never);
      const depot = await stockLocationService.create({ name: `${TAG}-s7depot${i}`, is_active: true } as never);
      await stockLocationService.setLocationLevel({ productId: p, variantId: null }, store.id, 5);
      await stockLocationService.setLocationLevel({ productId: p, variantId: null }, depot.id, 10); // total 15
      await Promise.allSettled([
        db.transaction((tx) =>
          stockLocationService.moveStockTx(tx, { productId: p, variantId: null }, store.id, depot.id, 3, { note: "race" }),
        ),
        stockLocationService.adjustLevelOnly({ productId: p, variantId: null }, depot.id, -3, { reason: "order", note: "race-ship" }),
      ]);
      const d = await levelAt(p, depot.id);
      const s = await levelAt(p, store.id);
      const t = await totalOf(p);
      if (!(d === 10 && s === 2 && t === 15)) raceOk = false;
    }
    check("S7: transfer-into-depot vs ship-decrement — no clobber (depot 10, store 2, total 15)", raceOk);
  }

  // ── S8: LOCK ORDER — a relative ERP adjust (adjustLocationLevel) racing a
  // ship-decrement (adjustLevelOnly) on the SAME (product, location). Pre-fix the
  // adjust pre-locked the LEVEL then the TOTAL while the ship locks TOTAL→LEVEL —
  // an AB/BA cycle that Postgres aborts as a deadlock (40P01). Both now take the
  // TOTAL before the LEVEL, so neither throws and the two compose: 10 +5 −4 = 11
  // whatever the interleaving (deterministic — each writer reads the other's
  // committed level under the lock). ───────────────────────────────────────────
  {
    let raceOk = true;
    let deadlocked = false;
    for (let i = 0; i < 8; i++) {
      const p = await mkProduct(`s8-${i}`);
      const depot = await stockLocationService.create({ name: `${TAG}-s8depot${i}`, is_active: true } as never);
      await stockLocationService.setLocationLevel({ productId: p, variantId: null }, depot.id, 10);
      const results = await Promise.allSettled([
        stockLocationService.adjustLocationLevel({ productId: p, variantId: null }, depot.id, 5, { reason: "api_delta", note: "race-erp" }),
        stockLocationService.adjustLevelOnly({ productId: p, variantId: null }, depot.id, -4, { reason: "order", note: "race-ship" }),
      ]);
      for (const r of results) {
        if (r.status === "rejected" && /deadlock|40P01/i.test(String(r.reason))) deadlocked = true;
        if (r.status === "rejected") raceOk = false;
      }
      if ((await levelAt(p, depot.id)) !== 11) raceOk = false;
    }
    check("S8: ERP adjust vs ship-decrement — no deadlock, composes to 11", raceOk && !deadlocked);
  }

  // ── Round-2 R4: moveStockTx dest-first must NOT re-list a delisted product ──
  //    (guards the round-1 HIGH fix). A whole-stock move source→dest crosses the
  //    cached total through 0; dest-first keeps the intermediate total > 0 so a
  //    DELIBERATELY delisted line (in_stock=false WITH units) stays delisted.
  {
    const p = await mkProduct("relist");
    const src = await stockLocationService.create({ name: `${TAG}-rsrc`, is_active: true } as never);
    const dest = await stockLocationService.create({ name: `${TAG}-rdest`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, src.id, 5);
    // Operator delist: keep the 5 units but mark it not-for-sale.
    await db.update(products).set({ in_stock: false }).where(eq(products.id, p));
    check("relist: delisted pre-move (in_stock=false, total 5)", !(await inStockOf(p)) && (await totalOf(p)) === 5);
    await db.transaction((tx) =>
      stockLocationService.moveStockTx(tx, { productId: p, variantId: null }, src.id, dest.id, 5, { note: "relist-test" }),
    );
    check("relist: total still 5 after whole-stock move (invariant)", (await totalOf(p)) === 5);
    check("relist: STAYS delisted (dest-first, not re-listed to in_stock=true)", !(await inStockOf(p)));
    check("relist: units relocated (src 0, dest 5)", (await levelAt(p, src.id)) === 0 && (await levelAt(p, dest.id)) === 5);
  }

  // ── Round-2 R4: per-location matrix compare-and-set (StockConflictError) ──
  //    A stale expectedLevel is refused (no clobber); the correct one commits.
  {
    const p = await mkProduct("cas");
    const loc = await stockLocationService.create({ name: `${TAG}-cas`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, loc.id, 3);
    let conflict = false;
    try {
      await stockLocationService.setLocationLevel({ productId: p, variantId: null }, loc.id, 9, { expectedLevel: 99 });
    } catch (e) {
      conflict = e instanceof StockConflictError;
    }
    check("CAS: stale expectedLevel → StockConflictError", conflict);
    check("CAS: level unchanged after refused save (still 3)", (await levelAt(p, loc.id)) === 3);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, loc.id, 9, { expectedLevel: 3 });
    check("CAS: correct expectedLevel commits (level 9)", (await levelAt(p, loc.id)) === 9);
  }

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

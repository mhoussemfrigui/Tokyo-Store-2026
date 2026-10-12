import { NextResponse } from "next/server";

import { resolveProductRow, type ProductRef } from "@/lib/api/products";
import { productService } from "@/modules/catalog/product/service";
import { findVariantById, findVariantBySku } from "@/modules/catalog/product/queries";
import { getSharedStockDefault, isSharedStock } from "@/lib/inventory/variant-stock";
import { applyStockDelta, applyStockSet, type StockTargetKind } from "@/lib/inventory/adjust";
import { resolveLowStockConfig } from "@/lib/inventory/low-stock";
import { resolveInventoryConfig } from "@/lib/inventory/locations-config";
import { emitStockCrossingEvents } from "@/lib/inventory/stock-alerts";
import { stockLocationService } from "@/modules/stock-location";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { readJsonObject } from "@/lib/api-auth/respond";
import { requireApiActor } from "@/lib/api-auth/actor";
import { dbContentionFail } from "@/workflows/shared";
import { bus } from "@/events/bus";

/** Bust the catalog cache after an API stock write (replaces the product.updated
 *  the old workflow path emitted). */
async function invalidate(
  productId: string,
  slug: string,
  actorUserId: string,
  stock?: { stockQty: number | null; locationCode?: string | null },
): Promise<void> {
  // Enrich with the PRODUCT's merchant identifiers so an ERP consuming this
  // outbound product.updated can correlate the stock change to its own record
  // without a GET /api/products callback (mirrors the catalog workflows). One
  // indexed lookup off the hot path; a miss degrades to nulls and never fails the
  // already-committed stock write. The new authoritative qty (+ the location code
  // for a per-store write) ride along so the ERP mirrors the VALUE from the webhook
  // without a GET /api/stock callback.
  const ids = await productService.findIdentifiers(productId).catch(() => null);
  await bus
    .emit(
      "product.updated",
      {
        productId,
        slug,
        changedFields: ["stock_qty", "in_stock"],
        sku: ids?.sku ?? null,
        gtin: ids?.gtin ?? null,
        externalRef: ids?.externalRef ?? null,
        ...(stock ? { stockQty: stock.stockQty, locationCode: stock.locationCode ?? null } : {}),
      },
      { actorUserId },
    )
    .catch(() => {});
}

/**
 * Emit `product.restocked` on an unavailable → available transition, mirroring
 * bulkUpdateStockAction / updateProductWorkflow — so an ERP/WMS replenishment
 * (the dominant restock channel on an integrated store) fires the back-in-stock
 * email + the restocked outbound webhook, which the `product.updated`-only path
 * silently skipped. `t` reflects the PRE-write state (resolved before the
 * mutation), so the `was` flags are the availability before the adjustment.
 *
 * Fires on EITHER transition: the stock ROW's own (for a shared-pool variant ref
 * that's the parent pool — a sold-out pool refilled through a DISABLED variant's
 * SKU re-lists every sibling, and the next sync through a sibling sees qty > 0
 * and never fires) or the ADDRESSED target's (pool && the variant's own flag —
 * re-enabling one colour of a stocked pool). For a non-pool target both are the
 * same row, so this is the plain unavailable → available test.
 */
async function emitRestockIfBackInStock(
  t: ResolvedTarget,
  now: { row: boolean; target: boolean },
  actorUserId: string,
): Promise<void> {
  const qtyWas = t.currentQty === null || t.currentQty > 0;
  const rowWas = t.inStock && qtyWas;
  const targetWas = targetInStock(t) && qtyWas;
  if ((!rowWas && now.row) || (!targetWas && now.target)) {
    await bus.emit("product.restocked", { productId: t.productId }, { actorUserId }).catch(() => {});
  }
}

/**
 * Operator low-stock / rupture alerts for an API adjustment that took a TRACKED
 * level down across the threshold (or to 0) — the same crossing events a web or
 * ERP-pushed sale raises (place-order), so a POS/ERP that syncs its sales as
 * stock deltas doesn't silently skip the reorder signal. Gated on the low-stock
 * toggle; the settings read only happens for a real decrease. Post-commit +
 * best-effort (the helper swallows its own errors).
 */
async function emitStockAlertsIfCrossed(
  t: ResolvedTarget,
  prevQty: number | null,
  newQty: number | null,
  actorUserId: string,
): Promise<void> {
  if (prevQty == null || newQty == null || newQty >= prevQty) return;
  const settings = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
  await emitStockCrossingEvents(
    [{ productId: t.productId, variantId: t.variantId, ...t.alert, prevQty, newQty }],
    { lowStock: resolveLowStockConfig(settings), actorUserId },
  );
}

/**
 * Run a stock mutation, mapping foreseeable Postgres contention (deadlock /
 * lock_timeout / stock CHECK) to a friendly retryable 409 instead of an opaque
 * 500 — the stock route writes directly (not through workflow()), so it doesn't
 * inherit dbContentionFail's mapping otherwise.
 */
async function adjustOr409<T>(fn: () => Promise<T>): Promise<T | NextResponse> {
  try {
    return await fn();
  } catch (err) {
    const f = dbContentionFail(err);
    if (f) return NextResponse.json({ error: f.message, code: f.error }, { status: 409, headers: NO_STORE });
    throw err;
  }
}

/**
 * /api/stock — view + adjust inventory for a product OR a specific variant,
 * addressed by any reference, for ERP / warehouse sync.
 *
 *   GET   ?productId= | ?externalRef= | ?sku= | ?gtin=   (product pool)
 *         ?variantId= | ?variantSku=                     (variant)
 *   PATCH { <ref>, stockDelta: ±N }     → atomic add/remove (race-safe; ledgered)
 *         { <ref>, stockQty?, inStock? } → absolute set (in_stock derived; ledgered)
 *
 * Shared-stock: a variant ref on a SHARED-mode variable product addresses the
 * PARENT pool for QUANTITY (that IS the variant's stock), flagged `pool:true` in
 * the view — but the variant keeps its OWN `in_stock` flag (checkout + the
 * storefront honour it), so an `inStock` write goes to the variant row (never
 * delisting every variant of the product) and the reported `inStock` is
 * variant && parent. Adjustments delegate to atomic SQL that composes with the
 * order decrement (no lost update). Live inventory is never shared-cached.
 *
 * A decrease that crosses the low-stock threshold (or hits 0) raises the same
 * operator alerts as a sale (`product.stock_low` / `product.stock_depleted`,
 * gated on the low-stock toggle).
 *
 * Multi-location: without `location`, `stockQty` is the cached TOTAL (the sum
 * across active locations) — the default, backward-compatible behaviour. With
 * `location=<code>` (a stock_locations.code), the call is scoped to that ONE
 * location's on-hand level so an ERP/WMS can sync a specific store or the central
 * depot: GET returns `locationStockQty` + `totalStockQty`; PATCH `{ location,
 * stockQty | stockDelta }` writes that location's level (maintaining the cached
 * total + the ledger via stockLocationService). Per-location writes require
 * per_location mode and a KEYED caller (operator data). `externalRef` is the
 * product↔ERP link; `code` is the location↔ERP link.
 */
const NO_STORE = { "Cache-Control": "no-store" } as const;
const REF_MAX = 120;

type ResolvedTarget = {
  kind: StockTargetKind;
  rowId: string;
  productId: string;
  variantId: string | null;
  currentQty: number | null;
  inStock: boolean;
  published: boolean;
  slug: string;
  sku: string | null;
  externalRef: string | null;
  /** True when a variant ref was redirected to the shared parent pool. */
  pool: boolean;
  /** Shared-pool variant ref only: the addressed VARIANT row. Quantity lives on
   *  the parent pool (this target's row) while the variant keeps its own
   *  `in_stock` flag — `inStock` writes go here, availability = variant && pool. */
  poolVariant: { id: string; inStock: boolean } | null;
  /** Labels for the operator low-stock / rupture alert email (the variant's own
   *  SKU + label when its row holds the stock, the parent's otherwise). */
  alert: { sku: string | null; name: string; variantLabel: string | null };
};

type StockSetResult = Awaited<ReturnType<typeof applyStockSet>>;

/** Availability flag as checkout sees it: a shared-pool variant needs BOTH its
 *  own flag and the pool's (place-order + the storefront DTO apply the same AND). */
function targetInStock(t: ResolvedTarget): boolean {
  return t.inStock && (t.poolVariant?.inStock ?? true);
}

function q(params: URLSearchParams, k: string): string | null {
  const v = params.get(k)?.trim();
  return v ? v.slice(0, REF_MAX) : null;
}
function bodyStr(body: Record<string, unknown>, k: string): string | null {
  const v = body[k];
  return typeof v === "string" && v.trim() ? v.trim().slice(0, REF_MAX) : null;
}

// id columns are `uuid`; a non-UUID value would hit `WHERE id = $1` and raise
// 22P02 → an unhandled 500 (resolveTarget runs before the adjust wrapper). Guard
// the shape up front so a bad ref is a clean 400 — mirrors the products /
// categories / brands routes. (sku/gtin/externalRef/variantSku are text — no guard.)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve the addressed product/variant into a concrete stock target. */
async function resolveTarget(get: (k: string) => string | null): Promise<
  { ok: true; target: ResolvedTarget } | { ok: false; status: number; error: string }
> {
  const variantId = get("variantId");
  const variantSku = get("variantSku");
  if (variantId && !UUID_RE.test(variantId)) {
    return { ok: false, status: 400, error: "variantId invalide." };
  }

  if (variantId || variantSku) {
    const variant = variantId ? await findVariantById(variantId) : await findVariantBySku(variantSku!);
    if (!variant) return { ok: false, status: 404, error: "Variante introuvable." };
    const product = await productService.findById(variant.product_id);
    if (!product) return { ok: false, status: 404, error: "Produit introuvable." };
    const shared = product.product_type === "variable" && isSharedStock(product.shared_variant_stock, await getSharedStockDefault());
    if (shared) {
      // The variant's QUANTITY is the parent pool — operate on the product for
      // stock, but keep the variant row for its own in_stock flag.
      return {
        ok: true,
        target: {
          kind: "product", rowId: product.id, productId: product.id, variantId: null,
          currentQty: product.stock_qty, inStock: product.in_stock,
          published: product.is_published, slug: product.slug, sku: product.sku, externalRef: product.external_ref,
          pool: true,
          poolVariant: { id: variant.id, inStock: variant.in_stock },
          alert: { sku: product.sku, name: product.name, variantLabel: null },
        },
      };
    }
    return {
      ok: true,
      target: {
        kind: "variant", rowId: variant.id, productId: variant.product_id, variantId: variant.id,
        currentQty: variant.stock_qty, inStock: variant.in_stock,
        published: product.is_published, slug: product.slug, sku: variant.sku, externalRef: product.external_ref,
        pool: false,
        poolVariant: null,
        alert: { sku: variant.sku ?? product.sku, name: product.name, variantLabel: variant.label || null },
      },
    };
  }

  const ref: ProductRef = { productId: get("productId"), externalRef: get("externalRef"), sku: get("sku"), gtin: get("gtin") };
  if (!ref.productId && !ref.externalRef && !ref.sku && !ref.gtin) {
    return { ok: false, status: 400, error: "Référence requise : productId | externalRef | sku | gtin | variantId | variantSku." };
  }
  if (ref.productId && !UUID_RE.test(ref.productId)) {
    return { ok: false, status: 400, error: "productId invalide." };
  }
  const product = await resolveProductRow(ref);
  if (!product) return { ok: false, status: 404, error: "Produit introuvable." };
  return {
    ok: true,
    target: {
      kind: "product", rowId: product.id, productId: product.id, variantId: null,
      currentQty: product.stock_qty, inStock: product.in_stock,
      published: product.is_published, slug: product.slug, sku: product.sku, externalRef: product.external_ref,
      pool: false,
      poolVariant: null,
      alert: { sku: product.sku, name: product.name, variantLabel: null },
    },
  };
}

function stockView(t: ResolvedTarget, opts?: { stripInternal?: boolean }) {
  return {
    productId: t.productId,
    variantId: t.variantId,
    slug: t.slug,
    sku: t.sku,
    // externalRef is the merchant's internal ERP key — hidden from anonymous
    // public callers, round-tripped only to keyed ERP integrations.
    externalRef: opts?.stripInternal ? null : t.externalRef,
    inStock: targetInStock(t),
    stockQty: t.currentQty,
    pool: t.pool,
  };
}

// ─────────────────────────────── per-location (ERP store-level sync) ──────────
/** The LevelTarget a per-location op addresses — the parent POOL for a shared
 *  variant ref (quantity lives there), the variant otherwise; same rule the
 *  total path + ship decrement use. */
function levelTargetOf(t: ResolvedTarget): { productId: string; variantId: string | null } {
  return { productId: t.productId, variantId: t.variantId };
}

/** Current cached TOTAL for the target's row, re-read after a per-location write. */
async function readTotal(t: ResolvedTarget): Promise<number | null> {
  if (t.kind === "variant") return (await findVariantById(t.rowId))?.stock_qty ?? null;
  return (await productService.findById(t.rowId))?.stock_qty ?? null;
}

function perLocationView(
  t: ResolvedTarget,
  loc: { code: string | null; name: string; is_active: boolean; is_default: boolean },
  locationStockQty: number,
  totalStockQty: number | null,
) {
  return {
    productId: t.productId,
    variantId: t.variantId,
    slug: t.slug,
    sku: t.sku,
    externalRef: t.externalRef,
    location: loc.code,
    locationName: loc.name,
    locationActive: loc.is_active,
    isCentral: loc.is_default,
    locationStockQty,
    totalStockQty,
    inStock: targetInStock(t),
    pool: t.pool,
  };
}

/** Resolve + validate a location for a per-location WRITE: per_location mode must
 *  be on, the code must resolve, and the location must be active. */
async function resolveWriteLocation(
  code: string,
): Promise<{ ok: true; loc: Awaited<ReturnType<typeof stockLocationService.findByCode>> & object } | { ok: false; response: NextResponse }> {
  const cfg = resolveInventoryConfig(await getSettingsMap().catch(() => ({}) as Record<string, string | null>));
  if (cfg.locationMode !== "per_location") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Le mode « par emplacement » n'est pas activé — l'écriture par emplacement est indisponible.", code: "not_per_location" },
        { status: 409, headers: NO_STORE },
      ),
    };
  }
  const loc = await stockLocationService.findByCode(code);
  if (!loc) {
    return { ok: false, response: NextResponse.json({ error: "Emplacement introuvable (code)." }, { status: 404, headers: NO_STORE }) };
  }
  if (!loc.is_active) {
    return { ok: false, response: NextResponse.json({ error: "Emplacement inactif — réactivez-le avant d'y écrire du stock." }, { status: 409, headers: NO_STORE }) };
  }
  return { ok: true, loc };
}

/**
 * PATCH a single location's level: `{ location, stockQty }` (absolute set) or
 * `{ location, stockDelta }` (±N). Writes through the locked level writers
 * (stockLocationService) so the cached TOTAL + the ledger stay correct, then runs
 * the SAME side effects as the total path — cache bust, back-in-stock restock, and
 * the low-stock/rupture crossing alert. `inStock` is rejected here: availability is
 * a product-level flag, not a per-store quantity. Keyed callers only (the PATCH
 * gate already enforced auth + an actor).
 */
async function perLocationPatch(
  target: ResolvedTarget,
  code: string,
  body: Record<string, unknown>,
  actorUserId: string,
  note: string | null,
): Promise<NextResponse> {
  if ("inStock" in body) {
    return NextResponse.json(
      { error: "La disponibilité (« inStock ») se règle au niveau du produit, pas par emplacement." },
      { status: 400, headers: NO_STORE },
    );
  }
  const resolved = await resolveWriteLocation(code);
  if (!resolved.ok) return resolved.response;
  const loc = resolved.loc;

  const hasDelta = "stockDelta" in body;
  const hasSet = "stockQty" in body;
  if (hasDelta === hasSet) {
    return NextResponse.json(
      { error: "Fournissez « stockQty » (absolu) OU « stockDelta » (±N) pour l'emplacement." },
      { status: 400, headers: NO_STORE },
    );
  }

  const lt = levelTargetOf(target);
  let out: { becameAvailable: boolean } | NextResponse;
  if (hasDelta) {
    const delta = body.stockDelta;
    if (typeof delta !== "number" || !Number.isInteger(delta) || delta === 0) {
      return NextResponse.json({ error: "« stockDelta » doit être un entier non nul (±N)." }, { status: 400, headers: NO_STORE });
    }
    out = await adjustOr409(() =>
      stockLocationService.adjustLocationLevel(lt, loc.id, delta, { reason: "api_delta", actorUserId, note }),
    );
  } else {
    const qty = body.stockQty;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 0) {
      return NextResponse.json({ error: "« stockQty » doit être un entier ≥ 0." }, { status: 400, headers: NO_STORE });
    }
    out = await adjustOr409(() =>
      stockLocationService.setLocationLevel(lt, loc.id, qty, { reason: "api_set", actorUserId, note }),
    );
  }
  if (out instanceof NextResponse) return out;

  const [newLevel, newTotal] = await Promise.all([
    stockLocationService.getLocationLevel(lt, loc.id),
    readTotal(target),
  ]);
  // The outbound product.updated carries the new TOTAL + the location code so an ERP
  // knows WHICH store/depot moved and to WHAT, straight from the webhook.
  await invalidate(target.productId, target.slug, actorUserId, { stockQty: newTotal, locationCode: loc.code });
  if (out.becameAvailable) {
    await bus.emit("product.restocked", { productId: target.productId }, { actorUserId }).catch(() => {});
  }
  // A per-location write moves the TOTAL by the same amount — raise the operator's
  // low-stock / rupture alert when it crossed down, like a sale or a total-path write.
  await emitStockAlertsIfCrossed(target, target.currentQty, newTotal, actorUserId);

  return NextResponse.json({ stock: perLocationView(target, loc, newLevel, newTotal) }, { headers: NO_STORE });
}

export async function GET(request: Request) {
  const gate = await enforceExternalApi(request, "stock.get");
  if (!gate.ok) return gate.response;

  const params = new URL(request.url).searchParams;
  const res = await resolveTarget((k) => q(params, k));
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status, headers: NO_STORE });

  // A PUBLIC caller only sees published products' stock (keyed callers are trusted).
  if (gate.isPublic && !res.target.published) {
    return NextResponse.json({ error: "Produit introuvable." }, { status: 404, headers: NO_STORE });
  }

  // Per-location read (`?location=<code>`) — a specific store / the central depot's
  // own on-hand. Operator/ERP data, so keyed callers only (never a public caller).
  const locationCode = q(params, "location");
  if (locationCode) {
    if (gate.isPublic) {
      return NextResponse.json({ error: "Détail par emplacement réservé aux intégrations authentifiées." }, { status: 403, headers: NO_STORE });
    }
    const loc = await stockLocationService.findByCode(locationCode);
    if (!loc) return NextResponse.json({ error: "Emplacement introuvable (code)." }, { status: 404, headers: NO_STORE });
    const level = await stockLocationService.getLocationLevel(levelTargetOf(res.target), loc.id);
    return NextResponse.json({ stock: perLocationView(res.target, loc, level, res.target.currentQty) }, { headers: NO_STORE });
  }

  return NextResponse.json(
    { stock: stockView(res.target, { stripInternal: gate.isPublic }) },
    { headers: NO_STORE },
  );
}

export async function PATCH(request: Request) {
  const gate = await enforceExternalApi(request, "stock.update");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const res = await resolveTarget((k) => bodyStr(body, k));
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status, headers: NO_STORE });
  const target = res.target;
  const note = typeof body.note === "string" ? body.note.slice(0, 200) : null;

  // Per-location write (`{ location: <code>, stockQty | stockDelta }`) — sync ONE
  // store / the central depot's level. Delegates to the locked level writers (total
  // + ledger maintained); requires per_location mode.
  const locationCode = bodyStr(body, "location");
  if (locationCode) {
    return perLocationPatch(target, locationCode, body, actor.actorUserId, note);
  }

  const hasDelta = "stockDelta" in body;
  const hasSet = "stockQty" in body || "inStock" in body;
  if (hasDelta && hasSet) {
    return NextResponse.json(
      { error: "Fournissez « stockDelta » OU « stockQty »/« inStock », pas les deux." },
      { status: 400, headers: NO_STORE },
    );
  }

  if (hasDelta) {
    const delta = body.stockDelta;
    if (typeof delta !== "number" || !Number.isInteger(delta) || delta === 0) {
      return NextResponse.json({ error: "« stockDelta » doit être un entier non nul (±N)." }, { status: 400, headers: NO_STORE });
    }
    const out = await adjustOr409(() =>
      applyStockDelta(
        { kind: target.kind, rowId: target.rowId, productId: target.productId, variantId: target.variantId },
        delta,
        { reason: "api_delta", actorUserId: actor.actorUserId, note },
      ),
    );
    if (out instanceof NextResponse) return out;
    if (!out.ok) {
      return out.code === "untracked"
        ? NextResponse.json({ error: "Ligne à stock illimité (non suivi) — un ajustement relatif ne s'applique pas." }, { status: 422, headers: NO_STORE })
        : NextResponse.json({ error: "Stock insuffisant pour ce retrait.", code: "insufficient" }, { status: 409, headers: NO_STORE });
    }
    await invalidate(target.productId, target.slug, actor.actorUserId, { stockQty: out.resultingQty });
    // `out.inStock` = the row's in_stock as WRITTEN (sold-out rule — a delisted
    // line with units stays delisted), not re-guessed from the quantity here. A
    // shared-pool variant also needs its own (untouched) flag.
    const inStock = out.inStock && (target.poolVariant?.inStock ?? true);
    const rowNow = out.inStock && (out.resultingQty == null || out.resultingQty > 0);
    await emitRestockIfBackInStock(
      target,
      { row: rowNow, target: rowNow && (target.poolVariant?.inStock ?? true) },
      actor.actorUserId,
    );
    // The delta is atomic (`stock_qty = stock_qty + delta`), so the level before
    // is exactly resulting − delta.
    await emitStockAlertsIfCrossed(
      target,
      out.resultingQty == null ? null : out.resultingQty - delta,
      out.resultingQty,
      actor.actorUserId,
    );
    return NextResponse.json({ stock: { ...stockView(target), stockQty: out.resultingQty, inStock } }, { headers: NO_STORE });
  }

  if (!hasSet) {
    return NextResponse.json({ error: "Fournissez « stockDelta », ou « stockQty » et/ou « inStock »." }, { status: 400, headers: NO_STORE });
  }

  // Absolute set. Validate stockQty (integer ≥ 0, or null = untracked).
  let setQty: number | null | undefined;
  if ("stockQty" in body) {
    const v = body.stockQty;
    if (v === null) setQty = null;
    else if (typeof v === "number" && Number.isInteger(v) && v >= 0) setQty = v;
    else return NextResponse.json({ error: "« stockQty » doit être un entier ≥ 0 ou null (illimité)." }, { status: 400, headers: NO_STORE });
  }
  let setInStock: boolean | undefined;
  if ("inStock" in body) {
    if (typeof body.inStock !== "boolean") {
      return NextResponse.json({ error: "« inStock » doit être un booléen." }, { status: 400, headers: NO_STORE });
    }
    setInStock = body.inStock;
  }

  const row = { kind: target.kind, rowId: target.rowId, productId: target.productId, variantId: target.variantId };
  const ledger = { reason: "api_set" as const, actorUserId: actor.actorUserId, note };
  const poolVariant = target.poolVariant;
  // What actually COMMITTED. A shared-pool variant ref is two separate
  // applyStockSet transactions — the QUANTITY on the parent pool, `inStock` on
  // the variant's own row (writing it to the pool would delist / re-list every
  // variant of the product) — so a failure on the second write must still run
  // the first one's side effects below: a retry sees prev == new and would never
  // bust the cache, fire the restock or raise the crossing alert. Each write is
  // an idempotent absolute set, so the retry itself converges.
  const done: { row: StockSetResult | null; flag: StockSetResult | null } = { row: null, flag: null };
  let failure: NextResponse | { error: unknown } | null = null;
  try {
    const res = await adjustOr409(async () => {
      if (!poolVariant) {
        done.row = await applyStockSet(row, { ...(setQty !== undefined ? { setQty } : {}), setInStock }, ledger);
        return;
      }
      if (setQty !== undefined) done.row = await applyStockSet(row, { setQty }, ledger);
      if (setInStock !== undefined) {
        done.flag = await applyStockSet(
          { kind: "variant", rowId: poolVariant.id, productId: target.productId, variantId: poolVariant.id },
          { setInStock },
          ledger,
        );
      }
    });
    if (res instanceof NextResponse) failure = res;
  } catch (error) {
    failure = { error };
  }

  // The in_stock applyStockSet actually wrote (explicit, or derived under the row
  // lock by the sold-out rule) — not re-guessed from the quantity here. For a
  // shared-pool variant: its own flag AND the pool's.
  const resultingQty = done.row ? done.row.resultingQty : target.currentQty;
  const rowInStock = done.row ? done.row.inStock : target.inStock;
  const finalInStock = rowInStock && (poolVariant ? (done.flag ? done.flag.inStock : poolVariant.inStock) : true);
  if (done.row || done.flag) {
    await invalidate(target.productId, target.slug, actor.actorUserId, { stockQty: resultingQty });
    // Quantity-aware availability (matches the delta branch + bulkUpdateStockAction):
    // in_stock=true with a resulting qty of 0 is NOT available, so setting inStock:true
    // on a 0-qty line must not fire a false back-in-stock email / restocked webhook.
    const qtyOk = resultingQty == null || resultingQty > 0;
    await emitRestockIfBackInStock(
      target,
      { row: rowInStock && qtyOk, target: finalInStock && qtyOk },
      actor.actorUserId,
    );
    // Low-stock / rupture alert when an absolute set lowered the level across the
    // threshold. The level before is the pre-write read (an absolute set is
    // last-writer-wins by design; a racing sale can only shift which write alerts).
    if (setQty !== undefined && done.row) {
      await emitStockAlertsIfCrossed(target, target.currentQty, resultingQty, actor.actorUserId);
    }
  }
  if (failure instanceof NextResponse) return failure;
  if (failure) throw failure.error;
  return NextResponse.json({ stock: { ...stockView(target), stockQty: resultingQty, inStock: finalInStock } }, { headers: NO_STORE });
}

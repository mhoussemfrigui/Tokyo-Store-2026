import { NextResponse } from "next/server";

import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { stockMovementService } from "@/modules/stock-movement";
import { type StockMovementReason } from "@/modules/stock-movement/schema";
import { resolveProductRow, type ProductRef } from "@/lib/api/products";
import { serializeStockMovement } from "@/lib/api/movements";
import { parseIncrementalCursor, UUID_RE } from "@/lib/api/cursor";

/**
 * /api/stock/movements — the stock MOVEMENT ledger for ERP reconciliation.
 * Incremental keyset (?since=&sinceId=, created_at ASC). Filters: a product by
 * ?productId=/?externalRef=/?sku=/?gtin=, ?variantId=, ?orderId=, ?reason=.
 * KEY-ONLY (movement volumes are business-sensitive). Scope: stock:read.
 */
const noStore = { "Cache-Control": "no-store" } as const;
const REASONS: readonly StockMovementReason[] = [
  "order",
  "cancellation",
  "refund",
  "return",
  "api_delta",
  "api_set",
  "admin",
  "transfer", // inter-location transfer legs (0127) — appear in the unfiltered feed, so must be filterable too
];

export async function GET(request: Request) {
  const gate = await enforceExternalApi(request, "stock.movements");
  if (!gate.ok) return gate.response;

  const { searchParams } = new URL(request.url);
  const cur = parseIncrementalCursor(searchParams);
  if (!cur.ok) return NextResponse.json({ error: cur.error }, { status: 400, headers: noStore });

  // Optional product scope — resolve any product reference to its id first.
  let productId: string | undefined;
  const ref: ProductRef = {
    productId: searchParams.get("productId")?.trim() || null,
    externalRef: searchParams.get("externalRef")?.trim() || null,
    sku: searchParams.get("sku")?.trim() || null,
    gtin: searchParams.get("gtin")?.trim() || null,
  };
  if (ref.productId && !UUID_RE.test(ref.productId)) {
    return NextResponse.json({ error: "productId invalide." }, { status: 400, headers: noStore });
  }
  if (ref.productId || ref.externalRef || ref.sku || ref.gtin) {
    const product = await resolveProductRow(ref);
    if (!product) {
      return NextResponse.json({ error: "Produit introuvable." }, { status: 404, headers: noStore });
    }
    productId = product.id;
  }

  const variantId = searchParams.get("variantId")?.trim() || undefined;
  if (variantId && !UUID_RE.test(variantId)) {
    return NextResponse.json({ error: "variantId invalide." }, { status: 400, headers: noStore });
  }
  const orderId = searchParams.get("orderId")?.trim() || undefined;
  if (orderId && !UUID_RE.test(orderId)) {
    return NextResponse.json({ error: "orderId invalide." }, { status: 400, headers: noStore });
  }
  const reasonRaw = searchParams.get("reason")?.trim();
  if (reasonRaw && !(REASONS as readonly string[]).includes(reasonRaw)) {
    return NextResponse.json(
      { error: `reason invalide. Valeurs : ${REASONS.join(", ")}.` },
      { status: 400, headers: noStore },
    );
  }

  const ledger = await stockMovementService.listForApi({
    productId,
    variantId,
    orderId,
    reason: reasonRaw as StockMovementReason | undefined,
    sinceIso: cur.sinceIso,
    sinceId: cur.sinceId,
    limit: cur.limit,
  });
  return NextResponse.json(
    {
      movements: ledger.items.map(serializeStockMovement),
      pagination: { limit: cur.limit, count: ledger.items.length, nextSince: ledger.nextSince, nextId: ledger.nextId },
    },
    { headers: noStore },
  );
}

import { inArray } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/lib/db/client";
import { requirePermission } from "@/lib/auth/session";
import { isUuid } from "@/lib/utils/uuid";
import { orders, type OrderRow } from "@/modules/order/schema";
import { listOrdersForExport } from "@/modules/order/export";
import { getTaxConfig } from "@/lib/tax";
import { orderChargesTaxOnTop } from "@/workflows/order/set-invoice-tax";
import { csvCell } from "@/lib/csv/cell";
import { collectKeysetPages } from "@/lib/csv/collect-pages";
import { bus } from "@/events/bus";

/**
 * Streams a CSV of orders. Two modes:
 *   - `?ids=<uuid>&ids=<uuid>` → only those rows (drives the "Exporter
 *     sélection" bulk action on the orders panel)
 *   - no params → the EXPORT_CAP most recent orders (the dashboard « Exporter »)
 *
 * The full export walks a dedicated µs-precise `(created_at, id)` keyset
 * (modules/order/export.ts) — it used to ask the UI list for 1000 rows and
 * silently get its 100-row page. Past the ceiling a trailing marker row + the
 * `X-Export-Truncated` header flag the file as incomplete (the customers / audit
 * export convention); `X-Export-Cap` states the ceiling on every full export.
 *
 * Header keeps the column order stable so spreadsheet templates can be
 * reused across exports (new columns are appended at the end).
 *
 * Emits `data.exported` (resource "orders", row count, the downloading admin as
 * actor) — the file carries customer contact + shipping PII.
 */
const EXPORT_CAP = 1000;
const PAGE = 200;

export async function GET(req: Request) {
  const session = await requirePermission("orders", "view");
  const url = new URL(req.url);
  // Only keep well-formed UUIDs: a malformed id would otherwise blow up the
  // `WHERE id IN (...)::uuid` cast with a 500 instead of returning a clean CSV.
  const rawIds = url.searchParams.getAll("ids").filter(Boolean);
  const ids = rawIds.filter(isUuid);
  const selection = rawIds.length > 0;

  // Selection mode is signalled by the presence of `ids` params. If the caller
  // asked for a selection but none survive validation, return an empty export
  // (header only) — don't silently fall back to the full export.
  let rows: OrderRow[];
  let truncated = false;
  if (selection) {
    rows = ids.length ? await db.select().from(orders).where(inArray(orders.id, ids)) : [];
  } else {
    ({ items: rows, truncated } = await collectKeysetPages(
      (cursor) => listOrdersForExport({ limit: PAGE, cursor }),
      EXPORT_CAP,
    ));
  }

  await bus
    .emit("data.exported", { resource: "orders", count: rows.length }, { actorUserId: session.user.id })
    .catch(() => {});

  // The live mode only decides orders that carry no TVA at all (no signal in
  // their own arithmetic) — see orderChargesTaxOnTop.
  const taxMode = (await getTaxConfig()).mode;

  const header = [
    "id",
    "order_number",
    "created_at",
    "status",
    "currency",
    "contact_email",
    "contact_phone",
    "ship_full_name",
    "ship_street_line1",
    "ship_city",
    "ship_postal_code",
    "ship_country",
    "subtotal_cents",
    "shipping_cents",
    "discount_cents",
    "tax_cents",
    // tax_manual_cents (NULL = use tax_cents) collapsed into a single
    // reconcilable column. How it reaches total_cents depends on the order's
    // tax mode, given per row by `tax_included_in_total`. `care_cents` is the
    // Tokyo Care add-on (ex-TVA; its TVA is inside effective_tax), an additive
    // term of the total like shipping:
    //   false (HT — tax charged on top):
    //     total = subtotal + shipping + care - discount + effective_tax
    //   true (TTC — tax already inside the prices, an informational extract):
    //     total = subtotal + shipping + care - discount
    "effective_tax_cents",
    "total_cents",
    "payment_method",
    "payment_reference",
    "paid_at",
    // Inferred from the order's OWN arithmetic (the admin order / invoice rule),
    // so a later store-wide mode switch can't re-interpret an old order.
    "tax_included_in_total",
    // Sales channel / origin (migration 0172), appended per the "new columns at the
    // end" convention. external_ref carries the ERP link ref when channel='erp'.
    "channel",
    "external_ref",
    // Tokyo Care protection add-on (migration 0203), ex-TVA; appended last per the
    // "new columns at the end" convention.
    "care_cents",
  ];

  const lines = rows.map((o) =>
    [
      o.id,
      o.order_number,
      o.created_at.toISOString(),
      o.status,
      o.currency,
      o.contact_email,
      o.contact_phone ?? "",
      o.ship_full_name,
      o.ship_street_line1,
      o.ship_city,
      o.ship_postal_code ?? "",
      o.ship_country,
      String(o.subtotal_cents),
      String(o.shipping_cents),
      String(o.discount_cents),
      String(o.tax_cents),
      // Effective tax on the order: the manual override when set, otherwise the
      // computed tax (added to the total only when tax_included_in_total=false).
      String(o.tax_manual_cents ?? o.tax_cents),
      String(o.total_cents),
      o.payment_method ?? "",
      o.payment_reference ?? "",
      o.paid_at?.toISOString() ?? "",
      orderChargesTaxOnTop(o, taxMode) ? "false" : "true",
      o.channel,
      o.external_ref ?? "",
      String(o.care_cents),
    ]
      .map(csvCell)
      .join(","),
  );
  const out = [header.join(","), ...lines];
  if (truncated) {
    out.push(
      csvCell(`# tronqué à ${EXPORT_CAP} commandes (les plus récentes) — l'export complet dépasse ce plafond`),
    );
  }
  const csv = out.join("\n");

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="orders-${stamp}.csv"`,
      "cache-control": "no-store",
      ...(selection ? {} : { "x-export-cap": String(EXPORT_CAP) }),
      ...(truncated ? { "x-export-truncated": "1" } : {}),
    },
  });
}

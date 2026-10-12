import "server-only";

import { NextResponse } from "next/server";

import { apiSettingsService } from "@/modules/api-settings/service";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { requireApiKey } from "./require-api-key";
import { routeById } from "./route-catalog";

/**
 * The single gate every EXTERNAL API handler runs first. Resolves the route in
 * the catalog, applies the global kill-switch, then either lets a public read
 * through or demands a scoped key. Fails CLOSED on any misconfiguration.
 *
 *   const gate = await enforceExternalApi(req, "products.create");
 *   if (!gate.ok) return gate.response;
 *   // … gate.actorUserId is the workflow actor for writes …
 */
export type EnforceResult =
  | { ok: true; actorUserId: string | null; keyId: string | null; isPublic: boolean }
  | { ok: false; response: NextResponse };

/**
 * Does the request carry an API-key credential (`Authorization: Bearer …` or
 * `X-API-Key`)? Mirrors requireApiKey's extraction, so a non-Bearer
 * Authorization (e.g. a proxy's Basic auth in front of a headless front-end)
 * still reads a public route anonymously.
 */
export function presentsApiKey(req: Request): boolean {
  const auth = req.headers.get("authorization");
  if (auth && /^bearer\s+\S/i.test(auth)) return true;
  return Boolean(req.headers.get("x-api-key")?.trim());
}

export async function enforceExternalApi(req: Request, routeId: string): Promise<EnforceResult> {
  const route = routeById(routeId);
  if (!route || route.tier !== "external" || !route.scope) {
    // Programmer error — a handler referenced an unknown/non-external id.
    // Never silently allow: refuse.
    return {
      ok: false,
      response: NextResponse.json({ error: "Configuration de route invalide." }, { status: 500 }),
    };
  }

  const settings = await apiSettingsService.get();

  // Global kill-switch: when the external API is disabled, nothing passes —
  // not even a valid key, not even a public route.
  if (!settings.apiEnabled) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "L'API externe est désactivée." },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }

  // Public read route (admin-opted) → no key required. The per-key rate limit
  // lives in requireApiKey, which we skip here, so apply an IP-based limit
  // instead (mirrors /api/store/search + /api/track) — otherwise a public,
  // un-cached read (e.g. stock.get) is unthrottled. Fail-open on limiter error.
  //
  // A caller that PRESENTS a key on a public route is authenticated as a keyed
  // caller instead: opening a read to a headless front-end must not silently
  // downgrade the ERP to the public view (drafts hidden, externalRef stripped,
  // embargo applied, per-IP bucket) — its create-then-verify / reconciliation
  // reads would conclude its products are missing and re-create them. A bad key
  // is rejected (401/403) exactly as on a key-only route, never quietly served
  // the public view. No credential → the public path below.
  if (route.canBePublic && settings.publicRoutes.includes(route.id) && !presentsApiKey(req)) {
    const ip = getClientIp(req.headers) || "anon";
    const rl = await checkRateLimit({ bucket: `pubapi:${route.id}:${ip}`, max: 60, windowSeconds: 60 }).catch(
      (err) => {
        // Fail-open: a transient limiter (DB) error must not 500 a public read.
        // But LOG it — a silent fail-open means an attacker who can stress the
        // DB disables rate limiting on every public endpoint with no trace.
        console.error(`[api-auth] rate-limit check failed for ${route.id}, allowing (fail-open)`, err);
        return { ok: true } as { ok: boolean };
      },
    );
    if (!rl.ok) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Trop de requêtes." },
          { status: 429, headers: { "Cache-Control": "no-store" } },
        ),
      };
    }
    return { ok: true, actorUserId: null, keyId: null, isPublic: true };
  }

  // Otherwise a scoped key is mandatory.
  const auth = await requireApiKey(req, route.scope);
  if (!auth.ok) return { ok: false, response: auth.response };
  return { ok: true, actorUserId: auth.createdBy, keyId: auth.keyId, isPublic: false };
}

/** Map a workflow `fail()` error code to an HTTP status. */
export function workflowErrorStatus(error: string): number {
  switch (error) {
    case "validation":
      return 400;
    // 409 — CURRENT-STATE conflicts the caller can resolve, never a 500 an ERP
    // would retry forever (one comment block: an empty `case` holding a comment
    // trips eslint no-fallthrough).
    //  - `in_use`: a delete/convert refused because another entity still depends
    //    on it (a variant/facet/tax-rule on an attribute, …) — manage-attributes,
    //    via DELETE/PATCH /api/attributes[/values].
    //  - Fulfilment writes (order shipment/return/refund POST endpoints): the
    //    state machine rejected the op (`invalid_status`) or a parcel/return
    //    would exceed the remaining quantity (`exceeds_remaining`).
    //  - Order push (POST /api/orders → placeOrderWorkflow): the pushed line is
    //    disabled (`product_unavailable`) or exceeds stock (`out_of_stock`), or a
    //    coupon window closed (`promotion_expired`) — re-read stock and retry.
    //  - Refunds (POST /api/orders/[id]/refunds): refunding an unpaid/COD order
    //    (`not_paid`) or one already fully refunded (`fully_refunded`).
    //  - Status (PATCH /api/orders/[id]/status): an illegal jump in the
    //    payment-aware graph (`invalid_transition`), or → refunded with no refund
    //    on the ledger yet (`refund_required`); its ERP link — a different ref on
    //    an already-linked order (`already_linked`) or a ref another order owns
    //    (`external_ref_conflict`).
    //  - Product type demotion (PUT/PATCH /api/products {productType:"simple"})
    //    on a variable product that still has live variants (`has_variants`) —
    //    delete the variants first.
    // Any NEW fail code reachable from an external route must be mapped here —
    // erp-api.test.ts statically checks every one against this switch.
    case "conflict":
    case "in_use":
    case "invalid_status":
    case "exceeds_remaining":
    case "out_of_stock":
    case "product_unavailable":
    case "promotion_expired":
    case "not_paid":
    case "fully_refunded":
    case "invalid_transition":
    case "refund_required":
    case "already_linked":
    case "external_ref_conflict":
    case "has_variants":
      return 409;
    // Cancelling a PENDING online order re-verifies the payment with the gateway
    // first; an unreachable gateway refuses the cancel fail-closed. Transient —
    // retry later (503), not a server fault.
    case "payment_unverified":
      return 503;
    // Order-push policy/quantity rejections: empty resolvable cart, below the
    // store minimum, per-product min/max quantity, a store that requires a
    // linked account, or a delivery method / pickup point the store doesn't
    // offer (`delivery_unavailable`). The request is well-formed but
    // unprocessable as-is — the ERP must change the payload (fix quantities,
    // attach a customer, pick an enabled method), so 422 (never a retried 500).
    case "empty_cart":
    case "min_order":
    case "min_purchase_qty":
    case "max_purchase_qty":
    case "account_required":
    case "delivery_unavailable":
      return 422;
    case "not_found":
      return 404;
    case "forbidden":
      return 403;
    default:
      return 500;
  }
}

import "server-only";

import { z } from "zod";
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { orderService } from "@/modules/order/service";
import { deliveredAtByOrder } from "@/modules/order/queries";
import { computeOrderLineWarranty } from "@/lib/warranty";
import {
  warranty_claims,
  WARRANTY_REASON_CODES,
  WARRANTY_RESOLUTIONS,
  WARRANTY_CLAIM_TRANSITIONS,
  WARRANTY_CLAIM_TERMINAL,
  type WarrantyClaimStatus,
  type WarrantyClaimRow,
} from "@/modules/warranty-claim/schema";
import { warrantyClaimService } from "@/modules/warranty-claim/service";
import { fail, ok, workflow } from "../shared";
import type { WorkflowFail } from "../shared";

/**
 * Warranty claims (SAV / RMA). Three workflows mirror the returns lifecycle:
 *   create → update (non-terminal status + field edits) → resolve (terminal +
 *   resolution). Each locks its row FOR UPDATE, re-checks under the lock, and
 *   emits a `warranty.claim.*` event AFTER commit (audited + webhooked; the ERP
 *   push axis gates delivery). The update / resolve workflows also back the
 *   external PATCH /api/warranty-claims/[id] write-back — the ERP resolves a claim
 *   by its external_ref → claimId, then calls the same workflow.
 */

// ─────────────────────────────────────────────────────────────── create
const createClaimSchema = z.object({
  orderId: z.string().uuid(),
  orderItemId: z.string().uuid(),
  reasonCode: z.enum(WARRANTY_REASON_CODES).optional(),
  reason: z.string().trim().max(1000).optional(),
  comment: z.string().trim().max(2000).optional(),
  /** Optional ERP/repair-shop reference stamped at creation. */
  externalRef: z.string().trim().max(120).optional(),
});

export const createWarrantyClaimWorkflow = workflow<
  [z.input<typeof createClaimSchema>, { actorUserId?: string | null }],
  { claimId: string }
>("warranty.claim.create", async (input, { actorUserId }) => {
  const parsed = createClaimSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const d = parsed.data;

  const order = await orderService.findById(d.orderId);
  if (!order) return fail("not_found", "Commande introuvable.");
  const item = await orderService.findItemById(d.orderItemId);
  if (!item || item.order_id !== d.orderId) {
    return fail("validation", "Ligne de commande introuvable pour cette commande.");
  }

  // Snapshot the coverage AT CLAIM TIME from the order-line warranty snapshot —
  // resolved BEFORE the tx (a settings-touching read inside it could deadlock).
  const deliveredAt = (await deliveredAtByOrder([d.orderId])).get(d.orderId) ?? null;
  const w = computeOrderLineWarranty(
    { status: order.status, createdAt: order.created_at, paidAt: order.paid_at, deliveredAt },
    item.warranty_months,
    item.warranty_label,
  );

  const result = await db.transaction<{ kind: "ok"; claimId: string } | { kind: "fail"; error: WorkflowFail }>(
    async (tx) => {
      // Lock the order row to serialize concurrent claim creation on its lines.
      const locked = await orderService.findById(d.orderId, tx, { forUpdate: true });
      if (!locked) return { kind: "fail", error: fail("not_found", "Commande introuvable.") };
      // One ACTIVE claim per sold UNIT — a resolved/rejected one may be re-claimed
      // (a later fault). A line can hold quantity > 1, so allow up to `quantity` open
      // cases (a customer bringing the 2nd watch of a qty-2 line while the 1st is in
      // repair must not be refused); block only once every unit already has one.
      const openClaims = await warrantyClaimService.countOpenClaimsForOrderItem(d.orderItemId, tx);
      if (openClaims >= (item.quantity ?? 1)) {
        return {
          kind: "fail",
          error: fail(
            "conflict",
            (item.quantity ?? 1) > 1
              ? `Toutes les unités de cet article (${item.quantity}) ont déjà une réclamation ouverte — traitez-les d'abord.`
              : "Une réclamation est déjà ouverte pour cet article — traitez-la d'abord.",
          ),
        };
      }
      const [row] = await tx
        .insert(warranty_claims)
        .values({
          order_id: d.orderId,
          order_item_id: d.orderItemId,
          product_id: item.product_id,
          variant_id: item.variant_id ?? null,
          product_name: item.product_name,
          status: "open",
          reason_code: d.reasonCode ?? null,
          reason: d.reason ?? null,
          comment: d.comment ?? null,
          warranty_months: item.warranty_months ?? null,
          warranty_label: item.warranty_label ?? null,
          covered_until: w.expiresAt,
          was_covered: w.state === "active",
          external_ref: d.externalRef ?? null,
          created_by_user_id: actorUserId ?? null,
        } as never)
        .returning({ id: warranty_claims.id });
      return { kind: "ok", claimId: row.id };
    },
  );
  if (result.kind === "fail") return result.error;

  await bus.emit(
    "warranty.claim.created",
    { orderId: d.orderId, orderNumber: order.order_number, claimId: result.claimId, productId: item.product_id },
    { actorUserId: actorUserId ?? null },
  );
  return ok({ claimId: result.claimId });
});

// ─────────────────────────────────────────────────────────────── update
const updateClaimSchema = z.object({
  claimId: z.string().uuid(),
  /** A NON-terminal status move (in_repair / awaiting_parts / back to open is not
   *  allowed). Terminal moves (resolved / rejected) go through resolve. */
  status: z.enum(["in_repair", "awaiting_parts"]).optional(),
  comment: z.string().trim().max(2000).optional(),
  reasonCode: z.enum(WARRANTY_REASON_CODES).optional(),
  externalRef: z.string().trim().max(120).optional(),
});

export const updateWarrantyClaimWorkflow = workflow<
  [z.input<typeof updateClaimSchema>, { actorUserId?: string | null }],
  { claimId: string }
>("warranty.claim.update", async (input, { actorUserId }) => {
  const parsed = updateClaimSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const d = parsed.data;

  const result = await db.transaction<
    { kind: "ok"; claim: WarrantyClaimRow; changed: string[] } | { kind: "fail"; error: WorkflowFail }
  >(async (tx) => {
    const [claim] = await tx.select().from(warranty_claims).where(eq(warranty_claims.id, d.claimId)).for("update").limit(1);
    if (!claim) return { kind: "fail", error: fail("not_found", "Réclamation introuvable.") };
    if (WARRANTY_CLAIM_TERMINAL.has(claim.status as WarrantyClaimStatus)) {
      return { kind: "fail", error: fail("conflict", "Cette réclamation est déjà clôturée (résolue ou refusée).") };
    }
    const patch: Record<string, unknown> = { updated_at: sql`now()` };
    const changed: string[] = [];
    if (d.status && d.status !== claim.status) {
      if (!WARRANTY_CLAIM_TRANSITIONS[claim.status as WarrantyClaimStatus].includes(d.status)) {
        return { kind: "fail", error: fail("invalid_transition", `Transition non autorisée : ${claim.status} → ${d.status}.`) };
      }
      patch.status = d.status;
      changed.push("status");
    }
    if (d.comment !== undefined) { patch.comment = d.comment || null; changed.push("comment"); }
    if (d.reasonCode !== undefined) { patch.reason_code = d.reasonCode; changed.push("reason_code"); }
    if (d.externalRef !== undefined) { patch.external_ref = d.externalRef || null; changed.push("external_ref"); }
    if (changed.length === 0) return { kind: "ok", claim, changed };
    const [updated] = await tx.update(warranty_claims).set(patch).where(eq(warranty_claims.id, d.claimId)).returning();
    return { kind: "ok", claim: updated ?? claim, changed };
  });
  if (result.kind === "fail") return result.error;

  if (result.changed.length > 0) {
    const order = await orderService.findById(result.claim.order_id);
    await bus.emit(
      "warranty.claim.updated",
      {
        orderId: result.claim.order_id,
        orderNumber: order?.order_number ?? "",
        claimId: d.claimId,
        changedFields: result.changed,
      },
      { actorUserId: actorUserId ?? null },
    );
  }
  return ok({ claimId: d.claimId });
});

// ─────────────────────────────────────────────────────────────── resolve
const resolveClaimSchema = z.object({
  claimId: z.string().uuid(),
  resolution: z.enum(WARRANTY_RESOLUTIONS),
  resolutionNote: z.string().trim().max(2000).optional(),
});

export const resolveWarrantyClaimWorkflow = workflow<
  [z.input<typeof resolveClaimSchema>, { actorUserId?: string | null }],
  { claimId: string; status: WarrantyClaimStatus }
>("warranty.claim.resolve", async (input, { actorUserId }) => {
  const parsed = resolveClaimSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const d = parsed.data;
  // A "rejected" resolution closes the claim as rejected; every other outcome
  // (repaired / replaced / refunded) closes it as resolved.
  const nextStatus: WarrantyClaimStatus = d.resolution === "rejected" ? "rejected" : "resolved";

  const result = await db.transaction<
    { kind: "ok"; claim: WarrantyClaimRow } | { kind: "fail"; error: WorkflowFail }
  >(async (tx) => {
    const [claim] = await tx.select().from(warranty_claims).where(eq(warranty_claims.id, d.claimId)).for("update").limit(1);
    if (!claim) return { kind: "fail", error: fail("not_found", "Réclamation introuvable.") };
    if (WARRANTY_CLAIM_TERMINAL.has(claim.status as WarrantyClaimStatus)) {
      return { kind: "fail", error: fail("conflict", "Cette réclamation est déjà clôturée (résolue ou refusée).") };
    }
    const [updated] = await tx
      .update(warranty_claims)
      .set({
        status: nextStatus,
        resolution: d.resolution,
        resolution_note: d.resolutionNote ?? null,
        processed_by_user_id: actorUserId ?? null,
        processed_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(eq(warranty_claims.id, d.claimId))
      .returning();
    return { kind: "ok", claim: updated ?? claim };
  });
  if (result.kind === "fail") return result.error;

  const order = await orderService.findById(result.claim.order_id);
  await bus.emit(
    "warranty.claim.resolved",
    {
      orderId: result.claim.order_id,
      orderNumber: order?.order_number ?? "",
      claimId: d.claimId,
      resolution: d.resolution,
    },
    { actorUserId: actorUserId ?? null },
  );
  return ok({ claimId: d.claimId, status: nextStatus });
});

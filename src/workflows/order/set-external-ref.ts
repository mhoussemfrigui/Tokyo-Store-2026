import "server-only";

import { z } from "zod";

import { db, type DbOrTx } from "@/lib/db/client";
import { order_status_history, type OrderRow } from "@/modules/order/schema";
import { orderService } from "@/modules/order/service";
import { bus } from "@/events/bus";
import { fail, flattenZodError, ok, uniqueViolationFail, workflow } from "../shared";
import type { WorkflowFail } from "../shared";

/**
 * ERP LINK of an order — stamp (or explicitly clear) `orders.external_ref`, the
 * two-way key an ERP addresses the order by (`/api/orders/{externalRef}`). Used
 * by PATCH /api/orders/[id]/status.
 *
 * Link rules (mirrors the customer upsert):
 *   - the SAME ref again → idempotent no-op (no write, no event);
 *   - a DIFFERENT ref on an already-linked order → `already_linked` (409), never
 *     a silent re-link;
 *   - a ref owned by ANOTHER order → `external_ref_conflict` (409) — the partial
 *     unique index is the race backstop;
 *   - clearing the link needs an explicit `unlink: true`. A blank `externalRef`
 *     is REFUSED: a stray "" used to silently unlink the order, after which any
 *     other ref could be stamped — bypassing `already_linked` — with no trace.
 *
 * Locked read + guard + write in ONE transaction, a same-status timeline row, and
 * `order.edited` (→ audit_log + outbound webhooks) with the actor.
 */
const EXTERNAL_REF_MAX = 200;

const linkSchema = z.object({
  externalRef: z
    .string({ error: "externalRef doit être une chaîne." })
    .trim()
    .max(EXTERNAL_REF_MAX, `externalRef : ${EXTERNAL_REF_MAX} caractères maximum.`)
    .optional(),
  unlink: z.boolean({ error: "unlink doit être un booléen." }).optional(),
});

export const setOrderExternalRefSchema = linkSchema.extend({ orderId: z.string().uuid() });

export type OrderExternalRefInput = z.input<typeof linkSchema>;

const ALREADY_LINKED_MSG = "Cette commande est déjà liée à un autre externalRef.";
const REF_TAKEN_MSG = "externalRef déjà utilisé par une autre commande.";

type LinkPlan = { kind: "noop" | "set"; ref: string | null } | { kind: "fail"; error: WorkflowFail };

/**
 * The link rules against `order`'s CURRENT ref — `set` (with the target ref,
 * null = unlink), `noop`, or the refusal. Shared by the workflow (on the row
 * locked in its tx) and PATCH /api/orders/[id]/status, which pre-checks BEFORE
 * running a status transition so a doomed link never leaves a half-applied
 * request (transition committed, link refused).
 */
export async function checkOrderExternalRefChange(
  order: Pick<OrderRow, "id" | "external_ref">,
  input: OrderExternalRefInput,
  txOrDb: DbOrTx = db,
): Promise<LinkPlan> {
  const parsed = linkSchema.safeParse(input);
  if (!parsed.success) {
    return {
      kind: "fail",
      error: fail("validation", parsed.error.issues[0]?.message ?? "externalRef invalide.", flattenZodError(parsed.error)),
    };
  }
  const ref = parsed.data.externalRef || null;
  if (parsed.data.unlink === true) {
    if (ref) {
      const msg = "unlink: true délie la commande — n'envoyez pas d'externalRef avec.";
      return { kind: "fail", error: fail("validation", msg, { externalRef: msg }) };
    }
  } else if (!ref) {
    const msg = "externalRef vide : pour délier la commande de l'ERP, envoyez « unlink: true ».";
    return { kind: "fail", error: fail("validation", msg, { externalRef: msg }) };
  }

  const current = order.external_ref ?? null;
  if (current === ref) return { kind: "noop", ref };
  if (ref && current) {
    return { kind: "fail", error: fail("already_linked", ALREADY_LINKED_MSG, { externalRef: ALREADY_LINKED_MSG }) };
  }
  if (ref) {
    const owner = await orderService.findByExternalRef(ref, txOrDb);
    if (owner && owner.id !== order.id) {
      return { kind: "fail", error: fail("external_ref_conflict", REF_TAKEN_MSG, { externalRef: REF_TAKEN_MSG }) };
    }
  }
  return { kind: "set", ref };
}

export const setOrderExternalRefWorkflow = workflow<
  [z.input<typeof setOrderExternalRefSchema>, { actorUserId: string }],
  { orderId: string; externalRef: string | null; changed: boolean }
>("order.set_external_ref", async (input, { actorUserId }) => {
  const parsed = setOrderExternalRefSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", parsed.error.issues[0]?.message ?? "Requête invalide.", flattenZodError(parsed.error));
  }
  const { orderId, externalRef, unlink } = parsed.data;

  type TxResult =
    | { kind: "ok"; orderNumber: string; ref: string | null; changed: boolean }
    | { kind: "fail"; error: WorkflowFail };

  let result: TxResult;
  try {
    result = await db.transaction<TxResult>(async (tx) => {
      const order = await orderService.findById(orderId, tx, { forUpdate: true });
      if (!order) return { kind: "fail", error: fail("not_found", "Commande introuvable.") };

      const plan = await checkOrderExternalRefChange(order, { externalRef, unlink }, tx);
      if (plan.kind === "fail") return plan;
      if (plan.kind === "noop") {
        return { kind: "ok", orderNumber: order.order_number, ref: plan.ref, changed: false };
      }

      await orderService.setExternalRef(order.id, plan.ref, tx);
      // Timeline trace (same-status row, like an edit-items / TVA change).
      await tx.insert(order_status_history).values({
        order_id: order.id,
        from_status: order.status,
        to_status: order.status,
        actor_user_id: actorUserId,
        notes: plan.ref
          ? `Liée à l'ERP : externalRef « ${plan.ref} »`
          : `Déliée de l'ERP (externalRef « ${order.external_ref ?? ""} » retiré)`,
      });
      return { kind: "ok", orderNumber: order.order_number, ref: plan.ref, changed: true };
    });
  } catch (err) {
    // Residual race: a concurrent request claimed the same ref between the
    // pre-check and the write → the partial-unique index raised 23505.
    if (uniqueViolationFail(err)) {
      return fail("external_ref_conflict", REF_TAKEN_MSG, { externalRef: REF_TAKEN_MSG });
    }
    throw err;
  }
  if (result.kind === "fail") return result.error;

  if (result.changed) {
    await bus.emit(
      "order.edited",
      { orderId, orderNumber: result.orderNumber, changedFields: ["external_ref"], actorUserId },
      { actorUserId },
    );
  }

  return ok({ orderId, externalRef: result.ref, changed: result.changed });
});

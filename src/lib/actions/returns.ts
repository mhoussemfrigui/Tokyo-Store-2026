"use server";

import { revalidatePath } from "next/cache";

import { requirePermissionAny } from "@/lib/auth/session";
import { workflows } from "@/workflows";
import { type ActionState } from "@/lib/actions/types";

/**
 * Admin actions for customer returns (retours). Typed direct-call actions (the
 * returns panel passes a structured payload), mapping the workflow result to
 * ActionState and revalidating the order page.
 *
 * Gate: `returns:manage` OR `orders:manage`. The « Retours » page is gated on
 * `returns:view`, so a scoped "returns agent" role (`returns:view` +
 * `returns:manage`) can now process returns WITHOUT the broad `orders:manage`
 * (which also confers full order edit/cancel/refund); existing `orders:manage`
 * holders are unaffected. Mirrors the « Nouvelle commande » OR-grant pattern.
 */
const RETURN_MANAGE_GRANTS = [
  { module: "returns", action: "manage" },
  { module: "orders", action: "manage" },
] as const;
export async function createReturnAction(input: {
  orderId: string;
  /** Omitted = classic after-sale (SAV). "shipment" = « Retour d'expédition ». */
  kind?: "after_sale" | "shipment";
  reasonCode?: string;
  reason?: string;
  comment?: string;
  /** « Retour d'expédition » only — external carrier snapshot + attempts. */
  carrierName?: string;
  trackingRef?: string;
  deliveryAttempts?: number;
  lines: Array<{ orderItemId: string; quantity: number; restockable: boolean; conditionNote?: string }>;
}): Promise<ActionState> {
  const session = await requirePermissionAny(RETURN_MANAGE_GRANTS);
  const res = await workflows.order.createReturn(
    {
      orderId: input.orderId,
      kind: input.kind ?? "after_sale",
      reasonCode: input.reasonCode as never,
      reason: input.reason,
      comment: input.comment,
      carrierName: input.carrierName,
      trackingRef: input.trackingRef,
      deliveryAttempts: input.deliveryAttempts,
      lines: input.lines,
    },
    { actorUserId: session.user.id },
  );
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  revalidatePath(`/admin/orders/${input.orderId}`);
  const message = input.kind === "shipment" ? "Retour d'expédition enregistré." : "Retour créé.";
  return { ok: true, message, id: res.data.returnId };
}

export async function receiveReturnAction(returnId: string, orderId: string): Promise<ActionState> {
  const session = await requirePermissionAny(RETURN_MANAGE_GRANTS);
  const res = await workflows.order.receiveReturn({ returnId }, { actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  revalidatePath(`/admin/orders/${orderId}`);
  // A « Retour d'expédition » receive also cancels the order — say so.
  const base = `Retour reçu — ${res.data.restocked} ligne(s) réintégrée(s) au stock.`;
  const message = res.data.cancelledOrder ? `${base} Commande annulée (non livrée).` : base;
  return { ok: true, message };
}

export async function rejectReturnAction(returnId: string, orderId: string): Promise<ActionState> {
  const session = await requirePermissionAny(RETURN_MANAGE_GRANTS);
  const res = await workflows.order.rejectReturn({ returnId }, { actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, message: "Retour rejeté." };
}

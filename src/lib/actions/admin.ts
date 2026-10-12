"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
// Imported directly (like newsletter-unsubscribe's workflow) rather than via the
// `workflows` registry — register it as `workflows.customer.setPromoOptOut`
// when that file is next touched.
import { setCustomerPromoOptOutWorkflow } from "@/workflows/customer/set-promo-opt-out";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";

/**
 * Admin sets whether a customer is EXCLUDED from public promotions
 * (customer_profiles.promo_opt_out). This is an ADMIN decision — the eligibility
 * engine suppresses public promos for excluded customers (targeted promos still
 * apply). There is no customer self-service for this; the admin controls promo
 * applicability from BOTH the Promotions tab (targeting) and here (per-client).
 */
export async function setCustomerPromoOptOutAction(input: {
  profileId: string;
  optOut: boolean;
}): Promise<ActionState> {
  const session = await requirePermission("customers", "update");
  if (!/^[0-9a-f-]{36}$/i.test(input.profileId)) {
    return { ok: false, error: "validation", message: "ID profil invalide." };
  }
  // The workflow checks the profile exists, writes, and emits the audited
  // customer.profile_updated (customer as userId, admin in the meta).
  const result = await setCustomerPromoOptOutWorkflow(
    { profileId: input.profileId, optOut: input.optOut },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath(`/admin/customers/${input.profileId}`);
  return {
    ok: true,
    message: input.optOut
      ? "Client exclu des promotions publiques."
      : "Client réintégré aux promotions publiques.",
  };
}

/**
 * Update admin-only notes on a customer profile. Notes are never sent to
 * the customer and only ever read by admin views.
 */
export async function updateCustomerNotesAction(input: {
  profileId: string;
  notes: string;
}): Promise<ActionState> {
  const session = await requirePermission('customers', 'update');
  if (!/^[0-9a-f-]{36}$/i.test(input.profileId)) {
    return { ok: false, error: "validation", message: "ID profil invalide." };
  }
  const result = await workflows.customer.updateNotes(
    { profileId: input.profileId, notes: input.notes },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath(`/admin/customers/${input.profileId}`);
  return { ok: true, message: "Notes mises à jour." };
}

/**
 * Admin-edit a customer's profile fields (notably the phone, which powers
 * guest↔client matching — customerService keeps phone_normalized in step).
 * Targeted by profileId so an admin can correct any client's details.
 */
export async function updateCustomerProfileAction(input: {
  profileId: string;
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  marketingOptIn?: boolean;
  /** 'YYYY-MM-DD' to set, null to clear, undefined to leave unchanged. */
  birthday?: string | null;
  /** Gender to set, null to clear, undefined to leave unchanged. An admin write
   *  never earns the customer the `provide_gender` reward (actor ≠ owner). */
  gender?: "female" | "male" | "other" | null;
}): Promise<ActionState> {
  const session = await requirePermission("customers", "update");
  const result = await workflows.customer.adminUpdateProfile(
    {
      profileId: input.profileId,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      marketingOptIn: input.marketingOptIn,
      birthday: input.birthday,
      gender: input.gender,
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  }
  revalidatePath(`/admin/customers/${input.profileId}`);
  revalidatePath("/admin/customers");
  return { ok: true, message: "Profil mis à jour." };
}

/**
 * Hard-delete audit entries older than `olderThanDays`. The Purge tab passes the
 * admin-configured window (`audit.retention_months × 30`) so the manual purge
 * matches the auto-purge cron exactly. Floored at 30 days so a stray value can't
 * wipe recent activity; the workflow re-validates [30, 3650].
 */
export async function purgeOldAuditEntriesAction(input: {
  olderThanDays: number;
}): Promise<ActionState & { deletedCount?: number }> {
  const session = await requirePermission('system_audit', 'manage');
  const days = Math.max(30, Math.floor(input.olderThanDays));
  const result = await workflows.audit.purge(
    { olderThanDays: days },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/system/audit");
  return {
    ok: true,
    message: `${result.data.deletedCount} entrée${result.data.deletedCount === 1 ? "" : "s"} purgée${result.data.deletedCount === 1 ? "" : "s"} (> ${days} jours).`,
    deletedCount: result.data.deletedCount,
  };
}

/**
 * Invite a user. The account is created immediately with a throwaway password;
 * the invitee receives an email with a link to choose their own. Used by both the
 * users panel (which may attach RBAC roles → an internal account) and the
 * customers panel (no roles → a plain customer, optional phone).
 */
export async function inviteUserAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission('users', 'create');
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const phone = String(formData.get("phone") ?? "").trim();
  // Assigning ≥1 RBAC role makes the invitee an internal account (no account-type
  // enum anymore). The workflow guards each role against the actor's own grants.
  const roleIds = formData.getAll("roleIds").map(String).filter(Boolean);

  const result = await workflows.auth.inviteUser(
    {
      email,
      firstName: String(formData.get("firstName") ?? ""),
      lastName: String(formData.get("lastName") ?? ""),
      phone: phone || undefined,
      roleIds,
    },
    { actorUserId: session.user.id },
  );

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      message: result.message,
      fieldErrors: result.fieldErrors,
    };
  }

  revalidatePath("/admin/users");
  revalidatePath("/admin/customers");
  return { ok: true, message: `Invitation envoyée à ${email}.` };
}

/**
 * Delete (archive) a customer profile. Orders and history are kept; if a
 * linked plain-customer auth account (no RBAC role) exists, it is disabled and
 * its sessions revoked — see the delete-customer workflow.
 */
export async function deleteCustomerAction(
  customerProfileId: string,
): Promise<ActionState> {
  const session = await requirePermission('customers', 'delete');
  if (!/^[0-9a-f-]{36}$/i.test(customerProfileId)) {
    return { ok: false, error: "validation", message: "ID profil invalide." };
  }
  const result = await workflows.customer.deleteCustomer(
    { customerProfileId },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/customers");
  return { ok: true, message: "Client supprimé (profil archivé)." };
}


export async function setDefaultAddressAction(input: {
  customerProfileId: string;
  addressId: string;
  kind: "billing" | "shipping";
}): Promise<ActionState> {
  const session = await requirePermission('customers', 'update');
  const result = await workflows.customer.setDefaultAddress(input, {
    actorUserId: session.user.id,
  });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath(`/admin/customers/${input.customerProfileId}`);
  return {
    ok: true,
    message: input.kind === "billing"
      ? "Adresse de facturation par défaut mise à jour."
      : "Adresse de livraison par défaut mise à jour.",
  };
}


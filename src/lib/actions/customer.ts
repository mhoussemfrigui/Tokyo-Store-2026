"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requireSession } from "@/lib/auth/session";
import { getAuth } from "@/lib/auth/server";
import { AUTH_POLICY } from "@/lib/auth/policy";
import { checkRateLimit } from "@/lib/rate-limit";
import { type ActionState } from "@/lib/actions/types";

/**
 * Self-serve "change my password" from the account settings. Verifies the
 * CURRENT password (Better Auth's `changePassword` rejects a wrong one) before
 * setting the new one, and revokes all OTHER sessions so a stale/leaked cookie
 * elsewhere is invalidated while this device stays signed in. Per-user throttle
 * stops the current-password field being brute-forced. The plaintext never
 * reaches a workflow event or a log.
 */
export async function changePasswordAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (!currentPassword || !newPassword) {
    return { ok: false, error: "validation", message: "Renseignez votre mot de passe actuel et le nouveau." };
  }
  if (newPassword.length < AUTH_POLICY.minPasswordLength) {
    return { ok: false, error: "validation", message: `Le nouveau mot de passe doit comporter au moins ${AUTH_POLICY.minPasswordLength} caractères.` };
  }
  if (newPassword.length > AUTH_POLICY.maxPasswordLength) {
    return { ok: false, error: "validation", message: "Mot de passe trop long." };
  }
  if (newPassword !== confirmPassword) {
    return { ok: false, error: "validation", message: "Le nouveau mot de passe et sa confirmation ne correspondent pas." };
  }
  if (newPassword === currentPassword) {
    return { ok: false, error: "validation", message: "Le nouveau mot de passe doit être différent de l'actuel." };
  }

  const rl = await checkRateLimit({ bucket: `pwchange:user:${session.user.id}`, max: 5, windowSeconds: 60 });
  if (!rl.ok) {
    return { ok: false, error: "rate_limited", message: "Trop de tentatives — réessayez plus tard." };
  }

  try {
    const auth = await getAuth();
    await auth.api.changePassword({
      headers: await headers(),
      body: { currentPassword, newPassword, revokeOtherSessions: true },
    });
  } catch (err) {
    // Better Auth throws on a wrong current password (and on policy failures the
    // pre-checks above already caught). Log so a genuine infra error isn't
    // invisible, but stay generic to the user — don't confirm which field failed.
    console.error("[changePassword] failed", err);
    return { ok: false, error: "invalid", message: "Impossible de changer le mot de passe — vérifiez votre mot de passe actuel." };
  }
  return { ok: true, message: "Mot de passe mis à jour." };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Self-serve "change my email". Better Auth (`user.changeEmail`) sends a
 * confirmation to the CURRENT address — the email only changes after that link
 * is clicked — so a hijacked session can't move the address without the current
 * mailbox. Throttled per user; the new address re-enters email verification.
 */
export async function changeEmailAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const newEmail = String(formData.get("newEmail") ?? "").trim().toLowerCase();

  if (!EMAIL_RE.test(newEmail) || newEmail.length > 254) {
    return { ok: false, error: "validation", message: "Adresse email invalide." };
  }
  if (newEmail === session.user.email.toLowerCase()) {
    return { ok: false, error: "validation", message: "C'est déjà votre adresse actuelle." };
  }

  const rl = await checkRateLimit({ bucket: `emailchange:user:${session.user.id}`, max: 5, windowSeconds: 60 });
  if (!rl.ok) {
    return { ok: false, error: "rate_limited", message: "Trop de tentatives — réessayez plus tard." };
  }

  try {
    const auth = await getAuth();
    await auth.api.changeEmail({
      headers: await headers(),
      body: { newEmail, callbackURL: "/account" },
    });
  } catch (err) {
    // Better Auth throws when the new address is already in use (and on other
    // policy failures). Stay generic — don't confirm whether an email exists.
    console.error("[changeEmail] failed", err);
    return { ok: false, error: "invalid", message: "Impossible de changer l'email — il est peut-être déjà utilisé." };
  }
  return {
    ok: true,
    message: "Un lien de confirmation a été envoyé à votre adresse actuelle. Cliquez-le pour appliquer le changement.",
  };
}

export async function updateProfileAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const result = await workflows.customer.updateProfile(
    {
      firstName: optionalString(formData, "firstName"),
      lastName: optionalString(formData, "lastName"),
      phone: optionalString(formData, "phone"),
      // The profile form ALWAYS renders this checkbox, so an absent value means
      // the user unchecked it → explicit opt-OUT (false), not "field omitted".
      // (HTML omits unchecked checkboxes from FormData; mapping null→undefined
      // here made opting out impossible — the workflow skips undefined fields.)
      marketingOptIn: formData.get("marketingOptIn") === "on",
      // Birthday is always present in the form; an empty value CLEARS it (null),
      // so use a nullable extractor (optionalString collapses empty → undefined,
      // which would make clearing impossible).
      birthday: nullableField(formData, "birthday"),
      // Gender: the select always posts, empty CLEARS it (null). The workflow's
      // enum re-validates, so a bogus value (never from the select) is a clean
      // field error. Providing it earns the customer the `provide_gender` reward.
      gender: nullableField(formData, "gender") as "female" | "male" | "other" | null,
    },
    { actorUserId: session.user.id },
  );

  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  }
  revalidatePath("/account");
  return { ok: true, message: "Profil mis à jour." };
}

export async function addAddressAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const result = await workflows.customer.addAddress(
    {
      label: optionalString(formData, "label"),
      fullName: String(formData.get("fullName") ?? ""),
      company: optionalString(formData, "company"),
      streetLine1: String(formData.get("streetLine1") ?? ""),
      streetLine2: optionalString(formData, "streetLine2"),
      city: String(formData.get("city") ?? ""),
      region: optionalString(formData, "region"),
      postalCode: optionalString(formData, "postalCode"),
      country: String(formData.get("country") ?? "TN"),
      phone: optionalString(formData, "phone"),
      // Storefront only manages the SHIPPING default; billing defaults are an
      // admin-only concern (handled by the workflow, never posted from here).
      setAsDefaultShipping: formData.get("setAsDefaultShipping") === "on",
    },
    { actorUserId: session.user.id },
  );

  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  }
  revalidatePath("/account");
  return { ok: true, message: "Adresse ajoutée." };
}

/**
 * Checkout variant of {@link addAddressAction}: takes a plain object (not
 * FormData) and RETURNS the new address id (as `id`) so the checkout can add
 * the address to its local list and select it for the order without a full
 * page refetch.
 */
export async function createAddressAction(input: {
  label?: string;
  fullName: string;
  streetLine1: string;
  city: string;
  region?: string;
  postalCode?: string;
  phone?: string;
  setAsDefaultShipping?: boolean;
}): Promise<ActionState> {
  const session = await requireSession();
  const result = await workflows.customer.addAddress(
    {
      label: input.label,
      fullName: input.fullName,
      streetLine1: input.streetLine1,
      city: input.city,
      region: input.region,
      postalCode: input.postalCode,
      country: "TN",
      phone: input.phone,
      setAsDefaultShipping: input.setAsDefaultShipping ?? false,
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  }
  revalidatePath("/account");
  return { ok: true, message: "Adresse ajoutée.", id: result.data.addressId };
}

/**
 * Checkout variant of {@link updateAddressAction}: object args (not FormData)
 * so the inline checkout edit form can call it directly and patch its local
 * list from the values it already holds.
 */
export async function editAddressAction(input: {
  addressId: string;
  label?: string;
  fullName?: string;
  streetLine1?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  phone?: string;
  setAsDefaultShipping?: boolean;
}): Promise<ActionState> {
  const session = await requireSession();
  const result = await workflows.customer.updateAddress(
    {
      addressId: input.addressId,
      label: input.label,
      fullName: input.fullName,
      streetLine1: input.streetLine1,
      city: input.city,
      region: input.region,
      postalCode: input.postalCode,
      phone: input.phone,
      setAsDefaultShipping: input.setAsDefaultShipping,
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  }
  revalidatePath("/account");
  return { ok: true, message: "Adresse mise à jour." };
}

export async function deleteAddressAction(addressId: string): Promise<ActionState> {
  const session = await requireSession();
  const result = await workflows.customer.deleteAddress(
    { addressId },
    { actorUserId: session.user.id },
  );
  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message };
  }
  revalidatePath("/account");
  return { ok: true, message: "Adresse supprimée." };
}

export async function updateAddressAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const addressId = optionalString(formData, "addressId");
  if (!addressId) {
    return { ok: false, error: "validation", message: "Identifiant manquant." };
  }
  const result = await workflows.customer.updateAddress(
    {
      addressId,
      label: optionalString(formData, "label"),
      fullName: optionalString(formData, "fullName"),
      company: optionalString(formData, "company"),
      streetLine1: optionalString(formData, "streetLine1"),
      streetLine2: optionalString(formData, "streetLine2"),
      city: optionalString(formData, "city"),
      region: optionalString(formData, "region"),
      postalCode: optionalString(formData, "postalCode"),
      country: optionalString(formData, "country"),
      phone: optionalString(formData, "phone"),
      // Storefront only manages the SHIPPING default; billing defaults are an
      // admin-only concern (handled by the workflow, never posted from here).
      setAsDefaultShipping:
        formData.get("setAsDefaultShipping") === null
          ? undefined
          : formData.get("setAsDefaultShipping") === "on",
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  }
  revalidatePath("/account");
  return { ok: true, message: "Adresse mise à jour." };
}

/**
 * Convenience action to set a specific address as the default shipping
 * choice without going through the full update form. Used by the
 * "Définir par défaut" button in the account address list.
 */
export async function setDefaultShippingAddressAction(
  addressId: string,
): Promise<ActionState> {
  const session = await requireSession();
  const result = await workflows.customer.updateAddress(
    { addressId, setAsDefaultShipping: true },
    { actorUserId: session.user.id },
  );
  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message };
  }
  revalidatePath("/account");
  return { ok: true, message: "Adresse par défaut mise à jour." };
}

function optionalString(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  if (v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

/**
 * Like optionalString but distinguishes "field present but empty" (→ null, i.e.
 * clear the value) from "field absent" (→ undefined, leave unchanged). Used for
 * the birthday, where an empty input must actively clear a previously-set date.
 */
function nullableField(form: FormData, key: string): string | null | undefined {
  const v = form.get(key);
  if (v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : null;
}

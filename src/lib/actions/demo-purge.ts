"use server";

import { revalidatePath } from "next/cache";

import { requireSuperAdmin as requireSuperAdminGrant } from "@/lib/auth/super-admin";
import { checkRateLimit } from "@/lib/rate-limit";
import { dispatchEmail } from "@/modules/mailing/dispatch";
import { importJobService } from "@/modules/import";
import {
  createPurgeConfirmCode,
  consumePurgeConfirmCode,
  invalidatePurgeConfirmCode,
} from "@/lib/demo/purge-confirm";
import { isPurgeInProgress, beginPurge } from "@/lib/demo/purge-lock";
import { maskEmail } from "@/lib/format/mask-email";
import { runPurgeAndRelaunchDemo } from "@/workflows/demo/purge-relaunch";
import { type ActionState } from "@/lib/actions/types";

/**
 * Two-step, super-admin-gated, email-confirmed "purge everything + relaunch
 * demo" flow. requestDemoPurgeAction emails a one-time code to the acting
 * super-admin; confirmDemoPurgeAction verifies it then fires the (irreversible)
 * purge. Both require system_demo:manage AND the RBAC `*` wildcard (super-admin).
 */

/** Super-admin = system_demo:manage AND the RBAC `*` wildcard. Anything less →
 *  unauthorized. Shared gate (`@/lib/auth/super-admin`) — the demo `op=clear`
 *  route and the data-job cleanups use the same one. */
function requireSuperAdmin() {
  return requireSuperAdminGrant("system_demo", "manage");
}

export async function requestDemoPurgeAction(): Promise<ActionState & { emailMasked?: string }> {
  const gate = await requireSuperAdmin();
  if (!gate.ok) {
    return { ok: false, error: "forbidden", message: "Accès super-admin requis." };
  }
  const { session } = gate;
  const email = session.user.email;
  if (!email) {
    return { ok: false, error: "no_email", message: "Aucune adresse email sur votre compte." };
  }

  // Throttle code requests per super-admin (the code itself is single-use).
  const rl = await checkRateLimit({
    bucket: `demo-purge-req:${session.user.id}`,
    max: 3,
    windowSeconds: 600,
  });
  if (!rl.ok) {
    return { ok: false, error: "rate_limited", message: "Trop de demandes. Réessayez plus tard." };
  }

  const { code, expiresMinutes } = await createPurgeConfirmCode(session.user.id);
  const firstName = (session.user.name ?? "").trim().split(/\s+/)[0] || "Admin";
  const result = await dispatchEmail({
    key: "purge_confirmation",
    to: email,
    variables: { first_name: firstName, confirm_code: code, expires_minutes: expiresMinutes },
  });
  if (!result.sent && !result.queued) {
    // No code reached the operator → don't leave a live code dangling for 15 min.
    await invalidatePurgeConfirmCode(session.user.id);
    return {
      ok: false,
      error: "email_failed",
      message: "Impossible d'envoyer le code (vérifiez la configuration email).",
    };
  }
  const masked = maskEmail(email) || "votre adresse";
  return {
    ok: true,
    message: `Code de confirmation envoyé à ${masked} (valide ${expiresMinutes} min).`,
    emailMasked: masked,
  };
}

export async function confirmDemoPurgeAction(
  input: { code: string },
): Promise<ActionState> {
  const gate = await requireSuperAdmin();
  if (!gate.ok) {
    return { ok: false, error: "forbidden", message: "Accès super-admin requis." };
  }
  const { session } = gate;

  // Bound brute-force on the 6-digit code (single-use, 15-min, but cheap to guess).
  const rl = await checkRateLimit({
    bucket: `demo-purge-confirm:${session.user.id}`,
    max: 6,
    windowSeconds: 600,
  });
  if (!rl.ok) {
    return { ok: false, error: "rate_limited", message: "Trop de tentatives. Demandez un nouveau code." };
  }

  const valid = await consumePurgeConfirmCode(session.user.id, input.code);
  if (!valid) {
    return { ok: false, error: "bad_code", message: "Code invalide ou expiré. Demandez un nouveau code." };
  }

  // A running import/clean would make the relaunch's feed import silently skip.
  if (await importJobService.hasActive()) {
    return {
      ok: false,
      error: "busy",
      message: "Une tâche d'import/nettoyage est déjà en cours. Réessayez quand elle est terminée.",
    };
  }
  // Cluster-wide single-flight: refuse if another purge is mid-run.
  if (await isPurgeInProgress()) {
    return {
      ok: false,
      error: "busy",
      message: "Une réinitialisation est déjà en cours. Réessayez quand elle est terminée.",
    };
  }

  // Set the in-progress marker BEFORE firing so a concurrent purge/data-job is
  // refused during the runner's lockless destructive window (the runner clears
  // it in a finally; a hard crash leaves it as crash-evidence + auto-expires).
  await beginPurge();
  // Fire-and-forget — the Import-data panel polls the feed-import job it kicks.
  void runPurgeAndRelaunchDemo(session.user.id);
  revalidatePath("/admin/system/import-data");
  return {
    ok: true,
    message: "Purge lancée. Toutes les données sont supprimées puis la démo est rechargée.",
  };
}

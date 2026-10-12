"use server";

import { revalidatePath } from "next/cache";

import { bus } from "@/events/bus";
import { requirePermission } from "@/lib/auth/session";
import { apiKeyService } from "@/modules/api-key";
import { apiSettingsService } from "@/modules/api-settings/service";
import { normalizeScopes, scopesBeyondActor } from "@/lib/api-auth/scopes";
import { resolveUserPermissions } from "@/lib/rbac/authorize";
import { TOGGLEABLE_PUBLIC_IDS } from "@/lib/api-auth/route-catalog";
import { diffApiAccessSettings } from "@/lib/api-auth/access-settings-diff";
import { type ActionState } from "@/lib/actions/types";

const PATH = "/admin/system/api";

const DAY_MS = 86_400_000;
/** Allowed expiry presets (days). 0/absent = never. */
const EXPIRY_DAYS = new Set([30, 90, 180, 365]);

/**
 * Save the global API & webhooks toggles plus the per-route public set. Only
 * read routes are toggleable; the service drops any write/unknown id.
 *
 * The audit event carries the before → after values of ONLY the settings that
 * actually changed (kill-switch flips, routes opened / closed to the public),
 * and is not emitted at all for a no-op save.
 */
export async function saveApiTogglesAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_api", "update");

  const apiEnabled = formData.get("api.enabled") === "on";
  const webhooksEnabled = formData.get("webhooks.enabled") === "on";
  const outboundWebhooksEnabled = formData.get("webhooks.outbound_enabled") === "on";
  const publicRoutes = [...TOGGLEABLE_PUBLIC_IDS].filter(
    (id) => formData.get(`public.${id}`) === "on",
  );

  // Fresh (uncached) read of the stored state, for the audit diff.
  apiSettingsService.invalidate();
  const before = await apiSettingsService.get();

  await apiSettingsService.setApiEnabled(apiEnabled);
  await apiSettingsService.setWebhooksEnabled(webhooksEnabled);
  await apiSettingsService.setOutboundWebhooksEnabled(outboundWebhooksEnabled);
  await apiSettingsService.setPublicRoutes(publicRoutes);

  const change = diffApiAccessSettings(before, {
    apiEnabled,
    webhooksEnabled,
    outboundWebhooksEnabled,
    publicRoutes,
  });
  if (change) {
    await bus.emit("api.access_settings_updated", change, { actorUserId: session.user.id });
  }

  revalidatePath(PATH);
  return { ok: true, message: "Réglages d'accès enregistrés." };
}

/**
 * Create an API key. The plaintext secret is returned ONCE in the action result
 * for the UI to display; it is never stored or recoverable afterwards.
 *
 * A key's writes run the admin workflows attributed to its creator — so the
 * requested scopes are BOUNDED by the creator's own live permissions (scope →
 * RBAC map in `@/lib/api-auth/scopes`): a `system_api:create` delegate can't
 * mint a `full` / `orders:write` key it couldn't exercise in the dashboard.
 * requireApiKey re-checks the same bound at REQUEST time, so after a later role
 * reduction the key's out-of-grant scopes answer 403 (the key card shows its
 * creator, to revoke it outright).
 */
export type CreateApiKeyState = ActionState & { plaintext?: string; keyName?: string };

export async function createApiKeyAction(
  _prev: CreateApiKeyState | null,
  formData: FormData,
): Promise<CreateApiKeyState> {
  const session = await requirePermission("system_api", "create");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "validation", message: "Donnez un nom à la clé." };
  if (name.length > 80) {
    return { ok: false, error: "validation", message: "Nom trop long (80 caractères max)." };
  }

  const scopes = normalizeScopes(formData.getAll("scope").map((s) => String(s)));
  if (scopes.length === 0) {
    return { ok: false, error: "validation", message: "Sélectionnez au moins une permission." };
  }
  const beyond = scopesBeyondActor(await resolveUserPermissions(session.user.id), scopes);
  if (beyond.length > 0) {
    return {
      ok: false,
      error: "forbidden",
      message: `Vous ne pouvez pas accorder ces portées, qui dépassent vos propres droits : ${beyond.join(", ")}.`,
    };
  }

  const rawDays = Number(formData.get("expiresInDays") ?? "");
  const expiresAt = EXPIRY_DAYS.has(rawDays) ? new Date(Date.now() + rawDays * DAY_MS) : null;

  const { row, plaintext } = await apiKeyService.create({
    name,
    scopes,
    expiresAt,
    createdBy: session.user.id,
  });

  await bus.emit(
    "api_key.created",
    { keyId: row.id, label: row.name, scopes },
    { actorUserId: session.user.id },
  );

  revalidatePath(PATH);
  return { ok: true, message: `Clé « ${row.name} » créée.`, plaintext, keyName: row.name };
}

/** Revoke a key (idempotent). */
export async function revokeApiKeyAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_api", "delete");

  const keyId = String(formData.get("keyId") ?? "").trim();
  if (!keyId) return { ok: false, error: "validation", message: "Clé introuvable." };

  await apiKeyService.revoke(keyId);

  await bus.emit("api_key.revoked", { keyId }, { actorUserId: session.user.id });

  revalidatePath(PATH);
  return { ok: true, message: "Clé révoquée." };
}

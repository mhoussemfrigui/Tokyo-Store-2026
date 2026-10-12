"use server";

import { revalidatePath } from "next/cache";

import { bus } from "@/events/bus";
import { requirePermission } from "@/lib/auth/session";
import { isSuperAdmin } from "@/lib/auth/super-admin";
import { webhookEndpointService } from "@/modules/webhook-endpoints";
import { isEncryptionConfigured } from "@/lib/crypto/secrets";
import { isSecuritySensitiveEvent } from "@/events/subscribers/dispatch-webhooks";
import { EVENT_CATALOG } from "@/lib/api-auth/event-catalog";
import { type ActionState } from "@/lib/actions/types";

const PATH = "/admin/system/api";

/** The set of valid event names an endpoint may subscribe to (+ the "*" wildcard). */
const VALID_EVENTS = new Set<string>(["*", ...EVENT_CATALOG.flatMap((d) => d.events)]);

export type CreateWebhookEndpointState = ActionState & { secret?: string; endpointName?: string };

/**
 * Create an outbound webhook endpoint. The signing secret is returned ONCE for
 * the UI to display; only its encrypted form is stored. Permission: system_api:create.
 */
export async function createWebhookEndpointAction(
  _prev: CreateWebhookEndpointState | null,
  formData: FormData,
): Promise<CreateWebhookEndpointState> {
  const session = await requirePermission("system_api", "create");

  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 120) {
    return { ok: false, error: "validation", message: "Donnez un nom (120 caractères max)." };
  }
  const url = String(formData.get("url") ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "validation", message: "URL invalide." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "validation", message: "L'URL doit être http(s)." };
  }
  // Refuse cleartext http:// for any NON-loopback (public) host. The SSRF layer only
  // ever delivers to public IPs, and the HMAC signature gives integrity, not
  // confidentiality — so a public http endpoint would ship event payloads (order /
  // customer data) over the wire in cleartext. https only; loopback stays http for
  // local dev/testing.
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const isLoopback =
      host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
    if (!isLoopback) {
      return {
        ok: false,
        error: "validation",
        message: "Utilisez https:// — le http en clair exposerait les données des évènements (seul un hôte local peut rester en http).",
      };
    }
  }

  // Selected events, or the "*" wildcard = all. Drop unknown names.
  const wildcard = formData.get("allEvents") === "on";
  const selected = wildcard
    ? ["*"]
    : [...new Set(formData.getAll("event").map(String).filter((e) => VALID_EVENTS.has(e)))];
  if (selected.length === 0) {
    return { ok: false, error: "validation", message: "Sélectionnez au moins un évènement (ou « tous »)." };
  }
  // Security/PII events (auth, rbac, api_key, user, data) route sensitive
  // telemetry off-site. The "*" wildcard subscription already EXCLUDES them at
  // delivery (dispatch-webhooks), but a BY-NAME subscription would deliver them —
  // an exfiltration surface. So subscribing an endpoint to any security event is
  // OWNER-ONLY (super-admin): a system_api:create integration manager can wire
  // business events but not security ones. (isSecuritySensitiveEvent("*") is false,
  // so the wildcard stays available to any system_api:create.)
  if (selected.some(isSecuritySensitiveEvent) && !(await isSuperAdmin(session.user.id))) {
    return {
      ok: false,
      error: "forbidden",
      message:
        "Les évènements de sécurité (auth, rbac, clés API, utilisateurs, données) nécessitent un accès propriétaire (super-admin).",
    };
  }
  const description = String(formData.get("description") ?? "").trim() || null;

  // The signing secret is encrypted at rest — refuse cleanly (not a thrown 500)
  // if the encryption key isn't provisioned yet, mirroring the payment/mailing
  // credential actions. In prod PAYMENT_ENCRYPTION_KEY is auto-provisioned at
  // container start (init-secrets.ts); this guards a misconfigured environment.
  if (!isEncryptionConfigured()) {
    return {
      ok: false,
      error: "config",
      message:
        "Chiffrement non configuré : définissez PAYMENT_ENCRYPTION_KEY (auto-provisionné au démarrage du conteneur) avant de créer un endpoint.",
    };
  }

  const { row, secret } = await webhookEndpointService.createEndpoint({
    name,
    url,
    eventTypes: selected,
    description,
    createdBy: session.user.id,
  });

  // Audit WHERE the data goes: the host only — a path/query/userinfo may embed a
  // receiver-side token, so the full URL never enters the payload.
  await bus.emit(
    "webhook_endpoint.created",
    { endpointId: row.id, name: row.name, eventTypes: selected, host: parsed.host },
    { actorUserId: session.user.id },
  );

  revalidatePath(PATH);
  return { ok: true, message: `Endpoint « ${row.name} » créé.`, secret, endpointName: row.name };
}

/** Pause / resume an endpoint (no deliveries enqueued while paused). */
export async function toggleWebhookEndpointAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_api", "update");
  const endpointId = String(formData.get("endpointId") ?? "").trim();
  const active = formData.get("active") === "on";
  if (!endpointId) return { ok: false, error: "validation", message: "Endpoint introuvable." };

  await webhookEndpointService.setActive(endpointId, active);
  await bus.emit(
    "webhook_endpoint.updated",
    { endpointId, active },
    { actorUserId: session.user.id },
  );
  revalidatePath(PATH);
  return { ok: true, message: active ? "Endpoint activé." : "Endpoint en pause." };
}

/** Permanently revoke an endpoint. */
export async function revokeWebhookEndpointAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_api", "delete");
  const endpointId = String(formData.get("endpointId") ?? "").trim();
  if (!endpointId) return { ok: false, error: "validation", message: "Endpoint introuvable." };

  await webhookEndpointService.revoke(endpointId);
  await bus.emit("webhook_endpoint.revoked", { endpointId }, { actorUserId: session.user.id });
  revalidatePath(PATH);
  return { ok: true, message: "Endpoint révoqué." };
}

/** Re-queue a delivery for another attempt (admin "redeliver"). */
export async function redeliverWebhookAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  await requirePermission("system_api", "update");
  const deliveryId = String(formData.get("deliveryId") ?? "").trim();
  if (!deliveryId) return { ok: false, error: "validation", message: "Livraison introuvable." };

  const ok = await webhookEndpointService.redeliver(deliveryId);
  revalidatePath(PATH);
  return ok
    ? { ok: true, message: "Livraison reprogrammée (prochain passage du cron)." }
    : { ok: false, error: "not_found", message: "Livraison introuvable." };
}

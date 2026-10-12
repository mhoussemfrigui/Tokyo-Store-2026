/**
 * PURE before/after diff of the Système › API access settings — NO
 * "server-only", NO DB import, so it is unit-testable (audit-target.test.ts).
 *
 * Shared by `saveApiTogglesAction` (builds the `api.access_settings_updated`
 * payload and emits ONLY when something really changed) and the audit-trail
 * subscriber (renders the French one-line summary). The payload carries the
 * values themselves, so an investigator can tell from the audit row that the
 * external-API kill-switch was turned off or which read routes were opened to
 * the public — not just that "the settings were saved".
 */
import type { EventPayload } from "@/events/types";

/** The subset of ApiSettings (modules/api-settings) the diff looks at. */
export type ApiAccessSnapshot = {
  apiEnabled: boolean;
  webhooksEnabled: boolean;
  outboundWebhooksEnabled: boolean;
  publicRoutes: readonly string[];
};

export type ApiAccessChange = EventPayload<"api.access_settings_updated">;

/**
 * Diff two snapshots. Returns null when nothing changed (the caller then emits
 * no event); otherwise only the changed settings are present, each boolean as
 * `{ from, to }` and the public-route set as sorted added/removed id lists.
 */
export function diffApiAccessSettings(
  before: ApiAccessSnapshot,
  after: ApiAccessSnapshot,
): ApiAccessChange | null {
  const changedFields: string[] = [];
  const change: ApiAccessChange = {};

  if (before.apiEnabled !== after.apiEnabled) {
    changedFields.push("api.enabled");
    change.apiEnabled = { from: before.apiEnabled, to: after.apiEnabled };
  }
  if (before.webhooksEnabled !== after.webhooksEnabled) {
    changedFields.push("webhooks.enabled");
    change.webhooksEnabled = { from: before.webhooksEnabled, to: after.webhooksEnabled };
  }
  if (before.outboundWebhooksEnabled !== after.outboundWebhooksEnabled) {
    changedFields.push("webhooks.outbound_enabled");
    change.outboundEnabled = {
      from: before.outboundWebhooksEnabled,
      to: after.outboundWebhooksEnabled,
    };
  }

  const beforeRoutes = new Set(before.publicRoutes);
  const afterRoutes = new Set(after.publicRoutes);
  const added = [...afterRoutes].filter((id) => !beforeRoutes.has(id)).sort();
  const removed = [...beforeRoutes].filter((id) => !afterRoutes.has(id)).sort();
  if (added.length > 0 || removed.length > 0) {
    changedFields.push("publicRoutes");
    if (added.length > 0) change.publicRoutesAdded = added;
    if (removed.length > 0) change.publicRoutesRemoved = removed;
  }

  if (changedFields.length === 0) return null;
  return { changedFields, ...change };
}

/** Up to 3 ids verbatim, then a "+N" tail — keeps the summary a one-liner. */
function listIds(ids: readonly string[]): string {
  const head = ids.slice(0, 3).join(", ");
  return ids.length > 3 ? `${head} +${ids.length - 3}` : head;
}

/** French one-line audit summary for an `api.access_settings_updated` payload. */
export function summarizeApiAccessChange(p: ApiAccessChange): string {
  const parts: string[] = [];
  if (p.apiEnabled) parts.push(`API externe ${p.apiEnabled.to ? "activée" : "désactivée"}`);
  if (p.webhooksEnabled) {
    parts.push(`webhooks entrants ${p.webhooksEnabled.to ? "activés" : "désactivés"}`);
  }
  if (p.outboundEnabled) {
    parts.push(`webhooks sortants ${p.outboundEnabled.to ? "activés" : "désactivés"}`);
  }
  if (p.publicRoutesAdded?.length) {
    parts.push(`route(s) rendue(s) publique(s) : ${listIds(p.publicRoutesAdded)}`);
  }
  if (p.publicRoutesRemoved?.length) {
    parts.push(`route(s) repassée(s) sous clé : ${listIds(p.publicRoutesRemoved)}`);
  }
  // A payload without values (never emitted by the diff) keeps the generic wording.
  return parts.length > 0
    ? `Accès API/webhooks — ${parts.join(" ; ")}`
    : "Réglages d'accès API/webhooks mis à jour";
}

import "server-only";

import { bus } from "@/events/bus";
import { dispatchEmail } from "@/modules/mailing/dispatch";
import { escapeHtml } from "@/modules/mailing/render";
import { effectiveAdminEmails } from "@/lib/rbac/admin-recipients";
import { STORE_TIME_ZONE } from "@/lib/time/store-tz";
import { BREACH_LABELS, type Breach, type BreachMetric, type PerfConfig } from "./perf-config";
import type { RuntimeSample } from "./runtime-metrics";

/**
 * Performance-alert dispatch — kept OUT of runtime-metrics.ts so the sampler
 * stays lean and free of the bus/mailing import graph. Two effects per alert:
 *   1. ALWAYS emit a bus event → the wildcard audit subscriber persists it (the
 *      "nothing unmonitored" pattern) + the structured logger prints it.
 *   2. OPTIONALLY email (account/transactional category, never consent-gated)
 *      when `perf.alert_email_enabled` is on. Recipients come from
 *      `perf.alert_recipients`, falling back to the active admin accounts.
 *
 * Both effects are best-effort; the caller already catches and logs.
 */

/** Configured recipients, or the effective admins as a fallback (deduped + capped
 *  at 20 to match the configured-list invariant in parseRecipients). */
async function resolveRecipients(cfg: PerfConfig): Promise<string[]> {
  if (cfg.alertRecipients.length > 0) return cfg.alertRecipients;
  return effectiveAdminEmails();
}

/** Send the alert email to each recipient SEPARATELY so addresses aren't
 *  exposed to each other in a shared To: header (no BCC plumbing exists). */
async function sendToEach(to: string[], subject: string, html: string): Promise<void> {
  await Promise.all(
    to.map((addr) =>
      dispatchEmail({ composed: { subject, html, category: "account" }, to: addr }).catch(
        () => {},
      ),
    ),
  );
}

function fmtValue(metric: BreachMetric, value: number | null): string {
  if (value == null) return "—";
  if (metric === "ram" || metric === "cpu") return `${value} %`;
  return `${value} ms`;
}

/** A breach sustained past the debounce + cooldown → notify. */
export async function raisePerfAlert(
  breach: Breach,
  sample: RuntimeSample,
  cfg: PerfConfig,
  instanceId: string,
): Promise<void> {
  await bus
    .emit(
      "perf.alert.raised",
      {
        metric: breach.metric,
        value: breach.value,
        threshold: breach.threshold,
        instanceId,
      },
      { actorUserId: null },
    )
    .catch(() => {});

  if (!cfg.alertEmailEnabled) return;
  const to = await resolveRecipients(cfg);
  if (to.length === 0) return;

  const label = BREACH_LABELS[breach.metric];
  const when = new Date(sample.at).toLocaleString("fr-FR", { timeZone: STORE_TIME_ZONE });
  const subject = `[Tokyo Store] Alerte performance — ${label}`;
  const html =
    `<p>Une métrique de performance a dépassé son seuil d'alerte sur l'instance ` +
    `<strong>${escapeHtml(instanceId)}</strong>.</p>` +
    `<table style="border-collapse:collapse;font-size:14px;">` +
    `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Métrique</td><td><strong>${escapeHtml(label)}</strong></td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Valeur</td><td>${escapeHtml(fmtValue(breach.metric, breach.value))}</td></tr>` +
    (breach.threshold != null
      ? `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Seuil</td><td>${escapeHtml(fmtValue(breach.metric, breach.threshold))}</td></tr>`
      : "") +
    `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Heure</td><td>${escapeHtml(when)}</td></tr>` +
    `</table>` +
    `<p style="font-size:12px;color:#6b7280;">Mesure propre à une instance Node. ` +
    `Consultez Système → Performance pour le détail et les seuils.</p>`;

  await sendToEach(to, subject, html);
}

/** A previously-alerting metric returned below threshold → recovery notice. */
export async function recoverPerfAlert(
  metric: BreachMetric,
  sample: RuntimeSample,
  cfg: PerfConfig,
  instanceId: string,
): Promise<void> {
  await bus
    .emit("perf.alert.recovered", { metric, instanceId }, { actorUserId: null })
    .catch(() => {});

  if (!cfg.alertEmailEnabled) return;
  const to = await resolveRecipients(cfg);
  if (to.length === 0) return;

  const label = BREACH_LABELS[metric];
  const when = new Date(sample.at).toLocaleString("fr-FR", { timeZone: STORE_TIME_ZONE });
  const subject = `[Tokyo Store] Rétabli — ${label}`;
  const html =
    `<p>La métrique <strong>${escapeHtml(label)}</strong> est repassée sous son seuil ` +
    `sur l'instance <strong>${escapeHtml(instanceId)}</strong> (${escapeHtml(when)}).</p>`;

  await sendToEach(to, subject, html);
}

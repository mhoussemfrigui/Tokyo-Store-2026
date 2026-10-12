import "server-only";

import { dispatchEmail } from "@/modules/mailing/dispatch";
import { escapeHtml } from "@/modules/mailing/render";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { resolveLowStockConfig } from "@/lib/inventory/low-stock";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { effectiveAdminEmails } from "@/lib/rbac/admin-recipients";
import { stockTransferService } from "@/modules/stock-transfer";
import { bus } from "../bus";

/**
 * Transfer notification (staff). When an order can't be filled from the depot the
 * auto-request raises a store→depot transfer that NOBODY is watching — so email
 * the ops team so the source store prepares + ships it. Only AUTO (order-driven)
 * requests notify; a MANUALLY created transfer's author is already in the UI.
 * Recipients reuse the low-stock alert list (or active admins). Transactional
 * (staff, category "account"). Best-effort.
 */

/** Configured stock-alert recipients, else the effective admins (deduped, capped). */
async function resolveRecipients(): Promise<string[]> {
  const cfg = resolveLowStockConfig(await getSettingsMap());
  if (cfg.recipients.length > 0) return cfg.recipients.slice(0, 20);
  return effectiveAdminEmails();
}

/** One email per recipient (no BCC — addresses aren't exposed to each other). */
async function sendToEach(to: string[], subject: string, html: string): Promise<void> {
  await Promise.all(
    to.map((addr) =>
      dispatchEmail({ composed: { subject, html, category: "account" }, to: addr }).catch(() => {}),
    ),
  );
}

export function registerTransferNotifySubscriber() {
  bus.on("stock.transfer.requested", async ({ payload }) => {
    try {
      if (payload.source !== "auto") return; // only order-driven requests notify
      const to = await resolveRecipients();
      if (to.length === 0) return;
      const detail = await stockTransferService.getById(payload.transferId);
      if (!detail) return;

      const origin = await resolvePublicOrigin().catch(() => "");
      const link = origin ? `${origin}/admin/catalog/stock?tab=transferts` : "";
      const lines = detail.items
        .map(
          (it) =>
            `<li>${escapeHtml(it.productName)}${
              it.variantLabel ? ` — ${escapeHtml(it.variantLabel)}` : ""
            } × <strong>${it.qty}</strong></li>`,
        )
        .join("");
      const subject = `[Tokyo Store] Transfert requis — TR-${payload.ref}`;
      const html =
        `<p>Une commande nécessite un réapprovisionnement du dépôt par transfert.</p>` +
        `<p><strong>${escapeHtml(detail.fromName ?? "—")}</strong> → <strong>${escapeHtml(
          detail.toName ?? "—",
        )}</strong> (TR-${payload.ref})</p>` +
        `<ul>${lines}</ul>` +
        (link
          ? `<p><a href="${escapeHtml(link)}">Ouvrir les transferts</a> pour l'accepter, l'expédier puis le réceptionner.</p>`
          : `<p>Ouvrez Catalogue → Stock → Transferts pour le traiter.</p>`);
      await sendToEach(to, subject, html);
    } catch (err) {
      console.error("[transfer] notify failed", err);
    }
  });
}

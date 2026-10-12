import "server-only";

import { dispatchEmail } from "@/modules/mailing/dispatch";
import { escapeHtml } from "@/modules/mailing/render";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { resolveLowStockConfig, type LowStockConfig } from "@/lib/inventory/low-stock";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { effectiveAdminEmails } from "@/lib/rbac/admin-recipients";
import { bus } from "../bus";

/**
 * Low-stock OPERATOR alert (L10). Listens for the two crossing events emitted
 * when a sale (place-order), an order edit or an /api/stock adjustment takes a
 * TRACKED line to/under the configured threshold (`product.stock_low`) or to
 * zero (`product.stock_depleted`) and emails the operators so they can reorder.
 *
 * Transactional (category "account", never consent-gated) — these go to staff,
 * not customers. Recipients come from `stock.alert_recipients`, falling back to
 * every active admin (mirrors the perf-alert recipient model). The emit side is
 * already gated on `stock.alert_enabled`; the re-check here is belt-and-braces
 * and protects any future emitter. Best-effort: a failure is logged, never
 * thrown (the bus fan-out is non-blocking anyway).
 */

/** Configured recipients, or the effective admins as a fallback (deduped, capped 20).
 *  `effectiveAdminEmails` is React-cache()'d so a multi-crossing order (several
 *  events for one order) issues the fallback lookup ONCE per request. */
async function resolveRecipients(cfg: LowStockConfig): Promise<string[]> {
  if (cfg.recipients.length > 0) return cfg.recipients.slice(0, 20);
  return effectiveAdminEmails();
}

/** One email per recipient so addresses aren't exposed to each other (no BCC). */
async function sendToEach(to: string[], subject: string, html: string): Promise<void> {
  await Promise.all(
    to.map((addr) =>
      dispatchEmail({ composed: { subject, html, category: "account" }, to: addr }).catch(() => {}),
    ),
  );
}

function productLine(name: string, variantLabel: string | null, sku: string | null): string {
  const variant = variantLabel ? ` — ${escapeHtml(variantLabel)}` : "";
  const ref = sku ? ` <span style="color:#6b7280;">(${escapeHtml(sku)})</span>` : "";
  return `<strong>${escapeHtml(name)}</strong>${variant}${ref}`;
}

export function registerLowStockSubscriber() {
  bus.on("product.stock_depleted", async ({ payload }) => {
    try {
      const cfg = resolveLowStockConfig(await getSettingsMap());
      if (!cfg.enabled) return;
      const to = await resolveRecipients(cfg);
      if (to.length === 0) return;

      const origin = await resolvePublicOrigin().catch(() => "");
      const link = origin ? `${origin}/admin/catalog/products/${payload.productId}` : "";
      const subject = `[Tokyo Store] Rupture de stock — ${payload.name}`;
      const html =
        `<p>Un mouvement de stock (vente ou ajustement) vient d'épuiser le stock d'un article (quantité <strong>0</strong>).</p>` +
        `<p>${productLine(payload.name, payload.variantLabel, payload.sku)}</p>` +
        (link
          ? `<p><a href="${escapeHtml(link)}">Ouvrir la fiche produit</a> pour réapprovisionner.</p>`
          : `<p>Réapprovisionnez la fiche produit dans l'admin (Catalogue → Produits).</p>`);
      await sendToEach(to, subject, html);
    } catch (err) {
      console.error("[low-stock] depleted alert failed", err);
    }
  });

  bus.on("product.stock_low", async ({ payload }) => {
    try {
      const cfg = resolveLowStockConfig(await getSettingsMap());
      if (!cfg.enabled) return;
      const to = await resolveRecipients(cfg);
      if (to.length === 0) return;

      const origin = await resolvePublicOrigin().catch(() => "");
      const link = origin ? `${origin}/admin/catalog/products/${payload.productId}` : "";
      const subject = `[Tokyo Store] Stock faible — ${payload.name}`;
      const html =
        `<p>Un mouvement de stock (vente ou ajustement) a fait passer un article au niveau de stock faible ` +
        `(seuil <strong>${escapeHtml(String(payload.threshold))}</strong>).</p>` +
        `<p>${productLine(payload.name, payload.variantLabel, payload.sku)}</p>` +
        `<p>Stock restant : <strong>${escapeHtml(String(payload.currentQty))}</strong>.</p>` +
        (link
          ? `<p><a href="${escapeHtml(link)}">Ouvrir la fiche produit</a> pour réapprovisionner.</p>`
          : `<p>Réapprovisionnez la fiche produit dans l'admin (Catalogue → Produits).</p>`);
      await sendToEach(to, subject, html);
    } catch (err) {
      console.error("[low-stock] low alert failed", err);
    }
  });
}

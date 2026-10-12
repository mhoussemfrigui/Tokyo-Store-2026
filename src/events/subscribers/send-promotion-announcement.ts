import "server-only";

import { BRAND_PRIMARY, dispatchEmail, isFlowEnabled, mailingSendsService } from "@/modules/mailing";
import { promotionService } from "@/modules/promotion";
import { resolvePromotionAudience } from "@/lib/mailing/audience";
import { marketingGateSummary, marketingSendBlocked } from "@/lib/mailing/automation-gate";
import { describePromoDiscount } from "@/lib/mailing/promo-describe";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { formatStoreDateTime } from "@/lib/time/store-tz";
import { bus } from "../bus";

const FLOW = "promotion_announcement";
/** mailing_sends ledger key (one row per promotion × recipient). */
const DEDUP_FLOW = "promo_announce";

/**
 * Promotion-announcement blast for `promotion.announce_requested` — fired ONLY by
 * the « Annoncer par email » checkbox when a promotion is CREATED (there is no
 * re-announce button). Re-checks the promo is LIVE: a scheduled / inactive /
 * ended promo is skipped (logged) — the create form disables the checkbox in
 * that case so the operator isn't misled. Resolves its marketing audience
 * (public → opt-in minus public-promo opt-outs; targeted → matching opt-in
 * customers, kept in step with coupon eligibility), and enqueues one email per
 * recipient — idempotent per (promotion, recipient) via `mailing_sends`, so a
 * duplicate event can't double-mail anyone.
 *
 * ⚠️ STUCK-BUTTON RULE (bus.emit awaits subscribers): the fan-out is up to
 * AUDIENCE_CAP serial claim + enqueue round-trips, so it is DETACHED — the admin
 * « Créer la promotion » request returns at once instead of hanging for the whole
 * blast. Best-effort like every bus side effect: errors are logged, and a process
 * restart mid-loop drops the not-yet-enqueued tail. (Batched render-once +
 * single-INSERT enqueue, like `enqueueCampaign`, is a deferred follow-up.)
 */
export function registerPromotionAnnouncementSubscriber() {
  bus.on("promotion.announce_requested", ({ payload }) => {
    void runPromotionAnnounceBlast(payload.promotionId).catch((err) =>
      console.error("[events] send-promotion-announcement failed", err),
    );
  });
}

/**
 * The reusable announcement blast — shared by THREE callers:
 *   - the `promotion.announce_requested` subscriber (immediate create-time announce,
 *     fired DETACHED so the create request doesn't hang on the whole fan-out);
 *   - the scheduled-announce cron SWEEP (`runPromotionAnnounceSweep`), which AWAITS it
 *     inside the bounded job so the run is recorded;
 *   - the manual « Annoncer maintenant » action.
 * Idempotent per (promotion, recipient) via `mailing_sends`, so a duplicate call /
 * a re-announce can't double-mail anyone. Returns a small summary for the sweep's log.
 */
export async function runPromotionAnnounceBlast(
  promotionId: string,
): Promise<{ queued: number; skipped?: string }> {
  if (!(await isFlowEnabled(FLOW))) return { queued: 0, skipped: "flux désactivé" };
  // Global gates BEFORE any claim — see marketingSendBlocked.
  const blocked = await marketingSendBlocked(FLOW);
  if (blocked) {
    console.warn(`[mailing] annonce promo ${promotionId} non envoyée : ${marketingGateSummary(blocked, FLOW)}`);
    return { queued: 0, skipped: marketingGateSummary(blocked, FLOW) };
  }

  const promo = await promotionService.findById(promotionId);
  const now = Date.now();
  if (
    !promo ||
    !promo.is_active ||
    promo.deleted_at ||
    (promo.starts_at && new Date(promo.starts_at).getTime() > now) ||
    (promo.ends_at && new Date(promo.ends_at).getTime() <= now)
  ) {
    console.warn(`[mailing] annonce promo ${promotionId} ignorée : promotion inexistante, inactive, programmée ou terminée`);
    return { queued: 0, skipped: "promotion inexistante, inactive, programmée ou terminée" };
  }

  // « −30 % » / « −5 TND » / « Livraison offerte » (never « 0% »).
  const discount = describePromoDiscount(promo);

  const codeBlock =
    promo.trigger_kind === "code" && promo.code
      ? `<div style="font-family:'Courier New',Courier,monospace;font-size:18px;font-weight:700;letter-spacing:3px;color:${BRAND_PRIMARY};background:#fbf9f8;border:1px dashed ${BRAND_PRIMARY};border-radius:12px;padding:16px;text-align:center;margin:4px 0;">${promo.code.toUpperCase()}</div>`
      : "";

  const site = await resolvePublicOrigin();
  const ctaUrl =
    promo.trigger_kind === "url" && promo.url_slug ? `${site}/promo/${promo.url_slug}` : site;

  // Date AND time in shop time (Africa/Tunis) — a bare date in the container's
  // UTC zone showed a 00:30-on-the-1st end as « the 30th ».
  const validUntil = promo.ends_at
    ? `Offre valable jusqu'au ${formatStoreDateTime(promo.ends_at, "long")}.`
    : "Offre à durée limitée.";

  const { recipients, truncated } = await resolvePromotionAudience(promotionId);
  if (truncated) {
    console.warn(
      `[mailing] annonce promo ${promotionId} : audience plafonnée — ${recipients.length} destinataire(s) retenu(s), les suivants ne sont pas contactés`,
    );
  }
  let queued = 0;
  for (const r of recipients) {
    const dedupKey = `${promotionId}:${r.email}`;
    const first = await mailingSendsService.claimOnce(DEDUP_FLOW, dedupKey).catch(() => false);
    if (!first) continue;
    const res = await dispatchEmail({
      key: "promotion_announcement",
      to: r.email,
      flowKey: FLOW,
      bulk: true,
      variables: {
        promo_name: promo.name,
        discount,
        valid_until: validUntil,
        cta_url: ctaUrl,
      },
      htmlVariables: { code_block: codeBlock },
    }).catch(() => null);
    // Not enqueued (skipped / failed) → give the claim back so it isn't burned.
    if (res?.queued) queued++;
    else await mailingSendsService.release(DEDUP_FLOW, dedupKey).catch(() => {});
  }
  return { queued };
}

import "server-only";

import { isFlowEnabled } from "@/modules/mailing";
import { promotionService } from "@/modules/promotion";
import { marketingGateSummary, marketingSendBlocked } from "@/lib/mailing/automation-gate";
import { runPromotionAnnounceBlast } from "@/events/subscribers/send-promotion-announcement";

/**
 * Scheduled promotion-announcement SWEEP (GZ parity G4, job `promotion_announce_sweep`).
 *
 * Fires the email announcement of every promotion whose `announce_at` has been
 * reached but that hasn't been announced yet and is still LIVE. Runs on an INTERVAL
 * cadence (~5 min) so an arbitrary scheduled minute is honored (a `daily` cadence
 * would delay a 14:30 announce until the next fixed daily tick).
 *
 * Idempotency is two-tiered:
 *   1. per-promotion — `claimAnnounce(id)` stamps `announced_at` race-safely
 *      (UPDATE … WHERE announced_at IS NULL AND still due AND live RETURNING), so two
 *      overlapping ticks — or a manual « Annoncer maintenant » racing the heartbeat —
 *      can't both fire the same promo. We claim BEFORE the blast (claim-then-fire).
 *   2. per-recipient — the blast's `mailing_sends` claim (`promo_announce`,
 *      `${promotionId}:${email}`) prevents double-mailing any recipient.
 *
 * The marketing kill-switch + flow toggle are checked ONCE up front and, if blocked,
 * the run SKIPS without claiming anything — so a run while marketing is paused doesn't
 * burn `announced_at` (a re-enable + next tick then fires the still-due promos).
 */
export type PromotionAnnounceRunResult = { ok: boolean; summary: string; status?: "skipped" };

/** Bound the per-run fan-out so one tick can't exceed the 90s job ceiling (each due
 *  promo can blast up to AUDIENCE_CAP=5000 recipients; the rest fire next tick). */
const MAX_PROMOS_PER_RUN = 20;

export async function runPromotionAnnounceSweep(): Promise<PromotionAnnounceRunResult> {
  const FLOW = "promotion_announcement";
  // GATE BEFORE CLAIM: a run while the flow / marketing is off must claim nothing,
  // so re-enabling + the next tick still fires the due promos.
  if (!(await isFlowEnabled(FLOW))) {
    return { ok: true, summary: "annonces de promotions désactivées", status: "skipped" };
  }
  const blocked = await marketingSendBlocked(FLOW);
  if (blocked) return { ok: true, summary: marketingGateSummary(blocked, FLOW), status: "skipped" };

  const dueIds = await promotionService.listDueForAnnounce(MAX_PROMOS_PER_RUN);
  if (dueIds.length === 0) {
    return { ok: true, summary: "aucune annonce programmée à envoyer", status: "skipped" };
  }

  let fired = 0;
  let queued = 0;
  for (const id of dueIds) {
    // Race-safe claim (stamps announced_at) BEFORE the blast — only one tick wins.
    if (!(await promotionService.claimAnnounce(id))) continue;
    fired++;
    const res = await runPromotionAnnounceBlast(id).catch((err) => {
      console.error("[mailing] annonce programmée échouée", id, err);
      return { queued: 0 };
    });
    queued += res.queued;
  }

  if (fired === 0) return { ok: true, summary: "aucune annonce programmée à envoyer", status: "skipped" };
  return { ok: true, summary: `${fired} annonce(s) programmée(s) déclenchée(s), ${queued} email(s) mis en file` };
}

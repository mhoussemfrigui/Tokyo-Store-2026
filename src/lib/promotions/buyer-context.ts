import "server-only";

import { customerUserLink } from "@/associations/customer-user.service";
import { customerService } from "@/modules/customer/service";
import { resolveSegmentIdsForProfile } from "@/lib/promotions/segments";

/**
 * Pre-resolved buyer facts the promotion eligibility gates need — targeting
 * (which customers/segments match) and the opt-out direction. Resolved ONCE per
 * cart render / per place-order (never per line) and threaded into
 * evaluateCouponEligibility so each gate is an in-memory check. Guests get
 * EMPTY_BUYER (match no target, no opt-out).
 */
export type BuyerContext = {
  userId: string | null;
  profileId: string | null;
  /** Segment ids the buyer belongs to (manual + matched dynamic). */
  segmentIds: string[];
  /** Customer opted out of public promos. */
  promoOptOut: boolean;
};

export const EMPTY_BUYER: BuyerContext = {
  userId: null,
  profileId: null,
  segmentIds: [],
  promoOptOut: false,
};

/** Resolve the buyer context for a user (null/guest → EMPTY_BUYER). A pure data read. */
export async function resolveBuyerContext(userId: string | null): Promise<BuyerContext> {
  if (!userId) return { ...EMPTY_BUYER };
  const link = await customerUserLink.findByUserId(userId).catch(() => null);
  const profile = link
    ? await customerService.findProfileById(link.customer_profile_id).catch(() => null)
    : null;
  const segmentIds = profile
    ? await resolveSegmentIdsForProfile(profile, userId).catch(() => [] as string[])
    : [];
  return {
    userId,
    profileId: profile?.id ?? null,
    segmentIds,
    promoOptOut: profile?.promo_opt_out ?? false,
  };
}

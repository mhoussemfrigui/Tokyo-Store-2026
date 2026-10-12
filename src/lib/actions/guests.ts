"use server";

import { requirePermission } from "@/lib/auth/session";
import { listFilteredGuests, guestFilterStats } from "@/lib/customers/guest-filter";
import type { GuestFilter, GuestRow, GuestStats } from "@/lib/customers/guest-filter-shared";

/**
 * Filter + paginate the guest-clients list, gated by invites:view. Backs the initial
 * server render and the client filter panel's keyset pagination (Précédent/Suivant).
 * The filter is applied server-side (email/phone/name search + hasEmail / hasPhone /
 * hasAccount / order-count & spend ranges / last-order dates), and each page is
 * keyset-paginated (last_at desc, email_key desc, phone desc), account-enriched.
 */
export async function searchGuestsAction(input: {
  filter: GuestFilter;
  cursor?: string;
}): Promise<{ items: GuestRow[]; nextCursor: string | null }> {
  await requirePermission("invites", "view");
  return listFilteredGuests(input.filter, { cursor: input.cursor, limit: 30 });
}

/**
 * Stat counts for the CURRENTLY-FILTERED guest set (the header cards). Same query shape
 * as the list, so the counts always match what's shown / exported.
 */
export async function guestStatsAction(filter: GuestFilter): Promise<GuestStats> {
  await requirePermission("invites", "view");
  return guestFilterStats(filter);
}

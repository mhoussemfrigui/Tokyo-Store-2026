"use server";

import { requirePermission } from "@/lib/auth/session";
import {
  listFilteredCustomers,
  customerFilterStats,
} from "@/lib/customers/filter";
import type { CustomerFilter, CustomerFilterStats, FilteredCustomerRow } from "@/lib/customers/filter-shared";

/**
 * Filter + paginate the Clients list, gated by customers:view. Backs the initial
 * server render and the client filter panel's keyset pagination (Précédent/Suivant).
 * The filter is applied server-side (name/email/phone search + gender / used-coupon /
 * has-cart / marketing opt-in / created-date range / birthday month), and each
 * page is keyset-paginated (created_at desc, id desc) with email enriched.
 */
export async function searchCustomersAction(input: {
  filter: CustomerFilter;
  cursor?: string;
}): Promise<{ rows: FilteredCustomerRow[]; nextCursor: string | null }> {
  await requirePermission("customers", "view");
  return listFilteredCustomers(input.filter, { cursor: input.cursor, limit: 30 });
}

/**
 * Demographic stat counts for the CURRENTLY-FILTERED set (the header cards). Same
 * conditions builder as the list, so the counts always match what's shown/exported.
 */
export async function customerStatsAction(filter: CustomerFilter): Promise<CustomerFilterStats> {
  await requirePermission("customers", "view");
  return customerFilterStats(filter);
}

import "server-only";

import { cache } from "react";

import { db } from "@/lib/db/client";
import { site_settings } from "./schema";

/**
 * Read-side helpers. Returns a parsed map keyed by setting key for easy
 * consumption: `settings["contact.phone"]` etc.
 *
 * Wrapped in React `cache()` so the whole-table read is deduped within a
 * single request render. A storefront page often reads settings through
 * several independent helpers (e.g. `getDefaultWarranty` + `getCheckoutCopy`
 * on the PDP) — without this each would issue its own `SELECT * FROM
 * site_settings`. The cache is per-request, so an admin edit + revalidate is
 * always reflected on the next request (no staleness).
 */
export const getSettingsMap = cache(
  async (): Promise<Record<string, string | null>> => {
    const rows = await db.select().from(site_settings);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
);

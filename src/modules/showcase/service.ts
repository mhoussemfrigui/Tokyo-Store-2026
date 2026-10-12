import "server-only";

import { asc, eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { showcase_pins, type ShowcasePinRow } from "./schema";

/** Pins for the showcase collection pages — read + replace-all write. */
class ShowcaseService {
  async listPins(slug: string): Promise<ShowcasePinRow[]> {
    return db
      .select()
      .from(showcase_pins)
      .where(eq(showcase_pins.slug, slug))
      .orderBy(asc(showcase_pins.position));
  }

  async listPinnedProductIds(slug: string): Promise<string[]> {
    const rows = await this.listPins(slug);
    return rows.map((r) => r.product_id);
  }

  /** Replace every pin for `slug` with the given ordered product ids. */
  async setPins(slug: string, productIds: string[]): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(showcase_pins).where(eq(showcase_pins.slug, slug));
      if (productIds.length > 0) {
        await tx.insert(showcase_pins).values(
          productIds.map((pid, i) => ({ slug, product_id: pid, position: i })),
        );
      }
    });
  }
}

export const showcaseService = new ShowcaseService();

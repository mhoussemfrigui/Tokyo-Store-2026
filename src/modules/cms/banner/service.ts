import "server-only";

import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { CMS_LIST_CAP } from "../list-cap";
import {
  banners,
  type BannerPlacement,
  type BannerRow,
  type NewBannerRow,
} from "./schema";

class BannerService {
  async findById(id: string): Promise<BannerRow | null> {
    const [row] = await db
      .select()
      .from(banners)
      .where(and(eq(banners.id, id), isNull(banners.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  async listAll(): Promise<BannerRow[]> {
    // Hand-curated content (dozens at most), but bound the admin list query so a
    // pathological row count can't load the whole table into memory on every
    // page view. The cap is a safety ceiling, not pagination — see CMS_LIST_CAP.
    return db
      .select()
      .from(banners)
      .where(isNull(banners.deleted_at))
      .orderBy(asc(banners.placement), asc(banners.display_order))
      .limit(CMS_LIST_CAP);
  }

  /**
   * Currently-live banners for a given placement.
   * A banner is live when:
   *   - is_active=true
   *   - now >= start_at (or start_at null)
   *   - now <  end_at   (or end_at   null)
   *
   * Implementation note (Next.js 16 Cache Components compatibility):
   * the "now" comparison is delegated to Postgres via `sql\`now()\`` rather
   * than `new Date()`. Cache Components forbids reading the current time
   * in JS during prerender unless the function is `'use cache'`-marked or
   * the page has otherwise opted into dynamic data — pushing the time
   * comparison into SQL sidesteps that rule entirely, and Postgres's clock
   * is the right authority for banner scheduling anyway.
   */
  async listLive(placement: BannerPlacement): Promise<BannerRow[]> {
    return db
      .select()
      .from(banners)
      .where(
        and(
          eq(banners.placement, placement),
          eq(banners.is_active, true),
          isNull(banners.deleted_at),
          or(isNull(banners.start_at), lte(banners.start_at, sql`now()`))!,
          or(isNull(banners.end_at), gt(banners.end_at, sql`now()`))!,
        ),
      )
      .orderBy(asc(banners.display_order));
  }

  /**
   * Live `category_grid` banners for a specific listing, filtered by targeting:
   * a banner shows when `target_kind='none'` (global) OR it matches the listing's
   * category slug / brand slug / one of its filter-attribute ids. Ordered by
   * display_order. The cadence (`after_load_more_count`) is applied at render.
   */
  async listGridBannersForListing(opts: {
    /** The listing's category slug + its ancestors (so a parent-targeted banner
     *  cascades to sub-category pages). */
    categorySlugs?: string[];
    brandSlug?: string | null;
    filterAttributeIds?: string[];
  }): Promise<BannerRow[]> {
    const targetConds = [eq(banners.target_kind, "none")];
    if (opts.categorySlugs && opts.categorySlugs.length > 0) {
      targetConds.push(and(eq(banners.target_kind, "category"), inArray(banners.target_ref, opts.categorySlugs))!);
    }
    if (opts.brandSlug) {
      targetConds.push(and(eq(banners.target_kind, "brand"), eq(banners.target_ref, opts.brandSlug))!);
    }
    if (opts.filterAttributeIds && opts.filterAttributeIds.length > 0) {
      targetConds.push(and(eq(banners.target_kind, "filter"), inArray(banners.target_ref, opts.filterAttributeIds))!);
    }
    return db
      .select()
      .from(banners)
      .where(
        and(
          eq(banners.placement, "category_grid"),
          eq(banners.is_active, true),
          isNull(banners.deleted_at),
          or(isNull(banners.start_at), lte(banners.start_at, sql`now()`))!,
          or(isNull(banners.end_at), gt(banners.end_at, sql`now()`))!,
          or(...targetConds)!,
        ),
      )
      .orderBy(asc(banners.display_order));
  }

  async insert(input: NewBannerRow): Promise<BannerRow> {
    const [row] = await db.insert(banners).values(input).returning();
    return row;
  }

  async update(id: string, patch: Partial<Omit<BannerRow, "id" | "created_at">>) {
    const [row] = await db
      .update(banners)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(banners.id, id))
      .returning();
    return row ?? null;
  }

  async softDelete(id: string) {
    await db
      .update(banners)
      // Both stamps use the DB clock (sql now()) for consistency with update() and the
      // listLive scheduling comparisons — one authoritative clock, no JS/DB skew.
      .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
      .where(eq(banners.id, id));
  }

  /**
   * Most-recent non-deleted banner for a placement, REGARDLESS of active /
   * schedule state. Unlike `listLive` (which filters to currently-showing
   * rows), this is the upsert anchor for the singleton `nav_*` featured-image
   * + `footer` placements: the Nav Menu / Footer admin pages edit a single
   * banner per placement, so we look up whichever one already exists and patch
   * it in place rather than spawning duplicates. Returns null when none exists.
   */
  async findAnyByPlacement(placement: BannerPlacement): Promise<BannerRow | null> {
    const [row] = await db
      .select()
      .from(banners)
      .where(and(eq(banners.placement, placement), isNull(banners.deleted_at)))
      .orderBy(asc(banners.display_order))
      .limit(1);
    return row ?? null;
  }

  /**
   * Look up a banner by its `name` (used as the stable demo key — banners
   * have no slug column). Returns null when nothing matches.
   */
  async findByName(name: string): Promise<BannerRow | null> {
    const [row] = await db
      .select()
      .from(banners)
      .where(and(eq(banners.name, name), isNull(banners.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Every banner id, INCLUDING soft-deleted rows. Used by the segmented
   * `clean` flow to wipe ALL banners (not just the demo-named set). Pair
   * with `deleteByIds` so the orphaned hero images get swept too.
   */
  async listAllIds(): Promise<string[]> {
    const rows = await db.select({ id: banners.id }).from(banners);
    return rows.map((r) => r.id);
  }

  /**
   * Hard-delete a set of banners by id. Returns BOTH the rows' desktop
   * (image_media_id) and mobile (image_mobile_media_id) media ids so the caller
   * (e.g. demo clear) can sweep every orphaned hero image afterwards — missing
   * the mobile id would leave its object-store blob behind. (`video_url` is an
   * external URL, not a stored média, so there is nothing to sweep for it.)
   */
  async deleteByIds(
    ids: string[],
  ): Promise<{ id: string; mediaId: string | null; mobileMediaId: string | null }[]> {
    if (ids.length === 0) return [];
    const rows = await db
      .delete(banners)
      .where(inArray(banners.id, ids))
      .returning({
        id: banners.id,
        mediaId: banners.image_media_id,
        mobileMediaId: banners.image_mobile_media_id,
      });
    return rows.map((r) => ({ id: r.id, mediaId: r.mediaId, mobileMediaId: r.mobileMediaId }));
  }

  /**
   * From the given set of media ids, return the subset still referenced by a
   * non-deleted banner's `image_media_id` or `image_mobile_media_id`. Used by
   * the demo-clear flow to avoid wiping media still in use elsewhere (e.g. when
   * a product and a banner shared a hero image). (`video_url` is an external
   * URL, not a média id, so it is not part of this reference check.)
   */
  async listMediaIdsInUse(mediaIds: string[]): Promise<string[]> {
    if (mediaIds.length === 0) return [];
    const rows = await db
      .select({
        image: banners.image_media_id,
        imageMobile: banners.image_mobile_media_id,
      })
      .from(banners)
      .where(
        and(
          or(
            inArray(banners.image_media_id, mediaIds),
            inArray(banners.image_mobile_media_id, mediaIds),
          )!,
          isNull(banners.deleted_at),
        ),
      );
    const wanted = new Set(mediaIds);
    const inUse = new Set<string>();
    for (const r of rows) {
      if (r.image && wanted.has(r.image)) inUse.add(r.image);
      if (r.imageMobile && wanted.has(r.imageMobile)) inUse.add(r.imageMobile);
    }
    return [...inUse];
  }
}

export const bannerService = new BannerService();

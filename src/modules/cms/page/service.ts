import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { CMS_LIST_CAP } from "../list-cap";
import {
  page_sections,
  pages,
  type NewPageRow,
  type PageRow,
  type PageSectionRow,
} from "./schema";

class PageService {
  async findBySlug(slug: string): Promise<PageRow | null> {
    const [row] = await db
      .select()
      .from(pages)
      .where(and(eq(pages.slug, slug), isNull(pages.deleted_at)))
      .limit(1);
    return row ?? null;
  }
  async findById(id: string): Promise<PageRow | null> {
    const [row] = await db
      .select()
      .from(pages)
      .where(and(eq(pages.id, id), isNull(pages.deleted_at)))
      .limit(1);
    return row ?? null;
  }
  async listAll(): Promise<PageRow[]> {
    // Bounded admin list (safety ceiling, not pagination — see CMS_LIST_CAP).
    return db
      .select()
      .from(pages)
      .where(isNull(pages.deleted_at))
      .orderBy(asc(pages.slug))
      .limit(CMS_LIST_CAP);
  }
  /**
   * Slug + freshness for the sitemap: EVERY published page (custom AND system).
   * Custom pages resolve at the flat `/[slug]` URL; system pages that own a
   * dedicated file route (/cgu, /apropos…) are also in the
   * sitemap's static list and are deduped there by URL (static entry wins). A
   * system page WITHOUT a file route is served by `/[slug]` too — filtering
   * `is_system` out (the old behaviour) silently dropped such published pages
   * (e.g. /garantie) from the sitemap.
   */
  async listPublishedCustomPageSlugs(): Promise<
    Array<{ slug: string; updated_at: Date | null; published_at: Date | null }>
  > {
    return db
      .select({
        slug: pages.slug,
        updated_at: pages.updated_at,
        published_at: pages.published_at,
      })
      .from(pages)
      // Exclude noindex pages from the sitemap — advertising a page the admin marked
      // "keep out of search" contradicts the robots directive it emits.
      .where(and(eq(pages.is_published, true), eq(pages.noindex, false), isNull(pages.deleted_at)))
      .orderBy(asc(pages.slug))
      .limit(CMS_LIST_CAP);
  }

  /**
   * Slugs of every page the `/[slug]` route still RENDERS — published and not
   * deleted, regardless of `noindex` (noindex only governs search indexing, not
   * whether the page 404s) and including system pages. Used by the nav/footer
   * dead-link pruning so a link to an unpublished/deleted CMS page is dropped,
   * while a published-but-noindex page keeps its link (it renders fine).
   */
  async listPublishedSlugs(): Promise<string[]> {
    const rows = await db
      .select({ slug: pages.slug })
      .from(pages)
      .where(and(eq(pages.is_published, true), isNull(pages.deleted_at)))
      .limit(CMS_LIST_CAP);
    return rows.map((r) => r.slug);
  }

  /**
   * {slug, noindex, isPublished} for every non-deleted page — lets the sitemap gate the
   * hardcoded file-routed system/maison entries on the SAME condition those pages' metadata
   * uses: list a slug only when `!noindex && (isPublished || has-system-default)`, so an
   * unpublished no-default maison page (which emits robots:noindex) is never advertised.
   */
  async listPageStates(): Promise<{ slug: string; noindex: boolean; isPublished: boolean }[]> {
    const rows = await db
      .select({ slug: pages.slug, noindex: pages.noindex, isPublished: pages.is_published })
      .from(pages)
      .where(isNull(pages.deleted_at))
      .limit(CMS_LIST_CAP);
    return rows;
  }
  async insert(input: NewPageRow): Promise<PageRow> {
    const [row] = await db.insert(pages).values(input).returning();
    return row;
  }
  async update(id: string, patch: Partial<Omit<PageRow, "id" | "created_at">>) {
    const [row] = await db
      .update(pages)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(pages.id, id))
      .returning();
    return row ?? null;
  }
  async softDelete(id: string) {
    await db
      .update(pages)
      .set({ deleted_at: new Date(), updated_at: sql`now()` })
      .where(eq(pages.id, id));
  }

  async listSectionsForPage(pageId: string): Promise<PageSectionRow[]> {
    return db
      .select()
      .from(page_sections)
      .where(eq(page_sections.page_id, pageId))
      .orderBy(asc(page_sections.display_order));
  }

}

export const pageService = new PageService();

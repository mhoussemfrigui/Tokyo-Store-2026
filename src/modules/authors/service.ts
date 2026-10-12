import "server-only";

import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { blog_posts, blog_categories } from "@/modules/blog/schema";
import { authors, type AuthorRow, type NewAuthorRow } from "./schema";

/**
 * Editorial author profiles. CRUD + batched hydration for storefront bylines,
 * and published-post counts for the admin list and the public archive / sitemap
 * gates.
 *
 * Deletion is SOFT (deleted_at): a retired author's already-published article
 * JSON-LD would otherwise dangle its Person @id. Public/enrich reads exclude
 * soft-deleted rows (the byline gracefully falls back), while the row survives
 * for restore.
 */
class AuthorService {
  /** Live (non-deleted) author by slug — the public archive loader. */
  async findBySlug(slug: string): Promise<AuthorRow | null> {
    const [row] = await db
      .select()
      .from(authors)
      .where(and(eq(authors.slug, slug), isNull(authors.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  /**
   * ANY author with this slug, INCLUDING soft-deleted — the workflow
   * slug-uniqueness guard. The `authors_slug_unique` index ignores deleted_at,
   * so a soft-deleted author still reserves its slug; checking here yields a
   * friendly conflict instead of a 23505.
   */
  async findBySlugAny(slug: string): Promise<AuthorRow | null> {
    const [row] = await db.select().from(authors).where(eq(authors.slug, slug)).limit(1);
    return row ?? null;
  }

  /** Live author by id — the admin editor. */
  async findById(id: string): Promise<AuthorRow | null> {
    const [row] = await db
      .select()
      .from(authors)
      .where(and(eq(authors.id, id), isNull(authors.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Batched fetch — one query for N ids, ACTIVE (non-deleted, is_active) authors
   * only. Used to hydrate public article bylines (blog enrich) without an N+1. A
   * deactivated or soft-deleted author drops out of the map so its posts fall
   * back to the default byline AND never link to a hidden /auteur page (404).
   */
  async findByIds(ids: string[]): Promise<Map<string, AuthorRow>> {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    if (unique.length === 0) return new Map();
    const rows = await db
      .select()
      .from(authors)
      .where(and(inArray(authors.id, unique), isNull(authors.deleted_at), eq(authors.is_active, true)));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Active (non-deleted) authors — the public list + the post-editor selector. */
  async listActive(): Promise<AuthorRow[]> {
    return db
      .select()
      .from(authors)
      .where(and(isNull(authors.deleted_at), eq(authors.is_active, true)))
      .orderBy(asc(authors.name));
  }

  /**
   * Admin listing — includes INACTIVE authors (the public `listActive` filters
   * them out) so the manager can re-activate a deactivated profile. Excludes
   * soft-deleted.
   */
  async listForAdmin(): Promise<AuthorRow[]> {
    return db
      .select()
      .from(authors)
      .where(isNull(authors.deleted_at))
      .orderBy(asc(authors.name));
  }

  /** Soft-deleted (archived) authors — the admin « Archivés » restore subsection. */
  async listArchived(): Promise<AuthorRow[]> {
    return db
      .select()
      .from(authors)
      .where(sql`${authors.deleted_at} IS NOT NULL`)
      .orderBy(asc(authors.name));
  }

  /**
   * NON-deleted post count per author id — for the admin list. Authors with no
   * posts are simply absent from the map.
   */
  async countPostsByAuthor(): Promise<Map<string, number>> {
    return this.#countByAuthor(false);
  }

  /**
   * PUBLISHED (non-deleted) post count per author id — the has-posts gate for the
   * public archive page + sitemap (an author with 0 published posts renders
   * `noindex`, so must not be advertised).
   */
  async countPublishedPostsByAuthor(): Promise<Map<string, number>> {
    return this.#countByAuthor(true);
  }

  /**
   * PUBLISHED posts by author — OFFSET-paged (numbered pagination) with the
   * category name/slug + reading time joined for the crimson archive cards, plus
   * an optional category filter. Returns the page of items + the matching total.
   */
  async listPublishedPostsByAuthorPage(
    authorId: string,
    opts: { page?: number; pageSize?: number; categorySlug?: string | null } = {},
  ): Promise<{
    items: Array<{
      id: string;
      slug: string;
      title: string;
      excerpt: string | null;
      publishedAt: Date | null;
      featuredImageMediaId: string | null;
      readingMinutes: number | null;
      categoryName: string | null;
      categorySlug: string | null;
    }>;
    total: number;
  }> {
    const pageSize = Math.min(Math.max(opts.pageSize ?? 12, 1), 48);
    const page = Math.max(opts.page ?? 1, 1);
    const cat = opts.categorySlug?.trim() || null;
    const conds = [
      eq(blog_posts.author_id, authorId),
      eq(blog_posts.is_published, true),
      isNull(blog_posts.deleted_at),
    ];
    if (cat) conds.push(eq(blog_categories.slug, cat));
    const where = and(...conds);
    const [rows, totalRows] = await Promise.all([
      db
        .select({
          id: blog_posts.id,
          slug: blog_posts.slug,
          title: blog_posts.title,
          excerpt: blog_posts.excerpt,
          publishedAt: blog_posts.published_at,
          featuredImageMediaId: blog_posts.featured_image_media_id,
          readingMinutes: blog_posts.reading_minutes,
          categoryName: blog_categories.name,
          categorySlug: blog_categories.slug,
        })
        .from(blog_posts)
        .leftJoin(blog_categories, and(eq(blog_posts.category_id, blog_categories.id), eq(blog_categories.is_active, true)))
        .where(where)
        .orderBy(sql`${blog_posts.published_at} DESC NULLS LAST`, desc(blog_posts.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db
        .select({ n: count() })
        .from(blog_posts)
        .leftJoin(blog_categories, and(eq(blog_posts.category_id, blog_categories.id), eq(blog_categories.is_active, true)))
        .where(where),
    ]);
    return { items: rows, total: Number(totalRows[0]?.n ?? 0) };
  }

  /**
   * Author archive stats: total published posts, total reading minutes, last
   * publish date, and the per-category breakdown (real categories only, desc by
   * count) for the filter chips + « rubrique principale ». One grouped query + one
   * aggregate.
   */
  async getAuthorStats(authorId: string): Promise<{
    total: number;
    totalMinutes: number;
    lastPublishedAt: Date | null;
    categories: Array<{ slug: string; name: string; count: number }>;
  }> {
    const base = and(
      eq(blog_posts.author_id, authorId),
      eq(blog_posts.is_published, true),
      isNull(blog_posts.deleted_at),
    );
    const [catRows, aggRows] = await Promise.all([
      db
        .select({ slug: blog_categories.slug, name: blog_categories.name, n: count() })
        .from(blog_posts)
        .leftJoin(blog_categories, and(eq(blog_posts.category_id, blog_categories.id), eq(blog_categories.is_active, true)))
        .where(base)
        .groupBy(blog_categories.slug, blog_categories.name),
      db
        .select({
          total: count(),
          minutes: sql<number>`coalesce(sum(${blog_posts.reading_minutes}), 0)`,
          last: sql<Date | null>`max(${blog_posts.published_at})`,
        })
        .from(blog_posts)
        .where(base),
    ]);
    const categories = catRows
      .filter((r) => !!r.slug && !!r.name)
      .map((r) => ({ slug: r.slug as string, name: r.name as string, count: Number(r.n) }))
      .sort((a, b) => b.count - a.count);
    const agg = aggRows[0];
    return {
      total: Number(agg?.total ?? 0),
      totalMinutes: Number(agg?.minutes ?? 0),
      lastPublishedAt: agg?.last ?? null,
      categories,
    };
  }

  async #countByAuthor(publishedOnly: boolean): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const conditions = [isNull(blog_posts.deleted_at), sql`${blog_posts.author_id} IS NOT NULL`];
    if (publishedOnly) conditions.push(eq(blog_posts.is_published, true));
    const rows = await db
      .select({ authorId: blog_posts.author_id, n: count() })
      .from(blog_posts)
      .where(and(...conditions))
      .groupBy(blog_posts.author_id);
    for (const r of rows) {
      if (r.authorId) out.set(r.authorId, Number(r.n));
    }
    return out;
  }

  async insert(input: NewAuthorRow): Promise<AuthorRow> {
    const [row] = await db.insert(authors).values(input).returning();
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<AuthorRow, "id" | "created_at">>,
    txOrDb: DbOrTx = db,
  ) {
    const [row] = await txOrDb
      .update(authors)
      .set({ ...patch, updated_at: sql`now()` })
      .where(and(eq(authors.id, id), isNull(authors.deleted_at)))
      .returning();
    return row ?? null;
  }

  /** Soft-delete (archive) — keeps the row so article bylines can be restored. */
  async softDelete(id: string) {
    await db
      .update(authors)
      .set({ deleted_at: new Date(), updated_at: sql`now()` })
      .where(eq(authors.id, id));
  }

  /**
   * Un-archive a soft-deleted author (clear deleted_at). Returns the row, or null
   * when the id doesn't match a soft-deleted author. The `authors_slug_unique`
   * index spans deleted rows, so a restore can never resurrect a duplicate slug
   * (nothing else could have taken it) — no cross-table check needed (authors own
   * the /auteur/ namespace).
   */
  async restore(id: string): Promise<AuthorRow | null> {
    const [row] = await db
      .update(authors)
      .set({ deleted_at: null, updated_at: sql`now()` })
      .where(and(eq(authors.id, id), sql`${authors.deleted_at} IS NOT NULL`))
      .returning();
    return row ?? null;
  }
}

export const authorService = new AuthorService();

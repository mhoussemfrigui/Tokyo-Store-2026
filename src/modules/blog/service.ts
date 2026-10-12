import "server-only";

import { and, asc, count, desc, eq, getTableColumns, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { isUuid } from "@/lib/utils/uuid";
import {
  blog_categories,
  blog_post_products,
  blog_post_tags,
  blog_posts,
  blog_tags,
  blog_comments,
  type BlogCategoryRow,
  type BlogPostRow,
  type BlogTagRow,
  type NewBlogCategoryRow,
  type NewBlogPostRow,
  type NewBlogTagRow,
} from "./schema";

export type BlogListSort = "recent" | "popular";

/**
 * Column projection for LIST views — every blog_posts column EXCEPT the heavy
 * `body` HTML the admin/storefront lists never render. Derived from
 * getTableColumns so a future column is auto-included (no brittle hand-list).
 */
const { body: _omitBody, ...BLOG_POST_LIST_COLUMNS } = getTableColumns(blog_posts);
export type BlogPostListRow = Omit<BlogPostRow, "body">;

class BlogService {
  // ────────────────────────────────────────── categories
  async findCategoryBySlug(slug: string): Promise<BlogCategoryRow | null> {
    const [row] = await db
      .select()
      .from(blog_categories)
      .where(eq(blog_categories.slug, slug))
      .limit(1);
    return row ?? null;
  }
  async findCategoryById(id: string): Promise<BlogCategoryRow | null> {
    const [row] = await db
      .select()
      .from(blog_categories)
      .where(eq(blog_categories.id, id))
      .limit(1);
    return row ?? null;
  }
  /**
   * Batched fetch — one query for N ids. Used by `enrichPosts` to avoid
   * the N+1 pattern when hydrating a posts listing with their categories.
   */
  async findCategoriesByIds(ids: string[]): Promise<Map<string, BlogCategoryRow>> {
    if (ids.length === 0) return new Map();
    const rows = await db
      .select()
      .from(blog_categories)
      .where(inArray(blog_categories.id, ids));
    return new Map(rows.map((r) => [r.id, r]));
  }
  async listCategories(): Promise<BlogCategoryRow[]> {
    return db
      .select()
      .from(blog_categories)
      .where(eq(blog_categories.is_active, true))
      .orderBy(asc(blog_categories.display_order), asc(blog_categories.name));
  }
  /**
   * Admin listing — includes INACTIVE categories (the storefront `listCategories`
   * filters them out). The admin must see deactivated rows to re-activate them,
   * otherwise toggling a category off would make it vanish from the manager.
   */
  async listCategoriesForAdmin(): Promise<BlogCategoryRow[]> {
    return db
      .select()
      .from(blog_categories)
      .orderBy(asc(blog_categories.display_order), asc(blog_categories.name));
  }
  /**
   * Published (non-deleted) post counts keyed by category id. Powers the
   * sitemap's "drop empty categories" filter: the category page renders
   * `noindex` when it has zero published posts, so a sitemap that still lists it
   * would trip Search Console's "Submitted URL marked noindex". Matches the
   * page's own `listPublishedPosts` predicate (is_published + not soft-deleted).
   */
  async countPublishedPostsByCategory(): Promise<Map<string, number>> {
    const rows = await db
      .select({ categoryId: blog_posts.category_id, n: count() })
      .from(blog_posts)
      .where(and(eq(blog_posts.is_published, true), isNull(blog_posts.deleted_at)))
      .groupBy(blog_posts.category_id);
    const map = new Map<string, number>();
    for (const r of rows) if (r.categoryId) map.set(r.categoryId, Number(r.n));
    return map;
  }
  async insertCategory(input: NewBlogCategoryRow): Promise<BlogCategoryRow> {
    const [row] = await db.insert(blog_categories).values(input).returning();
    return row;
  }
  async updateCategory(id: string, patch: Partial<Omit<BlogCategoryRow, "id" | "created_at">>) {
    const [row] = await db
      .update(blog_categories)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(blog_categories.id, id))
      .returning();
    return row ?? null;
  }
  async deleteCategory(id: string) {
    await db.delete(blog_categories).where(eq(blog_categories.id, id));
  }

  // ────────────────────────────────────────── tags
  async findTagBySlug(slug: string): Promise<BlogTagRow | null> {
    const [row] = await db.select().from(blog_tags).where(eq(blog_tags.slug, slug)).limit(1);
    return row ?? null;
  }
  async listTags(): Promise<BlogTagRow[]> {
    return db.select().from(blog_tags).orderBy(asc(blog_tags.name));
  }
  async findTagById(id: string): Promise<BlogTagRow | null> {
    const [row] = await db.select().from(blog_tags).where(eq(blog_tags.id, id)).limit(1);
    return row ?? null;
  }
  async insertTag(input: NewBlogTagRow): Promise<BlogTagRow> {
    const [row] = await db.insert(blog_tags).values(input).returning();
    return row;
  }
  async updateTag(id: string, patch: Partial<Pick<BlogTagRow, "name" | "slug">>) {
    const [row] = await db
      .update(blog_tags)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(blog_tags.id, id))
      .returning();
    return row ?? null;
  }
  async deleteTag(id: string) {
    await db.delete(blog_tags).where(eq(blog_tags.id, id));
  }

  // ────────────────────────────────────────── posts
  async findPostBySlug(slug: string): Promise<BlogPostRow | null> {
    const [row] = await db
      .select()
      .from(blog_posts)
      .where(and(eq(blog_posts.slug, slug), isNull(blog_posts.deleted_at)))
      .limit(1);
    return row ?? null;
  }
  async findPostById(id: string): Promise<BlogPostRow | null> {
    const [row] = await db
      .select()
      .from(blog_posts)
      .where(and(eq(blog_posts.id, id), isNull(blog_posts.deleted_at)))
      .limit(1);
    return row ?? null;
  }
  /** A SOFT-DELETED post by id — the restore pre-check needs its slug while archived. */
  async findArchivedPostById(id: string): Promise<BlogPostRow | null> {
    const [row] = await db
      .select()
      .from(blog_posts)
      .where(and(eq(blog_posts.id, id), sql`${blog_posts.deleted_at} IS NOT NULL`))
      .limit(1);
    return row ?? null;
  }
  async insertPost(input: NewBlogPostRow, txOrDb: DbOrTx = db): Promise<BlogPostRow> {
    const [row] = await txOrDb.insert(blog_posts).values(input).returning();
    return row;
  }
  async updatePost(
    id: string,
    patch: Partial<Omit<BlogPostRow, "id" | "created_at">>,
    txOrDb: DbOrTx = db,
  ) {
    const [row] = await txOrDb
      .update(blog_posts)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(blog_posts.id, id))
      .returning();
    return row ?? null;
  }
  async softDeletePost(id: string) {
    await db
      .update(blog_posts)
      .set({ deleted_at: new Date(), updated_at: sql`now()` })
      .where(eq(blog_posts.id, id));
  }
  /** Un-archive a soft-deleted post (clear deleted_at). Returns the row, or
   *  null when the id doesn't match a soft-deleted post. */
  async restorePost(id: string): Promise<BlogPostRow | null> {
    const [row] = await db
      .update(blog_posts)
      .set({ deleted_at: null, updated_at: sql`now()` })
      .where(and(eq(blog_posts.id, id), sql`${blog_posts.deleted_at} IS NOT NULL`))
      .returning();
    return row ?? null;
  }

  async listPosts(opts: {
    publishedOnly?: boolean;
    /** "draft" | "published" | "archived" — archived = soft-deleted. */
    status?: "draft" | "published" | "archived";
    categoryId?: string;
    /** Title/slug substring (case-insensitive). */
    search?: string;
    limit?: number;
    cursor?: string;
    /** Page offset for admin page-number pagination (the storefront uses `cursor`). */
    offset?: number;
    /** Run the COUNT(*) for page math. Default true; storefront listings pass
     *  false (they never read `total`) to skip a second query per request. */
    withTotal?: boolean;
  } = {}): Promise<{ items: BlogPostRow[]; nextCursor: string | null; total: number }> {
    const limit = Math.min(opts.limit ?? 25, 100);
    const offset = Math.max(0, opts.offset ?? 0);
    const conditions = [];
    if (opts.status === "archived") {
      // surface trash explicitly only when asked
      conditions.push(sql`${blog_posts.deleted_at} IS NOT NULL`);
    } else {
      conditions.push(isNull(blog_posts.deleted_at));
    }
    if (opts.publishedOnly || opts.status === "published") {
      conditions.push(eq(blog_posts.is_published, true));
    } else if (opts.status === "draft") {
      conditions.push(eq(blog_posts.is_published, false));
    }
    if (opts.categoryId) conditions.push(eq(blog_posts.category_id, opts.categoryId));
    if (opts.search) {
      conditions.push(
        or(
          ilike(blog_posts.title, `%${opts.search}%`),
          ilike(blog_posts.slug, `%${opts.search}%`),
        )!,
      );
    }
    if (opts.cursor) {
      // Composite keyset cursor "<published_at_iso>__<uuid>". published_at alone
      // isn't unique (a bulk publish / import stamps the same second), so a plain
      // lt(published_at) would SKIP rows sharing a timestamp at the page seam. id
      // is UUID v7 (time-ordered), so (published_at, id) is a stable total order
      // matching the ORDER BY below. Cursor mode is the storefront published-only
      // path, so published_at is never NULL here. A malformed cursor (no valid
      // timestamp+UUID pair) is ignored → first page, never a 500.
      const sep = opts.cursor.lastIndexOf("__");
      const iso = sep >= 0 ? opts.cursor.slice(0, sep) : opts.cursor;
      const cursorId = sep >= 0 ? opts.cursor.slice(sep + 2) : "";
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime()) && isUuid(cursorId)) {
        conditions.push(sql`(${blog_posts.published_at}, ${blog_posts.id}) < (${d}, ${cursorId}::uuid)`);
      }
    }
    const items = await db
      .select()
      .from(blog_posts)
      .where(and(...conditions))
      // NULLS LAST so drafts (published_at IS NULL) don't float to the top of the
      // admin list under Postgres' default DESC NULLS FIRST, and the partial
      // active_recent index stays usable. id DESC is the tiebreaker (unique +
      // time-ordered) so it matches the (published_at, id) keyset cursor exactly.
      .orderBy(sql`${blog_posts.published_at} DESC NULLS LAST`, desc(blog_posts.id))
      .limit(limit + 1)
      .offset(offset);
    let total = 0;
    if (opts.withTotal ?? true) {
      const [totalRow] = await db
        .select({ value: count() })
        .from(blog_posts)
        .where(and(...conditions));
      total = Number(totalRow?.value ?? 0);
    }
    const hasMore = items.length > limit;
    const trimmed = hasMore ? items.slice(0, limit) : items;
    const last = trimmed[trimmed.length - 1];
    return {
      items: trimmed,
      total,
      // Composite cursor pairs the boundary published_at with its row id so the
      // next page resumes after the exact row, not the timestamp (see above).
      nextCursor: hasMore && last?.published_at ? `${last.published_at.toISOString()}__${last.id}` : null,
    };
  }

  /**
   * PUBLIC full-text search over PUBLISHED posts — the storefront /blog?q=… search.
   * Relevance-ranked (ts_rank over the GENERATED, weighted `search_vector`:
   * title=A, excerpt=B, body=C, meta=D, `fr_unaccent` config) + served by the
   * partial GIN `blog_posts_search_gin` (WHERE deleted_at IS NULL AND is_published).
   * `websearch_to_tsquery` tolerates arbitrary user input (quotes / OR / -exclude)
   * and never throws; a title trigram ILIKE (index `blog_posts_title_trgm`) is
   * OR-ed in so short / substring queries the tsquery misses still hit. OFFSET
   * pagination (search result sets are small and relevance order isn't keyset-able).
   */
  async searchPublishedPosts(
    q: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{ items: BlogPostRow[]; total: number }> {
    const term = q.trim();
    if (term.length < 2) return { items: [], total: 0 };
    const limit = Math.min(opts.limit ?? 12, 50);
    const offset = Math.max(0, opts.offset ?? 0);
    const tsquery = sql`websearch_to_tsquery('fr_unaccent', ${term})`;
    // `search_vector` is a migration-only generated column (not modelled), so it is
    // referenced raw — unambiguous in this single-table query. The title trigram
    // index (gin_trgm_ops) needs >= 3 chars to form a 3-gram, so the ILIKE arm is
    // added ONLY from 3 chars up (escaping LIKE wildcards to literals); a 2-char
    // term is served by the FTS GIN alone instead of forcing a seq scan.
    const match =
      term.length >= 3
        ? sql`(search_vector @@ ${tsquery} OR ${blog_posts.title} ILIKE ${`%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`})`
        : sql`search_vector @@ ${tsquery}`;
    const conds = and(isNull(blog_posts.deleted_at), eq(blog_posts.is_published, true), match);
    const [items, totalRow] = await Promise.all([
      db
        // Drop the heavy TipTap `body` HTML (the search grid renders title/excerpt/
        // cover only) — replace it with '' so the row keeps its BlogPostRow shape
        // without transferring the full article per hit.
        .select({ ...getTableColumns(blog_posts), body: sql<string>`''`.as("body") })
        .from(blog_posts)
        .where(conds)
        .orderBy(
          sql`ts_rank(search_vector, ${tsquery}) DESC`,
          sql`${blog_posts.published_at} DESC NULLS LAST`,
          desc(blog_posts.id),
        )
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(blog_posts)
        .where(conds)
        .then((r) => r[0]),
    ]);
    return { items, total: Number(totalRow?.value ?? 0) };
  }

  /**
   * ADMIN list (offset-paginated) — same filters as `listPosts` but COLUMN-
   * PROJECTED to drop the heavy `body` HTML the admin table never renders (it
   * shows title/status/date only). `listPosts` stays full because the storefront
   * listing feeds the headless blog API, which serialises the body per post.
   */
  async listPostsLight(opts: {
    status?: "draft" | "published" | "archived";
    categoryId?: string;
    search?: string;
    limit?: number;
    offset?: number;
    withTotal?: boolean;
  } = {}): Promise<{ items: BlogPostListRow[]; total: number }> {
    const limit = Math.min(opts.limit ?? 25, 100);
    const offset = Math.max(0, opts.offset ?? 0);
    const conditions = [];
    if (opts.status === "archived") {
      conditions.push(sql`${blog_posts.deleted_at} IS NOT NULL`);
    } else {
      conditions.push(isNull(blog_posts.deleted_at));
    }
    if (opts.status === "published") conditions.push(eq(blog_posts.is_published, true));
    else if (opts.status === "draft") conditions.push(eq(blog_posts.is_published, false));
    if (opts.categoryId) conditions.push(eq(blog_posts.category_id, opts.categoryId));
    if (opts.search) {
      conditions.push(
        or(ilike(blog_posts.title, `%${opts.search}%`), ilike(blog_posts.slug, `%${opts.search}%`))!,
      );
    }
    const items = await db
      .select(BLOG_POST_LIST_COLUMNS)
      .from(blog_posts)
      .where(and(...conditions))
      .orderBy(sql`${blog_posts.published_at} DESC NULLS LAST`, desc(blog_posts.id))
      .limit(limit)
      .offset(offset);
    let total = 0;
    if (opts.withTotal ?? true) {
      const [totalRow] = await db.select({ value: count() }).from(blog_posts).where(and(...conditions));
      total = Number(totalRow?.value ?? 0);
    }
    return { items, total };
  }

  /**
   * Lean slug + dates for published posts — for the sitemap, which only needs
   * the URL + lastmod and must NOT pay for the full media/category/tag enrich
   * pipeline across up to `limit` rows.
   */
  async listPublishedPostSlugs(
    limit = 1000,
  ): Promise<{ slug: string; published_at: Date | null; updated_at: Date }[]> {
    return db
      .select({
        slug: blog_posts.slug,
        published_at: blog_posts.published_at,
        updated_at: blog_posts.updated_at,
      })
      .from(blog_posts)
      .where(and(eq(blog_posts.is_published, true), isNull(blog_posts.deleted_at)))
      .orderBy(sql`${blog_posts.published_at} DESC NULLS LAST`)
      .limit(Math.min(limit, 5000));
  }

  // ────────────────────────────────────────── post ↔ tag (in-module FK ok)
  async setPostTags(postId: string, tagIds: string[], txOrDb: DbOrTx = db) {
    await txOrDb.transaction(async (tx) => {
      await tx.delete(blog_post_tags).where(eq(blog_post_tags.post_id, postId));
      if (tagIds.length === 0) return;
      await tx.insert(blog_post_tags).values(tagIds.map((tid) => ({ post_id: postId, tag_id: tid })));
    });
  }

  async listTagsForPost(postId: string): Promise<BlogTagRow[]> {
    const rows = await db
      .select({ tag: blog_tags })
      .from(blog_post_tags)
      .innerJoin(blog_tags, eq(blog_post_tags.tag_id, blog_tags.id))
      .where(eq(blog_post_tags.post_id, postId));
    return rows.map((r) => r.tag);
  }

  // ──────────────────────── post ↔ product (« Cités dans l'article », soft link)
  /** Replace a post's cited-product links, preserving the given order. */
  async setPostProducts(postId: string, productIds: string[], txOrDb: DbOrTx = db) {
    const ids = [...new Set(productIds.filter(isUuid))];
    await txOrDb.transaction(async (tx) => {
      await tx.delete(blog_post_products).where(eq(blog_post_products.post_id, postId));
      if (ids.length === 0) return;
      await tx.insert(blog_post_products).values(
        ids.map((pid, i) => ({ post_id: postId, product_id: pid, display_order: i })),
      );
    });
  }

  /** The ordered product ids cited by ONE post (for the admin editor). */
  async listProductIdsForPost(postId: string): Promise<string[]> {
    const rows = await db
      .select({ product_id: blog_post_products.product_id })
      .from(blog_post_products)
      .where(eq(blog_post_products.post_id, postId))
      .orderBy(asc(blog_post_products.display_order));
    return rows.map((r) => r.product_id);
  }

  /** The ordered product ids cited by SEVERAL posts (enrich a list of cards). */
  async findProductIdsForPosts(postIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (postIds.length === 0) return out;
    const rows = await db
      .select({ post_id: blog_post_products.post_id, product_id: blog_post_products.product_id })
      .from(blog_post_products)
      .where(inArray(blog_post_products.post_id, postIds))
      .orderBy(asc(blog_post_products.display_order));
    for (const r of rows) {
      const list = out.get(r.post_id) ?? [];
      list.push(r.product_id);
      out.set(r.post_id, list);
    }
    return out;
  }

  /**
   * OFFSET-paginated published-post listing for the crimson blog redesign
   * (numbered pages need a total). Filters by category (id) and/or tag (id via
   * EXISTS), sorted « Récents » (published_at DESC) or « Populaires » (approved
   * top-level comment count DESC). Omits the heavy `body`. Search is served
   * separately by `searchPublishedPosts` (relevance).
   */
  async listPublishedPaged(opts: {
    categoryId?: string;
    tagId?: string;
    sort?: BlogListSort;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ items: BlogPostListRow[]; total: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 12, 1), 50);
    const offset = Math.max(opts.offset ?? 0, 0);
    const conds = [eq(blog_posts.is_published, true), isNull(blog_posts.deleted_at)];
    if (opts.categoryId) conds.push(eq(blog_posts.category_id, opts.categoryId));
    if (opts.tagId)
      conds.push(
        sql`EXISTS (SELECT 1 FROM ${blog_post_tags} pt WHERE pt.post_id = ${blog_posts.id} AND pt.tag_id = ${opts.tagId})`,
      );
    const where = and(...conds);
    const popCount = sql`(SELECT count(*) FROM ${blog_comments} c WHERE c.post_id = ${blog_posts.id} AND c.status = 'approved' AND c.deleted_at IS NULL AND c.parent_id IS NULL)`;
    const order =
      opts.sort === "popular"
        ? [sql`${popCount} DESC`, sql`${blog_posts.published_at} DESC NULLS LAST`, desc(blog_posts.id)]
        : [sql`${blog_posts.published_at} DESC NULLS LAST`, desc(blog_posts.id)];
    const [items, totalRows] = await Promise.all([
      db.select(BLOG_POST_LIST_COLUMNS).from(blog_posts).where(where).orderBy(...order).limit(limit).offset(offset),
      db.select({ n: count() }).from(blog_posts).where(where),
    ]);
    return { items: items as BlogPostListRow[], total: Number(totalRows[0]?.n ?? 0) };
  }

  /**
   * Published posts carrying a given tag (by tag id). Joins post_tags → posts,
   * filters to published + non-deleted, newest first. Modelled on the
   * category listing path in `listPosts` but scoped via the N-N join. Returns
   * a simple list (no cursor) — tag archives are low-volume browse surfaces.
   */
  async listPublishedPostsByTagId(
    tagId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{ items: BlogPostRow[]; nextCursor: string | null }> {
    const limit = Math.min(opts.limit ?? 24, 100);
    const conds = [
      eq(blog_post_tags.tag_id, tagId),
      eq(blog_posts.is_published, true),
      isNull(blog_posts.deleted_at),
    ];
    if (opts.cursor) {
      // Composite keyset "<published_at_iso>__<uuid>", same as listPosts.
      const sep = opts.cursor.lastIndexOf("__");
      const iso = sep >= 0 ? opts.cursor.slice(0, sep) : opts.cursor;
      const cursorId = sep >= 0 ? opts.cursor.slice(sep + 2) : "";
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime()) && isUuid(cursorId)) {
        conds.push(sql`(${blog_posts.published_at}, ${blog_posts.id}) < (${d}, ${cursorId}::uuid)`);
      }
    }
    const rows = await db
      .select({ post: blog_posts })
      .from(blog_post_tags)
      .innerJoin(blog_posts, eq(blog_post_tags.post_id, blog_posts.id))
      .where(and(...conds))
      .orderBy(sql`${blog_posts.published_at} DESC NULLS LAST`, desc(blog_posts.id))
      .limit(limit + 1);
    const items = rows.map((r) => r.post);
    const hasMore = items.length > limit;
    const trimmed = hasMore ? items.slice(0, limit) : items;
    const last = trimmed[trimmed.length - 1];
    return {
      items: trimmed,
      nextCursor: hasMore && last?.published_at ? `${last.published_at.toISOString()}__${last.id}` : null,
    };
  }

  async findTagsForPosts(postIds: string[]): Promise<Map<string, BlogTagRow[]>> {
    if (postIds.length === 0) return new Map();
    const rows = await db
      .select({ postId: blog_post_tags.post_id, tag: blog_tags })
      .from(blog_post_tags)
      .innerJoin(blog_tags, eq(blog_post_tags.tag_id, blog_tags.id))
      .where(inArray(blog_post_tags.post_id, postIds));
    const out = new Map<string, BlogTagRow[]>();
    for (const r of rows) {
      if (!out.has(r.postId)) out.set(r.postId, []);
      out.get(r.postId)!.push(r.tag);
    }
    return out;
  }
}

export const blogService = new BlogService();

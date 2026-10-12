import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { isUuid } from "@/lib/utils/uuid";
import { primeCdnBase } from "./cdn-base";
import { media, type MediaRow } from "./schema";
import { escapeLike } from "./sql-util";
import { resolveMediaUrl, resolveMediaSocialUrl, resolveMediaAlt } from "./url-resolver";

/** A resolved media reference: its public URL + the Médiathèque alt text. */
/** `width`/`height` are the stored source dimensions (null when unknown) — optional so
 *  callers that build their own maps stay compatible; renderers use them to tell a
 *  square product packshot (contain) from a lifestyle photo (cover). */
export type ResolvedMedia = { url: string; alt: string | null; width?: number | null; height?: number | null };

export async function findMediaByIds(ids: string[]): Promise<Map<string, MediaRow>> {
  if (ids.length === 0) return new Map();
  // Callers (products/cms loaders) feed these rows straight into the sync
  // resolvers, so prime the effective CDN base here too — guarantees
  // getCdnBaseSync() sees the DB value before resolution.
  await primeCdnBase();
  const rows = await db
    .select()
    .from(media)
    .where(and(inArray(media.id, ids), isNull(media.deleted_at)));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Internal single-id lookup — the body backing `resolveUrlById` below. Not
 * exported: external single-id reads go through `mediaService.findById`, and
 * single-id URL resolution through `resolveUrlById`; nothing consumes a
 * `mediaQueries.findById`.
 */
async function findById(id: string): Promise<MediaRow | null> {
  const [row] = await db
    .select()
    .from(media)
    .where(and(eq(media.id, id), isNull(media.deleted_at)))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve a single media id to its public URL — convenience wrapper so
 * callers don't need to import the resolver separately. Returns null when
 * the media row is missing or has no usable URL.
 */
export async function resolveUrlById(id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  // Prime the effective CDN base (DB cdn_base_url → MEDIA_CDN_URL env) so the
  // sync resolver below rewrites /cdn/<key> through the CDN when configured.
  await primeCdnBase();
  const row = await findById(id);
  return resolveMediaUrl(row);
}

/**
 * Batch variant: resolves a set of media ids to a Map<id, url>. Used by
 * enrichment passes that hydrate multiple rows at once (blog, CMS).
 */
export async function resolveUrlMap(ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(ids.filter((x): x is string => Boolean(x))));
  if (unique.length === 0) return out;
  await primeCdnBase();
  // Project only the URL fields the resolver reads — these run on hot paths
  // (cart/checkout/list/OG) and SELECT * pulled ~21 cols incl. size/mime/key.
  const rows = await db
    .select({
      id: media.id,
      url: media.url,
      url_override: media.url_override,
      webp_url: media.webp_url,
      avif_url: media.avif_url,
      original_url: media.original_url,
    })
    .from(media)
    .where(and(inArray(media.id, unique), isNull(media.deleted_at)));
  for (const row of rows) {
    const url = resolveMediaUrl(row);
    if (url) out.set(row.id, url);
  }
  return out;
}

/**
 * Compat sibling of {@link resolveUrlMap} — resolves each id with the
 * AVIF-AVOIDING {@link resolveMediaSocialUrl}. Use this for images that end
 * up in `og:image`, JSON-LD `image`, emails, or any other context a non-Next
 * consumer (social scraper, Google rich results, mail client) must render,
 * where AVIF isn't reliably supported. On-page `<Image>` callers can use the
 * result too — Next still up-negotiates the webp source to AVIF in-browser.
 */
export async function resolveSocialUrlMap(ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(ids.filter((x): x is string => Boolean(x))));
  if (unique.length === 0) return out;
  await primeCdnBase();
  // Project only the URL fields the resolver reads (see resolveUrlMap).
  const rows = await db
    .select({
      id: media.id,
      url: media.url,
      url_override: media.url_override,
      webp_url: media.webp_url,
      avif_url: media.avif_url,
      original_url: media.original_url,
    })
    .from(media)
    .where(and(inArray(media.id, unique), isNull(media.deleted_at)));
  for (const row of rows) {
    const url = resolveMediaSocialUrl(row);
    if (url) out.set(row.id, url);
  }
  return out;
}

/**
 * Like {@link resolveUrlMap} but also carries each media row's Médiathèque alt
 * text → `Map<id, { url, alt }>`. Use when the resolved image is RENDERED (so
 * the `alt` attribute should come from the Médiathèque, falling back to a
 * semantic name on the consumer side), not just referenced. AVIF-first
 * (display) URL — pair with on-page `<Image>`.
 */
export async function resolveUrlAltMap(
  ids: readonly string[],
): Promise<Map<string, ResolvedMedia>> {
  const out = new Map<string, ResolvedMedia>();
  const unique = Array.from(new Set(ids.filter((x): x is string => Boolean(x))));
  if (unique.length === 0) return out;
  await primeCdnBase();
  const rows = await db
    .select({
      id: media.id,
      url: media.url,
      url_override: media.url_override,
      webp_url: media.webp_url,
      avif_url: media.avif_url,
      original_url: media.original_url,
      alt_text: media.alt_text,
      width: media.width,
      height: media.height,
    })
    .from(media)
    .where(and(inArray(media.id, unique), isNull(media.deleted_at)));
  for (const row of rows) {
    const url = resolveMediaUrl(row);
    if (url) out.set(row.id, { url, alt: resolveMediaAlt(row), width: row.width, height: row.height });
  }
  return out;
}

/**
 * AVIF-AVOIDING sibling of {@link resolveUrlAltMap} — pairs the
 * {@link resolveMediaSocialUrl} URL (webp-first, never AVIF) with the
 * Médiathèque alt. Use for images that double as `og:image` / JSON-LD `image`
 * (blog, CMS) but are ALSO rendered on-page and so want a real `alt`.
 */
export async function resolveSocialUrlAltMap(
  ids: readonly string[],
): Promise<Map<string, ResolvedMedia>> {
  const out = new Map<string, ResolvedMedia>();
  const unique = Array.from(new Set(ids.filter((x): x is string => Boolean(x))));
  if (unique.length === 0) return out;
  await primeCdnBase();
  const rows = await db
    .select({
      id: media.id,
      url: media.url,
      url_override: media.url_override,
      webp_url: media.webp_url,
      avif_url: media.avif_url,
      original_url: media.original_url,
      alt_text: media.alt_text,
    })
    .from(media)
    .where(and(inArray(media.id, unique), isNull(media.deleted_at)));
  for (const row of rows) {
    const url = resolveMediaSocialUrl(row);
    if (url) out.set(row.id, { url, alt: resolveMediaAlt(row) });
  }
  return out;
}

/**
 * A media's storage-key BASE: `<scope>/<uuid>-<name>` with the final `.<ext>`
 * stripped. Every variant key (`.jpg` / `.webp` / `.avif` / `.original.<ext>`)
 * shares this base, and the random uuid prefix makes it unique — so it is the
 * stable substring to look for inside rich-HTML bodies. JS mirror of the SQL
 * `regexp_replace(storage_key, '\.[A-Za-z0-9]+$', '')` used by {@link bodyRefMatch}.
 */
export function storageKeyBase(storageKey: string): string {
  return storageKey.replace(/\.[A-Za-z0-9]+$/, "");
}

/**
 * Correlated EXISTS over every rich-HTML body column whose TipTap output can
 * embed an inline `<img src="/cdn/<key>">`. The rich-text editor splices the
 * media's PUBLIC URL straight into the body (rich-body-field.tsx) — no media_id —
 * so the `*_media_id` anti-join misses these and the media reads as an ORPHAN.
 * Left unfixed, the destructive reclaim sweep (segments.ts) hard-deletes such a
 * media + purges its object → broken published content + irreversible loss, and
 * the single/bulk delete confirm shows "0 references". Matching is on the
 * storage-key BASE (see {@link storageKeyBase}) so it catches whichever variant
 * key the editor inlined. Correlated on the outer media alias `m`; a leading-`%`
 * ILIKE can't use an index, but these run only on admin/destructive paths over
 * bounded content tables. KEEP IN LOCK-STEP with the three lists below.
 *
 * The pattern is NOT LIKE-escaped (unlike countMediaReferences, which escapes for
 * a single-id confirm count): a `_` in a key base would act as a single-char
 * wildcard here, but that only ever OVER-matches, which is the safe direction (an
 * EXISTS in the orphan/sweep guard only KEEPS an image), and the unique random
 * uuid in every base makes a phantom wildcard match effectively unreachable.
 */
function bodyRefMatch() {
  // SQL mirror of storageKeyBase (`\\.` → a literal backslash-dot in the pattern).
  const base = sql`regexp_replace(m.storage_key, '\\.[A-Za-z0-9]+$', '')`;
  return sql`(
       EXISTS (SELECT 1 FROM blog_posts        WHERE body ILIKE '%' || ${base} || '%')
    OR EXISTS (SELECT 1 FROM products           WHERE description ILIKE '%' || ${base} || '%' OR short_desc ILIKE '%' || ${base} || '%')
    OR EXISTS (SELECT 1 FROM categories         WHERE editorial_body ILIKE '%' || ${base} || '%' OR description ILIKE '%' || ${base} || '%')
    OR EXISTS (SELECT 1 FROM brands             WHERE editorial_body ILIKE '%' || ${base} || '%' OR description ILIKE '%' || ${base} || '%')
    OR EXISTS (SELECT 1 FROM text_sections      WHERE body ILIKE '%' || ${base} || '%')
  )`;
}

/**
 * Correlated EXISTS over the editorial value-prop cards' OPTIONAL custom icon
 * image. `value_props` is a jsonb ARRAY of {icon, iconMediaId?, title, body} on
 * categories AND brands; each card may carry a média uuid
 * `iconMediaId` (set in ValuePropsEditor, resolved at render by
 * resolveValuePropIcons). There is NO `*_media_id` column for it, so the flat
 * anti-join misses it and the image reads as an ORPHAN — leaving the reclaim
 * sweep free to hard-delete an in-use icon. Correlated on the outer media alias
 * `m`; the jsonb value is text, so compare against `m.id::text`. The CASE guard
 * feeds `jsonb_array_elements` only a real array (value_props is only ever an
 * array or NULL, but this stays safe against any malformed row). KEEP IN
 * LOCK-STEP with the three reference functions below.
 */
function valuePropIconMatch() {
  const cards = (col: ReturnType<typeof sql>) =>
    sql`jsonb_array_elements(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END)`;
  return sql`(
       EXISTS (SELECT 1 FROM categories  vpc, ${cards(sql`vpc.value_props`)} vp WHERE vp->>'iconMediaId' = m.id::text)
    OR EXISTS (SELECT 1 FROM brands       vpb, ${cards(sql`vpb.value_props`)} vp WHERE vp->>'iconMediaId' = m.id::text)
  )`;
}

/**
 * The settings keys whose value is a JSON-array of landing "Réassurance" trust
 * cards ({icon, iconMediaId?, title, body}) — one per operator-controlled landing
 * page. Every landing that renders `<ValuePropsEditor name="trust">` MUST be listed
 * here or its custom icons become invisible to orphan/reference tracking (a HIGH
 * data-loss class — see landingTrustIconMatch). Written by save{Boutique,Marques}
 * LandingAction; parsed by parseLandingTrust; resolved at render by the landing pages.
 */
const LANDING_TRUST_KEYS = [
  "storefront.boutique_landing.trust",
  "pages.marques.trust",
] as const;
const LANDING_TRUST_KEYS_SQL = sql.join(
  LANDING_TRUST_KEYS.map((k) => sql`${k}`),
  sql`, `,
);

/**
 * Correlated EXISTS over the /boutique AND /marques landing
 * "Réassurance" trust cards' OPTIONAL custom icon image. Unlike value_props (a
 * jsonb COLUMN on categories/brands), each landing's trust points are
 * stored as a JSON-array STRING under a settings key (see LANDING_TRUST_KEYS), each
 * element a {icon, iconMediaId?, title, body}. The settings anti-join above only
 * matches `key LIKE '%media_id'` (a bare uuid value), so these JSON-blob keys are
 * invisible to it — leaving the reclaim sweep / delete-guard free to hard-delete an
 * in-use trust icon. Restricting to the known keys BEFORE casting means no other
 * (non-JSON) settings value is cast, and the `LIKE '[%'` guard keeps a
 * malformed/legacy value from raising 22P02. KEEP IN LOCK-STEP with the three
 * reference functions below (and with the trust block in countMediaReferences).
 */
function landingTrustIconMatch() {
  return sql`EXISTS (
    SELECT 1 FROM site_settings s
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN s.value LIKE '[%' THEN s.value::jsonb ELSE '[]'::jsonb END
    ) vp
    WHERE s.key IN (${LANDING_TRUST_KEYS_SQL})
      AND vp->>'iconMediaId' = m.id::text
  )`;
}

/**
 * Correlated EXISTS over the HOME block-composer layout (`home.blocks`). Every
 * image an operator places through the composer — a block's desktop/mobile image
 * (config.image/imageMobile.mediaId), a card image (config.cards[].image.mediaId),
 * a testimonial avatar (config.testimonials[].image.mediaId), and the two banner_duo
 * slots (config.bannerId/bannerId2) — lives ONLY inside this one settings row's JSON
 * array, NOT in a `*_media_id` column or a bare-id setting. The substring match covers
 * any UUID in the blob, so a future media-bearing block shape is caught automatically.
 * The generic `key LIKE '%media_id'` anti-join therefore never sees them (wrong key,
 * and the value is a JSON blob), leaving the reclaim sweep / delete-guard free to
 * hard-delete an in-use homepage image — the same data-loss class as
 * landingTrustIconMatch. Média ids are UUIDs, so a substring match against the single
 * `home.blocks` row is exact in practice and OVER-covers safely (it can only ever
 * KEEP a média, never wrongly delete one); scanning one row keeps it cheap. KEEP IN
 * LOCK-STEP with the three reference functions (and the home.blocks term in
 * countMediaReferences).
 */
function homeBlocksMediaMatch() {
  return sql`EXISTS (
    SELECT 1 FROM site_settings s
    WHERE s.key = 'home.blocks'
      AND s.value LIKE '%' || m.id::text || '%'
  )`;
}

/**
 * Correlated EXISTS over the PAGE block-composer layout (`pages.blocks`). Any médiathèque
 * image an operator places in the page composer — a block's desktop/mobile image, a card
 * image, a gallery image, a store photo, etc. — lives inside this JSON column, NOT in the
 * relational hero_sections/cta_sections/pages.og_image_media_id columns the other page
 * matchers cover. Média ids are UUIDs, so the substring match covers ANY id in the blob
 * (future block shapes included) and OVER-covers safely. Same data-loss class as
 * homeBlocksMediaMatch. It deliberately does NOT filter deleted_at: a SOFT-deleted page is
 * restorable, so its media must stay protected (matches the "soft-deleted rows still count"
 * reference-seam invariant; a hard-deleted page has no row and so naturally drops out). KEEP
 * IN LOCK-STEP with the three reference functions (and the pages.blocks term in countMediaReferences).
 */
function pageBlocksMediaMatch() {
  return sql`EXISTS (
    SELECT 1 FROM pages pb
    WHERE pb.blocks LIKE '%' || m.id::text || '%'
  )`;
}

/**
 * Correlated EXISTS over the composable mega-menu (`nav_items.config` JSONB). An
 * image block an operator places in a nav root's dropdown builder stores its
 * média id(s) inside this JSON column (NOT a *_media_id column). Média ids are
 * UUIDs, so the substring match covers any id in the blob (future block shapes
 * included) and OVER-covers safely. Same data-loss class as homeBlocksMediaMatch.
 * KEEP IN LOCK-STEP with the three reference functions (and the nav_items.config
 * term in countMediaReferences).
 */
function navItemsConfigMediaMatch() {
  return sql`EXISTS (
    SELECT 1 FROM nav_items ni
    WHERE ni.config IS NOT NULL
      AND ni.config::text LIKE '%' || m.id::text || '%'
  )`;
}

/**
 * The orphan predicate is split into two halves — a CHEAP, index-backed candidate
 * prune ({@link orphanCandidateWhere}) and the EXPENSIVE, un-indexable body/JSON
 * matchers ({@link orphanBodyWhere}) — so {@link listOrphans} / {@link countOrphans}
 * can run the prune FIRST (in a MATERIALIZED CTE) and apply the expensive half to
 * only the survivors. It is one logical conjunction (candidate AND body): because
 * AND is commutative, evaluating the cheap half first yields the IDENTICAL orphan
 * set, but on a handful of rows instead of the whole media table. (The old flat
 * predicate let the planner run the per-row leading-`%` ILIKE body matchers over
 * all ~8k media BEFORE the selective anti-joins, so the admin Médiathèque orphans
 * tab timed out at the 10s pool budget — ~130s on a 2.5k-product catalogue.)
 *
 * The two halves together are shared by list + count so they can never disagree.
 */

/**
 * CHEAP half of the orphan anti-join: `deleted_at IS NULL` + a NOT EXISTS over
 * every column that soft-links to media — the `*_media_id` columns and the
 * product_media FK, plus `%media_id` settings. Each is a partial-index or
 * tiny-table probe, so together they prune the whole media table down to a few
 * candidates in milliseconds. Add a new `*_media_id` source HERE as it lands —
 * missing one only over-counts orphans (safe for this half) — and mirror it into
 * {@link listReferencedMediaIds} (there a missing source is NOT safe: the
 * destructive sweeps would delete an in-use image) and {@link countMediaReferences}.
 */
function orphanCandidateWhere() {
  return sql`
    -- Most reference tables soft-link to media via a *text* column (no
    -- enforced FK) while media.id is uuid, and raw SQL has no implicit
    -- text↔uuid coercion — so those rows cast the outer id (m.id::text). The
    -- exception is product_media.media_id, a real uuid FK column, so it
    -- compares directly (= m.id). Casting the outer id (not the indexed
    -- columns) keeps the per-column partial indexes usable.
    m.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM product_media       pm  WHERE pm.media_id      = m.id)
      AND NOT EXISTS (SELECT 1 FROM products            pr  WHERE pr.video_poster_media_id = m.id::text)
      AND NOT EXISTS (SELECT 1 FROM products            pr2 WHERE pr2.og_image_media_id = m.id::text)
      AND NOT EXISTS (SELECT 1 FROM product_variants    pv  WHERE pv.image_media_id = m.id::text)
      AND NOT EXISTS (SELECT 1 FROM brands              b   WHERE b.logo_media_id  = m.id::text OR b.hero_media_id = m.id::text OR b.og_image_media_id = m.id::text OR b.icon_media_id = m.id::text)
      AND NOT EXISTS (SELECT 1 FROM categories          c   WHERE c.hero_media_id  = m.id::text OR c.og_image_media_id = m.id::text OR c.icon_media_id = m.id::text OR c.boutique_image_media_id = m.id::text)
      AND NOT EXISTS (SELECT 1 FROM banners             ba  WHERE ba.image_media_id = m.id::text OR ba.image_mobile_media_id = m.id::text)
      AND NOT EXISTS (SELECT 1 FROM pages               p   WHERE p.og_image_media_id = m.id::text)
      AND NOT EXISTS (SELECT 1 FROM hero_sections       hs  WHERE hs.image_media_id = m.id::text)
      AND NOT EXISTS (SELECT 1 FROM cta_sections        cs  WHERE cs.background_image_media_id = m.id::text)
      AND NOT EXISTS (SELECT 1 FROM blog_posts          bp  WHERE bp.featured_image_media_id = m.id::text)
      AND NOT EXISTS (SELECT 1 FROM authors             aut WHERE aut.avatar_media_id = m.id::text)
      -- Settings that store a média id (e.g. seo.og_image_media_id). Matched by
      -- key suffix so any future *_media_id setting is covered automatically.
      AND NOT EXISTS (SELECT 1 FROM site_settings       ss  WHERE ss.key LIKE '%media_id' AND ss.value = m.id::text)
  `;
}

/**
 * EXPENSIVE half of the orphan anti-join: the references that CANNOT use an index
 * — inline rich-HTML body refs ({@link bodyRefMatch}, a leading-`%` ILIKE) and the
 * JSON-blob seams (value-prop / landing-trust icons, home/page block composers,
 * mega-menu config). Correlated on the outer media alias `m`; applied by
 * {@link listOrphans} / {@link countOrphans} only to the small candidate set from
 * {@link orphanCandidateWhere} (via a MATERIALIZED CTE), so these per-row scans run
 * on a handful of rows, not the whole media table. KEEP each matcher in lock-step
 * with {@link listReferencedMediaIds} + {@link countMediaReferences}.
 */
function orphanBodyWhere() {
  return sql`
    -- Inline rich-HTML body references (no media_id — matched on the key base).
    NOT ${bodyRefMatch()}
      -- Editorial value-prop custom icon images (value_props jsonb iconMediaId).
      AND NOT ${valuePropIconMatch()}
      -- Landing (boutique/marques) trust-card custom icons (settings JSON iconMediaId).
      AND NOT ${landingTrustIconMatch()}
      -- Home block-composer images (home.blocks JSON: block/card images + banner_duo slots).
      AND NOT ${homeBlocksMediaMatch()}
      -- Page block-composer images (pages.blocks JSON: block/card/gallery images).
      AND NOT ${pageBlocksMediaMatch()}
      -- Composable mega-menu images (nav_items.config JSON: dropdown image blocks).
      AND NOT ${navItemsConfigMediaMatch()}
  `;
}

/**
 * Media rows that aren't referenced by any catalog/CMS/blog record (the
 * {@link orphanMediaWhere} anti-join), newest first, capped at `limit`.
 *
 * Returns the same `MediaRow` shape as the other list helpers so it can
 * substitute into the admin panel without further plumbing. Pair with
 * {@link countOrphans} to tell the operator when the cap hides older orphans.
 */
export async function listOrphans(limit = 200): Promise<MediaRow[]> {
  const rows = await db.execute<{
    id: string;
    kind: "image" | "video" | "document" | "other";
    storage_key: string;
    url: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    width: number | null;
    height: number | null;
    alt_text: string | null;
    uploaded_by: string | null;
    webp_url: string | null;
    webp_size_bytes: number | null;
    avif_url: string | null;
    avif_size_bytes: number | null;
    original_url: string | null;
    original_size_bytes: number | null;
    original_mime_type: string | null;
    url_override: string | null;
    created_at: Date;
    updated_at: Date;
    deleted_at: Date | null;
  }>(sql`
    WITH cand AS MATERIALIZED (
      SELECT m.*
      FROM media m
      WHERE ${orphanCandidateWhere()}
    )
    SELECT m.*
    FROM cand m
    WHERE ${orphanBodyWhere()}
    ORDER BY m.created_at DESC
    LIMIT ${limit}
  `);
  // Drizzle hands back snake_case rows from raw SQL; map back into the
  // ORM-typed MediaRow shape so callers see the same field names regardless
  // of which list helper they used.
  return rows.rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    storage_key: r.storage_key,
    url: r.url,
    filename: r.filename,
    mime_type: r.mime_type,
    size_bytes: Number(r.size_bytes),
    width: r.width,
    height: r.height,
    alt_text: r.alt_text,
    uploaded_by: r.uploaded_by,
    webp_url: r.webp_url,
    webp_size_bytes: r.webp_size_bytes !== null ? Number(r.webp_size_bytes) : null,
    avif_url: r.avif_url,
    avif_size_bytes: r.avif_size_bytes !== null ? Number(r.avif_size_bytes) : null,
    original_url: r.original_url,
    original_size_bytes: r.original_size_bytes !== null ? Number(r.original_size_bytes) : null,
    original_mime_type: r.original_mime_type,
    url_override: r.url_override,
    created_at: new Date(r.created_at),
    updated_at: new Date(r.updated_at),
    deleted_at: r.deleted_at !== null ? new Date(r.deleted_at) : null,
  }));
}

/**
 * Total orphan count (same {@link orphanMediaWhere} anti-join as
 * {@link listOrphans}, uncapped) — the Médiathèque orphans view loads only the
 * newest `listOrphans(200)`, so this lets it say « N affichés sur M » instead of
 * presenting the capped page as every orphan.
 */
export async function countOrphans(): Promise<number> {
  const res = await db.execute<{ n: number | string }>(sql`
    WITH cand AS MATERIALIZED (
      SELECT m.id, m.storage_key
      FROM media m
      WHERE ${orphanCandidateWhere()}
    )
    SELECT count(*)::int AS n
    FROM cand m
    WHERE ${orphanBodyWhere()}
  `);
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * Batched, positive twin of the {@link listOrphans} anti-join: the subset of
 * `ids` that ANY catalog/CMS/blog/settings record still references.
 *
 * Destructive sweeps (the data-job clean segments, the purge, the headless
 * demo clear) filter their candidate média through this AFTER deleting their
 * own owning rows — so the rows being deleted in the same job no longer count
 * as references, while an image another entity still uses (a banner visual
 * reused as a home-block image, a packshot picked as a category hero…) is kept.
 * Crucially it also stops a hard media delete from firing the
 * `product_media.media_id ON DELETE CASCADE` on a live product's gallery row.
 *
 * Soft-deleted consumer rows still count (they can be restored), exactly like
 * listOrphans. Non-uuid ids are ignored (never referenced as far as this goes —
 * and they'd break the uuid comparison). Chunked so a large sweep stays far
 * below Postgres's 65535 bind-parameter cap.
 *
 * KEEP THE SOURCE LIST IN SYNC with listOrphans + countMediaReferences.
 */
export async function listReferencedMediaIds(ids: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const unique = Array.from(new Set(ids.filter((id) => isUuid(id))));
  const CHUNK = 5000;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    // Same casting rule as listOrphans: product_media.media_id is a real uuid
    // FK (= m.id); every other source is a soft text link (= m.id::text).
    const res = await db.execute<{ id: string }>(sql`
      SELECT m.id
      FROM media m
      WHERE m.id IN (${sql.join(batch.map((id) => sql`${id}`), sql`, `)})
        AND (
             EXISTS (SELECT 1 FROM product_media       pm  WHERE pm.media_id      = m.id)
          OR EXISTS (SELECT 1 FROM products            pr  WHERE pr.video_poster_media_id = m.id::text)
          OR EXISTS (SELECT 1 FROM products            pr2 WHERE pr2.og_image_media_id = m.id::text)
          OR EXISTS (SELECT 1 FROM product_variants    pv  WHERE pv.image_media_id = m.id::text)
          OR EXISTS (SELECT 1 FROM brands              b   WHERE b.logo_media_id  = m.id::text OR b.hero_media_id = m.id::text OR b.og_image_media_id = m.id::text OR b.icon_media_id = m.id::text)
          OR EXISTS (SELECT 1 FROM categories          c   WHERE c.hero_media_id  = m.id::text OR c.og_image_media_id = m.id::text OR c.icon_media_id = m.id::text OR c.boutique_image_media_id = m.id::text)
          OR EXISTS (SELECT 1 FROM banners             ba  WHERE ba.image_media_id = m.id::text OR ba.image_mobile_media_id = m.id::text)
          OR EXISTS (SELECT 1 FROM pages               p   WHERE p.og_image_media_id = m.id::text)
          OR EXISTS (SELECT 1 FROM hero_sections       hs  WHERE hs.image_media_id = m.id::text)
          OR EXISTS (SELECT 1 FROM cta_sections        cs  WHERE cs.background_image_media_id = m.id::text)
          OR EXISTS (SELECT 1 FROM blog_posts          bp  WHERE bp.featured_image_media_id = m.id::text)
          OR EXISTS (SELECT 1 FROM authors             aut WHERE aut.avatar_media_id = m.id::text)
          OR EXISTS (SELECT 1 FROM site_settings       ss  WHERE ss.key LIKE '%media_id' AND ss.value = m.id::text)
          -- Inline rich-HTML body references (no media_id — matched on the key base).
          OR ${bodyRefMatch()}
          -- Editorial value-prop custom icon images (value_props jsonb iconMediaId).
          OR ${valuePropIconMatch()}
          -- Landing (boutique/marques) trust-card custom icons (settings JSON iconMediaId).
          OR ${landingTrustIconMatch()}
          -- Home block-composer images (home.blocks JSON: block/card images + banner_duo slots).
          OR ${homeBlocksMediaMatch()}
          -- Page block-composer images (pages.blocks JSON).
          OR ${pageBlocksMediaMatch()}
          -- Composable mega-menu images (nav_items.config JSON).
          OR ${navItemsConfigMediaMatch()}
        )
    `);
    for (const r of res.rows) out.add(r.id);
  }
  return out;
}

/**
 * The subset of bucket `keys` that an ORDER LINE still displays.
 *
 * Order lines snapshot the RESOLVED image URL at purchase time
 * (`order_items.product_image_url` / `variant_image_url` = resolveMediaThumbUrl
 * → `/cdn/<key>`, or `<cdn base>/<key>` when a CDN base was active), never a
 * media id — so the media tombstone alone can't keep order history from
 * dangling. Every object purge path (the `cleanup-media-storage` subscriber on
 * media.deleted / media.bulk_deleted, the détourage re-process reaping) skips
 * the keys returned here so the admin order view, the customer's order history
 * and already-sent emails keep their thumbnail.
 *
 * Match = the snapshot URL ENDS WITH `/<encoded key>` (the `publicUrlFor`
 * per-segment encoding), so it holds whatever origin/CDN base was stamped. The
 * join hashes on the last path segment (`<uuid>-<name>.<ext>`, unique thanks to
 * the random UUID prefix) — one pass over order_items per call instead of a
 * per-key scan (the URL columns carry no index); the full-suffix comparison then
 * confirms. A false positive only KEEPS an object (safe direction). Chunked like
 * listReferencedMediaIds to stay far below the bind-parameter cap.
 */
export async function listOrderReferencedStorageKeys(
  keys: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const unique = Array.from(new Set(keys.filter((k) => typeof k === "string" && k !== "")));
  const CHUNK = 2000; // 3 bind params per key
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK).map((key) => {
      const encoded = key
        .replace(/^\/+/, "")
        .replace(/\/+$/, "")
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      return { key, encoded, tail: encoded.slice(encoded.lastIndexOf("/") + 1) };
    });
    const res = await db.execute<{ key: string }>(sql`
      SELECT DISTINCT k.key
      FROM (VALUES ${sql.join(
        batch.map((b) => sql`(${b.key}::text, ${b.encoded}::text, ${b.tail}::text)`),
        sql`, `,
      )}) AS k(key, enc, tail)
      JOIN (
        SELECT u.url
        FROM order_items oi
        CROSS JOIN LATERAL (VALUES (oi.product_image_url), (oi.variant_image_url)) AS u(url)
        WHERE u.url IS NOT NULL AND u.url <> ''
      ) o
        ON regexp_replace(o.url, '^.*/', '') = k.tail
       AND right(o.url, length(k.enc) + 1) = '/' || k.enc
    `);
    for (const r of res.rows) out.add(r.key);
  }
  return out;
}

/**
 * How many consumer records still reference this media id — the inverse of the
 * {@link listOrphans} NOT-EXISTS set. Powers the Médiathèque delete confirm so an
 * admin is warned before deleting an in-use asset (delete is a soft tombstone +
 * S3 purge, so an in-use image silently vanishes from the storefront). Keep the
 * source list in sync with listOrphans + listReferencedMediaIds. product_media.media_id is a real uuid
 * FK (compare ::uuid); the rest are soft text links.
 */
export async function countMediaReferences(mediaId: string): Promise<number> {
  // Inline rich-HTML body references carry no media_id — match on the key base
  // (see bodyRefMatch / storageKeyBase). Fetch the row's storage_key first, then
  // ILIKE the body columns for its base so the confirm warns before an admin
  // purges an image still shown in a published body.
  const [row] = await db
    .select({ storage_key: media.storage_key })
    .from(media)
    .where(eq(media.id, mediaId))
    .limit(1);
  const like = row ? `%${escapeLike(storageKeyBase(row.storage_key))}%` : null;
  const bodyCount = like
    ? sql`
      + (SELECT count(*) FROM blog_posts        WHERE body ILIKE ${like})
      + (SELECT count(*) FROM products          WHERE description ILIKE ${like} OR short_desc ILIKE ${like})
      + (SELECT count(*) FROM categories        WHERE editorial_body ILIKE ${like} OR description ILIKE ${like})
      + (SELECT count(*) FROM brands            WHERE editorial_body ILIKE ${like} OR description ILIKE ${like})
      + (SELECT count(*) FROM text_sections     WHERE body ILIKE ${like})`
    : sql``;
  const res = await db.execute<{ total: number }>(sql`
    SELECT (
        (SELECT count(*) FROM product_media       WHERE media_id = ${mediaId}::uuid)
      + (SELECT count(*) FROM products            WHERE video_poster_media_id = ${mediaId} OR og_image_media_id = ${mediaId})
      + (SELECT count(*) FROM product_variants    WHERE image_media_id = ${mediaId})
      + (SELECT count(*) FROM brands              WHERE logo_media_id = ${mediaId} OR hero_media_id = ${mediaId} OR og_image_media_id = ${mediaId} OR icon_media_id = ${mediaId})
      + (SELECT count(*) FROM categories          WHERE hero_media_id = ${mediaId} OR og_image_media_id = ${mediaId} OR icon_media_id = ${mediaId} OR boutique_image_media_id = ${mediaId})
      + (SELECT count(*) FROM banners             WHERE image_media_id = ${mediaId} OR image_mobile_media_id = ${mediaId})
      + (SELECT count(*) FROM pages               WHERE og_image_media_id = ${mediaId})
      + (SELECT count(*) FROM hero_sections       WHERE image_media_id = ${mediaId})
      + (SELECT count(*) FROM cta_sections        WHERE background_image_media_id = ${mediaId})
      + (SELECT count(*) FROM blog_posts          WHERE featured_image_media_id = ${mediaId})
      + (SELECT count(*) FROM authors             WHERE avatar_media_id = ${mediaId})
      + (SELECT count(*) FROM site_settings       WHERE key LIKE '%media_id' AND value = ${mediaId})
      -- Editorial value-prop custom icons (value_props jsonb iconMediaId) on
      -- categories / brands.
      + (SELECT count(*) FROM categories  vpc WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(vpc.value_props) = 'array' THEN vpc.value_props ELSE '[]'::jsonb END) vp WHERE vp->>'iconMediaId' = ${mediaId}))
      + (SELECT count(*) FROM brands       vpb WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(vpb.value_props) = 'array' THEN vpb.value_props ELSE '[]'::jsonb END) vp WHERE vp->>'iconMediaId' = ${mediaId}))
      -- Landing (boutique/marques) trust-card custom icons (settings JSON iconMediaId).
      + (SELECT count(*) FROM site_settings s
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN s.value LIKE '[%' THEN s.value::jsonb ELSE '[]'::jsonb END) vp
           WHERE s.key IN (${LANDING_TRUST_KEYS_SQL}) AND vp->>'iconMediaId' = ${mediaId})
      -- Home block-composer images (home.blocks JSON: block/card images + banner_duo slots).
      + (SELECT count(*) FROM site_settings WHERE key = 'home.blocks' AND value LIKE '%' || ${mediaId} || '%')
      -- Page block-composer images (pages.blocks JSON). No deleted_at filter: a soft-deleted
      -- page is restorable, so its media still counts (lock-step with pageBlocksMediaMatch).
      + (SELECT count(*) FROM pages WHERE blocks LIKE '%' || ${mediaId} || '%')
      -- Composable mega-menu images (nav_items.config JSON: dropdown image blocks).
      + (SELECT count(*) FROM nav_items WHERE config IS NOT NULL AND config::text LIKE '%' || ${mediaId} || '%')
      ${bodyCount}
    )::int AS total
  `);
  return Number(res.rows[0]?.total ?? 0);
}

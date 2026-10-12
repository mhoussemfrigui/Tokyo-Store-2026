import { boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { id, softDelete, timestamps } from "@/lib/db/columns";

/**
 * Editorial AUTHOR profiles (« Auteurs », migration 0184).
 *
 * A pool of schema.org Person entities that blog posts reference for authorship
 * (blog_posts.author_id, DB-enforced FK ON DELETE SET NULL). The profile is the
 * CORE of authorship SEO: a DURABLE @id (`${siteUrl}/auteur/<slug>#person`)
 * referenced by each article's `author`, a public archive at `/auteur/<slug>`,
 * and the storefront byline.
 *
 * Distinct from the pre-existing `author_user_id` soft-link on blog_posts (the
 * staff account that SAVED a row) — that stays; this is the admin-chosen byline.
 *
 * Soft link to media.id (avatar, text, no FK — cross-module rule). `same_as` +
 * `expertise` are freeform text, one entry per line, parsed at render
 * (parseSameAs / splitLines) — mirrors products.same_as. Per-author SEO
 * overrides feed the SHARED buildPageMetadata + jsonld pipeline, exactly like
 * blog categories.
 */
export const authors = pgTable(
  "authors",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** Short editorial biography (plain text) → Person.description. */
    bio: text("bio"),
    /** e.g. "Rédacteur tech" → Person.jobTitle. */
    job_title: text("job_title"),
    /** Areas of expertise, one per line → Person.knowsAbout (E-E-A-T). */
    expertise: text("expertise"),
    /** Avatar — soft link to media.id; doubles as the archive hero + Person.image / OG. */
    avatar_media_id: text("avatar_media_id"),
    /** Social / canonical profile URLs, one per line → Person.sameAs (via parseSameAs). */
    same_as: text("same_as"),
    /** Per-author SEO overrides for the /auteur/<slug> archive page. */
    meta_title: text("meta_title"),
    meta_description: text("meta_description"),
    canonical_url: text("canonical_url"),
    noindex: boolean("noindex").notNull().default(false),
    /** Hide from the public author list + article selector without deleting. */
    is_active: boolean("is_active").notNull().default(true),
    ...timestamps(),
    ...softDelete(),
  },
  (table) => ({
    slugUnique: uniqueIndex("authors_slug_unique").on(table.slug),
    activeIdx: index("authors_active_idx").on(table.is_active),
  }),
);

export type AuthorRow = typeof authors.$inferSelect;
export type NewAuthorRow = typeof authors.$inferInsert;

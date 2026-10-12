# CMS content model

How content is stored. Two storage shapes coexist:

- **Typed relational tables** — banner placements, FAQ targets and nav items each
  get typed columns in dedicated tables, with every parent→child relationship a real
  `ON DELETE CASCADE` foreign key (enforced in the squash baseline —
  [`src/lib/db/migrations/0000_squash_baseline.sql`](../src/lib/db/migrations/0000_squash_baseline.sql)).
- **Instance-based block composers** — the **home page** (`home.blocks` setting) and
  every **CMS page** (`pages.blocks` column, migration 0175) store an ordered JSON
  array of `{ id, type, visible, config }` blocks. This is the successor to the old
  relational `page_sections`; those tables are kept **read-only** so a page that
  predates the composer renders identically until an operator saves it (see
  [Pages](#pages--block-composer)). Every block field is re-validated + coerced on save
  (unknown types dropped, stable ids, a 40-block cap), and média ids embedded in the
  JSON are tracked by a dedicated matcher in all three media-reference seams
  ([media.md](media.md)), so the orphan sweep never hard-deletes an in-use image.

> **Editing surface** — every entity in this document is editable from the admin
> panel (and creatable, except the fixed-key nav menus — only a missing one can
> be re-created — and the singleton banners, which are created on first save).
> Image fields use the central
> `<MediaPicker>` (see [media.md](media.md)). Slug fields are editable with
> server-side uniqueness checks. The admin CMS routes live under `/admin/cms/*`:
> - **Page builder** — [`/admin/cms/pages`](../src/app/admin/cms/pages/page.tsx)
>   lists pages as cards, split into **Système** (`is_system`: editable, not deletable,
>   slug locked — see [System / legal pages](#system--legal-pages)), **Personnalisées**
>   (create/delete), and **Gérées ailleurs** (Boutique / Marques — vitrine landings composed in their own section, linked not duplicated).
>   [`/admin/cms/pages/[id]`](../src/app/admin/cms/pages/%5Bid%5D/page.tsx) is the
>   **block composer** (`PageMetaForm` + `PageComposer`): add blocks from a grouped
>   palette, reorder / toggle / remove, edit each block's config, and save the whole
>   layout to `pages.blocks` through `savePageBlocksAction`. A new page is created as a
>   **draft**; it can't be published until it has ≥1 **visible** block (or, for a system
>   slug, its built-in default), and a deleted page's slug stays reserved (the slug
>   checker also sees soft-deleted pages).
> - **Navigation builder** — split into two pages over the shared
>   `MenuCard` / `NavItemRow` / `NavMenuRenameForm` editor
>   ([`_components/nav-menu-editor.tsx`](../src/app/admin/cms/_components/nav-menu-editor.tsx)),
>   each using the shared `<LinkTargetPicker>` for internal targets. Menus are
>   fixed-key **system menus** ([`lib/cms/nav-menus.ts`](../src/lib/cms/nav-menus.ts)):
>   there is no menu create/delete UI beyond re-creating a missing system key,
>   and `updateNavMenuAction` only renames one (the key is immutable):
>   - [`/admin/cms/nav-menu`](../src/app/admin/cms/nav-menu/page.tsx) ("Nav Menu") —
>     the COMPOSABLE header mega-menu builder (`NavBuilder`): per-root link / icon /
>     visibility + a dropdown composed in blocks (categories / brands [logos|titres]
>     / products / image / free links), column count and mobile
>     visibility, stored in `nav_items` + a `config` JSONB per root and saved
>     replace-all via `saveHeaderNavAction`. (The former featured panels + `nav.*`
>     label overrides are legacy — imagery is now an image block in the config.)
>   - [`/admin/cms/footer`](../src/app/admin/cms/footer/page.tsx) ("Footer") —
>     a `FooterContentForm` (→ `saveFooterAction`) editing the footer SUBSET of
>     `site.*`/`social.*` (identity/logo, multi-value contact lists, socials) +
>     the `storefront.footer.*` appearance (tone / newsletter style / social
>     style / show-toggles); the `footer-shop` / `footer-support` / `footer-society`
>     column menus; the `maison-explore` index (foot of the Maison/legal pages); and
>     the `footer`-placement newsletter banner. Each column heading is its menu
>     name (« Renommer »; a leading `Footer — ` is dropped; blank → Boutique /
>     Support / Société). Missing column menus are recreated with the one-click
>     « Créer les colonnes du footer » (« Créer les colonnes manquantes » when
>     only some are missing; nothing creates them at boot). The Kawn
>     copyright is fixed (not editable).
> - **Banners** — [`/admin/cms/banners`](../src/app/admin/cms/banners/page.tsx)
>   (+ `/[id]` edit) for the `home_hero`, `header_strip` and `category_grid`
>   placements; the `footer` and `nav_*` singletons are edited only from their
>   own pages above.
> - **Settings** — [`/admin/cms/settings`](../src/app/admin/cms/settings/page.tsx)
>   (per-group "setting" forms), plus a dedicated
>   [`/admin/cms/home`](../src/app/admin/cms/home/page.tsx) panel that edits the
>   homepage-block settings, and
>   [`/admin/cms/showcase`](../src/app/admin/cms/showcase/page.tsx) for the
>   collection/vitrine pages (a separate `showcase` module — see
>   [modules.md](modules.md), out of scope here).
>
> FAQ content has no dedicated admin route — product/category FAQs are edited
> inline from the product and category forms (see [FAQ](#faq) below).

## Why fully relational?

A `content jsonb` column is convenient at insert time and terrible
everywhere else:

- You can't `WHERE` on a structured value efficiently.
- You can't add a `CHECK` constraint that says "every CTA section must
  have an href".
- You can't `JOIN` on a media id buried 4 levels deep.
- You can't diff two versions in a meaningful way.
- You can't localise individual fields without a custom rewrite.
- You can't add a column to a *type* of section without touching every
  row.

The relational design pays one-time cost (more tables) for permanent
gains (queryable, typed, indexable, auditable, localisable).

## Modules overview

All six surfaces live under [`src/modules/cms`](../src/modules/cms) and are
re-exported through the parent barrel
[`src/modules/cms/index.ts`](../src/modules/cms/index.ts).

| Module                | What it stores                                              |
| --------------------- | ----------------------------------------------------------- |
| `cms/page`            | Pages + sections + per-type section tables                  |
| `cms/banner`          | Banners with placement + scheduling                         |
| `cms/navigation`      | Nav menus + items (self-ref for nesting)                    |
| `cms/faq`             | FAQ categories + items targeted at help / category / product |
| `cms/setting`         | Typed key/value site-wide settings                          |
| `cms/trust_badge`     | Reassurance strip (per-badge icon + label + ordering); strip-wide appearance/placement in `storefront.trust_badges.*`. Renders on product/cart/checkout via the shared `TrustStrip` — distinct from the home/landing « Réassurance » editorial block |

Per the module convention (see [modules.md](modules.md)), each sub-module's
`queries.ts` is re-exported as `<name>Queries` (`pageQueries`, `bannerQueries`,
`navQueries`, `settingQueries`) while `service.ts` stays internal. Two surfaces
deviate: `cms/faq` and `cms/trust_badge` expose no `queries.ts` — their reads go
through `faqService` / `trustBadgeService` directly.

## Pages — block composer

Schema: [`src/modules/cms/page/schema.ts`](../src/modules/cms/page/schema.ts).
Block model: [`src/lib/pages/page-blocks.ts`](../src/lib/pages/page-blocks.ts)
(page catalog) over the shared [`block-model.ts`](../src/lib/pages/block-model.ts)
core; reader/resolver: [`page-blocks-data.ts`](../src/lib/pages/page-blocks-data.ts);
renderer: [`page-blocks-render.tsx`](../src/components/storefront/page/page-blocks-render.tsx).

A page's body is an ordered JSON array of blocks stored in `pages.blocks`
(`[{ id, type, visible, config }]`). The page block catalog is `hero`, `rich_text`,
`editorial`, `quote`, `cta_band`, `banner`, `stats`, `timeline`, `gallery`,
`fifty_fifty`, `feature_cards`, `trust`, `steps`, `faq`, `contact_channels`,
`stores`, `jobs`, `product_grid`, `categories`, `brands`. The composer
exposes only the fields each block type (and its chosen layout) actually renders
(`headerFields(type, layout)` / `ALIGN_AWARE` in the composer), so an operator never
fills a field that silently does nothing.

**Layouts.** Most blocks carry a per-type `layout` variant (`PAGE_BLOCK_LAYOUTS` in
`page-blocks.ts`), which is what lets pages built from one catalog look genuinely
different — e.g. `hero` centered / statement (typographic, founding-year watermark,
chapter index) / split (text + visual) / compact; `rich_text` split (sticky heading
column) / centered (documents); `stats` grid / row / ledger; `timeline` vertical /
rail; `steps` cards / ladder / vertical; `trust` cards / plain / tiles (clickable) /
numbered; `stores` atlas / salons; `contact_channels` concierge / strip. The FIRST
variant is the default and reproduces the previous look, and parsing runs on read, so
a stored block without a `layout` renders unchanged. Shared extras: `accent` (italic
gold second line of a title), `chapter` (gold numeral), `anchor` (section id for
`#ancre` links), `imageFit` (cover a photo / contain a packshot on a « vitrine »
panel), `chips`, `points`, secondary CTAs. Unset CTA links normalise to `""` (never
a dead `href="#"`).

**Backend-linked blocks.** `contact_channels` renders phone / WhatsApp / e-mail /
hours / address LIVE from the « Identité & contact » settings (`site.*`; a channel
whose setting is blank is hidden); `stores` derives a Google Maps embed + directions
link from each address (or takes a validated embed URL) and can link a card to a
`pickup_locations` row whose name / address / phone / hours then win; `jobs` builds
`mailto:` applications to `applyEmail` or, when blank, `site.contact_email`; `stats`
items can be live (`brands` = active brand count, `years_since` = years since a year).
`resolvePageBlocks` fetches settings / pickups / the brand count only when a visible
block needs them.

**Layout & tone.** Every block renders in the canonical 1400px container on a
12-column grid (no narrow centred islands); sections are separated by tone classes
(`tk-tone-surface` / `-muted` / `-olive` / `-dark` / `-brand` in `globals.css` — the
dark and brand tones re-declare the palette locally so every token-driven child flips
automatically). A leading `hero` or concierge `contact_channels` renders the page
`<h1>`; otherwise an editorial masthead does.

### Read / fallback chain

`getPageForRender(slug)` / `getEditBlocks(page)` follow a non-destructive chain so a
page is never blank and a legacy page is never mutated until saved:

1. a **non-null** `pages.blocks` is authoritative — even `"[]"` (an operator who
   cleared the composer): the legacy sections are **not** resurrected;
2. a **null** `blocks` column (a page never saved in the composer) **synthesises**
   blocks from the visible legacy `page_sections` below (non-destructive rollover);
3. a **system legal slug** (cgu/cgv/cookies/privacy/mentions-legales/help) falls back
   to its built-in default HTML as a single `rich_text` block, so it is live out of
   the box;
4. otherwise (unpublished custom slug) → `null`.

`resolvePageBlocks` then resolves every block's média + catalogue data in batched
round-trips. Locked by
[`page-render-fallback.test.ts`](../src/lib/db/tests/page-render-fallback.test.ts).

### Legacy sections (read-only)

Pages that predate the composer still carry relational sections, kept **read-only**
purely so they render via synthesis (there is **no section write path** any more —
the admin section editor and its workflows were removed). Each `page_sections` row
declares its `type`; the data lives in a per-type table keyed by the same
`page_section_id` (uuid v7, `ON DELETE CASCADE`).

```
pages
  ↓ id  (page_sections.page_id → pages.id  ON DELETE CASCADE)
page_sections
  ├─ id (= page_section_id below)
  ├─ page_id
  ├─ type     ('hero' | 'text' | 'cta' | 'stats' | 'timeline' | 'product_list' | 'banner_grid')
  ├─ display_order
  └─ is_visible
       ↓  (each subtype's page_section_id → page_sections.id  ON DELETE CASCADE)
   ┌───┴────────────────────────────────────────────────┐
   ↓                       ↓                            ↓
hero_sections         text_sections             stats_sections
  ├─ page_section_id    ├─ page_section_id         ├─ page_section_id (PK)
  │   (uuid PK, FK)     ├─ heading                 ├─ heading
  ├─ eyebrow            ├─ body  (HTML, sanitized) └─ layout
  ├─ title (NOT NULL)   └─ alignment                     ↓ (FK ON DELETE CASCADE)
  ├─ subtitle                                     stats_section_items
  ├─ description                                     ├─ id
  ├─ image_media_id                                  ├─ stats_section_id
  ├─ primary_cta_label                               ├─ label
  ├─ primary_cta_href                                ├─ value
  ├─ secondary_cta_label                             ├─ caption
  └─ secondary_cta_href                              └─ display_order
```

`cta_sections` carries `title`, `description`, `primary_cta_label/href` (both
NOT NULL), `background_image_media_id`, and `style`. `timeline_sections` is a
bare `heading` plus `timeline_section_items` children (`year`, `title`,
`description`, `display_order`) — also a cascade FK. The `product_list` and
`banner_grid` enum values exist but are **dormant**: no admin UI creates them and
the renderer ignores them.

> The `stats_section_items` / `timeline_section_items` FKs point at the
> **parent's `page_section_id`** (`stats_sections.page_section_id`,
> `timeline_sections.page_section_id`), which is that table's PK — not at
> `page_sections` directly.

Writes go through the `workflows.cms` page workflows
([`workflows/cms/page.ts`](../src/workflows/cms/page.ts)): `createPage` (always a
draft), `updatePage` (slug / title / SEO meta / canonical / noindex),
`savePageBlocks` (the composer layout), `togglePagePublish` (guarded: ≥1 visible
block, or visible legacy sections, or a system default), and `deletePage`. Page
edits and block saves both emit `page.updated { pageId, slug, changedFields }`
(block saves with `changedFields: ["blocks"]`), plus `page.created`,
`page.published`, `page.unpublished`, `page.deleted`. `page.section.changed`
remains a catalogued webhook event but is no longer emitted (no section write path).

### Rendering

Every page surface shares one pipeline:
`getPageForRender(slug)` → `resolvePageBlocks(forRender)` →
[`<PageBlocksRenderer>`](../src/components/storefront/page/page-blocks-render.tsx),
which renders each visible block through the page layout kit
([`blocks/kit.tsx`](../src/components/storefront/page/blocks/kit.tsx): `PageSection`,
`HeadRow`, `Title`, `MediaFrame`, `CtaPair`, …) plus the client islands
`store-atlas.tsx` (map follows the selected boutique) and `job-board.tsx` (team
filter + expandable offers). `rich_text` HTML is sanitised at render.

Consumers: the dedicated legal / Maison file routes (`/cgu`, `/cgv`, `/cookies`,
`/privacy`, `/mentions-legales`, `/about`, `/notre-histoire`, `/service-client`,
`/nos-boutiques`, `/carrieres`) render through
[`LegalPageRenderer`](../src/components/legal-page-renderer.tsx), which drives the
shared block pipeline (`getPageForRender → resolvePageBlocks → PageBlocksRenderer`);
`/help` ([`(shop)/help/page.tsx`](../src/app/(shop)/help/page.tsx)) calls that same
block pipeline directly and appends its own settings-driven contact/showroom
sections below the body; every other published page is served at `/<slug>` by the
polymorphic `(shop)/[slug]` resolver (also through the block pipeline).

### System / legal pages

Two sources make these pages live out of the box:

- **Built-in defaults** —
  [`lib/legal/system-page-content.ts`](../src/lib/legal/system-page-content.ts)
  (`SYSTEM_PAGE_SLUGS`: `cgu`, `cgv`, `cookies`, `privacy`, `mentions-legales`,
  `help`). The block pipeline falls back to them whenever a page has no visible
  blocks (and no synthesisable visible sections), so an emptied or all-hidden
  published shell never blanks the legal text. Other slugs fall back to a
  neutral public placeholder (the route's hint, or « Cette page sera bientôt
  disponible. » — a hint naming an `/admin` path is never printed).
- **Boot seeding** —
  [`lib/bootstrap/system-content-pages.ts`](../src/lib/bootstrap/system-content-pages.ts)
  (`ensureSystemContentPages`, run from `instrumentation.ts` on every boot; copy
  in `system-content-pages.data.ts`) seeds the Maison pages (`notre-histoire`,
  `service-client`, `nos-boutiques`, `carrieres`, `about`), the policy pages
  (`garantie-retours`, `suivi-de-commande`, served by `/[slug]`) and the full
  `cgv`. Missing page → inserted + published; an existing pristine shell (no
  sections, never published or edited) → populated; anything an admin edited or
  emptied → skipped. Each page is written in one transaction under a per-slug
  advisory lock, and every live row's `is_system` flag is re-synced from the
  data. `help` + the five legal pages were seeded by migration `0061`.

`is_system` pages are editable but not deletable (`forbidden`), and their slug
is locked (the file routes depend on it).

### Adding a new block type

No migration — blocks live in the `pages.blocks` JSON, so a new type is pure code:

1. Add the literal to `PAGE_BLOCK_TYPES` + a `PAGE_BLOCK_META` entry (label / hint /
   palette group) in [`page-blocks.ts`](../src/lib/pages/page-blocks.ts).
2. Extend `parsePageBlockConfig` there to coerce the new config fields (reuse the
   shared coercers in [`block-model.ts`](../src/lib/pages/block-model.ts) — `asStr`,
   `parseHeader`, `parseImage`, `parseCard`, `parsePresentation`, … — so every field
   is bounded and safe).
3. Implement its editor in
   [`page-composer.tsx`](../src/app/admin/cms/pages/%5Bid%5D/page-composer.tsx), and
   list its real header fields in `HEADER_FIELDS` / `ALIGN_AWARE` so the composer
   exposes only what the renderer uses.
4. Add its `case` to
   [`page-blocks-render.tsx`](../src/components/storefront/page/page-blocks-render.tsx)
   (and to `blocksToMarkdown` in
   [`generate.ts`](../src/lib/seo/markdown/generate.ts) if it carries text, so the
   `/md` twin stays complete).
5. If the config embeds a média id in a NEW shape the resolver doesn't already gather,
   extend `resolvePageBlocks` — and confirm `pageBlocksMediaMatch()` still covers it
   (it LIKE-scans the whole JSON, so UUID ids are covered automatically). Seeds that
   reference images (`heroImageRef(n)` / `mediaFileRef("file.jpg")` in
   `system-content-pages.data.ts`) need the new slot in `resolveConfigMedia` too.
6. A new layout variant: add it to the type's `*_LAYOUTS` list + `PAGE_BLOCK_LAYOUTS`
   label (append — index 0 must stay the backward-compatible default).

Seeded block pages are written by `ensureSystemContentPages` only when missing or a
pristine shell; refresh a dev DB with `scripts/seed-system-pages.ts` (export the
`.env.development.local` DATABASE_URL first).

That's the entire workflow. No schema change, no migration.

## Banners

Schema: [`src/modules/cms/banner/schema.ts`](../src/modules/cms/banner/schema.ts).
Single `banners` table with a `placement` enum (`home_hero`, `header_strip`,
`category_grid`, `footer`, `checkout`, plus the mega-menu featured-image
placements `nav_boutique` / `nav_marques` / `nav_maison` — the enum also retains
the legacy `nav_collection` / `nav_fidelite` labels) and a soft-delete column. Filtered live at
request time via `bannerService.listLive(placement)`:

```sql
SELECT * FROM banners
WHERE placement = $1
  AND is_active = TRUE
  AND deleted_at IS NULL
  AND (start_at IS NULL OR start_at <= NOW())
  AND (end_at   IS NULL OR end_at   >  NOW())
ORDER BY display_order;
```

Scheduling is just the `start_at` / `end_at` timestamp columns (the comparison
runs on Postgres's `now()`). No cron, no separate publishing queue. The admin
enters dates in store time (Africa/Tunis, `parseStoreLocalDateTime`); clearing a
date input stores `NULL` (an absent field leaves it untouched), and an end at or
before the start is refused (it would never match `listLive`).

`category_grid` banners also carry in-grid targeting: `target_kind`
(`none` = global | `category` | `brand` | `filter`, CHECK
`banners_target_kind_chk`), `target_ref` (the category/brand slug or filter
attribute id) and `after_load_more_count` (the cadence N, default 2).
`bannerService.listGridBannersForListing` returns the global rows plus those
targeting the listing (a parent-category target cascades to its sub-categories).
Their **position** is operator-controlled per banner via `grid_position`
(migration 0177, CHECK `banners_grid_position_chk`): `top` pins it ABOVE the
listing (the client renders every `top` banner there); `after_load_more` shows
it once at the first block boundary; `after_rows` interperses it every N blocks
(the legacy cadence). The pure rule lives in
[`banner-rotation.ts`](../src/lib/listing/banner-rotation.ts)
(`gridBannerSchedule` / `isBannerDueAtBlock`, shared with the listing client +
its unit tests); migration 0177 backfilled the lowest-`display_order` grid
banner to `top` to preserve the previous "first banner pinned" behaviour.

### 0177 enhancements (Bannières source-of-truth)

[`src/lib/cms/banner-model.ts`](../src/lib/cms/banner-model.ts) is the pure model
shared by the admin form, the workflow validation and the storefront renderers.
The form (`src/components/admin/banner-form.tsx`) gates every field per placement
so it only ever collects what the matching renderer reads (no form↔render
conflicts):

- **Editable buttons** (`buttons`, home hero) — a JSON array `[{label, href,
  variant}]` superseding the legacy `cta_* / secondary_cta_*` columns. `variant`
  is one of `primary | secondary | onyx | ghost | link | on-photo`, mapped to the
  shared button system via `BANNER_BUTTON_STYLE`. `parseBannerButtons` sanitises
  (safe-href, drops label-or-link-less rows, caps at `MAX_BANNER_BUTTONS` = 4). A
  **non-NULL `buttons` column is AUTHORITATIVE** — `effectiveBannerButtons` returns
  it even when it's an empty `[]` (so an operator can clear a hero's CTAs); it
  falls back to synthesising from the legacy `cta_* / secondary_cta_*` columns
  ONLY when `buttons` is NULL (a pre-0177 hero never re-saved through the editor).
- **With/without text + video** (`show_text`, `video_url`, home hero) —
  `show_text=false` is a pure image/video slide (the headline stays as an sr-only
  `<h1>` for SEO; the whole slide links to the first button). `video_url` is a
  **hosted external video URL** (sanitised on read), NOT a média id — the
  médiathèque pipeline is image-only, so there is no `video_media_id` FK and no
  media-orphan seam for it; the still image is the poster + reduced-motion fallback.
- **Desktop + mobile visuals** — `image_media_id` + `image_mobile_media_id` (both
  médiathèque-linked, tracked across the 3 `media/queries.ts` seams), art-directed
  by hero + `category_grid`. The strip (text bar) and footer (newsletter) render
  **no image at all**, so their form has no image tab.
- **Header strip style** (`strip_tone` CHECK olive|dark|gold|burgundy,
  `strip_icon` emoji/glyph, `show_countdown` → a live countdown to `end_at`) —
  rendered in [`site-header.tsx`](../src/components/site-header.tsx).

**What each placement's renderer actually reads** (the form collects exactly this,
no dead inputs): `home_hero` → eyebrow/title/subtitle/description, image(+mobile),
video, buttons; `category_grid` → eyebrow/title/subtitle, image(+mobile), one CTA
(label+link), targeting+position; `header_strip` → title (the message), tone/icon/
countdown, a link (wraps the message); `footer` (newsletter) → eyebrow/title/
subtitle + the newsletter button LABEL only (no image, description, or link);
`nav_*` → eyebrow/subtitle/title, image, featured-panel link.

The `checkout` placement is deprecated (no storefront consumer, and removed from
the create/update zod enum — only the DB enum keeps it for any legacy row). The
`footer` placement is a `navigation`-governed **singleton** owned by CMS → Footer;
the generic banner CRUD list hides it and `/admin/cms/banners/[id]` redirects it
to its editor. The five `nav_*` placements are **LEGACY**: the composable Nav Menu
builder now owns the header and stores dropdown imagery in `nav_items.config`
image blocks, so `nav_*` banners no longer drive the storefront (the boot seed
`ensureHeaderNavRoots` migrated each existing `nav_*` banner into an image block
once). They are not offered as new placements; the `setNavFeaturedWorkflow` is
now DORMANT (no admin/seed caller), kept only as an injection-safety-tested guard.

`bannerQueries` exposes `listHomeHeroSlides`, `listHeaderStripBanners`,
`listFooterBanners` and the
targeting-aware `listGridBannersForListing(opts)`; the storefront reaches them
through the API seam below, which resolves `image_media_id` → URL and sanitises
every CTA href.

## Catalogues (showcase pages)

Admin: [`/admin/cms/showcase`](../src/app/admin/cms/showcase/page.tsx) ("Contenu &
Design → **Catalogues**"). The three strategy-driven collection pages — **Nouveautés**
(`/nouveautes`, new arrivals), **Top ventes** (`/top-ventes`, best sellers) and
**Promotions** (`/promotions`, on sale). The slug list is the single source of truth in
[`collection-slugs.ts`](../src/lib/pages/collection-slugs.ts) (spread into RESERVED_ROUTES
and `SYSTEM_PAGES`); the typed, settings-backed config is
[`collection-page-config.ts`](../src/lib/pages/collection-page-config.ts).

Each page stores `pages.<slug>.*` site_settings and (separately) manual product pins in
the `showcase_pins` table. The strategy is intrinsic to the slug (not editable); the admin
tunes:

- **Content** — `visible` (off ⇒ a 404 AND removal from the nav/link pickers +
  sitemap), `eyebrow` / `title` / `subtitle`, an optional CTA (`cta_label` / `cta_href`),
  a hero image (`hero_media_id`, médiathèque), and the `meta_title` / `meta_description` /
  `noindex` SEO.
- **Selection** — `limit` (1–100), manual `pins` (render first, in order; a deleted /
  unpublished pin is skipped), `window_days` (best-sellers only — the sales window) and
  `promo_strategy` (promotions only — engine / compare-at / both). See `listShowcaseProducts`.
- **Presentation + content** — `default_sort` (seeds the listing's initial sort), an
  editable **empty-state** (`empty_title` / `empty_body`, rendered when the page has no
  products), and an opt-in **closing CTA band** (`show_closing_cta` + `cta_band_*`,
  rendered at the foot). Both pieces of copy are threaded through `renderShowcaseClassic`
  into `CategoryPageClient` as hide-when-unset `showcaseEmpty` / `showcaseCtaBand` props.

**Render:** the pages reuse the shared `CategoryPageClient` (full grid + filters + sort +
« Charger plus ») via `renderShowcaseClassic` ((shop)/[slug]/page.tsx); there is no bespoke
showcase component. **Lockstep contract:** a key in the save action's field list
([`showcase-settings.ts`](../src/lib/actions/showcase-settings.ts) `COMMON_FIELDS` /
`EXTRA_FIELDS`) MUST have a matching panel input AND a config read, or it is NULL-overwritten
every save (the old `design_variant` / `grid_*` trap) — pinned by `showcase-lockstep.test.ts`.

## Navigation

Schema:
[`src/modules/cms/navigation/schema.ts`](../src/modules/cms/navigation/schema.ts).
`nav_menus` is keyed by `key` (the four menus actually consumed: `main`,
`footer-shop`, `footer-support`, `footer-society` — the mobile header reuses
`main`, there is no separate `mobile` menu). These are the fixed-key system
menus of [`lib/cms/nav-menus.ts`](../src/lib/cms/nav-menus.ts)
(`SYSTEM_NAV_MENU_KEYS`): the data-job « Nettoyer › Navigation » keeps them
(emptied) and deletes every other menu. `nav_items` has a self-referencing `parent_id` for
nesting. FKs in the baseline: `nav_items.menu_id → nav_menus.id` **ON DELETE
CASCADE**, and `nav_items.parent_id → nav_items.id` **ON DELETE SET NULL** (so
deleting a parent promotes its children rather than dropping them).

Each item links either via a free-form `href` or a typed internal target
(`internal_kind` + `internal_ref`, where `ref` is the target slug):

| internal_kind | internal_ref | resolved to   |
| ------------- | ------------ | ------------- |
| `system`      | `promotions` | `/promotions` |
| `category`    | `consoles`   | `/consoles`   |
| `brand`       | `sony`       | `/sony`       |
| `page`        | `livraison`  | `/livraison`  |
| `product`     | `ps5-edge`   | `/ps5-edge`   (legacy kind) |

**Every entity — brands included — shares the flat
`/[slug]` namespace.** The `[slug]` resolver handles brands directly;
`/brand/[slug]` redirects there.
Resolution is centralised in `resolveLinkHref()`
([`src/lib/links/link-target.ts`](../src/lib/links/link-target.ts)), shared by
nav items and promo chips, and a manual `href` always wins over the internal
pair. `product` is a retained-for-compat kind (no longer offered in the picker)
that still resolves to the flat namespace.

`navQueries.getMenu("main")`
([queries.ts](../src/modules/cms/navigation/queries.ts)) returns the item tree
with `resolvedHref` pre-filled. The storefront header consumes the **`main`**
menu, and the footer reads `footer-shop` / `footer-support` / `footer-society`
(see the recap below). Both readers drop links whose category / brand /
**CMS page** target is deactivated, deleted or unpublished (it would 404) unless
an active redirect still serves the stored URL (e.g. a renamed slug) —
[`lib/cms/nav-link-liveness.ts`](../src/lib/cms/nav-link-liveness.ts); the admin
editor flags such dead items (a `page`-kind ref is checked against the published-slug set, so
to keep a system-default page linked even while unpublished, store it as a plain `/slug` href
rather than an internal `page` ref).

## FAQ

Schema: [`src/modules/cms/faq/schema.ts`](../src/modules/cms/faq/schema.ts).
Two tables: `faq_categories` (slug + name + order, for grouping help-center
entries) and `faqs`. Targeting is by **dedicated uuid columns**, not by a
slug-encoded scope string:

| Populated column | Where it shows                                       |
| ---------------- | ---------------------------------------------------- |
| `product_id`     | The matching product page (`/[slug]` PDP, Avis-style FAQ block) |
| `category_id`    | The matching category page                           |
| `brand_id`       | The matching brand page (`/[slug]`)                  |
| neither (NULL)   | Help-scoped (legacy `scope = 'help'` rows)           |

`faq_category_id`, `product_id`, `category_id`, and `brand_id`
are **soft FKs** (uuid, no `REFERENCES`) so a cross-module delete can't cascade
FAQ rows unexpectedly. The CHECK `faqs_scope_target_chk` enforces the invariant
that **at most one** of `product_id` / `category_id` / `brand_id`
is non-null (`num_nonnulls(...) <= 1`; widened for `brand_id` in migration 0018, then narrowed back to these three in 0204 when `collection_id` was dropped). The legacy `scope` text column is
retained (default `'help'`) for back-compat; new per-entity FAQs leave `scope` at
its default and populate the matching id column instead.

Read helpers ([service.ts](../src/modules/cms/faq/service.ts)):
`faqService.listByProductId` / `listByCategoryId` / `listByBrandId` — all **id-keyed**, not slug-keyed. (The legacy `scope`
column is retained for back-compat but is no longer read through a dedicated
helper — every live read is id-keyed.)

There is no dedicated FAQ admin: each per-entity FAQ set is edited inline from
that entity's admin form — product (`faqService.replaceForProduct`), category
(`replaceForCategory`), brand (`replaceForBrand`) — all idempotent, soft-deleting the old set and
re-inserting inside one transaction.

## Settings

Schema: [`src/modules/cms/setting/schema.ts`](../src/modules/cms/setting/schema.ts).
The `site_settings` table is a typed key/value store. The `type` enum
(`text | number | boolean | media`) tells the admin form what editor to render
and the consuming code how to parse:

| type      | Storage  | Parse                                  |
| --------- | -------- | -------------------------------------- |
| `text`    | string   | as-is                                  |
| `number`  | string   | `Number(v)`                            |
| `boolean` | string   | `v === "true"`                         |
| `media`   | string   | a `media.id` UUID — resolve URL on read |

Settings are grouped by `group_key` (e.g. `site`, `contact`, `social`, `nav`,
`home`, `checkout`) so the admin lists them in tidy sections; the key prefix
(`site.`, `nav.`, `home.`, `theme.`, `seo.`, `checkout.`, `auth.`, …) names the
owning panel. Many subsystems read their copy from here and **hide the surface
when the value is unset** (hide-when-unset) rather than printing a placeholder.

Read in app code via the React-`cache()`-wrapped whole-table read
([queries.ts](../src/modules/cms/setting/queries.ts)) — every helper that needs
settings in one request shares a single `SELECT`:

```ts
const settings = await settingQueries.getSettingsMap();
const phone   = settings["site.contact_phone"] ?? "";
const free    = Number(settings["checkout.delivery.free_threshold_cents"] ?? 0);
```

The map carries every panel's keys, including `*_enc` ciphertext: admin pages
pass a client panel only its own slice (`pickSettings(map, prefixes)`,
[`lib/settings/pick-settings.ts`](../src/lib/settings/pick-settings.ts)), and a
failed read reaches the error boundary instead of pre-filling the form with
defaults a save would persist (fail-closed).

**Writes** go through `workflows.cms.upsertSetting`
([`workflows/cms/setting.ts`](../src/workflows/cms/setting.ts)), which takes an
optional `{ actorUserId, actorIp }` context (admin actions always pass the
acting user). It runs the `site.*` validators (contact email/phone,
`seo.site_url`, `site.map_embed_url` — an https Google Maps embed URL only) and
**skips both the write and the `setting.upserted` event** when the stored row
is identical, so a panel save only audits the keys that changed. Security-relevant
keys ([`lib/cms/sensitive-settings.ts`](../src/lib/cms/sensitive-settings.ts):
`seo.site_url`, `site.mode`, `consent.enabled`, `redirects.enabled`,
`site.whatsapp`, `site.map_embed_url`, the `auth.*` (minus page copy),
`checkout.payment.*` and `site.contact_*` namespaces, and any `*.href` /
`*_href` / `*_url` destination) carry `from` / `to` on the event and are
audited at `warn` severity; secret-bearing keys (`*_enc`, password, secret,
token, api_key) never carry values.

> Naming reminder: a `*_cents` setting (or column) holds **millimes**, not
> centimes — 1 TND = 1000. The `_cents` suffix is a never-renamed legacy name.
> The single source of truth is [`src/lib/price.ts`](../src/lib/price.ts)
> (`MINOR_PER_DINAR = 1000`); see also the money section of
> [database.md](database.md).

Media-typed settings resolve through the API seam: the **site logo** is
`site.logo_media_id`, surfaced by `getSiteLogoUrl()` /
`mediaQueries.resolveUrlById` and falling back to the bundled static asset when
unset or missing. The header top strip is driven by `header_strip`
banners (`listHeaderStripBanners()`), which cycle when more than one is active —
there is no separate `site.announcement` setting.

## Storefront integration

One module-crossing seam, [`src/lib/api/cms.ts`](../src/lib/api/cms.ts) (infra
layer), turns the CMS module reads into flat, render-ready DTOs — resolving
`*_media_id` → URL and sanitising every href so individual page components don't
fan out into the media module. Every function degrades gracefully: a DB outage
returns `[]` / `{}` so the storefront renders fallback chrome instead of 500ing.

The shop chrome is wired in
[`src/app/(shop)/layout.tsx`](../src/app/(shop)/layout.tsx), which fetches header
+ footer data once per request:

| Storefront surface               | Reads through (`lib/api/cms.ts` unless noted)    | Status |
| -------------------------------- | ------------------------------------------------ | ------ |
| Header `main` menu row           | `listMainMenu()` → `navQueries.getMenu("main")` (dead category/brand links pruned) | live |
| Header mega menu (composable)    | `getComposedNavRoots()` ([`lib/api/nav-composer.ts`](../src/lib/api/nav-composer.ts)) — materialized `main` `nav_items` + `config` blocks, resolved against the live catalog (`listCategories()` / active brands / `listProductsForSource`) + média; default roots as fallback | live |
| Header top strip                 | `listHeaderStripBanners()` → `bannerQueries.listHeaderStripBanners()` (cycles when >1) | live |
| Site logo                        | `site.logo_media_id` → `mediaQueries.resolveUrlById` in the layout; `getSiteLogoUrl()` for auth / admin / mail surfaces | live |
| Footer columns                   | `listFooterColumns()` → `navQueries.getMenu("footer-*")`, heading = menu name (`footerColumnTitle`) | live (per-menu, hide-when-empty) |
| Footer banner                    | `listFooterBanners()` → `bannerQueries.listFooterBanners()` | live |
| Footer contact / social / settings | `getAllSettingsServerOnly()` → `settingQueries.getSettingsMap()` (server components only — never serialised to a client; headless `/api/content` uses an allow-listed subset) | live |
| Home hero carousel               | `listHomeHeroSlides()` → `bannerQueries.listHomeHeroSlides()` (in [`(shop)/page.tsx`](../src/app/(shop)/page.tsx)) | live |
| In-grid listing banners          | `listCategoryGridBanners(opts)` → `bannerQueries.listGridBannersForListing(opts)` (global + targeted) | live |
| Trust / reassurance badges       | `trustBadgeService.listActive()` + `getTrustBadgeAppearance(settings)` (layout) → `TrustStrip` on product/cart/checkout; `listActiveTrustBadges()` for headless `/api/content` | live |
| Legal / Maison / custom pages    | `getPageForRender(slug)` → `PageBlocksRenderer` via `LegalPageRenderer` or `/[slug]` (built-in defaults for system slugs) | live |
| `/help` page body + contact      | `getPageForRender("help")` → `PageBlocksRenderer` + `site.*` contact / showroom settings | live |
| Product FAQ block                | `faqService.listByProductId(id)` (in the PDP)    | live   |
| Category FAQ section             | `faqService.listByCategoryId(id)` (in the category page) | live |
| Brand FAQ section                | `faqService.listByBrandId(id)` (in the brand page) | live |

Each surface that has no admin-configured data falls back to neutral/empty output
(hide-when-unset) — never a crash or fabricated copy.

---

Built by **[Kawn Digital Studio](https://kawn.me)** for Tokyo Store. See [CREDITS.md](CREDITS.md).


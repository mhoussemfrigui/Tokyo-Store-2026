# Page d'accueil (home block composer) — verification & scenario matrix

Re-audit + hardening of Tab 1 « Page d'accueil » of Contenu & Design (the instance-based
home block composer + the hero art-directed mobile image). Covers the flagship composer
(`home-blocks*`), its storefront renderer, the admin editor, the Bannières hero seam, and
every cross-tab link. Method: a 9-agent discovery workflow + adversarial verification, plus
hands-on browser (clean `.next` build) and Docker-DB probing.

**Result:** 1 HIGH data-loss (found by hands-on probing, missed by the finder pass) + 1
invalid-HTML/hydration bug (found via console) + 47 verified findings fixed or resolved.
Commits: `8668f09` (fixes), `8a0d52b` (dead-code + relocation), `e173f9a` (hero mobile image).

## Architecture under test

- **Model** `src/lib/pages/home-blocks.ts` — pure: 20-block catalog, `parseHomeBlocks` /
  `serializeHomeBlocks` / `parseBlockConfig` (every field coerced via médiathèque / safe-href
  / enum / clamp guards), `ProductSource` (new / best_sellers / on_promotion / category /
  brand / collection / manual), `BlockPresentation`.
- **Reader/resolver** `src/lib/pages/home-blocks-data.ts` — `getHomeBlocks` (stored
  `home.blocks` OR non-destructive legacy synthesis), `resolveHomeBlocks` (media batched one
  round-trip + products via `listProductsForSource` + shared catalogue lists).
- **Renderer** `home-blocks-render.tsx` + `home-hero.tsx` + `home-rail.tsx` + the shared
  design kit `components/storefront/page/blocks/kit.tsx` (block-primitives.tsx was folded in).
- **Admin** `home-composer.tsx` + `listing-settings-panel.tsx` + `saveHomeBlocksAction`.
- **Hero seam** Bannières module (`banners`, placement `home_hero`), art-directed mobile via
  `image_mobile_media_id` (migr 0174).

## Scenario matrix

Status: ✅ verified pass · 🐛 was a bug, now fixed · 🧪 covered by an automated test.

### A. Block lifecycle (admin composer)
| # | Scenario | Result |
|---|---|---|
| A1 | Load with legacy synthesis (no `home.blocks`) → the current 8 sections appear, editable | ✅ |
| A2 | All 20 block types present in the grouped add-palette | ✅ (browser) |
| A3 | Add / reorder (up/down) / toggle visible / remove / expand a block | ✅ |
| A4 | Save → `home.blocks` persisted; reload → same layout | ✅ 🧪 (round-trip test) |
| A5 | Malformed / non-array / oversized JSON → `[]` (never throws); >40 blocks capped | 🧪 |
| A6 | Duplicate / missing block ids regenerated to unique | 🧪 |

### B. Product sources (product_rail / product_grid)
| # | Scenario | Result |
|---|---|---|
| B1 | `new` → newest published | ✅ |
| B2 | `best_sellers` with sales → ranked; **no sale → hides** (never cold-starts to newest) | ✅ 🧪 |
| B3 | `on_promotion` → promo pool; none → hides | ✅ |
| B4 | `category` / `brand` / `collection` valid slug → products; **invalid/deleted slug → hides** | ✅ (browser) |
| B5 | `manual` valid ids → those products, in order | ✅ |
| B6 | `manual` with a **non-UUID token** → bad token dropped (was: 22P02 blanked the whole rail) | 🐛 🧪 |
| B7 | count clamped (rail 2–24, grid 2–24); card prices match PDP/cart (enriched) | 🧪 ✅ |
| B8 | category/brand/collection cap the id set to ~count **before** enriching (perf) | 🐛 |

### C. Media / médiathèque
| # | Scenario | Result |
|---|---|---|
| C1 | Block / card image resolves to a médiathèque URL | ✅ |
| C2 | **banner_duo** two image slots render (was: rendered nothing — resolver never gathered them) | 🐛 (browser) |
| C3 | **collections / categories** cards show their médiathèque image (was: always gradient) | 🐛 |
| C4 | Invalid / deleted media id → image hidden gracefully | ✅ 🧪 |
| C5 | **Orphan-sweep safety:** a média used ONLY in `home.blocks` (block/card image or duo slot) is protected by all 3 media-reference seams | 🐛 🧪 (DB probe + regression test) |

### D. Personalisation (BlockPresentation)
| # | Scenario | Result |
|---|---|---|
| D1 | Band blocks: background (5 tones) / padding / width (incl. full-bleed) / align / divider | ✅ (browser: dark + full-width confirmed) |
| D2 | Core-component blocks: only light background + divider apply; composer hides the controls that would be ignored | 🐛 |
| D3 | Hero: no presentation controls (full-bleed, component-owned) | ✅ |

### E. Every block type renders + hides-when-empty
| # | Block | Result |
|---|---|---|
| E1–E20 | hero · product_rail · product_grid · banner · banner_duo · collections · categories · brands · fifty_fifty · editorial · cta_band · feature_cards · loyalty_levels · steps · trust · rich_text · faq · **testimonials · stats · spacer** | ✅ (browser: all render; empty/invalid ones hide) |
| E18 | fifty_fifty section header now renders (was editable but ignored) | 🐛 |
| E19 | editorial with image/body but no title renders (was: dropped) | 🐛 |
| E20 | fifty_fifty / feature_cards card with no CTA renders as a plain block (not a `<a href="">`) | 🐛 |

### F. Hero (Bannières-sourced)
| # | Scenario | Result |
|---|---|---|
| F1 | Multiple slides → carousel; no slides → hero hides | ✅ |
| F2 | Desktop-only slide → single image; desktop+mobile → art-directed `<img>` pair (`hidden sm:block` / `sm:hidden`) | ✅ (browser: distinct assets at 375px) |
| F3 | Mobile-only slide → mobile used as the base (was: no background) | 🐛 |
| F4 | Exactly **one `<h1>`**, stable across autoplay (was: slides 2+ downgraded to h2) | 🐛 (browser: h1=1) |
| F5 | LCP image not double-preloaded (mobile layer not `priority`) | 🐛 |

### G. Bannières form (mobile image)
| # | Scenario | Result |
|---|---|---|
| G1 | home_hero: desktop + mobile pickers with per-placement resolution recos | ✅ (browser) |
| G2 | header_strip / category_grid / footer: mobile picker hidden (those don't render a large image) | 🐛 |
| G3 | Create/edit set + clear mobile image; migration 0174 column + index present | ✅ 🧪 |

### H. Invalid-HTML / hydration
| # | Scenario | Result |
|---|---|---|
| H1 | cta_band / banner with a CTA: **no nested `<a>`** (was: BlockCta `<Link>` inside the band `<Link>` → hydration failure) | 🐛 (browser: 0 nested anchors, clean console on fresh build) |

### I. Cross-tab linking & source-of-truth
| # | Scenario | Result |
|---|---|---|
| I1 | Media only via médiathèque; product/category/brand/collection links via the catalog | ✅ |
| I2 | Save revalidates the storefront layout + admin page; home is `force-dynamic` so edits to a referenced entity propagate | ✅ |
| I3 | Listing settings (pagination + help CTA) editable again via the relocated panel; still read by category/brand/collection pages | 🐛 |
| I4 | `saveHomeBlocksAction` now catalogued in the internal-API catalog | 🐛 🧪 |

## Database / performance

- **Migration 0174** applied: `banners.image_mobile_media_id` + partial index present (Docker DB verified).
- **Orphan-sweep coverage** (the data-loss fix): `homeBlocksMediaMatch()` added to all three
  seams (`orphanMediaWhere`, `listReferencedMediaIds`, `countMediaReferences`); FROM-table set
  unchanged so the lockstep guard stays green. DB-probed both the block-image and duo-slot paths.
- **Render-path cost:** `listProductsForSource` now caps category/brand/collection to ~count
  before enrichment instead of enriching the whole tree (up to `MAX_GRID_PRODUCTS`=2000).
- **Known pre-existing** (not introduced here): the orphan/reference scan is an O(media×content)
  correlated scan (~seconds on large catalogues); the new single-row `home.blocks` LIKE adds
  negligibly. Admin-triggered maintenance op, not a hot path.

## Automated tests
- `home-blocks-model.test.ts` (pure, **88 checks**) — parse/serialize/coerce, UUID-gating, caps, round-trip, `accent` + `accentStyle`, testimonials/stats/spacer parse + clamps, the full-bleed `width`/`padding` gate, `separator`/`homeSeam`/`planSeams`, `sourceListingHref`, per-type clamp/slice bounds, `HOME_BLOCK_SEED`.
- `home-blocks-synthesis.test.ts` (DB, 12 checks) — the legacy fresh-install fallback: 8-section order, rail sources, editorial sides, `title_accent` → `accent` mapping.
- `home-blocks-media-coverage.test.ts` (DB, 24 checks) — every media-bearing shape (block image + mobile, card image, both banner_duo slots, a TESTIMONIAL avatar, banner mobile column) is seen by all three média seams (the data-loss class), and the seam still detects real orphans.
- `media-reference-lockstep.test.ts` (pure, 18 checks) — the three media seams cover the same `*_media_id` FROM-tables AND the same JSON-blob matchers (home.blocks / pages.blocks / landing-trust / value-prop), so dropping one from a single function fails CI.
- Both registered in `test:pure` / `test:db`. Existing suites re-run green: media-reference-lockstep, media-orphans-count, storefront-chrome, banner-targeting, data-clean-scoping, internal-api-catalog, test-chain-integrity.

## Deferred (low, intentionally not changed)
- Saving zero blocks stores `[]`, which is kept as the operator's deliberately-empty home (the read path `getHomeBlocks` branches on PRESENCE, so legacy synthesis only fills an ABSENT row). A present-but-UNPARSEABLE payload is rejected by `saveHomeBlocksAction` before it can overwrite the layout.
- A product PICKER for `manual` pins (today a validated free-text id field) — a future enhancement.
- Relocating the listing settings to the Catalogues/Categories tab (their final home) — a future tab pass.

---

## Addendum — 2026-10-03 soft-luxury redesign (editability pass)

Follow-on to the "quiet luxury" home rebuild: ONE ivory ground + soft hairline seams (no
per-block tone), and a push to make everything operator-editable (no hardcoded accents) with
more composable blocks and recommended resolutions on every image input.

- **Three new blocks** (`home-blocks.ts` `HOME_BLOCK_TYPES` + `HOME_BLOCK_META`, group éditorial),
  all browser-verified at desktop + mobile:
  - `testimonials` — gold quote-mark + serif-italic quote, author/meta/optional avatar; 1-up centred
    or `colsFor(items,3)`. Parse slices to 6, drops entries with no quote/author/image.
  - `stats` — big serif tabular figures over small-caps labels under a hairline; `colsFor(items,4)`.
    Parse slices to 4.
  - `spacer` — pure whitespace break; `spacerHeight` sm/md/lg/xl × `spacerOrnament` none/rule(`tk-home-rule`)/mark(✦).
    Takes only the block (no ctx). It is **MEDIA_LED** so it renders with no header.
- **Accent is editable, not hardcoded** — `heading(title, accent)` (now exported pure from
  `home-blocks.ts`) promotes an explicit `accent` field, else the LAST line of a multi-line title.
  The legacy synthesizer maps `title_line3`/`title_accent` → the explicit `accent` field (E1) so
  « À Chaque Instant » etc. are editable in the composer's Accent area (with a live title preview).
  `accentStyle` = `gold` (default, omitted when gold) | `ink` — gold italic vs. foreground, applied
  by `Title`/`HeadRow` (kit) and the FAQ accordion.
- **Per-block full-bleed** — `FULL_BLEED_CAPABLE = {banner, cta_band, banner_duo}`. The composer's
  « Largeur » control (gated on that set) sets `presentation.width` = `default|full`; `full` + the
  « Aucun — collé aux bords » padding option flush the band to its neighbours (`HOME_PT/PB.none` =
  `pt-0/pb-0`, `homePad` returns `"none"`). `renderCta` full branch: photo bleeds 100vw (frame
  `rounded-none`, `lg:aspect-[32/9]`, `HomeSection bleed`) while the **copy stays in `SECTION_CONTAINER`**
  (luxury convention — bleed the image, not the text). Model coerces `width` to `default|full` only for
  bleed-capable types and keeps `padding:"none"` only WITH `width:"full"`.
- **Per-placement ALT override** — `pickImage` already honoured `BlockImage.alt` (block alt → média alt
  → fallback); the composer's `ImageField` now exposes an optional alt input (blank = inherit médiathèque)
  threaded through the banner/editorial image + mobile, card, and testimonial slots.
- **Recommended resolutions on every image input** — `IMAGE_RECO.banner_fullbleed` (« Pleine largeur
  32:9 — 2880×810 ») shown when a band is full-width; count-aware `fifty_fifty` reco (lone card = 21:9);
  `trust` card bumped to `IMAGE_RECO.square` (1000×1000). Catalog-feed forms gained recos too:
  category « Image Boutique » (portrait 4:5, dual-use on /boutique + home Catégories), brand logo
  (transparent PNG/SVG paysage ~400×160) + hero (21:9), collection hero (note the home crop to 4:5/paysage).
- **FAQ polish** — `ProductFaqAccordion` gained an `accent` prop (`olive` default keeps the PDP untouched;
  home passes `gold`/`ink` from `accentStyle`) with firmer answer contrast (`/75` vs the PDP's `/60`).
- **Tests** — `home-blocks-model.test.ts` now **88 checks** (adds `accentStyle`, testimonials/stats/spacer
  parse + clamps, and the full-bleed width/padding gate). `home-blocks-synthesis` (12) +
  `home-blocks-media-coverage` (24, now seeds a testimonial avatar too) re-run green.

**Note (dev-only):** verifying the new blocks + full-bleed requires temporarily writing demo blocks into
the live `home.blocks` setting. Always snapshot the real value first and restore it; a scratchpad backup
file from a PRIOR session is a trap — overwrite it from the current live value before use.

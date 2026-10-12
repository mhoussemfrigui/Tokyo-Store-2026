# Tokyo Store — Code & Architecture Audit (2026-06-25)

> **Status: superseded — point-in-time snapshot (2026-06-25).** This audit
> predates migrations **0088–0097**, which removed several features it documents
> as live (digital products, pre-orders, promo-links, product badge, the
> announcement bar). For the current sign-off see
> [`docs/preprod-signoff.md`](docs/preprod-signoff.md); treat the findings below
> as a historical record and re-verify any against current code before reopening.
>
> A fresh, line-by-line audit of the whole codebase (~1,186 TS/TSX files at the
> time, ~64 K LOC, 38 modules, ~90 admin pages), produced by an
> 11-domain multi-agent sweep in which **every** finding was independently
> re-verified against current code before inclusion. **25 findings confirmed,
> 0 refuted.** None are critical or high — the codebase is structurally sound.
> The earlier point-in-time audits (the June 2026 286-finding scan and the
> 2026-06-10 [`AUDIT-REPORT.md`](AUDIT-REPORT.md)) are **historical** and were
> resolved before this pass; see [Historical audits](#historical-audits).
>
> Of the 25 findings, **6 documentation/comment/content items were fixed in
> this pass** (✅). The other 19 are **admin↔frontend wiring gaps and a couple
> of cleanups that need a product/design decision before code changes** — each
> is documented with file:line, the write→read trace, and a recommendation,
> but intentionally **not** changed unilaterally.

---

## Method & scope

A workflow fanned out **11 domain auditors** — catalog/products,
catalog/taxonomy, CMS content, CMS theme+SEO+tracking, orders/checkout/cart,
marketing/loyalty, system settings, customers/auth/RBAC, media/import/digital,
cross-cutting bugs/dead-code, and docs/comments drift. Each traced every
admin-editable parameter end-to-end: **admin form → Server Action → workflow →
`site_settings`/column → storefront/feed/invoice/SEO consumer.** Every
candidate was then handed to a **separate adversarial verifier** that
re-grepped the setting key (or symbol) across all of `src/` and tried to refute
the claim. Only claims that survived independent confirmation appear here.

Headline question for each setting: *"Does the admin collect/persist a value
that NO storefront, invoice, feed, email, or SEO surface ever reads?"*
(disconnect) — and its inverse, *"Does storefront read a key NO admin panel
writes?"* (orphan-read).

---

## Executive summary

The codebase is in **strong-to-excellent health**. Across all ten functional
domains the dominant pattern is correct end-to-end wiring: admin-collected
settings are validated, persisted, hydrated back on edit, and read by at least
one consumer. The `place-order` workflow is confirmed as the single
authoritative source of order totals, so **every disconnect that touches money
is preview-only and self-corrects server-side** — no finding changes the amount
a customer is actually charged.

The cross-cutting layer (`src/lib`, `src/workflows`, `src/modules`,
`src/events`) was found **essentially free of correctness bugs** after
exhaustive verification. High-risk patterns were specifically probed and
**cleared**: no double-write of audit events, no millimes unit-conversion
errors, no double-award/double-fulfil, no unhandled rejections, no
restock/loyalty double-counting, no place-order race conditions
([details](#verified-safe-patterns-checked--cleared)).

The recurring theme among the 25 findings is the **admin↔frontend setting
disconnect** (10): fields an operator can configure but that no storefront
surface renders or honors. The most material are the entire **promo-links**
panel (label, icon, 7 hex colors, flash animations, scheduling) reaching no
rendered output; the header **"main" nav menu** silently dropping the
`openInNewTab` flag and all nested sub-items; the shared **banner form**
collecting Description + secondary-CTA for every placement while only
`home_hero` reads the description; the per-currency **"Décimales"** field that
never drives price display; and the product **"Ordre d'affichage"**
(`display_order`) saved, hydrated, and copied-on-duplicate yet never used as a
sort key. The related **orphan-read** theme (6) is storefront code reading keys
no admin form writes (home-page SEO title, blog & aide hero copy, five
payment-caption keys, the login subtitle, showcase grid/empty/CTA copy) — all
benign because each reader supplies a hardcoded default, but all representing
editor/storefront drift.

The remaining themes are small: **documentation drift** (6, all fixed this
pass) was confined to stale counts and incomplete inventories, not behavioral
drift; **dead code** (2) is one over-exported wrapper and one
reserved-but-unwired column; **inconsistency** (1) is a display-only checkout
preview. Two findings deserve operator attention despite low/medium severity
because they are *customer-facing on a fresh deploy*: the 404 page shipped
gaming-era **"Game Over"** copy (residual from the de-Game-Zone rename — **fixed
this pass**), and the storefront tiers page advertises the loyalty program even
when its master switch is off.

---

## Findings by severity & category

**By severity (25 confirmed):**

| Severity  | Count |
| --------- | ----- |
| Critical  | 0     |
| High      | 0     |
| Medium    | 13    |
| Low       | 11    |
| Info      | 1     |
| **Total** | **25** |

**By category:**

| Category                    | Count | Fixed | Documented |
| --------------------------- | ----- | ----- | ---------- |
| admin↔frontend disconnect   | 10    | 0     | 10         |
| orphan-read                 | 6     | 0     | 6          |
| documentation/content drift | 6     | 6     | 0          |
| dead code                   | 2     | 0     | 2          |
| inconsistency               | 1     | 0     | 1          |
| **Total**                   | **25**| **6** | **19**     |

> One additional change (not a separate finding) corrected a **misleading
> JSDoc** tied to F14. Net: **9 edits across 7 files** — see
> [Changes applied](#changes-applied-this-pass).

---

## Changes applied this pass

Only documentation, one misleading comment, and one residual brand-content
default were changed — squarely within "update MDs & Comments to match the
current version." **No functional/storefront behavior was altered.**

| File | Change | Finding |
| ---- | ------ | ------- |
| `README.md` | Migration chain `0001…0086`→`0001…0087` (this snapshot; chain has since grown to `0001…0099`, 100 files/entries, next `0100`) | F20 |
| `README.md` | Project-tree comment `webhooks (flouci)` → `(flouci, clictopay)` | F21 |
| `README.md` | Social-login bullet: add Facebook alongside Google | F24 |
| `CREDITS.md` | "Built on": Google **& Facebook** social sign-in | F24 |
| `docs/security.md` | CSP `buildCsp` attributed to `src/lib/security/headers.ts` (was `next.config.ts`) | F23 |
| `docs/modules.md` | Added the missing **`redirects`** module row (table 38→39) | F22 |
| `src/lib/checkout/quick-buy-config.ts` | Corrected JSDoc that falsely claimed 5 payment-caption keys are operator-tunable | F14 |
| `src/lib/redirects/config.ts` | `NOT_FOUND_DEFAULTS` "Game Over" → neutral luxury French copy | F25 |
| `src/app/admin/system/redirects/settings-forms.tsx` | 404 form placeholders "Game Over…" → "Page introuvable…" | F25 |

---

## Detailed findings

Severity: 🟠 medium · 🟡 low · ⚪ info. Status: ✅ fixed this pass · 📋 documented
(needs a product/design decision before a code change).

### A. Admin↔frontend disconnects — saved but never read

#### F1 🟠 📋 Promo-links CMS panel persists data no storefront surface renders
- **Files:** write `src/lib/actions/cms.ts:11-84` → `workflows.cms.createPromoLink/updatePromoLink`; DTO `src/lib/api/cms.ts:151-172`; passed in `src/app/(shop)/layout.tsx:95,239`; **dead read** `src/components/site-header.tsx:46-47,151-152`.
- **Trace:** The `/admin/cms/promo-links` editor collects label, link target, lucide icon, color preset, **7 hex colors**, urgency **flashMode** (pulse/glow/shake) and scheduling. `listPromoLinks()` builds the full DTO and `layout.tsx` passes it to `SiteHeader`, but the header declares `type HeaderPromoLink = { id: string }` ("Accepted-but-unrendered in the luxury design") and destructures `promoLinks` with an eslint-disable for being unused — the render body never references it. `globals.css:203-222` defines `.flash-pulse/.flash-glow/.flash-shake` but nothing applies them.
- **Recommendation:** Render the chip strip on the storefront (consuming the existing DTO + flash classes), **or** hide/remove the admin panel so operators don't configure dead data. If the omission is intentional, gate the admin nav entry behind a feature flag.

#### F2 🟠 📋 Header "main" nav menu drops `openInNewTab` and all nested sub-items
- **Files:** write `src/lib/actions/cms.ts:682-732`; read-seam OK `src/lib/api/cms.ts:266-315`; **dropped** `src/components/site-header.tsx:68-72,136-138,375-384`.
- **Trace:** The nav-item form exposes "Ouvrir dans un nouvel onglet" + parent/child nesting; the **footer** honors both (`footer-columns.tsx:16-17,33-35`). The header's `buildNavRoots()` flattens each item to `{ name, href, links: [] }` — `NavRoot` has no `newTab`/children — and the root `<Link>` has no `target`/`rel`.
- **Recommendation:** Add `newTab` + `children` to `NavRoot`, populate from `mainMenu`, and set `target="_blank" rel="noopener noreferrer"` when `newTab` — mirroring `footer-columns.tsx`.

#### F3 🟠 📋 Banner form collects Description + secondary CTA for every placement, but almost nothing reads them
- **Files:** write `src/lib/actions/cms.ts:319-392` (all placements); read `src/lib/api/cms.ts:83-100` (`listHomeHeroSlides` only); form `src/components/admin/banner-form.tsx:191-196,223-232`.
- **Trace:** The shared `BannerForm` shows "Description" and "Bouton secondaire" for **every** placement. Only `home_hero` reads `description`. **Verifier refinement:** the secondary CTA reaches **no** renderer for **any** placement — `listHomeHeroSlides` resolves it into the DTO (`cms.ts:95-96`) but `home-client.tsx:100-110` never maps it into `HomeHeroSlide`.
- **Recommendation:** Hide Description + secondary-CTA in `BannerForm` when `placement !== 'home_hero'` (the form already hides the Ciblage tab conditionally), **or** extend `RenderableBanner` + the strip/footer/grid/nav renderers to use them.

#### F4 🟠 📋 Announcement bar applies admin bg/text colors only when BOTH are set
- **Files:** write `src/lib/actions/cms.ts:163-216`; panel `src/app/admin/cms/announcements/announcements-panel.tsx:269-270`; read `src/components/site-header.tsx:260-263,278-284`.
- **Trace:** The two colors are independent nullable fields with independent helpers ("Vide = couleur principale du thème" / "Vide = blanc"), but `annColors` is built only when `bgColor && textColor` are **both** truthy — a lone color is ignored and the bar stays default olive, contradicting the form's per-field helper text.
- **Recommendation:** Build `annColors` per-property: `{ ...(bgColor && {backgroundColor: bgColor}), ...(textColor && {color: textColor}) }`.

#### F5 🟠 📋 Product "Ordre d'affichage" (`display_order`) is saved but never sorts any listing
- **Files:** form `src/components/admin/product-form.tsx:703-709`; write `src/workflows/catalog/create-product.ts:258,417` + `src/lib/actions/catalog.ts:326,410`; column `schema.ts:221`; **read NONE.**
- **Trace:** The helper promises "Plus bas = affiché en premier dans les listes." The value is persisted, hydrated on edit (`products/[id]/page.tsx:277`), and copied on duplicate (`duplicate-product.ts:146`), but `grep "products.display_order"` across `src/` returns **zero** ORDER BY uses. Every listing sorts by `published_at`/`created_at`; storefront sort handles only price + name. (Sibling tables — categories, product_media — do use their own `display_order`.)
- **Recommendation:** Either (a) honor it — add `asc(products.display_order)` as the leading sort key in `listPublishedProducts` and the storefront default + admin list, mirroring categories — or (b) remove the field/helper.

#### F6 🟠 📋 Sub-category SEO overrides (noindex / canonical / OG) dropped on the two-segment route
- **Files:** flat route OK `src/app/(shop)/[slug]/page.tsx:200-225`; **dropped** `src/app/(shop)/[slug]/[sub]/page.tsx:61-69`; write `src/lib/actions/catalog.ts:221-226`; form `src/components/admin/category-form.tsx:575-597`.
- **Trace:** `category-form` sets noindex/canonical/OG on any category incl. children; `getSubcategoryBySlug` returns the full row. The flat `/[slug]` route applies all three, but the two-segment `/[parent]/[sub]` `generateMetadata` forwards only `meta_title`/`meta_description`. A noindex sub-category therefore stays **indexable** (and loses its canonical/OG) via the two-segment URL.
- **Recommendation:** Mirror the flat-route logic in the sub route, **or** 301-redirect the two-segment route to the flat single-slug route.

#### F7 🟡 📋 CMS page OG image dropped by dedicated legal/about routes that shadow `/[slug]`
- **Files:** `src/app/(shop)/cgu/page.tsx:5-16` (+ cgv/cookies/privacy/mentions-legales/about); resolver OK `src/app/(shop)/[slug]/page.tsx:313-327`; `buildPageMetadata` accepts an `image` it isn't given (`src/lib/seo/page-metadata.ts:36-38,58`).
- **Trace:** A file-route wins over `/[slug]`, and these shadowing routes call `buildPageMetadata({title,description,path})` without resolving `pages.og_image_media_id`, so a page-level OG image set in admin is silently dropped (falls back to the global `seo.og` image).
- **Recommendation:** In each shadowing route's `generateMetadata`, resolve `cms.page.ogImageMediaId` and pass `buildPageMetadata({ image })`, or route these slugs through the `/[slug]` OG resolver.

#### F8 🟡 📋 Per-courier "Zone" label (`agents.zone_label`) collected but never read by any customer surface
- **Files:** panel `src/app/admin/system/delivery/delivery-panel.tsx:181`; write `src/lib/actions/delivery.ts:125,146` → `workflows/delivery/agent.ts` → `src/modules/delivery/schema.ts:30`; **read NONE** (only re-read into the admin form).
- **Trace:** `resolveDelivery`/`listDeliveryOptions` use only `agent.name` + `fee_cents`/`free_threshold_cents`; real region pricing uses the separate `delivery_zones` + `agent_zone_rates` tables. The operator types a "Zone" that drives nothing and appears nowhere.
- **Recommendation:** Surface `zone_label` in the delivery-option label, or remove the field (and ideally the column).

#### F9 🟡 📋 Storefront tiers page ignores the `coins.enabled` master switch
- **Files:** `src/app/(shop)/niveaux-avantages/page.tsx:30-35,63`; nav link `src/components/site-header.tsx:121`. Honored elsewhere: `src/lib/coins/award.ts:34`, `redeem.ts:39`, `checkout/page.tsx:277`.
- **Trace:** The page reads `earnPointsPerTnd` but ignores `config.enabled` and gates only on `levels.length`. When the program is **disabled** but enabled `coin_levels` still exist, the page keeps advertising tiers, discounts and the earn rate; the Fidélité nav link is also ungated.
- **Recommendation:** Render the empty state / redirect when `config.enabled` is false, and gate the nav link on `coins.enabled`.

#### F10 🟠 📋 Per-currency "Décimales" field is persisted but never drives price display
- **Files:** panel `src/app/admin/system/currency/currency-panel.tsx:108-117`; write `src/lib/actions/currency.ts:49,80` → `src/modules/currency/service.ts`; column `currencies.decimals`; **display read NONE.**
- **Trace:** All money formatting (`formatMoney` in `src/lib/price.ts`, `MoneyProvider`) takes its fractional digits from the separate `price.decimals` setting via `getPriceDecimals`; the shop layout passes only `currency.symbol`/`symbolPosition` to `MoneyProvider`. The schema comment already admits precision "stays governed by the `price.decimals` setting" — but the admin form gives no hint, so setting a currency's Décimales changes nothing on the storefront, JSON-LD, feeds or invoices.
- **Recommendation:** Either thread `currency.decimals` into `MoneyProvider`/`formatMoney`, **or** remove/disable the input and note precision lives under Prix → `price.decimals`.

### B. Orphan-reads — storefront reads a key no admin writes (renders the code default)

#### F11 🟡 📋 Category hero image not rendered on the two-segment sub-category route
- **Files:** read OK `src/app/(shop)/[slug]/page.tsx:586-594`; **missing** `src/app/(shop)/[slug]/[sub]/page.tsx:176-199`; write `src/lib/actions/catalog.ts:227-229`.
- **Trace:** `hero_media_id` is editable on any category and resolved into `showcaseHero.imageUrl` by `renderCategoryView`, but `SubcategoryPage` never reads child `hero_media_id` and passes no `showcaseHero`. Cosmetic (the child still shows its hero at the flat URL). Same root cause as F6.
- **Recommendation:** Resolve child `hero_media_id` like `renderCategoryView`, or redirect to the flat route.

#### F12 ✅ RESOLVED (2026-10-03) — Showcase empty/CTA-band copy now editable + rendered; obsolete grid_* dropped
- **Was:** `pages.<slug>.{grid_*,empty_*,cta_band_*}` were read with literal defaults but no admin form wrote them and no storefront surface rendered them (the referenced `PrecommandesShowcase` component no longer exists — stale note).
- **Fix:** the Catalogues panel now edits `empty_title/body` + `cta_band_*` (gated by `show_closing_cta`) + `default_sort`, in lockstep with `showcase-settings.ts` COMMON_FIELDS; `renderShowcaseClassic` threads `config.empty` / `config.ctaBand` into `CategoryPageClient` (`showcaseEmpty` / `showcaseCtaBand`). The obsolete `grid_*` section-header keys were removed from the config + defaults. Guarded by `showcase-lockstep.test.ts`. See [[bannieres-build-2026-10-03]]-style memory + docs/cms-content-model.md § Catalogues.

#### F13 🟠 📋 Home-page SEO title (`seo.title_home`) is read but un-editable from admin
- **Files:** read `src/app/(shop)/page.tsx:36-37` + `src/lib/seo/config.ts:173-174`; **no writer** (SEO panel + `src/lib/actions/seo.ts:9-42` TEXT_FIELDS omit it; only one-time seeded in `scripts/seed-editable-settings.ts:36`).
- **Trace:** `homeTitle` always falls back to a hardcoded literal and never to the editable `seo.default_title`, so editing "Titre par défaut" silently does **not** change the homepage tab title. **Verifier refinement:** the *description* is fine — when `seo.description_home` is unset, `buildPageMetadata` falls back to the admin-editable `seo.default_description`. Only the **title** is orphaned.
- **Recommendation:** Add a "Titre de la page d'accueil" field to the SEO panel + `saveSeoSettingsAction`, **or** drop the home-specific title override so the home route uses `seo.default_title`.

#### F14 🟡 📋 Payment caption keys read on the storefront but no admin panel writes them
- **Files:** read `src/lib/checkout/quick-buy-config.ts:270-284` → rendered `src/app/(shop)/checkout/checkout-form.tsx:833-876` + `buy-block.tsx`; **no writer** for `checkout.payment.cod_description`, `…clictopay_label/description`, `…flouci_label/description`.
- **Trace:** The payments panel writes only `*_enabled`, `checkout.quick.cod_enabled`, and `checkout.quick.cod_label`, so the caption/label keys always render the hardcoded literals. ✅ **The misleading JSDoc that claimed these were "operator-tunable" was corrected this pass** (the underlying disconnect remains).
- **Recommendation:** Add the five caption fields to the payments panel + `savePaymentSettingsAction`, or keep the (now-accurate) comment and treat the literals as fixed.

#### F15 🟡 📋 Login subtitle key `auth.login.subtitle` read but no admin panel writes it
- **Files:** read `src/lib/auth/pages-config.ts:108` → rendered `login-form.tsx:64`; **no writer** (panel exposes `auth.login.panel_subtitle`, `auth.forgot.subtitle`, `auth.reset.subtitle` — but not `auth.login.subtitle`).
- **Trace:** The login page's main subtitle is the one auth subtitle an admin cannot edit, inconsistent with its editable siblings; it renders the default "Accédez à votre espace personnel".
- **Recommendation:** Add `auth.login.subtitle` to `AUTH_FIELDS` + the panel, or hardcode the default in `pages-config.ts:108`.

#### F16 🟠 📋 Blog & Aide hero copy read from `site_settings` but no admin UI writes those keys
- **Files:** read `src/app/(shop)/aide/page.tsx:64-77` + `src/app/(shop)/blog/page.tsx:67-78` (`pages.aide.hero_*` / `pages.blog.hero_*`); **no writer** (`saveShowcaseSettingsAction` only loops `COLLECTION_SLUGS` = nouveautes/top-ventes/promotions/precommandes).
- **Trace:** Graceful inline French fallbacks render, so this is latent unwired config, not a visible break. The code comment (`aide/page.tsx:62-63`) already states "no admin form currently writes these keys."
- **Recommendation:** Add an admin panel that writes these keys, or delete the dead reads and inline the fallbacks.

### C. Inconsistency

#### F17 🟠 📋 Checkout-page TVA *preview* is computed off the stale cached price (display-only)
- **Files:** `src/app/(shop)/checkout/page.tsx:189` (preview loop) vs the same page's live subtotal at `:95-110`; authoritative tax `src/workflows/order/place-order.ts:457-466`; panier `src/app/(shop)/panier/page.tsx:266`.
- **Trace:** The displayed subtotal uses `liveUnitCents` (base + live auto-promos), but the TVA preview loop taxes the **raw cached** `it.unit_price_cents`. When a cart line's cached price is stale (promo went live/expired since add-to-cart), the previewed TVA — and in "ht" mode the previewed total — diverges from the panier preview and from what `place-order` charges. **The charge itself is correct** (place-order recomputes server-side); only the on-screen preview can drift.
- **Recommendation:** Tax `lines[i].subtotalCents` (the live promo-adjusted value already computed for display) instead of `it.unit_price_cents`.

### D. Dead code

#### F18 🟡 📋 Dead export: `getBusinessConfig()` has zero external consumers
- **Files:** `src/lib/business/config.ts:21` — referenced only by same-file `isBusinessEnabled()` (`:32`); 16 external consumers use `isBusinessEnabled`.
- **Recommendation:** Drop the `export` keyword (make it module-local). Zero behavioral change.

#### F19 ⚪ 📋 `businesses.slug` column selected but never written or used for routing
- **Files:** `src/modules/business/schema.ts:27`; selected in `service.ts:506` (`listForUser`), which itself has **zero callers** in `src/`. No write path exists; reserved for a future per-business slug surface (like `business_levels.slug`, dropped in migration 0043).
- **Recommendation:** Wire a slug input if the surface is planned, or drop the column + index. Safe to defer.

### E. Documentation & residual-content drift (✅ all fixed this pass)

#### F20 🟠 ✅ README migration count was stale
`README.md` golden-rule §3 said `0001…0086` (87 files, next `0087`). At the time: **88 files, idx 0–87, next `0088`** (`0087_drop_redundant_products_published_idx.sql` was latest). _As of 2026-06-26 the chain is `0001…0099` (100 files, idx 0–99, next `0100`; latest `0099_users_oauth_autolink.sql`)._ Corrected; `DEVELOPMENT.md`, `REQUIREMENTS.md`, `docs/database.md`, `docs/deploy-runbook.md` were already correct.

#### F21 🟡 ✅ README api-tree listed only the flouci webhook
There are two webhook routes — `api/webhooks/flouci/route.ts` **and** `api/webhooks/clictopay/route.ts` (both delegate to `src/lib/payments/webhook-handler.ts`). README comment updated to `(flouci, clictopay)`.

#### F22 🟠 ✅ `docs/modules.md` inventory omitted the `redirects` module
The canonical "current set" table had **38** rows; the filesystem had **39** modules at audit time (38 after the later digital-module removal). Added the `redirects` row (owns `redirects`: `source_path` unique, 301/302/307/308, `enabled`, `hits`; master toggle `redirects.enabled`; resolution `src/lib/redirects/resolve.ts`; also backs the 404 copy; migration 0076).

#### F23 🟡 ✅ `docs/security.md` mis-attributed the CSP `buildCsp` function
`buildCsp` is defined at `src/lib/security/headers.ts:42` (with `buildSecurityHeaders` at `:170`); `next.config.ts` only imports and wires it via `headers()`. The Source reference now points to the real file.

#### F24 🟡 ✅ README & CREDITS named only Google social login
Facebook OAuth is a full peer of Google (`src/components/auth/social-buttons.tsx`, `auth.social.facebook_enabled`, `src/lib/auth/social-config.ts`, gate `pages-config.ts:170`). README §27 and CREDITS now mention both.

#### F25 🟠 ✅ Live storefront 404 default copy was gaming-era "Game Over"
`NOT_FOUND_DEFAULTS` shipped `title: "Game Over"` / "…quitté la partie…récupère ta progression" — residual from the de-Game-Zone rename, shown on every 404 of a luxury-watch store until an admin overrides it. Replaced the runtime default (`src/lib/redirects/config.ts:40-46`) **and** the admin placeholders (`src/app/admin/system/redirects/settings-forms.tsx:100,107`) with neutral French copy ("Page introuvable" / "Cette page est introuvable…").

---

## Verified-safe patterns (checked & cleared)

The cross-cutting auditor specifically probed these high-risk patterns and
confirmed they are **not** bugs — recorded so they aren't re-flagged:

- **No double-write of audit events** — `audit-everything.ts` skips the curated allowlist owned by `audit-trail.ts` (`src/events/subscribers/audit-everything.ts:42`); one row per emit.
- **No unit-conversion errors** — millimes (`MINOR_PER_DINAR = 1000`) is the single source in `src/lib/price.ts`; the gateway boundary is correctly identity (`toGatewayMinor`, `src/lib/payments/shared.ts:55`).
- **No double-award** — `award-coins.ts` fires on both `order.paid` and the delivered transition but is idempotent (partial unique index `coin_tx_earn_per_order_uq` + `claimOnce`). _(The digital-fulfilment subscriber that shared this pattern was removed with the digital feature.)_
- **No unhandled rejections** — the event bus uses `Promise.allSettled` and every subscriber wraps its body in try/catch (`src/events/bus.ts:72`).
- **No restock / loyalty-reversal double-counting** — `transition-status.ts` guards with `alreadyRestockedByRefund`; `reconcile-loyalty-promos.ts` is idempotent.
- **No place-order race conditions** — stock decrements lock rows in deterministic id order; coupon/coins redemption is in-tx and clamp-safe.
- **`gz.` / `__gz_` cookie + globalThis names are intentional** — leftover Game-Zone naming, but reader and writer agree and they are user-facing (renaming would log users out / drop carts). Likewise `konnect` / `card_stripe` are documented forward-compat enum values, not dead code.
- **~140 dead-export candidates were all false positives** — Zod `*Schema` / Drizzle `*Enum` exports used in-file, intra-file helpers, or symbols consumed from outside `src/` (e.g. `buildSecurityHeaders` imported by `next.config.ts`). The only genuine dead export is `getBusinessConfig` (F18).

> **Note on demo content:** the demo/seed data (`src/lib/demo/data.ts`) still
> contains gaming-flavored product names inherited from the Game-Zone lineage.
> That is seed-only sample data, never shipped to a real store's catalogue, so
> it is out of scope here — but worth replacing with watch-appropriate samples
> before any demo to the client.

---

## Recommended remediation order (for the 19 open findings)

1. **Customer-facing on fresh deploy** — F9 (tiers page ignores `coins.enabled`). *(F25 already fixed.)*
2. **SEO correctness** — F6 (sub-category noindex/canonical leak), F7/F11 (page OG image + hero on shadowed routes), F13 (home title un-editable).
3. **Operator-confusing dead config** — F1 (promo-links), F10 (currency decimals), F5 (display_order), F8 (zone_label): decide *render vs. remove* for each.
4. **Honor-or-hide form fields** — F2 (nav newTab/children), F3 (banner desc/secondary-CTA), F4 (announcement colors), F12/F14/F15/F16 (orphan copy keys).
5. **Display polish** — F17 (checkout TVA preview base).
6. **Cleanup** — F18 (un-export `getBusinessConfig`), F19 (drop `businesses.slug` or wire it).

Each is small and self-contained; none require schema/migration work except the
optional column drops in F8/F19.

---

## Historical audits

- The **June 2026 286-finding** architecture scan and its remediation log were
  retired into git history; their resolved summary previously occupied this file.
- [`AUDIT-REPORT.md`](AUDIT-REPORT.md) — the **2026-06-10** 99-finding
  multi-agent audit (historical; superseded by this pass).
- [`PLAN.md`](PLAN.md) — the **completed** architecture roadmap (historical).

For the current state of the system, read [`README.md`](README.md),
[`DEVELOPMENT.md`](DEVELOPMENT.md), [`REQUIREMENTS.md`](REQUIREMENTS.md), and
[`docs/database.md`](docs/database.md).

---

Built by **[Kawn Digital Studio](https://kawn.me)** for Tokyo Store. See [CREDITS.md](CREDITS.md).

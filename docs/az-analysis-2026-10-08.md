# Tokyo‑Store — Comprehensive A–Z Architecture Analysis

> **Date:** 2026‑10‑08 · **Branch:** `main` · **Repo:** `/home/mhoussem/Desktop/Work/Tokyo-Store-2026` (package `tokyo-store`)
> **Scope:** the whole platform — frontend, backend, data, auth, admin, media, CMS, build/ops — mapped and **verified against the live source** (docs in the repo are treated as hints only; *code is the source of truth*).
> **How it was produced:** a 15‑agent parallel sweep (one deep reader per subsystem, ~2.3M tokens, 610 tool calls, code‑cited), synthesized here.
> **Why it exists:** you will be **editing and removing sections** and changing **both frontend and backend** on `main`. Every section below is written to answer three questions: *what is this*, *where does its source of truth live*, and *what is safe to change vs. load‑bearing*.

---

## How to use this document

- **§A–§E** are the synthesis: read these first. They give you the whole system in ~10 minutes and flag the traps that will cost you hours.
- **§1–§15** are the deep subsystem maps (frontend → transports → backend core → cross‑cutting → ops). Each ends with its own *sources of truth*, *editable/removable*, and *gaps/risks*.
- **Appendices A–D** are consolidated quick‑reference indexes (every source of truth, every edit/remove note, every risk, plus the conventions glossary) pulled from all 15 sections.
- Wherever you see `file.ts:NN`, that is a real, clickable line reference.

---

## §A. Executive summary

**What it is.** A production, single‑tenant **e‑commerce platform for a Tunisian high‑tech retailer** ("Tokyo Store" — Apple, phones, gaming, audio, smartwatches, gift‑cards). It was built on, and re‑skinned from, an older **watch‑store** codebase, itself re‑skinned from a "Game Zone" base. A full rebrand (legacy brand→tokyo, watch→high‑tech) has been done; a handful of **legacy identifiers are kept on purpose** (the `gz.` cookie prefix, `gz_` ids) — do not "tidy" them.

**The shape.** It is a **Medusa‑inspired modular monolith** on **Next.js 16 (App Router) + React 19**, **Drizzle ORM + PostgreSQL 16 + pgvector**, **better‑auth**, **sharp + SeaweedFS (S3)** media behind a same‑origin `/cdn` proxy, Tailwind v4, deployed on Coolify/Docker. ~44 domain modules, ~135 tables, 202 hand‑authored migrations, 60 REST routes, ~83 Server‑Action files, ~227 bus events.

**The one architectural idea you must hold in your head:** business logic lives in **`src/workflows/*`** (the true mutation API, run inside DB transactions, emitting events). Three transports *call into* workflows/queries to reach the UI:

1. **RSC direct imports** (`src/lib/api/*` + each module's `queries.ts`) — server‑component **reads**.
2. **Server Actions** (`src/lib/actions/*`) — the **real customer + admin mutation API** (Next‑only; cart, checkout, account, auth, wishlist, every admin save).
3. **REST API** (`src/app/api/**`) — a framework‑agnostic **ERP / integration + headless‑content** surface. **It is *not* a customer storefront API** — the transactional surface is deliberately Server‑Action‑only.

**The frontend today.** The customer storefront is the **new "Tokyo" design**, swapped *in‑repo* (not a separate app). UI code lives in `src/storefront/**`; routes live in the **`(tokyo)` route group** under `src/app/(shop)/(tokyo)/**`, scoped by a single **`.tokyo` CSS class**. A **legacy `(shell)` route group** still exists beside it and still owns real, un‑ported features (order confirmation, B2B/pro, loyalty, blog, collections, parrainage, full search results). Catalog **display** data is a **bundled JSON snapshot** (`src/storefront/data/*.json`) regenerated from the DB by scripts; cart/favorites/checkout/account/auth are wired to the **real backend** via Server Actions.

**Money & ids:** money is integer **millimes** — columns named `*_cents` hold *millimes*, **never divide by 100** (`src/lib/price.ts`, `MINOR_PER_DINAR=1000`). PKs are **uuid v7**. Deletes are **soft** (`deleted_at`, app‑enforced).

**The contract is the test suite.** There is **no OpenAPI**. The behavioural/contract spec is `src/lib/db/tests/**` (~296 files, split into `test:pure` and `test:db` chains). Adding a route/action/event/migration without updating its catalog/test will fail that suite.

---

## §B. Architecture at a glance

```
                          ┌─────────────────────────────────────────────┐
  Browser (customer)      │  Next.js 16 App Router (one deployable app)   │
  ┌──────────────┐        │                                               │
  │ (tokyo) UI   │ RSC    │  src/app/(shop)/(tokyo)/**  ──reads──┐        │
  │ .tokyo scope │◄───────┼─ src/storefront/** components        │        │
  │ bundled JSON │        │     │                                ▼        │
  └──────┬───────┘        │     │  src/lib/api/*  +  modules/*/queries.ts │ ── RSC reads
         │ Server Actions │     │        (RSC read layer)                 │
         ▼                │     ▼                                         │
  ┌──────────────┐        │  src/lib/actions/*  (Server Actions)──┐       │
  │ cart/checkout│───────▶│        validate · authorize · delegate │       │
  │ account/auth │        │                                        ▼       │
  └──────────────┘        │             src/workflows/*  ◄─── the TRUE     │
                          │        (orchestration, DB tx, emits events)    │
  ERP / integrators       │                 │          │                   │
  ┌──────────────┐  REST  │   src/app/api/**─┘          ▼                   │
  │ API key /    │───────▶│  (ERP + headless, route-catalog.ts gated)      │
  │ webhooks     │        │             src/events/*  (in-process bus)      │
  └──────────────┘        │        subscribers: email, audit, webhooks,     │
                          │        cache-bust, loyalty, gift-card, search    │
                          │                 │                               │
                          │   src/modules/*/{schema,service,queries,index}  │
                          │   + src/associations/* (cross-module joins)     │
                          │                 ▼                               │
                          │   PostgreSQL 16 + pgvector   ·   SeaweedFS (S3)  │
                          └─────────────────────────────────────────────┘
          Admin panel: src/app/admin/**  (RSC + Server Actions, RBAC-gated)
```

**Request → data flow (storefront read):** a `(tokyo)` page is an RSC → it imports `src/storefront/lib/catalog.ts` (a **synchronous bundled module** over the JSON snapshot) for catalog display, and calls Server Actions for live cart/favorites/user state. The layout reads backend settings **once, server‑side** (shipping config, footer identity, logo) and seeds them down via context providers, so **what the UI shows equals what the backend charges**.

**Mutation flow (checkout):** `(tokyo)` checkout view → `placeOrderFromCartAction` (`src/lib/actions/order.ts`) → `workflows.order.place` (the 1,469‑line `place-order.ts`: pricing, tax, promo, loyalty, credit, delivery, stock, all in one transaction) → emits `order.*` events → subscribers send email, write audit, enqueue webhooks, accrue loyalty, mint gift‑cards.

**The modular‑monolith rules:** modules never FK across each other; every cross‑module link is a *soft* uuid/text column plus a join table in `src/associations/*`. A module's `index.ts` re‑exports only queries + types (services stay internal, callable only by workflows).

---

## §C. Repository map (annotated)

```
src/
├─ app/                      # Next App Router: routes, API, admin, documents, feeds
│  ├─ (shop)/
│  │  ├─ (tokyo)/            # ★ NEW storefront (the live customer UI) — .tokyo scope
│  │  └─ (shell)/            # LEGACY storefront — still owns un-ported features
│  ├─ admin/                 # Full admin panel (10 sidebar groups; RBAC-gated)
│  ├─ api/                   # REST surface (60 routes): ERP + headless + cron + webhooks
│  ├─ (documents)/facture/   # Invoice PAGE (PII, UUID-bearer access)
│  ├─ cdn/[...path]/         # Same-origin media proxy (CSP requires it)
│  ├─ feeds/ robots.txt llms.txt md/[...path] promo/[slug]
│  └─ globals.css            # Tailwind v4 + .tokyo / .storefront / .admin token scopes
├─ storefront/               # ★ Tokyo UI code (components, content, data bridge, client libs)
│  ├─ components/storefront/ # All the storefront React components (header 2061 LOC, etc.)
│  ├─ content/*.ts           # AUTHORED legal/help page copy (NOT the DB)
│  ├─ data/*.json            # ★ Catalog SNAPSHOT (products/categories/taxonomy) — generated
│  └─ lib/                   # catalog.ts (sync bridge), cart.ts, favorites.ts, categoryNav.ts…
├─ components/               # Legacy (shell) + admin React components (site-header/footer, admin-*)
├─ modules/                  # ★ 44 domain modules: {schema,service,queries,index}.ts
├─ associations/             # Cross-module join services (product↔cat/brand/media, customer↔user…)
├─ workflows/                # ★ Orchestration = the TRUE mutation API (per-domain folders)
├─ events/                   # In-process bus.ts + types.ts + severity.ts + subscribers/
├─ lib/
│  ├─ api/                   # RSC read layer (also wrapped by REST)
│  ├─ actions/               # ★ Server Actions (~83 files): real storefront+admin mutations
│  ├─ api-auth/              # route-catalog.ts (REST surface SoT) + generated catalogs
│  ├─ auth/ rbac/            # better-auth policy + RBAC registry/authorize
│  ├─ db/                    # Drizzle client, schema barrel, migrations, 296-file test suite
│  ├─ workflows helpers, settings, cms, seo, theme, media, checkout, price.ts (millimes)…
├─ instrumentation.ts        # Boot-time bootstrap (seed system pages/nav, etc.)
└─ proxy.ts                  # Edge/proxy gate (reads gz. cookies)
scripts/                     # tokyo-export-catalog.ts (regen snapshot), seeds, migration tools
docker*, next.config.ts, drizzle.config.ts, .env*.example
```

---

## §D. The cross‑cutting landmines (read before you touch anything)

These were surfaced independently by multiple agents and are the things most likely to bite you. Each is expanded in the relevant section and listed in **Appendix C**.

1. **The storefront catalog is a STALE snapshot.** `src/storefront/data/{products,categories,taxonomy}.json` (~1.4 MB, ~2,595 products) is a point‑in‑time export. **Admin catalog/price/stock edits do NOT appear in the Tokyo UI until you re‑run `scripts/tokyo-export-catalog.ts` and commit the JSON.** There is no automation or freshness check. This is the single biggest gotcha for "editing both frontend and backend." It also ships the whole catalog into the client bundle.

2. **Two customer‑facing flows are MOCKS that fake success.** The PDP "Achat rapide" quick‑buy (`quick-buy-form.tsx:137‑138`) and the home newsletter (`newsletter.tsx:20‑30`) both show a success state with **no backend call** — a customer "orders" or "subscribes" and *nothing happens*. These need wiring to real actions before launch.

3. **Ratings, review counts, and discount/strike prices are FABRICATED.** `src/storefront/lib/productMeta.ts` (`fakeRating`/`fakeStrike`) synthesizes stars and "was" prices deterministically across *every* card and PDP. The whole "Bons plans" page is built on fake percentages. Replace when real reviews/pricing land. (Reels content is also hardcoded mock media.)

4. **The admin "Thème" panel does NOT recolor the live store.** `getThemeConfig`/`buildThemeCss` emit a `.storefront`‑scoped rule, but the Tokyo chrome is wrapped in `.tokyo`. So theme.* edits only affect the retired `(shell)` group and the admin root. The live Tokyo tokens live in `globals.css` (`.tokyo` block) + `ui-classes.ts`.

5. **The CMS page‑builder is DORMANT for the storefront.** No `(shop)` route renders `pages.blocks`. Tokyo legal/help pages are **hardcoded TypeScript** in `src/storefront/content/*.ts`. Editing a page in `/admin/cms/pages` changes only the `/md` twin, the sitemap, and the `<title>`/meta — the **visible HTML body can silently diverge** from the DB metadata for the same slug. (The home‑block composer is likewise dormant for Tokyo.)

6. **Dual‑chrome hazard.** Crossing from a `(tokyo)` page into a `(shell)` route swaps the entire header/footer/design system. Several live features only exist in `(shell)`; the Tokyo footer/header simply don't link them. **Routes that look "unused" are often the only implementation of a real feature** — migrate, don't delete. Grep before removing.

7. **Hard couplings into `(shell)` that are easy to miss:** checkout success redirects to `/order/[id]` (`actions/order.ts:1019`) and the Tokyo account links order detail to `/account/orders/[id]` (`account-view.tsx:233`). Both are legacy `(shell)` routes. Don't remove them without repointing.

8. **`return fail()` inside a DB transaction COMMITS it.** Drizzle only rolls back on *throw*. Every order workflow guards before the first write or throws a sentinel. A new in‑tx guard that `return fail()`s *after* a write silently persists a half‑mutation — the biggest footgun in the workflow layer.

9. **The event bus is in‑process, best‑effort, no retry/outbox.** A crash mid‑fan‑out drops the remaining subscribers; only loyalty accrual + gift‑card issuance have a re‑drive net. Emails/webhooks/cache‑busts after commit can silently not happen. `bus.emit` also *awaits* all subscribers, so a heavy subscriber blocks the request.

10. **Migrations are frozen; never run `db:generate`/`db:push`.** Snapshots are frozen at 0007 (202 migrations), so a generate/push emits destructive drops (incl. `app_secrets`, `rate_limit_buckets`, `gift_cards`). Add schema by hand: edit the module `schema.ts`, hand‑author `migrations/NNNN_*.sql` + a `_journal.json` entry, then `db:migrate`. Note the **schema barrel is incomplete** — `gift_cards` and `loyalty_referrals` aren't re‑exported (works at runtime, latent footgun).

**Rebrand residue to be aware of (harmless but misleading):** `drizzle.config.ts:21` and `Dockerfile:55` still carry `tokyo` defaults; `EMAIL_FROM` default domain disagrees across config files (`tokyostore.tn` vs `.com`); `seed-catalog.ts` still seeds watch brands; several doc‑comments reference the old watch brand. Trust the code.

---

## §E. How to edit / remove sections safely (playbook)

- **Reorder / remove a home section:** edit `src/app/(shop)/(tokyo)/page.tsx` (the 5 top‑level sections) and `home-extras.tsx` (the inner stack). Each is an isolated component — safe to drop. Shelf *contents* are category‑slug lists inside each `*-tabs.tsx` / `accessory-carousel.tsx`.
- **Change brand / identity / contacts / legal numbers:** this is **data, not code** — edit `site_settings` via the admin "Réglages site" form or re‑run `scripts/tokyo-seed-identity.ts`. **Do not** edit `DEFAULT_SITE_NAME` in `src/lib/seo/config.ts` (it is `'Tokyo Store'` and test‑pinned).
- **Change legal/help page wording:** edit the `ContentDoc` in `src/storefront/content/*.ts` (editing the admin CMS page will *not* change the visible body — see landmine #5).
- **Change catalog data shown to customers:** change the DB (admin), then **re‑run `scripts/tokyo-export-catalog.ts`** and commit the JSON. Never hand‑edit the JSON.
- **Change backend business behaviour:** edit the relevant `src/workflows/*` body (not the module service, not the action). Re‑run the matching `src/lib/db/tests/*`.
- **Remove a REST route / Server Action / event / admin tab:** it's always a *two‑or‑three‑step* edit (handler + catalog/registry entry, and sometimes the test allow‑list). The exact pairs are in Appendix B and each section.
- **Retire the `(shell)` group:** only after porting the still‑only features it owns (Appendix B lists the dead vs. live `(shell)` files) and repointing the two hard couplings in landmine #7.

---

## Subsystem map — table of contents

1. [Storefront (Tokyo design) — pages, tabs & components](#1-storefront-tokyo-design-pages-tabs-components)
2. [Storefront Data Bridge, Catalog Snapshots & Client Libs](#2-storefront-data-bridge-catalog-snapshots-client-libs)
3. [Legacy (shell) storefront — what remains & retirement status](#3-legacy-shell-storefront-what-remains-retirement-status)
4. [Server Actions Layer (`src/lib/actions/**`) — the real storefront & admin mutation API](#4-server-actions-layer-srclibactions-the-real-storefront-admin-mutation-api)
5. [RSC Read Layer (src/lib/api/** + module queries.ts)](#5-rsc-read-layer-srclibapi-module-queriests)
6. [REST API Surface (src/app/api/**)](#6-rest-api-surface-srcappapi)
7. [Modules & Domain Model (src/modules/** — 44 modules, 135 tables)](#7-modules-domain-model-srcmodules-44-modules-135-tables)
8. [Workflows — the orchestration / mutation API](#8-workflows-the-orchestration-mutation-api)
9. [Event Bus & Subscribers (src/events/**)](#9-event-bus-subscribers-srcevents)
10. [Database, Schema, Migrations & Money/ID Conventions](#10-database-schema-migrations-moneyid-conventions)
11. [Auth, RBAC, Sessions & API-Key Access](#11-auth-rbac-sessions-apikey-access)
12. [Media, Image Pipeline & Storage (sharp + SeaweedFS + /cdn)](#12-media-image-pipeline-storage-sharp-seaweedfs-cdn)
13. [CMS, Site Settings, Theme & Identity — the config sources of truth](#13-cms-site-settings-theme-identity-the-config-sources-of-truth)
14. [Admin Panel (src/app/admin/**) — Shell, RBAC Gating, and Full Tab/Section Map](#14-admin-panel-srcappadmin-shell-rbac-gating-and-full-tabsection-map)
15. [Build, Config, Ops, Scripts & Tests-as-Contract](#15-build-config-ops-scripts-testsascontract)

**Appendices:** [A — Sources of Truth](#appendix-a--master-sources-of-truth) · [B — Edit & Remove Playbook](#appendix-b--edit--remove-playbook) · [C — Risk Register](#appendix-c--risk-register--known-gaps) · [D — Conventions & Glossary](#appendix-d--conventions--glossary)


---

## 1. Storefront (Tokyo design) — pages, tabs & components

The customer-facing storefront is the new **"Tokyo" design**, a crimson high‑tech UI swapped in-repo. Its reusable code lives under `src/storefront/**`; its routes live in the `(tokyo)` route group under `src/app/(shop)/(tokyo)/**`. The design is scoped by a single `.tokyo` CSS class so it never collides with the retiring legacy `(shell)` chrome (`.storefront`) or the admin panel (`.admin`). Catalog data is a **bundled synchronous JSON snapshot**; cart, favorites, checkout, account, auth, order-tracking and appointments are **wired to the real backend** through Server Actions.

### 1. Route-group topology & the two layouts

`src/app/(shop)/` splits into two sibling groups:
- **`(shell)`** — the legacy backend-era chrome (`.storefront`), still serving ~40 routes the new design does not cover yet (blog, pro/B2B, fidélité, collections, brand pages, order confirmation, parrainage, etc.). Being retired. Not this subsystem.
- **`(tokyo)`** — the new design. 36 route files (listed in §8).

The **root `(shop)/layout.tsx`** (`src/app/(shop)/layout.tsx:37`) is a deliberately thin layout rendering NO chrome. It does two jobs above the per-group chrome: (1) hosts the chrome-free 404 boundary (`src/app/(shop)/not-found.tsx`), and (2) the maintenance/coming-soon hard gate — it reads `getSiteModeConfig()` and short-circuits to `<MaintenanceScene>` before the expensive chrome fan-out, failing OPEN on error (`:38-46`). Exempt routes (login/2fa, forgot/reset-password, verify-email, se-desabonner) and signed-in staff fall through.

The **`(tokyo)/layout.tsx`** (`src/app/(shop)/(tokyo)/layout.tsx:34`) is the Tokyo chrome. It:
- wraps everything in `<div className="tokyo flex min-h-dvh flex-col bg-surface-beige">` (`:54`) — this `.tokyo` class is what activates the entire design system;
- mounts `<Header>`, `<main id="contenu">`, `<Footer>`, `<MobileBottomNav>` (`:55-64`);
- reads backend data ONCE on the server and seeds it down: `getStorefrontShippingConfig()` (flat fee + free-shipping threshold) through `<ShippingConfigProvider>` (`:38-53`), and the footer identity/contacts from `getAllSettingsServerOnly()` + `getSiteLogoUrl()` + `getSiteContacts()` into a `FooterData` object (`:43-51`). So the shipping fee DISPLAYED equals the fee the backend CHARGES, and the footer brand/logo/phone/email/stores come from `site_settings`, nothing hardcoded;
- sets `viewport.themeColor = "#f6f2ed"` so the mobile browser chrome tint matches the beige canvas (`:32`).

### 2. The `.tokyo` scope & design tokens (globals.css)

Tokens live in `src/app/globals.css` (1590 lines total). Two blocks matter:
- **`.tokyo { … }`** (`globals.css:1197-1260`) defines the full token set: `--radius`, layout vars (`--nav-h`, `--banner-h`, `--gutter`, `--sticky-top`, `--dock-bottom`, `--envelope-*`), the crimson palette in **oklch** (`--primary: oklch(0.55 0.22 22)` = brand #C81232, `--background`, `--foreground`, `--surface-*`, `--graphite`, `--success`, `--rating`, `--border`, `--ring`…), and re-points `--font-sans`→Figtree / `--font-display`→Outfit (`:1242-1250`, overriding the shared `@theme` Manrope default). Responsive overrides at `:1262-1274`.
- **Dark mode** under `html.dark .tokyo, .tokyo.dark` (`:1276-1308`).
- Base element rules scoped to `.tokyo` (focus rings, heading fonts, 16px inputs, scroll margins) at `:1310-1361`; `html:has(.tokyo)` canvas/overscroll at `:1336-1355`.
- Decorative helpers (global, unique names): `@utility no-scrollbar` / `pill-gloss`, `.tokyo-search-reveal`, `.tokyo-pixel-grid` / `.tokyo-pixel` (the PromoBar arcade pixels), reduced-motion block (`:1363-1589`).

Shared Tailwind-class recipes (buttons, badges, chips, panels, fields, rhythm spacing, icon buttons, capsule bar) are centralized in **`src/storefront/components/storefront/ui-classes.ts`** (imported as `btn`, `badge`, `chip`, `panel`, `rhythm`, `iconBtn`, `field`, `option`, `capsuleBar`, `promise`, `card`…). This is the single place to retune the visual language.

### 3. Shared chrome components

- **`header.tsx`** (2061 lines — the largest, most complex component). A floating "Dynamic Island" nav pill: logo + Catégories mega-menu + centre shortcuts + search + favoris/panier/account icons on desktop; menu/logo/search/panier on mobile. Key wiring: `useCartCount()` + `useFavoriteCount()` for live badges (`header.tsx:51-54`), `useProductBar()` to hide the header while the PDP sticky capsule is active (`:385`), live local search over the bundled catalogue (`searchKeys`, `:80`, `:601-608`), and a **data-driven mega menu generated from the migration taxonomy** via `buildMega()` over `taxonomy.json` (`:230-244`). Curated presentation (icons/blurbs per universe) is the only hand-maintained part (`UNIVERSE_META`, `:213-223`); the structure is generated. Nav shortcut links (`navShortcuts`, `:161-175`) and the mobile category list (`mobileCategories`, `:262-271`) are derived here. The mega menu has elaborate hover-intent, roving focus, island-grow animation, and banner-bounded sizing logic.
- **`footer.tsx`** (`footer.tsx:177`). Backend-controlled identity via `FooterData` prop from the layout, with safe fallbacks for a fresh DB (`:184-192`). Link columns (`columns`, `:36-77`) and `legalLinks` (`:79`) are HARDCODED here with real route hrefs; items with no `href` render as plain text, never dead links. Socials come from `src/storefront/data/socials.ts`. Expandable accordion on phones, a 4-segment capsule bar from md. "Propulsé par Kawn Digital Studio" credit at `:466`.
- **`mobile-bottom-nav.tsx`** (`mobile-bottom-nav.tsx:67`). Fixed phone tab bar: Accueil / Recherche / Reels / Favoris / Compte (`tabs`, `:21-27`). Recherche is an action (dispatches `tokyo:open-search` CustomEvent the header listens for, `:72-80`), the rest are routes. Live `useFavoriteCount()` badge. Active tab derived from pathname.
- **`promo-bar.tsx`** (`promo-bar.tsx:45`). Presentational slim/tall promo banner used inside the home. `primary`/`dark` tone, optional arcade `pixels` layer (fixed hand-picked positions, `:12-37`). All copy passed by the caller (HomeExtras).
- **`mobile-category-accordion.tsx`** — the mobile menu's category disclosure, consumed by the header (`MobileCategory` type).

### 4. HOME PAGE composition (owner will remove/edit sections — read this)

`src/app/(shop)/(tokyo)/page.tsx` renders, in order (`page.tsx:42-46`): `<HeroCarousel>`, `<CategoryTabs>`, `<HomeExtras>`, `<PromoGrid>`, `<Newsletter>`. The only `<h1>` is sr-only (`:39`). JSON-LD Organization+WebSite graph is inline (`:18-32`). NOTE: there is NO reels section on the home page despite the task framing; reels is its own `/reels` route.

Section-by-section (data source noted):
1. **HeroCarousel** (`hero-carousel.tsx`) — 4 full-bleed banner slides, **hardcoded** in `slides[]` (`:30-56`) pointing at `/assets/1-4.webp` with hrefs to `/iphones-neufs`, `/smartphones`, `/iphones-d-occasion`. Embla + autoplay (WCAG pause). Pure presentational.
2. **CategoryTabs** (`category-tabs.tsx`) — "Découvrez notre sélection". **Data-driven**: `buildUniverseTabs()` counts products per top-level `product_type` universe from the bundled catalogue and builds a tab per universe with ≥6 products (`:24-38`). Renders via `<TabbedProducts>`.
3. **HomeExtras** (`home-extras.tsx`) — the big stack. In order (`:18-98`): a `<PromoBar>` "BONS PLANS" + `<IphoneTabs variant="neufs">`; `<AccessoryCarousel>`; `<IphoneTabs variant="occasion">`; a **hardcoded** "Tokyo Repair" dark editorial banner (CTAs are `tel:+21650059160`, `SHOP_TEL` `:14`); `<TelephonieTabs>`; a `<PromoBar>` "UNIVERS GAMING" + `<GamingTabs variant="consoles">`; `<GamingTabs variant="jeux">`; `<GiftCardTabs>`.
4. **PromoGrid** (`promo-grid.tsx`) — three blocks: (a) editorial "Le Journal Tokyo" `FeatureCard`s — **hardcoded** copy/images/hrefs (`:105-133`) + a hardcoded "Reprise Tokyo" dark island; (b) "Nos boutiques" — **hardcoded** `stores[]` (`:45-64`, 3 Tunis stores, Google-Maps links); (c) the `promises[]` reassurance tiles — **hardcoded** copy but the delivery line is backend-aware via `useShippingConfig().freeFrom` (`:23-43`, `:83`).
5. **Newsletter** (`newsletter.tsx`) — ⚠ **MOCK**: client-side email regex validation then `setSubmitted(true)`; NO backend subscribe call (`:20-30`). Any real newsletter integration must be added here.

**The home product shelves** all funnel through **`tabbed-products.tsx`** `<TabbedProducts>` (`tabbed-products.tsx:177`), which reads the bundled `products` catalog, de-dupes variants (`variantKey`, `:44`), interleaves categories (`interleave`, `:61`), keeps sellable-first (`buildShelf`, `:89`), drops sparse tabs, and equalizes row heights (`fit`, `:152`). Each shelf component just supplies tabs:
- `iphone-tabs.tsx` — tabs auto-built per iPhone generation from categories `iphones-neufs` / `iphones-d-occasion` (`:37-59`).
- `gaming-tabs.tsx` — consoles/jeux variants, tabs mapped to explicit catalogue category slugs (`:14-48`).
- `telephonie-tabs.tsx` — handset + accessory category slugs (`:14-33`).
- `gift-card-tabs.tsx` — dematerialised-code category slugs grouped by platform (`:15-47`).
- `accessory-carousel.tsx` — Embla rail; curated via `ACCESSORY_CATEGORIES` (`:14-48`) + `BRAND_TIERS` round-robin (`:56-93`).

To remove/reorder a home section the owner edits `page.tsx` (top-level order) or `home-extras.tsx` (the inner stack). Each shelf's content is controlled by the category-slug lists in its own `*-tabs.tsx` file.

### 5. Catalog data layer (the storefront's read source of truth)

Two parallel access paths over the SAME JSON:
- **Synchronous** `src/storefront/lib/catalog.ts` — imports `data/products.json` (**2595 products**) + `data/categories.json` (**125 categories**), decodes HTML entities, derives stable unique slugs, title-cases category labels, and builds lookup maps. Exports `products`, `categories`, `slugify`, `findCategory`, `findProductBySlug`, `findProductById`, `getProductsForSlug` (rolls up the `category_path` tree), `getCategoryLabel`. **Client components** (home shelves, header search, product-card, cart) import this directly and synchronously.
- **Async facade** `src/storefront/lib/api/products.ts` + `categories.ts` (both `"server-only"`) → `src/storefront/lib/data/` (`index.ts` picks `staticSource` vs `createHttpSource` on `NEXT_PUBLIC_DATA_SOURCE=http`). `static-source.ts` just wraps the sync catalog in async signatures. **Server components** (the `[slug]`, `p/[id]` pages) import these. This indirection is the **designed backend swap seam**: flip the env var, implement `http-source.ts`, no component changes.

The DTO contract is `src/storefront/types/catalog.ts` (`Product`, `Category`). `Product` carries `category_path?: string[]` (root→leaf slug chain) enabling universe/section roll-up.

**The JSON is regenerated from the live DB** by `scripts/tokyo-export-catalog.ts` (products), `scripts/tokyo-build-categories.ts` (categories + taxonomy). `taxonomy.json` (795 lines) drives the mega menu and category nav.

**Product metadata is SYNTHESIZED, not from the backend** — `src/storefront/lib/productMeta.ts`: `fakeRating()` (`:8`) and `fakeStrike()` (`:62`) generate deterministic placeholder ratings/review-counts and struck-through "before" prices from a seed; `productWarranty`/`productHighlights`/`productSpecs`/`productFaq` build synthetic copy; `relatedProducts`/`alsoViewed` pick by category. `stockState`/`isOrderable` read real `availability`. So star ratings, review counts and discount percentages shown on every card and PDP are PLACEHOLDER UI, not real data.

Nav aliases (`src/storefront/lib/navAliases.ts`): "Bons plans", "Notre sélection", "Nouveautés", "Gift Cards", "Précommande" are NOT catalogue categories; `NAV_ALIASES` (`:83`) defines each as a derived product set so the `[slug]` route renders them through `CategoryView`. Single place to repoint when the backend owns these lists.

### 6. Backend-wired client stores (cart & favorites)

The hook API is unchanged from the design kit; only the data source moved to the backend:
- **`src/storefront/lib/cart.ts`** — `useSyncExternalStore` store whose LINES are backed by backend cart actions `getStorefrontCartAction` / `addToCartBySlugAction` / `setCartItemQuantityAction` / `removeCartItemBySlugAction` (`cart.ts:5-10`). Optimistic updates then reconcile via `refresh()`. Slug-keyed. The Tokyo Care protection **plan** per line is a client-only localStorage overlay (`PLAN_KEY`, `:33`) — the backend has no plan concept, and `cartTotals` **deliberately excludes protection from `total`** so DISPLAY == CHARGE (`:231-252`). Shipping config is backend-seeded via context (`shipping-config.tsx`). Protection plan math in `protectionPlans()` (`:164`).
- **`src/storefront/lib/favorites.ts`** — backed by backend wishlist `getWishlistSlugsAction` / `toggleWishlistAction` (guest-cookie or user, merges guest→user on login) (`:5`). Optimistic flip + reconcile. Slug list.
- **`src/storefront/lib/hydration.ts`** `useHydrated()` — views gate on this so a filled cart/favorites never flashes its empty state on first paint.

### 7. Product & listing views

- **`product-card.tsx`** `CatalogProductCard` (`:20`) — the ONLY product card sitewide (home shelves, rails, listings, favorites). Links to `/${slug}`, shows synthesized rating/strike badges, `addToCart(slug,1)` on the CTA. Presentational + the one cart write.
- **`product-view.tsx`** `ProductView` (1320 lines, `:105`) — the full PDP. Gallery+lightbox, buy box, quantity stepper, Tokyo Care radiogroup, sticky purchase capsule + floating price pill (coordinated via `useProductBar` + `useCtaBelowFold`), description/specs/FAQ, related/also-viewed rails, related-searches chips. Writes: `addToCart` + `setLinePlan` (`:171-177`), `toggleFavorite`. Embeds `<QuickBuyForm>`.
- **`quick-buy-form.tsx`** `QuickBuyForm` (`:70`) — ⚠ **MOCK**: zod-validates name/phone/address, then `setTimeout(()=>setState("done"),900)` — it does NOT place a real order (`:118-139`), unlike the full checkout. Any real express-checkout must be wired here.
- **`category-view.tsx`** `CategoryView` (1505 lines, `:301`) — the listing page: story-tile sub-category rail, faceted filters (brand/stock/condition/price/rating, each counted against the OTHER facets, `passes()` `:372`), sort, 16/page pagination, mobile filter/sort `Sheet` modals, `CategorySeo` block. Fully client-side filtering over the products passed in from the server. Mounts `CatalogProductCard`.
- Supporting: `breadcrumb.tsx` (`Breadcrumb`, `Crumb`), `page-top.tsx` (`PageTop` envelope — crumbs/title/meta/aside, used by almost every non-home page), `section-heading.tsx` (`SectionHeading`, `ViewAllLink`), `rail-arrow.tsx`, `empty-state.tsx`, `category-seo.tsx`, `pending-body.tsx`, `page-top.tsx`.

### 8. Every `(tokyo)` route and the view it mounts

| Route | File | Mounts / notes |
|---|---|---|
| `/` | `page.tsx` | Home composition (§4) |
| `/[slug]` | `[slug]/page.tsx` | Universal resolver (`resolveSlug`, `:46`): nav-alias → category → product → fuzzy. Renders `CategoryView` or `ProductView`; emits Breadcrumb/FAQ/Product JSON-LD. The main catalog route. |
| `/p/[id]` | `p/[id]/page.tsx` | Legacy id → 301-ish `redirect` to `/${slug}` via `getProductById` |
| `/panier` | `panier/page.tsx` | `CartView` (backend cart) |
| `/checkout` | `checkout/page.tsx` | `CheckoutView` — **real order** via `placeOrderFromCartAction` (COD confirms in place; card returns gateway `redirectUrl`) (`checkout-view.tsx:57`,`:295-317`) |
| `/favoris` | `favoris/page.tsx` | `FavoritesView` (backend wishlist) |
| `/account` | `account/page.tsx` | server-reads `getCurrentUser` + `listOrdersForUser`, maps to `AccountView`; `signoutAction` form (`account-view.tsx:19`) |
| `/reels` | `reels/page.tsx` | `ReelsView` — ⚠ hardcoded mock `reels[]` + socials data, sample videos |
| `/suivi-de-commande` | `suivi-de-commande/page.tsx` | `TrackOrderView` — backend `trackOrderAction` via `useActionState` |
| `/rendez-vous` | `rendez-vous/page.tsx` | `RendezVousView` — backend `getBookingDataAction`/`getAvailabilityAction`/`bookAppointmentAction` |
| `/nos-boutiques` | `nos-boutiques/page.tsx` | `ContentPage` with `nosBoutiquesDoc` |
| `/login`, `/register`, `/forgot-password`, `/reset-password`, `/login/2fa`, `/verify-email` | respective folders | Better-Auth forms in `*-form.tsx`, config from `getAuthPagesConfig()` (admin-editable, falls back to `AUTH_PAGES_FALLBACK`). `verify-email` runs `workflows.auth.verifyEmail`. All use `AuthShell`. |
| `/cgu` `/cgv` `/cookies` `/privacy` `/mentions-legales` `/notre-histoire` `/service-client` `/garantie-retours` `/help` `/carrieres` | respective folders | All render `<ContentPage doc={…}>` from a structured doc in `src/storefront/content/*.ts`. `mentions-legales` injects backend identity from `site_settings`. |
| `error.tsx` | storefront error boundary — keeps chrome, `PageTop` + retry |

Content pages are driven by `content-page.tsx` `ContentPage` (`:44`) consuming `ContentDoc` (`:27`) — heading/body/bullets structure, shared contact card. Edit the `.ts` doc files under `src/storefront/content/` to change legal/brand copy.

### 9. Presentational vs backend-wired (quick map)

- **Backend-wired (writes/reads real data):** cart.ts, favorites.ts, CheckoutView (places orders), AccountView (`getCurrentUser`/orders/signout), auth forms, TrackOrderView, RendezVousView, the `(tokyo)` layout (shipping + footer identity + logo), mentions-legales.
- **Backend-read only (via static JSON, swappable):** home shelves, `[slug]` category/product pages, header search, product-card, category filters.
- **Pure presentational / hardcoded:** HeroCarousel slides, PromoGrid editorial+stores+promises copy, HomeExtras banners, PromoBar, ReelsView data, socials.ts, store phone/address constants scattered across ProductView/PromoGrid/quick-buy (3 Tunis stores + `tel:+21650059160`).
- **Mocks (look real, do nothing):** Newsletter form, QuickBuyForm submission.


<details>
<summary><strong>1. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- src/app/(shop)/(tokyo)/layout.tsx — Tokyo chrome + .tokyo scope + backend seeds
- src/app/(shop)/layout.tsx — thin 404/maintenance gate above chrome
- src/app/(shop)/(tokyo)/page.tsx — home section order
- src/app/globals.css:1189-1589 — the .tokyo design tokens & dark mode
- src/storefront/components/storefront/header.tsx — 2061-line nav pill + mega menu
- src/storefront/components/storefront/footer.tsx — hardcoded link columns + backend identity
- src/storefront/components/storefront/mobile-bottom-nav.tsx — phone tab bar
- src/storefront/components/storefront/home-extras.tsx — home inner section stack
- src/storefront/components/storefront/tabbed-products.tsx — shared home shelf engine
- src/storefront/components/storefront/product-view.tsx — full PDP (1320 lines)
- src/storefront/components/storefront/category-view.tsx — listing + facets (1505 lines)
- src/storefront/components/storefront/product-card.tsx — the only product card
- src/storefront/lib/catalog.ts — sync JSON catalog + slug/lookup logic
- src/storefront/lib/data/ — async source facade (static→http swap seam)
- src/storefront/lib/cart.ts & favorites.ts — backend-wired client stores
- src/storefront/lib/productMeta.ts — SYNTHESIZED ratings/strike/specs/warranty
- src/storefront/lib/navAliases.ts — Bons plans/Nouveautés/etc derived shelves
- src/storefront/components/storefront/ui-classes.ts — shared class recipes
- src/storefront/components/storefront/content-page.tsx + content/*.ts — legal/brand pages
- src/storefront/data/{products,categories,taxonomy}.json — the catalog snapshot

**Models / tables**

- No DB tables owned by this subsystem — it is the Next-bound frontend. It READS: site_settings (shipping config, footer identity, logo, auth-pages config), backend cart (cart + cart items, guest gz.cart_token cookie), wishlist, order + order_number/status/total_cents (millimes), user/session (better-auth), appointment/booking tables (rendez-vous).
- DTOs/types owned here: Product & Category in src/storefront/types/catalog.ts (the UI contract and backend-swap mapping); CartLine/CartState/CartItem/ProtectionPlan in lib/cart.ts; ContentDoc/ContentSection in content-page.tsx; FooterData in footer.tsx; AccountOrder/AccountSession in account-view.tsx; TaxoNode/NavCrumb/NavContext in lib/categoryNav.ts; NavAlias in lib/navAliases.ts.
- Catalog JSON schema (data/products.json item): id, slug, title, link, image, price (millime integer), currency, availability, condition, brand, category (slug), product_type (breadcrumb path), category_path[] (root→leaf slug chain).

**Sources of truth**

- Catalog display data: src/storefront/data/products.json (2595 items), categories.json (125), taxonomy.json — regenerated from the live DB by scripts/tokyo-export-catalog.ts & scripts/tokyo-build-categories.ts
- Design tokens: the .tokyo scope in src/app/globals.css:1197-1308 (light+dark); class recipes in src/storefront/components/storefront/ui-classes.ts
- Shipping fee/threshold shown in UI: backend checkout settings via getStorefrontShippingConfig() seeded in (tokyo)/layout.tsx through ShippingConfigProvider
- Footer/mentions-legales identity: backend site_settings via getAllSettingsServerOnly/getSiteContacts/getSiteLogoUrl
- Cart lines: backend cart (DB/guest-cookie) via @/lib/actions/cart; Favorites: backend wishlist via @/lib/actions/wishlist
- Orders: @/lib/actions/order (placeOrderFromCartAction, trackOrderAction); Account orders: listOrdersForUser; Auth: Better Auth + getAuthPagesConfig + workflows.auth
- Ratings/review counts/discount %: NOT a source of truth — synthesized deterministically in src/storefront/lib/productMeta.ts (fakeRating/fakeStrike)
- Nav-only shelves (Bons plans, Notre sélection, Nouveautés, Gift Cards, Précommande): src/storefront/lib/navAliases.ts NAV_ALIASES
- Legal/brand page copy: structured docs in src/storefront/content/*.ts
- Mega-menu structure: generated from taxonomy.json; curated icons/blurbs only in header.tsx UNIVERSE_META

**Editable / removable**

- Remove/reorder home sections by editing src/app/(shop)/(tokyo)/page.tsx (top-level 5 sections) and home-extras.tsx (inner stack) — each is an isolated component, safe to drop.
- Home shelf CONTENTS are controlled by category-slug lists in each *-tabs.tsx (iphone/gaming/telephonie/gift-card) and accessory-carousel.tsx ACCESSORY_CATEGORIES/BRAND_TIERS — edit freely; they just filter the bundled catalog.
- HeroCarousel slides[], PromoGrid FeatureCards/stores/promises, HomeExtras banners are hardcoded arrays — safe to edit copy/images/hrefs in place.
- Footer link columns (footer.tsx columns[]/legalLinks[]) are hardcoded with real route hrefs — editable; items with no href degrade to plain text, so removing a target page won't 404.
- Legal/brand/help page copy: edit the ContentDoc objects in src/storefront/content/*.ts; the page files are thin wrappers.
- LOAD-BEARING, do NOT lightly change: src/storefront/lib/catalog.ts slug derivation (the whole /[slug] URL space + cart/favorites keys depend on stable slugs); the Product DTO in types/catalog.ts (the backend-swap contract); the .tokyo class on the layout wrapper (removing it strips the entire design system); ui-classes.ts (shared by every component).
- LOAD-BEARING: the data/*.json + their generator scripts — editing JSON by hand will be overwritten on next regen; change the DB and re-run scripts instead.
- header.tsx is huge and tightly coupled (mega-menu sizing, hover-intent, product-bar coordination) — change surgically.
- Backend seams (cart.ts, favorites.ts, checkout-view.tsx, account, auth forms, track-order, rendez-vous) call real Server Actions — removing/altering them affects real orders/data; the cartTotals protection-exclusion (display==charge) is intentional, keep it until a real protection system exists.

**Gaps / risks**

- Newsletter form (newsletter.tsx:20-30) is a MOCK — validates email client-side and shows success but never subscribes anywhere. No backend integration.
- QuickBuyForm (quick-buy-form.tsx:118-139) is a MOCK — the PDP 'Achat rapide' express flow validates then fakes success with setTimeout; it does NOT create an order, unlike /checkout. A customer using it believes they ordered but no order exists.
- Star ratings, review counts, and discount/strike prices across ALL cards and PDPs are SYNTHESIZED placeholders (productMeta.ts fakeRating/fakeStrike), not real data — misleading if taken as genuine; must be replaced when real reviews/pricing land.
- ReelsView data is hardcoded mock reels with Unsplash posters + Google sample videos — not real content.
- Two parallel catalog access paths (sync catalog.ts for client, async lib/api for server) read the same JSON but could drift; the async http-source.ts is a stub (static-only today).
- Store addresses/phones are hardcoded in multiple places (promo-grid.tsx stores[], product-view.tsx stores[], quick-buy-form.tsx stores[], SHOP_TEL constants) — the footer pulls stores from backend site_settings, so the home/PDP store lists can disagree with the footer. Single source would be safer.
- products.json is 2595 products on a single line and bundled into the client via catalog.ts — this ships the full catalog to the browser (bundle-size/perf consideration) and means price/stock are only as fresh as the last scripts/tokyo-export-catalog.ts run, not live.
- Cart Tokyo Care protection plan is a localStorage-only overlay never sent to the order; deliberately excluded from totals — a known placeholder that will need backend support.
- The (shell) legacy group still owns real flows the (tokyo) design lacks a replacement for (order confirmation /order/[id], pro/B2B, fidélité, blog, collections, parrainage) — some footer/account links cross back into legacy chrome; retiring (shell) requires porting these first.
- Header is 2061 lines with intricate interdependent animation/measurement effects — high regression risk on edits.
- catalog.ts slug de-duplication is order-dependent on products.json; reordering/regenerating the JSON could in theory shift a fallback-derived slug (mitigated by backend-provided slugs being preferred).

</details>


---

## 2. Storefront Data Bridge, Catalog Snapshots & Client Libs

This subsystem is **how the swapped-in "Tokyo" storefront design renders the real backend catalogue without editing a single design component**. The design was built against a synchronous, bundled catalogue module; rather than rewrite every component to `await` DB queries, the bridge keeps that exact module shape and **feeds it a point-in-time JSON export of the live DB**. Catalogue *reads* for the Tokyo UI are therefore served from a bundled snapshot, while *mutations* (cart, favorites, checkout, shipping) are wired to the real backend through Server Actions.

### A. The source of truth (read this first)

For Tokyo-storefront **catalogue data** (products, category labels/counts, nav taxonomy), the source of truth is **three JSON files**, not the DB:

- `src/storefront/data/products.json` — 2,595 products, ~1.4 MB, minified single line
- `src/storefront/data/categories.json` — ~237 `{slug,label,count}` rows, pretty-printed
- `src/storefront/data/taxonomy.json` — the nav tree, 8 root universes, pretty-printed

These are a **snapshot regenerated from the live DB** by `scripts/tokyo-export-catalog.ts`. The live DB is the *upstream* source of truth, but the storefront never reads it for catalogue display — it reads the JSON bundled at build time. **Editing a product/category in the admin does NOT change the Tokyo storefront until `tokyo-export-catalog.ts` is re-run.** This staleness is the single most important fact for anyone editing catalogue data (see gaps).

Backend-owned *state* (cart lines, wishlist, shipping config, order creation) is the exception — it is read live from the DB via Server Actions, not from JSON (see section D).

### B. The synchronous catalogue module — `src/storefront/lib/catalog.ts`

`catalog.ts:1-2` statically imports the two JSON files, so the whole catalogue is bundled. It then (`catalog.ts:68-90`):
- Builds `export const products: Product[]` — for each raw row it HTML-decodes the title (`decodeEntities`, `catalog.ts:11-28`, handles `&#039;` etc.), **prefers the backend-provided `slug`**, and falls back to a title-derived, collision-suffixed slug (`seenSlugs`) only for slug-less rows. This is the **single slug space** shared by home/category/search/PDP.
- Builds `export const categories: Category[]` — title-cases each label (`titleCaseLabel`, `catalog.ts:44-58`, with French small-word rules).
- Builds three O(1) lookup Maps: `categoryBySlug`, `productBySlug`, `productById` (`catalog.ts:88-90`).

Exported resolvers: `slugify` (`:30`), `findCategory` (direct then fuzzy-by-slugified-label, `:92`), `getCategoryLabel` (`:99`), `findProductBySlug`/`findProductById` (`:109`/`:113`), and the key one:

**`getProductsForSlug(slug)` (`catalog.ts:117-132`) — the roll-up.** It resolves the slug to a category, then returns every product whose `category_path` *includes* that slug — so a **universe or section page shows all products filed anywhere beneath it**, not just direct children. Fallbacks: leaf-exact `category === targetSlug` for rows with no `category_path`, then a `product_type` substring match for fuzzy/alias slugs.

**Product DTO** (`src/storefront/types/catalog.ts:20-39`), the contract every component depends on:
`id, slug, title, link (/<slug>), image (/cdn/... AVIF URL), price (MAJOR-UNIT dinars — e.g. 199, already promo-folded, NOT millimes), currency ("TND"), availability ("in_stock"|"out_of_stock"), condition, brand, category (leaf slug), product_type (breadcrumb "A / B / C"), category_path (root→leaf slug chain)`. **Category DTO** = `{slug, label, count}`; `count` is products filed *directly* on that leaf (exact match), sorted desc.

### C. Taxonomy / nav derivation

- **`categoryNav.ts`** loads `taxonomy.json` as `TaxoNode[]` (`{slug,name,count,children}`). An IIFE (`:29-37`) indexes `nodeBySlug`/`parentBySlug`/`chainBySlug`. It exports `getNavContext(slug)` (universe/section/siblings/isUniverse — drills into children, else shows siblings, else universes, `:45-67`), `categoryTrail(slug)` (ancestors excl. self), `taxonomyLabel(slug)`, and `universeCrumbs`. Consumed by the `[slug]` route, `header.tsx`, `category-view.tsx`, `product-view.tsx`. The 8 universes: `univers-apple (896)`, `telephonie (522)`, `console-gaming (502)`, `pc-gaming (160)`, `audiovisuel (157)`, `univers-tokyo-store (124)`, `objets-connectes (118)`, `cartes-cadeaux-et-abonnements (95)`.
- **`navAliases.ts`** defines 5 **synthetic nav destinations that are NOT categories**: `bons-plans`, `notre-selection`, `nouveautes`, `gift-cards`, `precommande` (`NAV_ALIASES`, `:83-113`). Each `.resolve()` returns a `Product[]` computed from the static `products` array via hardcoded category-slug lists (`GIFT_CARD_CATEGORIES`/`SELECTION_CATEGORIES`/`NEW_IN_CATEGORIES`, `:23-62`) and helpers `inCategories`/`interleaveByCategory`. `bons-plans` uses `fakeStrike` (invented discounts); `precommande` filters `availability === "backorder"` (see gaps — export never emits that). The `[slug]` route checks aliases **before** real categories (`[slug]/page.tsx:51`).
- **`categorySeo.ts`** supplies French SEO/marketing copy — per-alias `ALIAS_COPY` (`:78-191`) plus generic templates for real categories: `getCategoryMeta`/`getCategoryBlurb`/`getCategoryIntro`/`getCategoryFaq` (`:204-251`). Drives `<title>`/description, the on-page SEO block (`category-seo.tsx`) and FAQPage JSON-LD.
- **`platform-map.ts`** — `toUiProduct(backendProduct)` maps `src/types/catalog` → the UI `Product` DTO. **Only consumer is the LEGACY `(shell)` route** (`(shop)/(shell)/_components/category-client.tsx`); it is **not used by the Tokyo design**, which goes through the JSON bridge. Effectively orphaned w.r.t. Tokyo.

### D. Backend-wired client libs (keep the design, hit the real backend)

These preserve the design's hook/function API while swapping the data layer to the real backend:

- **`cart.ts`** (`"use client"`) — a `useSyncExternalStore` store whose lines are backed by the **backend cart** (DB / guest cookie / user) via `@/lib/actions/cart`: `getStorefrontCartAction`, `addToCartBySlugAction`, `removeCartItemBySlugAction`, `setCartItemQuantityAction` (all confirmed to exist). Slug-keyed; keeps a `slug → backend item-id` map (`:38`). Optimistic updates then `refresh()`. **Tokyo Care protection plans are a client-only `localStorage` overlay** (`PLAN_KEY = "tokyo-cart-plans-v1"`, `:33,40-57`), deliberately **excluded from `total`** so display == charge (`cartTotals`, `:231-252`, comment `:237-243`). `cartTotals` takes a `ShippingConfig` arg.
- **`favorites.ts`** (`"use client"`) — backed by the **backend wishlist** via `@/lib/actions/wishlist`: `getWishlistSlugsAction`, `toggleWishlistAction` (exist; also merge guest list on login). Slug-list store, optimistic with server-truth reconcile.
- **`shipping-config.tsx`** — React context (`ShippingConfigProvider`/`useShippingConfig`). **Server-seeded** by the `(tokyo)` layout (`(shop)/(tokyo)/layout.tsx:39,53`) from `getStorefrontShippingConfig()` in `src/lib/checkout/shipping.ts`. `DEFAULT_SHIPPING = {fee:7, freeFrom:250}` is only a safety net when rendered outside the provider.
- **`price.ts`** — `MINOR_PER_DINAR=1000`, `minorToDinars`/`dinarsToMinor`/`formatDinars`. **Largely vestigial on the static path** (products.json already holds major-unit dinars); they exist to keep the swap mechanical and are only truly needed by the never-wired HTTP source.
- **`hydration.ts`** — `useHydrated()` SSR gate (prevents empty-cart/favorites flash).
- **`productBar.ts`** — tiny UI store for the sticky product/nav bar (not data).
- **`productMeta.ts`** — **deterministic PLACEHOLDER generators**, not backend data: `fakeRating` (seeded, ~1/7 unrated), `fakeStrike` (invented "was" price + %), `stockState`/`isOrderable`/`STOCK_LABEL` (handles a `backorder` state the data never carries), `conditionLabel`, `productWarranty`/`productSpecs`/`productFaq`/`productHighlights` (derived from taxonomy/condition), and `relatedProducts`/`alsoViewed` (computed client-side from the static array). Consumed by `static-source`, `navAliases`, `cart`, and the `[slug]` route.

### E. The data-source abstraction + server facades

- `src/storefront/lib/data/source.ts` — `CatalogSource` interface (12 async methods).
- `static-source.ts` — **the only active implementation**; delegates straight to `catalog.ts` + `productMeta`.
- `http-source.ts` — **a leftover stub**: `createHttpSource` returns an object whose every method throws `notImplemented()` (`:37-57`). It is never reached: `index.ts:13-18` picks it only when `NEXT_PUBLIC_DATA_SOURCE === "http"` && `NEXT_PUBLIC_API_URL` are set, and **neither var is set anywhere in the repo** (grep shows only the gate + doc comments). Safe to treat as dead/future code.
- `index.ts` — exports `catalogSource` (= `staticSource`).
- `src/storefront/lib/api/products.ts` & `categories.ts` — `"server-only"` facades over `catalogSource`.

**Two parallel access paths to the same JSON:** (1) the async `CatalogSource` facade, used by **exactly two routes** — `(tokyo)/[slug]/page.tsx` (the universal category/product resolver, incl. metadata + JSON-LD) and `(tokyo)/p/[id]/page.tsx` (legacy `/p/<id>` → `/<slug>` redirect); (2) **direct synchronous imports of `catalog.ts`** by ~17 modules, mostly client components (`header.tsx`, `product-card.tsx`, `cart-view.tsx`, `category-view.tsx`, `product-view.tsx`, tabs/carousels). Both resolve to the same bundled data.

### F. The regeneration pipeline (run in this order)

No `package.json` script wraps these; each file's header carries the raw `pnpm tsx --conditions=react-server --env-file-if-exists=.env.local scripts/<file>` invocation.

1. **`scripts/tokyo-build-categories.ts`** — reads the migration XML (`parseGoogleFeed`), **soft-deletes all existing categories/brands/products** (`:38-40`), then creates the nested category tree with globally-unique slugs (disambiguated by parent name, `:70-79`). Must run first because the importer maps feed breadcrumbs onto existing categories and never creates them.
2. **`scripts/tokyo-import-feed.ts`** — runs `runProductImport` headless on the same XML (`:38`), creating products + brands (find-or-create) and downloading images through the SSRF-hardened sharp→webp/avif→SeaweedFS pipeline. Long-running (~2.6k products).
3. **`scripts/tokyo-export-catalog.ts`** — reads the **live DB** (`categoryService.listAll()` + `listApiProducts({public:false})` paged, `:53-109`) and writes all three JSON files (`:149-151`). Notable logic: files each product at its **deepest** category (`leaf = p.subcategory ?? p.category`, `:91`, to preserve full taxonomy depth); builds `product_type` breadcrumb + `category_path` chain; rolls up taxonomy counts via `category_path` and **prunes empty categories** at every level (`:124-147`). Prices come straight from `listApiProducts` (`price: p.price`, major-unit dinars, promo-folded — `src/lib/api/products.ts` maps `price_cents → price`).

`scripts/tokyo-clean-page-meta.ts` and `scripts/patch-nav-fix.ts` do **not** touch storefront data (verified) and are out of scope here.


<details>
<summary><strong>2. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- src/storefront/lib/catalog.ts — synchronous bundled catalogue + roll-up resolver
- src/storefront/data/products.json — 2,595-product snapshot (source of truth for display)
- src/storefront/data/categories.json — {slug,label,count} rows
- src/storefront/data/taxonomy.json — nav tree, 8 universes, rolled-up counts
- src/storefront/types/catalog.ts — Product/Category DTO contract
- src/storefront/lib/categoryNav.ts — taxonomy indexing + nav context/trail
- src/storefront/lib/navAliases.ts — 5 synthetic non-category nav pages
- src/storefront/lib/categorySeo.ts — French SEO copy per alias + category template
- src/storefront/lib/platform-map.ts — backend→UI mapper (legacy shell only)
- src/storefront/lib/cart.ts — backend-cart-backed store + Tokyo Care overlay
- src/storefront/lib/favorites.ts — backend-wishlist-backed store
- src/storefront/lib/shipping-config.tsx — server-seeded shipping context
- src/storefront/lib/productMeta.ts — deterministic PLACEHOLDER rating/strike/warranty
- src/storefront/lib/price.ts — millime/dinar helpers (vestigial on static path)
- src/storefront/lib/data/{source,static-source,http-source,index}.ts — CatalogSource abstraction (http = dead stub)
- src/storefront/lib/api/{products,categories}.ts — server-only facades (used by 2 routes)
- src/app/(shop)/(tokyo)/[slug]/page.tsx — universal category/product resolver using the facade
- src/app/(shop)/(tokyo)/p/[id]/page.tsx — legacy /p/<id> → /slug redirect
- scripts/tokyo-export-catalog.ts — DB→JSON exporter (regenerates the 3 snapshots)
- scripts/tokyo-build-categories.ts — wipe+rebuild category tree from migration XML
- scripts/tokyo-import-feed.ts — headless product/brand/image import from XML
- src/app/(shop)/(tokyo)/layout.tsx — seeds ShippingConfigProvider from backend

**Models / tables**

- UI Product DTO (src/storefront/types/catalog.ts): id, slug, title, link, image(/cdn AVIF), price(major-unit dinars, promo-folded), currency, availability(in_stock|out_of_stock), condition, brand, category(leaf slug), product_type(breadcrumb), category_path(root→leaf slugs)
- UI Category DTO: {slug, label, count(direct-filed products)}
- TaxoNode (categoryNav.ts): {slug, name, count(rolled-up), children: TaxoNode[]}
- CartLine (cart.ts): {id(slug), qty, plan(Tokyo Care plan id|null)}; ProtectionPlan {id,label,months,monthly,total,perks}
- ShippingConfig (shipping-config.tsx): {fee(dinars), freeFrom(dinars)}
- CatalogSource interface (data/source.ts): 12 async catalogue read methods
- Upstream DB (read only by export script): categories (id, slug, name, parent_id, display_order), products, brands — via categoryService / listApiProducts; cart + wishlist tables via Server Actions
- NavAlias (navAliases.ts): {label, resolve():Product[]} for bons-plans|notre-selection|nouveautes|gift-cards|precommande

**Sources of truth**

- Tokyo storefront catalogue DISPLAY data: the three JSON files in src/storefront/data/ (products.json, categories.json, taxonomy.json) — a point-in-time export, NOT live DB
- Upstream of those JSON files: the live PostgreSQL catalogue (categories/products/brands tables), read only by scripts/tokyo-export-catalog.ts
- Slug space: the backend-provided product/category slugs carried through the export into products.json/categories.json/taxonomy.json (catalog.ts prefers p.slug)
- Cart lines: live backend cart via @/lib/actions/cart (DB + gz.cart_token guest cookie / user) — NOT JSON, NOT localStorage
- Favorites: live backend wishlist via @/lib/actions/wishlist — NOT localStorage
- Shipping fee/threshold shown in storefront: getStorefrontShippingConfig() in src/lib/checkout/shipping.ts, seeded server-side in (tokyo)/layout.tsx
- Tokyo Care protection plan selection: client-only localStorage key 'tokyo-cart-plans-v1' (no backend persistence)
- Synthetic nav pages (bons-plans/nouveautes/etc.): hardcoded category-slug lists in src/storefront/lib/navAliases.ts
- Product ratings / strike-through discounts / warranty text: deterministic generators in src/storefront/lib/productMeta.ts (fabricated, not DB-backed)

**Editable / removable**

- SAFE TO EDIT: navAliases.ts slug lists, categorySeo.ts copy, productMeta.ts warranty/FAQ/highlight text, shipping DEFAULT_SHIPPING safety net, socials.ts / content/*.ts — pure config/content, no DB coupling
- DO NOT hand-edit the 3 JSON files: they are generated output; manual edits are overwritten on the next tokyo-export-catalog run. Change the DB (admin/import) then re-export
- catalog.ts is LOAD-BEARING: ~17 modules + the CatalogSource facade depend on its exports (products, slugify, getProductsForSlug, findProductBySlug, findCategory); the entire /[slug] routing hinges on getProductsForSlug roll-up and the slug map
- REMOVABLE (dead): http-source.ts is a never-reached stub (NEXT_PUBLIC_DATA_SOURCE is never set). The whole data/ abstraction + api/ facades could in principle be collapsed to direct catalog.ts imports, but [slug]/page.tsx and p/[id]/page.tsx currently depend on the async facade — update those two routes first
- platform-map.ts: used ONLY by the legacy (shell) route; removable once (shell) is retired, not before
- price.ts minorToDinars/dinarsToMinor: vestigial for the static path but imported by http-source and used elsewhere in the platform — keep
- Tokyo Care (cart.ts protectionPlans/setLinePlan + localStorage): removable as a unit since it is excluded from totals and not persisted server-side — but cart-view UI references it
- Server Actions (@/lib/actions/cart, @/lib/actions/wishlist) and getStorefrontShippingConfig are the real backend wiring — treat as load-bearing contracts; the storefront hook API intentionally mirrors them

**Gaps / risks**

- STALE-SNAPSHOT RISK (biggest): products.json/categories.json/taxonomy.json are a point-in-time DB export. Admin catalogue edits, price/stock changes, and new products do NOT appear in the Tokyo storefront until scripts/tokyo-export-catalog.ts is re-run. No automation/CI hook exists; it is a manual raw pnpm tsx command documented only in file headers.
- FAKE DISCOUNTS: productMeta.fakeStrike invents the struck-through 'was' price and % off from a seed; the real backend promo price is already baked into products.json 'price' (promo-folded), but the displayed discount badge is fabricated. The 'bons-plans' nav page is built entirely on these fake percentages.
- BROKEN 'precommande' ALIAS: navAliases precommande filters availability === 'backorder', but tokyo-export-catalog only ever writes 'in_stock' | 'out_of_stock' (RawProduct type line ~33 and mapping line ~99). So the Précommande page almost certainly renders EMPTY. stockState() also has dead 'backorder' handling.
- FULL CATALOGUE SHIPS TO CLIENT: catalog.ts statically imports the ~1.4 MB products.json and is imported by client components (cart.ts 'use client', header.tsx, product-card.tsx). The entire 2,595-product array is bundled into the client JS — a real bundle-size/perf concern that grows with the catalogue.
- DEAD CODE: http-source.ts throws on every call and is unreachable (NEXT_PUBLIC_DATA_SOURCE/NEXT_PUBLIC_API_URL never set). The CatalogSource abstraction's stated purpose (flip to a live HTTP backend) is unrealised; the real 'live backend' path chosen instead was the JSON re-export + Server Actions.
- price.ts helpers are vestigial on the active path and the header comments still describe a 'future backend swap' that was superseded by the in-repo JSON bridge — docs lag the actual architecture.
- DESTRUCTIVE PIPELINE ORDERING: tokyo-build-categories.ts soft-deletes ALL categories/brands/products before rebuilding; running it out of order (or without the subsequent import) wipes the catalogue. The 3 scripts have an implicit build→import→export ordering with no guard.
- Tokyo Care protection is a placeholder: client-only localStorage, excluded from totals, never sent to the order — any future real implementation must fold it back into cartTotals.total AND the order.
- Two divergent code paths read the same data (async facade in 2 routes vs. direct sync catalog.ts imports elsewhere); a change to data shape must satisfy both. The legacy (shell) route additionally reads the DB live via platform-map, so (shell) and (tokyo) can show different data for the same product until the export is refreshed.

</details>


---

## 3. Legacy (shell) storefront — what remains & retirement status

### What the (shell) group is

`src/app/(shop)/(shell)/**` is the **backend-era storefront chrome and the routes the new Tokyo design has not yet re-implemented**. It is a Next.js route group (parentheses → no URL prefix), so every `page.tsx` under it serves its path wrapped in the legacy header/footer. The sibling `(tokyo)` group is the new crimson design. They coexist: a static `(shell)` segment (e.g. `/blog`) wins over Tokyo's `[slug]` catch-all, while any un-matched slug falls through to `(tokyo)/[slug]` (the catalog). The two groups never collide because the retired shell routes (`panier`, `checkout`, `favoris`, `account` base) **had their `page.tsx` removed** — only orphan component files remain.

**Three layouts stack:**
- `src/app/(shop)/layout.tsx:37` — thin, **no chrome**: runs the maintenance/coming-soon hard gate and is the 404 boundary (so a storefront 404 is chrome-free). Short-circuits before any expensive chrome fan-out.
- `src/app/(shop)/not-found.tsx` — chrome-free 404 scene (admin-editable copy via `getNotFoundConfig`).
- `src/app/(shop)/(shell)/layout.tsx:71` — the **legacy chrome**: `SiteHeader`/`SiteFooter`/`MobileBottomBar` (`@/components/site-header`, `@/components/site-footer`, imported at lines 3-5), the data-driven mega-menu (`getMainNavRoots`, line 211), consent/tracking scripts, theme injection, cart badge, B2B door visibility. This chrome is scoped `.storefront` and is imported **only** by this layout (shell-only; Tokyo does not use it).
- `src/app/(shop)/(tokyo)/layout.tsx:34` — the new `.tokyo` chrome (`@/storefront/components/storefront/{header,footer,mobile-bottom-nav}`).
- `src/app/(shop)/(shell)/error.tsx` — the shell error boundary (keeps chrome mounted on a render failure).

**Consequence for the owner:** the legacy chrome is **not retired** — it still renders on ~16 live shell routes. Navigating from a Tokyo page to any shell route swaps the entire design (crimson `.tokyo` → legacy `.storefront`). It cannot be deleted until those routes are migrated to Tokyo or removed.

### Route-by-route inventory

Legend — **DEAD** (no `page.tsx`, orphan files), **SHIM** (thin redirect), **LIVE-ONLY** (the sole implementation of a feature; removing it deletes the feature).

| Route | Status | What it is / backing | Tokyo equivalent? |
|---|---|---|---|
| `about/page.tsx:8` | SHIM | 308 → `/notre-histoire` | Yes (`notre-histoire`) — this is the shim into it |
| `brand/[slug]/page.tsx:20` | SHIM | `resolveRedirect` then 308 → flat `/<slug>` | Yes (`[slug]` resolver) |
| `blog/category/[slug]` | SHIM | 308 → flat `/blog/<slug>` | No (blog is shell) |
| `mes-credits/page.tsx:11` | SHIM | `requireSession` then 308 → `/account` | Yes (`account`) |
| `boutique/page.tsx:71` | LIVE-ONLY | Admin block-builder category **chooser** landing; `getBoutiqueLandingConfig`, `listCategories`, `collectionQueries`, `brandQueries`. Links to `/collection/<slug>` + flat brand slugs | No |
| `marques/page.tsx:58` | LIVE-ONLY | Admin block-builder **brands index**; `getMarquesLandingConfig`, `brandQueries`. (`/brand/<slug>` redirects here-ish → flat) | No |
| `collections/page.tsx:65` | LIVE-ONLY | Admin block-builder **collections magazine**; `getCollectionsLandingConfig`, `collectionQueries`, `CollectionRail`/`CollectionHero` | No |
| `collection/[slug]/page.tsx:65` | LIVE-ONLY | Collection detail grid via shared `CategoryPageClient`; `collectionQueries` + `listProductsByCollection`. Own namespace (not flat) | No |
| `recherche/page.tsx` | LIVE-ONLY | Full search results via `CategoryPageClient` + `SearchTrack`; `searchService`, rate-limited. **Orphaned** — Tokyo header search never routes here | No (see gaps) |
| `fidelite/page.tsx:49` | LIVE-ONLY | Loyalty landing « Cercle de Famille » block-builder; `getFideliteLandingConfig` + live `loyalty_levels`. `/niveaux-avantages` 308→ here (`next.config.ts:78`) | No |
| `blog/page.tsx` · `blog/[slug]` · `blog/tag/[slug]` · `auteur/[slug]` | LIVE-ONLY | Blog system; `blogQueries`/`authorQueries`; components in `src/components/blog/*`. `blog/[slug]` resolves a post then falls back to a category | No |
| `pro/page.tsx:35` · `pro/login` · `pro/join/[token]` | LIVE-ONLY | **B2B portal**, flag-gated (`isBusinessEnabled()` → `notFound()` when off); session + membership auth; `businessService`/`authService`. Sub-components `pro-manage-company` → `member-role-control`, `pro-join-requests`; `pro-login-form` → `pro-apply-dialog` | No |
| `order/[id]/page.tsx:54` | LIVE-ONLY, **depended-on** | Checkout confirmation, UUID-bearer; `modules/order` + `workflows` + `PurchaseTrack`. **Tokyo checkout redirects here** (`src/lib/actions/order.ts:1019` → `/order/${id}?fresh=1`) | No — Tokyo relies on it |
| `order/verify/[id]/page.tsx` | LIVE-ONLY | Public QR verification (limited bearer payload) | No |
| `account/orders/[id]/page.tsx:47` | LIVE-ONLY, **depended-on** | Owner-gated order detail/tracking (`requireSession`); `OrderSteps`. **Tokyo account links here** (`storefront/components/storefront/account-view.tsx:233`) | Base `/account` is Tokyo; the `/orders/[id]` detail is shell-only |
| `parrainage/[token]/page.tsx:28` | LIVE-ONLY | Loyalty referral invite accept, flag-gated; `loyaltyReferralService`; `accept-button` | No |
| `u/[slug]/page.tsx:27` | LIVE-ONLY | Public shared-favorites page, **feature-gated OFF by default** (`favoritesPublicEnabled`); `wishlistService`; `ProductGrid` + `share-button` | No |
| `se-desabonner/page.tsx:18` | LIVE-ONLY | Newsletter unsubscribe (POST-confirm), **gate-exempt** (renders in the bare maintenance shell); `unsubscribeByTokenAction` | No |

**Shared internals:** `_components/category-client.tsx` (`CategoryPageClient`) is the **shared product-grid + facet-filter + sort client**, used by `collection/[slug]` and `recherche`, and depended on by catalog libs (`src/lib/catalog/*`, `src/lib/listing/*`) and tests — load-bearing.

### Dead / retired leftovers (no `page.tsx`, zero runtime importers)

These directories lost their routes to Tokyo but kept orphan files (stale duplicates that can mislead edits):
- `panier/cart-panel.tsx`, `panier/coupon-form.tsx` — dead (only a comment reference in `src/lib/cart/cart-page-copy.ts:9-10`). Tokyo `/panier` is live.
- `checkout/checkout-form.tsx` — dead (only comment refs in `src/lib/checkout/form-copy.ts`, `src/lib/actions/order.ts:629`; the `id="checkout-form"` in `storefront/.../checkout-view.tsx` is an HTML id, not an import). Tokyo `/checkout` is live.
- `account/account-client.tsx` (**74 KB**) + `cercle-panel.tsx`, `two-factor-card.tsx`, `company-loyalty-card.tsx`, `join-by-code-card.tsx`, `leave-company-button.tsx`, `life-stage-panel.tsx`, `loyalty-qr-card.tsx`, `oauth-autolink-card.tsx`, `public-share-card.tsx`, `purchase-mode-card.tsx` — dead UI subtree (no `page.tsx` renders them). Tokyo `/account` is live. **But** `account-client.tsx` is read as source text by `src/lib/db/tests/identity-low.test.ts:238` (a `sourceInvariants` regex check), so deleting it breaks that test until the assertion block is removed.
- `favoris/` — **empty directory**. Tokyo `/favoris` is live.


<details>
<summary><strong>3. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- src/app/(shop)/layout.tsx:37 — thin parent: maintenance gate + 404 boundary, no chrome
- src/app/(shop)/not-found.tsx — chrome-free storefront 404
- src/app/(shop)/(shell)/layout.tsx:71 — legacy chrome (SiteHeader/SiteFooter/MobileBottomBar, mega-menu, tracking)
- src/app/(shop)/(shell)/error.tsx — shell error boundary
- src/app/(shop)/(shell)/_components/category-client.tsx — shared product grid+filters (collection + recherche)
- src/app/(shop)/(shell)/boutique/page.tsx — admin block-builder category chooser landing
- src/app/(shop)/(shell)/marques/page.tsx — admin block-builder brands index
- src/app/(shop)/(shell)/collections/page.tsx + collection/[slug]/page.tsx — collections magazine + detail
- src/app/(shop)/(shell)/recherche/page.tsx — full search results (orphaned from Tokyo)
- src/app/(shop)/(shell)/fidelite/page.tsx — loyalty landing Cercle de Famille
- src/app/(shop)/(shell)/blog/{page,[slug],tag/[slug]}/page.tsx + auteur/[slug]/page.tsx — blog system
- src/app/(shop)/(shell)/pro/{page,login,join/[token]}/page.tsx — flag-gated B2B portal
- src/app/(shop)/(shell)/order/[id]/page.tsx — checkout confirmation (Tokyo checkout redirects here)
- src/app/(shop)/(shell)/account/orders/[id]/page.tsx — order detail (Tokyo account links here)
- src/app/(shop)/(shell)/{parrainage/[token],u/[slug],se-desabonner}/page.tsx — referral / public favorites / unsubscribe
- src/app/(shop)/(shell)/account/account-client.tsx (74KB, DEAD) + panier/*, checkout/checkout-form.tsx, favoris/ (empty) — retired orphans
- src/app/(shop)/(tokyo)/layout.tsx:34 — contrast: new Tokyo chrome (shell is not this)

**Models / tables**

- modules/order (orders, items, status history) — order/[id], order/verify/[id], account/orders/[id]
- modules/blog + authorQueries — blog/*, auteur/[slug]
- modules/business (B2B companies, memberships, invites, seat allocations) — pro/*
- modules/loyalty (loyalty_levels, loyalty config) + associations/loyalty-referral.service — fidelite, parrainage/[token]
- modules/wishlist (public shared lists) — u/[slug]
- modules/catalog/{collection,brand,category} — boutique, marques, collections, collection/[slug]
- modules/search (keyword + semantic) — recherche
- modules/cms/setting (settings key-value) — *-landing-config landing-page content, chrome identity/contact, tracking/consent/theme

**Sources of truth**

- Route existence = presence of page.tsx under src/app/(shop)/(shell)/** (no page.tsx = retired, e.g. panier/checkout/favoris/account-base)
- Which chrome renders = which layout owns the route: (shell)/layout.tsx imports @/components/site-header|site-footer (legacy); (tokyo)/layout.tsx imports @/storefront/components/storefront/* (new)
- boutique/marques/collections/fidelite page CONTENT = admin CMS settings via get*LandingConfig in src/lib/pages/*-landing-config.ts, edited from src/components/admin/*-landing-settings.tsx (boutique-, marques-, collections-, fidelite-landing-settings)
- Legacy→flat/Tokyo redirects: next.config.ts:59-83 (/category,/product,/niveaux-avantages→/fidelite) + per-page permanentRedirect shims (about, brand/[slug], mes-credits, blog/category)
- B2B visibility = isBusinessEnabled() feature flag (src/lib/business/config); public favorites = favoritesPublicEnabled() (off by default); loyalty = resolveLoyaltyConfig().enabled
- Checkout→confirmation contract = src/lib/actions/order.ts:1019 returns redirectUrl /order/${id}?fresh=1 (points at shell order/[id])
- Account order-history link contract = src/storefront/components/storefront/account-view.tsx:233 → /account/orders/${id}
- Feature data modules read by shell: modules/order, modules/blog, modules/business, modules/loyalty + associations/loyalty-referral.service, modules/wishlist, modules/catalog/{collection,brand,category}, modules/search, modules/cms/setting

**Editable / removable**

- SAFE TO DELETE NOW (dead, zero runtime importers): src/app/(shop)/(shell)/panier/cart-panel.tsx, panier/coupon-form.tsx, checkout/checkout-form.tsx, and the empty favoris/ directory — Tokyo owns these routes
- account/account-client.tsx + its sibling *-card.tsx/*-panel.tsx are dead UI, but deleting account-client.tsx first breaks src/lib/db/tests/identity-low.test.ts:238 (reads it as source) — remove that sourceInvariants block in the same change. KEEP account/orders/[id]/ (live)
- SHIM routes (about, brand/[slug], mes-credits, blog/category/[slug]) are safe to drop if losing old-link/SEO 301s is acceptable — they implement no feature, only redirects into Tokyo / flat namespace
- DO NOT remove order/[id] without first repointing src/lib/actions/order.ts:1019 — it is the checkout success page for BOTH storefronts; removing breaks every completed order
- DO NOT remove account/orders/[id] without first repointing src/storefront/components/storefront/account-view.tsx:233 — it is the only order-detail view, linked from the Tokyo account
- Content routes (boutique, marques, collections, collection/[slug], fidelite, blog*, auteur, pro*, recherche, parrainage, u) are each the ONLY implementation — removing one deletes that feature, not a duplicate. They look unused because Tokyo chrome does not link them, but they are live via direct URL / sitemap / admin legacy nav
- Legacy chrome src/components/site-header.tsx + site-footer.tsx (and mega-menu/mobile-bottom-bar) is LIVE on all ~16 shell routes and imported only by (shell)/layout.tsx — removable only after every live shell route is migrated to Tokyo or deleted
- _components/category-client.tsx is shared by collection/[slug] + recherche and by catalog/listing libs — treat as load-bearing, not a per-route component
- Editing landing-page content (boutique/marques/collections/fidelite) means editing admin settings, not the page.tsx — the pages are block renderers driven by src/lib/pages/*-landing-config.ts

**Gaps / risks**

- /recherche is orphaned: the Tokyo header search runs on the local static catalog and on Enter goes to the best-match product — src/storefront/components/storefront/header.tsx:838 literally comments 'the full results page doesn't exist yet'. So full server-side search results are unreachable from the Tokyo UI even though the page is live.
- All shell CONTENT routes (blog, fidelite, collections, boutique, marques, pro, parrainage, u) are orphaned from the Tokyo chrome — the Tokyo footer/header link only to Tokyo routes + category slugs (footer.tsx links: /help,/garantie-retours,/suivi-de-commande,/service-client,/notre-histoire,/nos-boutiques,/carrieres,/mentions-legales,/cgv,/cgu,/privacy,/cookies). They can look dead but are live via direct URL, sitemap, legacy chrome, and admin-configured nav — do not delete them as 'unused'.
- Dual-chrome UX hazard: crossing from a Tokyo page into a shell route swaps the whole header/footer/design system (.tokyo crimson ↔ .storefront legacy). This is the main reason to migrate, not delete, the live shell routes.
- account/account-client.tsx is 74 KB of dead code kept alive ONLY by a source-invariant test (identity-low.test.ts:238); easy to mistake for live account UI (the live account is (tokyo)/account).
- Feature-flag masking: pro/* (isBusinessEnabled), u/[slug] (favoritesPublicEnabled, off by default), parrainage/[token] + fidelite (loyalty enabled) return 404/thin when their flag is off — they may appear dead in a default/dev config while being real features.
- Hard couplings to shell from Toksyo that are easy to miss when 'removing sections': checkout success (actions/order.ts:1019 → /order/[id]) and account order detail (account-view.tsx:233 → /account/orders/[id]). Grep both before touching those routes.
- Retired routes left orphan files (panier/checkout/favoris/account) — editors may edit these stale copies thinking they are live; the live versions are under (tokyo).
- Several shell pages are SEO/sitemap-registered; dropping them without 301s (they have resolveRedirect hooks) will create dead indexed URLs.

</details>


---

## 4. Server Actions Layer (`src/lib/actions/**`) — the real storefront & admin mutation API

The `'use server'` files in `src/lib/actions/` are the **primary, Next-bound mutation API** for this app — the path every form, button and client store in the UI takes to change state. There are **83 action modules** (85 files minus two non-action helpers, `types.ts` and `coerce.ts`), totalling ~20.4k lines. **There is no barrel** (`src/lib/actions/index.ts` does not exist) — every consumer imports the concrete file, e.g. `import { placeOrderFromCartAction } from "@/lib/actions/order"`. This matters for the owner's edit/remove work: an action's blast radius is exactly its direct importers, found with `grep -rln 'actions/<file>"'`.

This layer is one of the **three transports** that reach the backend (the other two are RSC direct imports via `src/lib/api/*` for reads, and the framework-agnostic REST surface under `src/app/api/**`). Actions are **Next-only**: they rely on `cookies()`/`headers()` and `revalidatePath`/`refresh`/`redirect` from `next/*`, so they cannot be reused by the REST/ERP surface. The mutation *logic* they share with REST lives one level down in `src/workflows/*` — actions are a thin, Next-aware adapter, not the business logic.

### The canonical action contract

Every action returns the shared discriminated union `ActionState` (`src/lib/actions/types.ts:17`):
```
{ ok: true;  message?; id? }
| { ok: false; error: string; message: string; fieldErrors?: Record<string,string> }
```
`message` is always **French, render-ready**; `error` is a machine code (`validation`, `not_found`, `rate_limited`, `forbidden`, …). Actions that return extra payload **extend by intersection** rather than redefining — e.g. `PlaceOrderActionState = ActionState & { orderId?; orderNumber?; redirectUrl? }` (`order.ts:39`) and `trackOrderAction`'s `ActionState & { order?: TrackedOrder }` (`order.ts:1091`). Two `(prev, formData)` shapes exist for `useActionState` form actions (auth/customer/order-tracking); most others take plain typed args.

The standard body is **four steps, in order**:
1. **Authorize** (see taxonomy below) — the *first* call, before any work.
2. **Validate / coerce** the client input defensively (a server action is a public endpoint; never trust arg types — see `auth.ts:31` rejecting a non-boolean).
3. **Delegate** to a workflow (`workflows.<domain>.<op>(input, { actorUserId })`) — **65 of 83 files import `@/workflows`**. The workflow is the true mutation API (transaction, event emission, audit).
4. **Revalidate** the affected paths and return `ActionState`. On business failure the action maps the workflow's `{ok:false,error,message,fieldErrors}` straight through; it **throws only for genuine server errors** (that trips Next's error boundary — see the pattern note at `auth.ts:47`).

**Validation is deliberately light at this layer.** Only **3 files import `zod`** (`order.ts`, `business.ts`, `manual-order.ts`); the authoritative schema validation lives in the workflows. Actions do shape/guard checks (required-field, enum, clamp) via inline checks plus two shared helpers: `coerce.ts` (`toIntOrNull`/`toIntOr`/`toNonNegInt` — the single audited numeric-coercion path) and per-domain helpers like `optionalString`/`nullableField` in `customer.ts:248`. **Money fields keep legacy `*_cents` names but hold integer millimes** — settings actions convert dinars→millimes explicitly (`checkout-settings.ts:15` `DINAR_INPUT_KEYS`, `order.ts:31` `dinarsToMinor`); never divide by 100 here.

### Authorization taxonomy (all from `src/lib/auth/session.ts`)

The gate chosen tells you instantly whether an action is customer-facing or admin:
- **`getSession()`** — optional auth; returns null for guests. Used by the public/customer flows that must work for anonymous shoppers: `cart.ts`, `order.ts` (place/quick/resume/cancel/track), `wishlist.ts`, `newsletter.ts`, `promotion.ts`, loyalty family (`cercle.ts`, `loyalty.ts`, `life-stage.ts`, `gift-card.ts`).
- **`requireSession()`** — must be signed in (redirects to `/login?from=`), with a live DB re-check that denies soft-disabled accounts (`session.ts:87`). Used by self-serve account actions: `customer.ts` (profile/address/password/email), `auth.ts` (signout, oauth-autolink), `two-factor.ts`, `appointment.ts`, `wishlist.ts` (public-favorites prefs).
- **`requirePermission(module, action)`** — fine-grained RBAC gate, **`notFound()` on deny** (admin routes never leak), records a security-trail event. This is the dominant admin gate — **73 of 83 files use it**. Resolved **live per request** against the RBAC engine (revoking a role takes effect next request, no token regen).
- **`requirePermissionAny([...])`** — OR of grants, for surfaces reachable by more than one role (`order.ts`, `manual-order.ts`, `returns.ts`, `related-products.ts`, `content-generation.ts`).
- **`requireSuperAdmin`/`checkSuperAdmin`** (`src/lib/auth/super-admin.ts`) — `*` step-up for store-wide destructive ops: `demo-purge.ts`, `data-jobs.ts`, `payment-settings.ts`.
- **Token/rate-limit-only (no session gate)** — `newsletter-unsubscribe.ts` (HMAC token), `loyalty-qr.ts` (signed QR token), `blog-comment.ts` (`getCurrentUser` + per-IP/per-user `checkRateLimit`), and `cart.ts` (intentionally public; `resolveCart` handles guest-vs-user).

Rate limiting is a first-class concern here because **in-process `auth.api.*` calls bypass Better Auth's HTTP limiter** — auth/order/account actions add Postgres-backed `checkRateLimit` buckets (`auth.ts:75,135,217,297,337,453`, `order.ts` order-placement guards, `customer.ts:46,89`). RBAC elevation beyond the module grant is enforced inside workflows via `assertActorOutranksTarget` (`auth.ts:11,446`).

### Three concrete traces

**1. Add to cart — `cart.ts:71` `addToCartAction` / `cart.ts:106` `addToCartBySlugAction`.** No auth gate: `resolveCart()` (`src/lib/cart/session.ts`) returns the guest-cookie or signed-in cart (get-or-create). The by-slug variant does **server-side enforcement** of the card's UI guards first — refuses unpublished rows, `variable` products (need PDP options), and out-of-stock (`cart.ts:108-120`) — then delegates the mutation to `workflows.cart.add({cartId, productId, variantId, quantity})`. Analytics is best-effort via `cartEventService.record(...).catch(()=>{})` and never blocks. Cache: `refreshCartViews()` → `refresh()` (see below), **not** `revalidatePath`. Note cart.ts mixes transports — mutations go through `workflows.cart.*` but reads (`cartService.listItems`, `productService.*`) call module services directly (`cart.ts:60,63,153`).

**2. Place order — `order.ts:606` `placeOrderFromCartAction`.** `getSession()` (works for guests). Read-only `readCart()` refuses a cartless guest without INSERTing a row (`order.ts:614`). Then a wall of **authoritative server-side re-validation** that the client form only enforces in UI: email/phone required per `getQuickBuyConfig()`, city+governorate required for home delivery, pickup-point required for pickup, and `resolvePaymentMethod` re-checks the submitted gateway against the admin enable toggles (`order.ts:624-684`). Abuse throttle (`checkOrderPlacementRateLimit`, per IP/phone/email) runs **before** the cart resolve (`order.ts:691`). Promotions are re-priced live (`priceCartLinesLive` + `resolveAppliedCartPromotion`) so a stale cookie can't forward a different discount. The actual placement is `workflows.order.place({...}, {actorUserId})` (`order.ts:716`); on success it clears `gz.cart_token`/`gz.coupon` cookies, `revalidatePath("/panier")`, and for online methods calls `startOnlinePayment` → `workflows.order.initiatePayment` to get a gateway `redirectUrl` (zero-total orders are settled in place). `placeQuickOrderAction` (`order.ts:804`) is the twin for the PDP "Acheter maintenant" express path with an `idempotencyKey` to dedupe double-submits.

**3. Sign in / sign up — `auth.ts:121`/`auth.ts:58`.** Both are `(prev, formData)` form actions. Per-IP + per-account/email `checkRateLimit` first (defence against enumeration/credential-stuffing, with a neutral identical message so it's no oracle), emitting `auth.rate_limited` on trip. Delegate to `workflows.auth.signin`/`signup` with `{ ip }`. On signin success: compute a **safe same-origin redirect** (`safeRedirectPath`, `auth.ts:263`, blocks `//evil.com`, backslashes, control chars, `javascript:`), and if `twoFactorRequired` go to `/login/2fa` else `redirect(dest)`. `redirect()` is used in only two files (`auth.ts`, and transitively `requireSession`).

### Domain grouping of the 83 files

**Customer / storefront-facing (the owner's frontend seam):**
- `cart.ts` — add/remove/setQty/merge/read (hydrates the Tokyo store).
- `wishlist.ts` — toggle/read favourites (+ admin moderation + public-favorites board).
- `order.ts` — checkout (`placeOrderFromCartAction`, `placeQuickOrderAction`), customer order mgmt (`resumeOrderPaymentAction`, `cancelMyPendingOrderAction`), public tracking (`trackOrderAction`), **plus** the bulk of admin order ops (status transitions, refunds, shipments, spam, invoice tax).
- `auth.ts` + `customer.ts` + `two-factor.ts` — login/signup/reset/2fa + self-serve profile/address/password/email.
- `appointment.ts` — booking (used by Tokyo `/rendez-vous`).
- `newsletter.ts` / `newsletter-unsubscribe.ts`, `blog-comment.ts`, `reviews.ts` (`submitReviewAction`), `life-stage.ts`, `cercle.ts` (referral circle), `loyalty.ts`/`loyalty-qr.ts`/`gift-card.ts` (customer redeem paths).

**Admin — orders/ops:** `manual-order.ts` (counter sales/POS), `returns.ts`, `delivery.ts`, `stock-locations.ts`/`stock-transfers.ts`/`stock-settings.ts`, `appointments-admin.ts`, `documents.ts`, `demo-purge.ts`, `data-jobs.ts`, `jobs.ts`, `import.ts`, `analytics.ts`, `audit-log.ts`.

**Admin — catalog/content/CMS:** `catalog.ts` (2068 lines, 31 permission gates — the biggest), `attribute.ts`, `collection.ts`, `related-products.ts`, `cms.ts`, `blog.ts`/`blog-comments-admin.ts`/`authors.ts`, `home.ts`/`footer.ts`/`nav-builder.ts`/`theme.ts`/`showcase-settings.ts`/`site.ts`/`seo.ts`/`redirects.ts`/`search-aliases.ts`.

**Admin — commerce config/pricing:** `promotion.ts`, `currency.ts`, `tax.ts`/`tax-settings.ts`, `loyalty-program.ts`/`fidelite.ts`/`credit.ts`, `segments.ts`, `mailing.ts` (campaigns), `business.ts` (1714 lines, B2B/pro partner portal — auto-creates employee accounts with generated passwords).

**Admin — identity/platform/settings:** `admin.ts`, `rbac.ts`, `customers.ts`/`guests.ts`, `session-policy.ts`, `auth-settings.ts`, `api-settings.ts`/`webhooks.ts`, and the large family of `*-settings.ts` (`checkout-settings`, `payment-settings`, `express-settings`, `search-settings`, `catalog-settings`, `audit-settings`, `perf-settings`, `site-mode`). These nearly all follow one shape: `requirePermission` → iterate a declared field list → `workflows.cms.upsertSetting(...)` (writes `site_settings`) → `revalidatePath` (see `checkout-settings.ts:49`).

**Admin — AI:** `ai-assign.ts`, `ai-generate.ts`, `ai-settings.ts`, `ai-job-logs.ts`, `content-generation.ts`, `product-generation.ts`, `review-generation.ts`, `embeddings.ts`, `search-maintenance.ts`.

### Exactly which actions the Tokyo storefront depends on (critical seam)

The new `(tokyo)` design was swapped in-repo and wired to the real backend through a **thin bridge** in `src/storefront/lib/` that keeps the UI's hook API unchanged:
- **Cart** — `src/storefront/lib/cart.ts` (a `useSyncExternalStore` optimistic store) calls `addToCartBySlugAction`, `getStorefrontCartAction`, `removeCartItemBySlugAction`, `setCartItemQuantityAction` (all in `cart.ts`). The store is **slug-keyed** (simple products); the "Tokyo Care" protection plan is a client-only localStorage overlay the backend order never charges (see `cart.ts:237` in the storefront bridge).
- **Favourites** — `src/storefront/lib/favorites.ts` calls `getWishlistSlugsAction` + `toggleWishlistAction` (`wishlist.ts`); guest→user merge happens inside `getWishlistSlugsAction`.
- **Checkout** — `src/storefront/components/storefront/checkout-view.tsx:295` calls `placeOrderFromCartAction` only; it maps the two-choice UI to `paymentMethod: card→"flouci" | cod`, `deliveryMethod: pickup→"in_store" | home_delivery` (`checkout-view.tsx:306`).
- **Auth** — the `(tokyo)` login/register/forgot/reset/2fa forms call `signinAction`/`signupAction`/`requestPasswordResetAction`/`resetPasswordAction`/`verifyTwoFactorAction`; `account-view.tsx` calls `signoutAction`.
- **Appointments** — `(tokyo)/rendez-vous` calls `getBookingDataAction`/`getAvailabilityAction`/`bookAppointmentAction`.
- **Order tracking** — `(tokyo)/suivi-de-commande` calls `trackOrderAction`.

Everything else in `src/lib/actions/**` is admin-only (reached from `src/app/admin/**`) or still wired to the **legacy `(shell)` storefront** — notably `customer.ts` profile/address actions are imported only by `src/app/(shop)/(shell)/account/account-client.tsx`, and the variant-aware `addToCartAction`/`removeCartItemAction` only by `(shell)/panier/cart-panel.tsx`.

### Revalidation / cache behaviour

- **`revalidatePath`** is the workhorse — **465 call sites** across the admin actions (e.g. `revalidatePath("/admin/orders")` + the specific detail path). `revalidateTag` is **not used anywhere** in this layer.
- **`refresh()`** is used in exactly **one file, `cart.ts`** (via `refreshCartViews`, `cart.ts:24`). This is deliberate and documented: `refresh()` re-renders only dynamic data in the action response and leaves `'use cache'` readers (PDP, category tree, feeds) intact, whereas `revalidatePath("/","layout")` would expire every cached reader on every anonymous cart click. **Do not "normalize" cart.ts to `revalidatePath`** — the comment at `cart.ts:14-23` is a load-bearing warning.
- Customer account/order actions use targeted `revalidatePath("/account")`, `revalidatePath("/order/<id>")`, `revalidatePath("/favoris")`.


<details>
<summary><strong>4. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- src/lib/actions/types.ts — shared ActionState union (contract)
- src/lib/actions/cart.ts — Tokyo cart seam; refresh() cache note
- src/lib/actions/order.ts (1131 lines) — checkout + all order ops
- src/lib/actions/auth.ts — signin/signup/reset/2fa, rate limits, safe redirect
- src/lib/actions/customer.ts — self-serve profile/address/password/email
- src/lib/actions/wishlist.ts — favourites toggle + moderation
- src/lib/actions/coerce.ts — single numeric-coercion helper path
- src/lib/auth/session.ts — getSession/requireSession/requirePermission gates
- src/workflows/index.ts — the `workflows` registry actions delegate to
- src/storefront/lib/cart.ts & favorites.ts — Tokyo bridges to the actions
- src/storefront/components/storefront/checkout-view.tsx:295 — placeOrderFromCartAction call
- src/lib/actions/catalog.ts (2068) & business.ts (1714) — largest admin modules

**Models / tables**

- carts / cart_items (cart.ts via workflows.cart.* + cartService) — simple-product lines store variant_id='' not null (cart.ts:154)
- orders / order_items / order status history (order.ts via workflows.order.*) — total_cents etc. are millimes
- wishlists / wishlist items + public-favorites profile & moderation lock (wishlist.ts via wishlistService)
- user / account / session (Better Auth) — mutated via workflows.auth.* and auth.api.* (customer.ts, auth.ts)
- customer addresses + loyalty profile (customer.ts via workflows.customer.*)
- site_settings — the single key/value store behind every *-settings.ts action (workflows.cms.upsertSetting)
- appointments (appointment.ts via workflows.appointments.*)
- cart_event analytics (cartService/cartEventService, best-effort)

**Sources of truth**

- ActionState shape: src/lib/actions/types.ts:17 (every action returns this)
- True mutation logic + zod validation: src/workflows/* (actions are thin adapters; 65/83 files delegate here)
- Authorization: resolved live per request by src/lib/rbac/authorize.ts via the gates in src/lib/auth/session.ts (no barrel, no token-baked perms)
- Admin settings values: site_settings table, written only through workflows.cms.upsertSetting (the *-settings.ts actions)
- Rate-limit buckets: Postgres-backed via src/lib/rate-limit checkRateLimit (auth/order/account actions)
- Money: integer millimes; dinar→millime conversion at the action edge (checkout-settings.ts:15, order.ts:31)
- No OpenAPI/contract file for actions; behavioural contract is the workflow test suite under src/lib/db/tests/*

**Editable / removable**

- SAFE TO EDIT: validation/guard logic and French `message` strings inside an action — they are client-facing copy, not business logic. Keep the returned `error` codes stable (clients branch on them).
- SAFE TO EDIT independently: each *-settings.ts field list — adding/removing a key only changes which site_settings keys that admin page writes.
- LOAD-BEARING — do NOT change: cart.ts uses refresh() not revalidatePath on purpose (cart.ts:14-23); swapping it re-introduces site-wide cache expiry on every cart click.
- LOAD-BEARING: the authoritative re-validation in placeOrderFromCartAction (order.ts:624-684) and the rate-limit buckets in auth.ts — they are the server-side enforcement behind UI-only guards; removing them opens enumeration/abuse holes.
- LOAD-BEARING: safeRedirectPath (auth.ts:263) is an open-redirect guard; do not loosen the regex.
- REMOVABLE with care: an action is removable once `grep -rln 'actions/<file>"'` shows no importers. Several admin actions are only reachable from src/app/admin/** — removing the admin page and the action together is clean.
- When removing a Tokyo section, the seam is one bridge file: drop the import in src/storefront/lib/{cart,favorites}.ts or the relevant (tokyo) form; the underlying action can stay (the legacy (shell) UI and/or workflow tests may still use it).
- No barrel to update — deleting a file only breaks its direct importers, which the grep above enumerates exactly.

**Gaps / risks**

- Delegation is inconsistent: most mutations go through workflows, but toggleWishlistAction (wishlist.ts:42-49) writes via wishlistService directly (no workflow → no audit/event path), and cart.ts reads via cartService/productService directly. If the owner adds audit/event hooks at the workflow layer, these direct-service paths bypass them.
- Tokyo account is incomplete: account-view.tsx uses only signoutAction. The production-ready customer.ts profile/address/password/email actions are still wired ONLY to the legacy (shell) account-client — the Tokyo account page cannot yet edit profile/addresses. Wiring them is a frontend task; the backend actions already exist.
- Tokyo Care protection plan shown at checkout is a client-only overlay NOT sent to or charged by placeOrderFromCartAction (storefront cart.ts:237-251) — display==charge by design today, but a real protection feature means threading new fields through order.ts + workflows.order.place.
- Tokyo checkout hardcodes region = city (checkout-view.tsx:303) to satisfy the backend's governorate requirement; this feeds bogus zone data into delivery pricing/routing. Real governorate selection is needed before relying on zone-based delivery.
- Validation lives mostly in workflows (only 3 action files use zod). Editing an action's input shape without updating the workflow schema will fail at the workflow, not the action — trace both layers when changing a payload.
- order.ts is doing double duty (customer checkout + ~15 admin order ops, 1131 lines); splitting customer vs admin would reduce the chance an admin-gate change touches the public checkout path.
- cancelMyPendingOrderAction is restricted to online payment methods (order.ts:1041); a guest COD order remains cancellable by any UUID-holder via other paths — noted in the action's own comment as a known rough edge.
- business.ts auto-generates employee-account passwords (business.ts generateEmployeePassword) — any change to AUTH_POLICY min length must stay compatible with that generator.

</details>


---

## 5. RSC Read Layer (src/lib/api/** + module queries.ts)

### What this layer IS (and how it differs from Server Actions and REST)

`src/lib/api/**` is the **server-side READ façade**. Every file begins with `import "server-only"` (e.g. `src/lib/api/products.ts:1`, `categories.ts:1`, `cms.ts:1`) so it can never be bundled into a client component. It has three jobs:

1. **Curate** raw Drizzle rows from the module `queries.ts`/`service.ts` layer into stable DTOs (the storefront `Product`/`Category` shapes, or the ERP `ApiProduct`/`ApiCategory`/… shapes).
2. **Batch + enrich** reads so an RSC page issues ~6-8 DB round-trips instead of N+1 (the whole point of `mapProductRows`).
3. **Cross module boundaries** on the read side only — e.g. joining a product to its media URL, brand, category chain, promotions and loyalty gate — work that must NOT live inside a single module (no cross-module FKs; `src/associations/*` holds the join tables).

The three-transport rule the architecture doc states holds exactly here:

| Transport | Location | Direction | Reaches |
| --- | --- | --- | --- |
| **RSC direct import (this layer)** | `src/lib/api/**` + module `queries.ts` | **READ only** | RSC pages, SEO feeds, home-block composer, the Tokyo export script |
| Server Actions | `src/lib/actions/*` | mutations (call into `src/workflows/*`) | `"use client"` forms |
| REST | `src/app/api/**` | read+write for ERP/headless | external callers; wraps these same read fns |

This layer **never mutates**. Writes go through `src/workflows/*`. The REST routes (`src/app/api/products/route.ts:4-7`, `/api/content`, `/api/customers`, `/api/orders`, …) are thin HTTP wrappers that call the *same* functions here (e.g. `src/app/api/products/route.ts:65,86-87` calls `getApiProductByRef`/`listApiProductsPage`). So editing a function here changes the RSC page, the SEO feed, AND the REST contract simultaneously — a key blast-radius fact for the owner.

**One file in this folder is NOT a read:** `src/lib/api/attribute-validation.ts` (`validateAttributeRefs`, line 18) is a **write-path** validation helper shared by the `/api/products/[slug]/attributes` PUT and the product create/update workflows. It is filed here by convenience, not because it is part of the read layer.

### File-by-file inventory

**`products.ts`** (1673 lines — the heart of the layer). Two DTO families:
- *Storefront* `Product` (from `@/types/catalog`) — what pages/cards render.
- *ERP* `ApiProduct = Product & { id, externalRef, stockQty, minPurchaseQty, maxPurchaseQty, basePriceCents, baseOldPriceCents }` (`products.ts:163-171`). **Price contract** (`products.ts:156-162`): `priceCents`/`oldPriceCents` are the **effective** price (live auto-promos folded in — the price a shopper pays now); `basePriceCents`/`baseOldPriceCents` are the **stored** row values an ERP round-trips.

Key exported reads and their callers:
- `getProductWithRowBySlug` (`products.ts:90`) — the **PDP base DTO**, `'use cache'` + `cacheLife("hours")`, tagged `productsList/products/brands/categories/product:slug:<slug>/product:<id>` (`products.ts:106-115`). Deliberately `withTags:false` (no exclusivity/drip/collection tags) because those are time/tier-dependent and would freeze in cache. Called by the `/[slug]` resolver (both `generateMetadata` and the body).
- `getProductBySlug` (`127`) — public wrapper, drafts excluded, no promo/embargo (caller must gate).
- `getApiProductByRef` (`225`) — single ERP read by any `ProductRef`; `includeUnpublished` for keyed callers, `public` applies the early-access embargo + strips `externalRef`.
- `listApiProductsPage`/`listApiProducts` (`273`/`292`), `listPublicFeedProductsPage` (`307`), `listApiProductsByCategory[Page]` (`319`/`343`), `listApiProductsByBrand` (`402`) — paginated ERP/feed lists returning `rawCount` (the DB page size **before** the public embargo filter, so clients paginate on `offset += rawCount`, never `products.length` — `products.252-251`).
- Storefront listing reads: `listProductsByCategory` (`133`, full tree roll-up for faceting), `listProductsBySubcategory` (`350`), `listProductsByBrand` (`361`, fails closed on inactive brand), `listProductsByCollection` (`379`, curated order), `listProductsByIds` (`1075`, order-preserving), `listRelatedProducts` (`434`) / `listComplementaryProducts` (`461`) (PDP rails), `listNewArrivals` (`599`) / `listPromotions` (`610`) (home rails), `listShowcaseProducts` (`915`, /promotions etc.), `listProductsForSource` (`1003`, the **home block composer** entry for rail/grid blocks), `listCollectionPreviews` (`1101`, /collections magazine).
- `publicProductReadHeaders` (`266`) — Cache-Control for keyless reads; detects the Better-Auth session cookie via `SESSION_COOKIE_RE` (`products.ts:256`) and returns `private, no-store` for signed-in viewers (per-viewer embargo) vs shared-cacheable for anonymous, both `Vary: Cookie`.

**The enrichment pipeline** (the most load-bearing internal machinery):
- `mapProductRows` (`products.ts:1259`) — the **batched row→Product mapper**. For any batch it runs a fixed ~6-8 queries regardless of row count: media links, brand ids, primary categories, variants (+variant-value links +attribute meta, only when `variable` present), one media batch, category parents, brands, global warranty, shared-stock default. Resolves gallery/OG images, brand (active-only), primary category + subcategory, warranty cascade (product→category chain→global), variant DTOs + picker axes, display price (cheapest variant for variable), and in-stock. Returns in input order.
- `computeProductTags` (`1145`) — card tags (exclusivity/drip from the loyalty schedule + collection membership), fully batched; skipped with `withTags:false`.
- `buildLivePromotionDiscountMap` (`651`) / `livePromoMap` (`731`, React `cache()`) / `enrichWithLivePromos` (`743`) / `mapAndEnrichRows` (`817`) — fold live auto-promotions into card/variant prices via the SAME `resolveProductDiscount` the cart/PDP/checkout use, so a card never disagrees with the landing price (Merchant-feed correctness). `enrichProductSearchHits` (`791`) applies the same map to search hits (consumed by `src/modules/search/service.ts:263`). **Critical rule** (`products.ts:809-816`): the PDP uses bare `mapProductRows` + its own richer enrichment, so it must NOT go through `mapAndEnrichRows` (double-discount).
- `productsForIds` (`1047`) — the private helper behind most storefront list reads: raw id set → `listPublishedIdsNewestFirst` (SQL order) → grid cap → per-row read → early-access filter → `mapAndEnrichRows`.

**`categories.ts`**: `listCategories` (`288`, `'use cache'`, nested **active-only** storefront tree, build-phase-guarded, called by the mega-menu on *every* page), `getCategoryBySlug` (`354`, `'use cache'`, /[slug] resolver), `getCategoryAncestors` (`393`, breadcrumb), `mapActiveSubcategoryTree` (`335`). ERP: `ApiCategory` (flat, with `parentId`), `resolveCategoryRow`/`getApiCategoryByRef`/`listApiCategories` (`494`/`508`/`524`). Plus the **faceted-filter resolvers** `getCategoryAttributeFilters` (`57`) and `getProductsAttributeFilters` (`158`, search variant) that feed `CategoryPageClient`, and `getSubcategoryCounts` (`532`).

**`cms.ts`**: banner readers (`listHomeHeroSlides` `112`, `listHeaderStripBanners` `183`, `listCategoryGridBanners` `194`, `listFooterBanners` `200`), nav readers (`loadLiveNavTargets` `317`, `listFooterColumns` `410`, `getMaisonExploreNav` `484`, `listMainMenu` `517`), trust badges (`listActiveTrustBadges` `536`), logo (`getSiteLogoUrl` `223`, `getSiteLogoDataUrl` `248` print-safe base64), and `getAllSettingsServerOnly` (`212`) — **returns the FULL raw settings map including `mail.*_enc` / `payment.*` secrets**; server-only, must never be serialized to a client or JSON route. All CMS readers degrade to `[]`/`{}` on DB error.

**`nav-composer.ts`**: `getComposedNavRoots` (`78`) builds the mega-menu roots from the materialized `main` menu (or `defaultNavRoots`), resolving media in one batch, product rails via `listProductsForSource`, and **dead-link pruning + active-redirect re-admission** for every internal ref.

**`main-nav-items.ts`**: `getMainNavRoots` (`21`, React `cache()` — composed ONCE per request, shared by the shell layout header and the home JSON-LD) and `getMainNavItems` (`57`, `{name,url}` for `SiteNavigationElement` JSON-LD).

**`content.ts`**: `getContentBundle` (`89`) — the one-shot headless chrome bundle for REST `/api/content`. Its security core is `publicSettings` (`58`): an **allow-list** of public prefixes (`PUBLIC_SETTING_PREFIXES` `33`), a secret-token **deny** filter (`SECRET_TOKENS` `47`), and an explicit `DENY_KEYS` (`55`) — `payment.`/`mail.` are not allow-listed so gateway/mail secrets can never reach the public surface.

**`link-targets.ts`**: `listLinkTargets` (`27`) — option lists for the admin LinkTargetPicker (system pages, categories, brands, collections, pages), each filtered to what actually renders at a storefront URL (active chain, published).

**`brands.ts`** / **`collections.ts`**: `ApiBrand`/`ApiCollection` + `resolve*Row`/`getApi*ByRef`/`listApi*` (mirror the product/category reference pattern); `brands.ts` also has `listNavBrands` (`124`) for the category-page "Marques" strip.

**`blog.ts`**: `listApiBlogPosts`/`getApiBlogPost`/`listApiBlogCategories` — curates `PublicBlogPost`; bodies run through `sanitizeRichHtml`, memoized per content-hash in a bounded LRU (`SAFE_BODY_MEMO` `48`) because sanitizing is ~5-12 ms of jsdom work per body.

**ERP serializer files** (keyed external API, PII-aware): `orders.ts` (`serializeOrder`/`serializeOrderItem`/`resolveApiOrder` — money in millimes, every term of the total exposed so an ERP can verify the identity), `order-substreams.ts` (shipments/refunds/returns/status-history), `customers.ts` (key-only PII, `admin_notes` never serialized, joins the Better-Auth email via `customer_user_links`), `warranty-claims.ts`, `movements.ts` (stock + credit ledger serializers), `reviews.ts` (`getApiProductReviews` — applies the draft + early-access + `reviews.enabled` gates on the public path).

**Pagination helpers** `cursor.ts` + `keyset.ts`: the shared ASC `(timestamp, id)` keyset for the four incremental-sync REST feeds (orders, customers, stock movements, loyalty movements). `parseIncrementalCursor` (`cursor.ts:35`) does three-gate ISO validation; `keysetAfter`/`keysetCursor`/`settledBefore` (`keyset.ts:45/58/66`) bind the cursor as a raw `::timestamptz` cast (µs-faithful), and the **settle window** (`KEYSET_SETTLE_SECONDS=5`, `keyset.ts:36`) holds back rows younger than 5s so a long commit can't be paged past. Consumers: `order/service.ts`, `customer/service.ts`, `stock-movement/service.ts`, `credit/service.ts` and their REST routes.

### Relationship to module `queries.ts`

The `src/lib/api/**` layer sits **above** the module query layer and composes it across modules. A module `queries.ts` (e.g. `src/modules/catalog/product/queries.ts`) is **single-module, raw Drizzle, returns `*Row` types**, and is the only thing pages are supposed to import from a module (mutations go through workflows — stated at `product/queries.ts:14-17`). Representative examples this layer leans on: `listPublishedProducts` (`product/queries.ts:19`, index-tuned `published_at DESC NULLS LAST, id DESC`), `listPublishedIdsNewestFirst` (`98`, binds ids as one `uuid[]` param to dodge the bind-parameter limit), `listPublishedCompareAtProducts` (`130`, the SQL compare-at pool for promotions), `listVariantsForProducts` (`253`, batch), `listProductsByIds` (`82`). Rule of thumb: **a `queries.ts` function returns rows; a `lib/api` function returns a render-ready DTO** and may touch several modules + `src/associations/*` + media + promotions + loyalty.

### The listing engine (`src/lib/listing`) and search read path

`src/lib/listing/*` is **pure** (no React, no `server-only`) so the SAME predicates run on the server (promotion pools in `products.ts`) and the client (`CategoryPageClient`):
- `display-pricing.ts` — `listingDisplayPricing` (`71`, cheapest-variant price + normalized compare-at), `hasVisibleCompareAt`/`normalizeCompareAt`/`cheapestVariant`/`toDisplayMinor`, `cardDealFraction` (`93`). This is the ONE definition of "card price / is on promotion", imported by the mapper and the promotion pools so a product can't qualify on one surface and show no discount on another.
- `facet-availability.ts` — `deriveFacetAvailability` (`125`) + the filter predicates (`isPromoProduct`, `exceedsMaxPrice`, `pruneSubcategoryTree`, `filterAttributeValues`) that the category/search client filters with.
- `banner-rotation.ts` — `gridBannerSchedule` (`61`), the in-grid banner cadence/fair-rotation rule.

**Search read path**: `src/modules/search/service.ts` runs the FTS/vector query, then calls `enrichProductSearchHits` (`products.ts:791`) to fold live promos into the hits; facets for a search result come from `getProductsAttributeFilters` (`categories.ts:158`). The legacy `recherche/page.tsx` is the consumer.

### How this layer feeds the Tokyo storefront (the important clarification)

At **request time** the new `(tokyo)` route group does **NOT** read this layer for catalog data. Tokyo server components import `@/storefront/lib/api/*` (`src/storefront/lib/api/products.ts`, `categories.ts`), which delegate to `catalogSource` (`src/storefront/lib/data/index.ts`) → `staticSource` (`static-source.ts`) → the **bundled JSON** `src/storefront/data/{products,categories,taxonomy}.json` via `src/storefront/lib/catalog.ts`. The alternate `http-source.ts` is a **stub that throws** (`http-source.ts:37-43`); the HTTP flip (`NEXT_PUBLIC_DATA_SOURCE=http`) is not implemented.

The **only** link from this RSC read layer to the Tokyo catalog is the **export script** `scripts/tokyo-export-catalog.ts`, which pages through `listApiProducts({ public:false })` (`scripts/tokyo-export-catalog.ts:82`) to regenerate `products.json`. So: **the RSC read layer is the source of truth for the Tokyo catalog snapshot, but only at regeneration time, not per request.** A `(tokyo)` page will not reflect an edit to `products.ts` until the export is re-run.

The `(tokyo)` group DOES use a tiny slice of this layer directly for chrome: `getAllSettingsServerOnly` + `getSiteLogoUrl` from `cms.ts` in `src/app/(shop)/(tokyo)/layout.tsx:5,40-41` and `getAllSettingsServerOnly` in `(tokyo)/mentions-legales/page.tsx`. Everything else in `(tokyo)` is the JSON bridge.

The legacy `(shell)` group (being retired) is the heavy consumer of this layer at request time: `boutique`, `recherche`, `collection/[slug]`, `collections`, `u/[slug]`, and `(shell)/layout.tsx` (header via `getMainNavRoots`).


<details>
<summary><strong>5. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- src/lib/api/products.ts — 1673-line catalog read+enrich engine
- src/lib/api/products.ts:1259 mapProductRows — the batched row→Product mapper
- src/lib/api/products.ts:651-820 live-promo map + mapAndEnrichRows
- src/lib/api/categories.ts — storefront tree + ERP + facet filters
- src/lib/api/cms.ts — banners/nav/settings/logo readers (getAllSettingsServerOnly leaks secrets)
- src/lib/api/nav-composer.ts:78 getComposedNavRoots — mega-menu builder
- src/lib/api/main-nav-items.ts:21 getMainNavRoots — request-cached nav
- src/lib/api/content.ts:58-119 getContentBundle + public-settings allow/deny
- src/lib/api/keyset.ts + cursor.ts — incremental-sync keyset helpers
- src/lib/api/attribute-validation.ts — WRITE-path helper (not a read)
- src/lib/listing/display-pricing.ts — pure card-price/promo definition
- src/lib/listing/facet-availability.ts + banner-rotation.ts — pure listing predicates
- src/modules/catalog/product/queries.ts — raw Drizzle row reads the layer composes
- src/storefront/lib/data/{index,static-source,http-source}.ts — Tokyo catalog source (JSON; http stubbed)
- scripts/tokyo-export-catalog.ts:82 — the only RSC-read→Tokyo-catalog link (listApiProducts)

**Models / tables**

- products / product_variants / product_variant_values (src/modules/catalog/product/schema.ts) — ProductRow/ProductVariantRow
- categories (self-FK parent_id tree) — CategoryRow; attributes/attribute_values (catalog/attribute)
- brands, collections (catalog/brand, catalog/collection) — BrandRow/CollectionRow
- src/associations/* join tables: product_categories, product_brand, product_media, product_collections, product_related, product_complementary, customer_user_links
- banners (cms/banner), nav menus + nav_items (cms/navigation), site_settings (cms/setting), trust_badge, pages (cms/page)
- orders / order_items / shipments / order_refunds / order_status_history / order_returns (modules/order)
- customer_profiles + addresses (modules/customer); credit_entries (modules/credit); stock_movements (modules/stock-movement)
- promotions + promotion_scope_targets (modules/promotion); warranty_claims (modules/warranty-claim); loyalty levels/config (modules/loyalty); blog posts/categories/tags (modules/blog); media (modules/media)

**Sources of truth**

- Storefront Product DTO shape: mapProductRows return object (src/lib/api/products.ts:1609-1671) + src/types/catalog.ts
- ERP ApiProduct/ApiCategory/ApiBrand/ApiCollection shapes: the toApi* mappers (products.ts:182, categories.ts:456, brands.ts:48, collections.ts:43)
- Effective vs stored price rule: products.ts:156-162 (priceCents=promo-folded, basePriceCents=stored) via resolveProductDiscount
- Card-price / 'is on promotion' definition: src/lib/listing/display-pricing.ts (listingDisplayPricing, hasVisibleCompareAt)
- Public-safe settings subset: content.ts PUBLIC_SETTING_PREFIXES/SECRET_TOKENS/DENY_KEYS (lines 33/47/55)
- Incremental-sync cursor contract: cursor.ts parseIncrementalCursor + keyset.ts (KEYSET_SETTLE_SECONDS=5)
- Tokyo storefront catalog snapshot: src/storefront/data/*.json, regenerated by scripts/tokyo-export-catalog.ts from listApiProducts
- No OpenAPI: the REST contract that wraps these reads is the test suite under src/lib/db/tests/* (erp-api.test.ts, order-api.test.ts, keyset-cursor.test.ts)

**Editable / removable**

- Editing ANY exported fn in src/lib/api/** changes the RSC page, the SEO feed, AND the REST endpoint at once (REST routes wrap the same fns) — never assume a change is UI-only.
- src/lib/listing/display-pricing.ts + facet-availability.ts + banner-rotation.ts are PURE and imported by BOTH server (promotion pools) and client (CategoryPageClient) — a change hits both; they are load-bearing shared contracts, not safe to tweak for one surface.
- mapProductRows (products.ts:1259) is the batching core — changing the fixed query set risks reintroducing N+1 across every listing page; keep the input-order/length invariant that enrichWithLivePromos relies on (products.ts:284).
- getAllSettingsServerOnly (cms.ts:212) returns secrets (mail.*_enc, payment.*) — never serialize it to a client/JSON route; the (tokyo) layout consumes it server-side only. Removing/altering the content.ts allow/deny lists can leak secrets via /api/content.
- attribute-validation.ts is a WRITE-path helper misfiled in lib/api — safe to move, but it is depended on by both the attributes PUT and the product workflows (keep them in sync).
- Tokyo (tokyo) catalog reads are decoupled: editing products.ts/categories.ts does NOT change (tokyo) pages until scripts/tokyo-export-catalog.ts is re-run and *.json committed. Treat the JSON as a build artifact, not hand-edited.
- The legacy (shell) route group is the primary request-time consumer of this layer and is being retired — reads used ONLY by (shell) (e.g. getMaisonExploreNav, some banner readers) may become removable once (shell) is gone; verify no REST route / Tokyo layout also uses them first.
- ERP-only serializers (orders.ts, order-substreams.ts, customers.ts, warranty-claims.ts, movements.ts) and the keyset/cursor helpers feed the REST ERP surface, not the storefront — safe to leave untouched when editing the storefront, but their shape is locked by src/lib/db/tests/*.

**Gaps / risks**

- Request-time decoupling trap: the (tokyo) storefront serves a STALE JSON snapshot of the catalog. Any backend/read-layer edit is invisible in (tokyo) until scripts/tokyo-export-catalog.ts re-runs. This is the single biggest gotcha for 'editing both frontend and backend'.
- http-source.ts is an unimplemented stub that throws (lines 37-43); flipping NEXT_PUBLIC_DATA_SOURCE=http would break the storefront. The 'redeploy-time flip' promised in index.ts:7-14 does not exist yet.
- Doc-comment staleness: legacy watch-store vocabulary persists in comments (e.g. products.ts:62-64 references a /montres breadcrumb; cms.ts MAISON_EXPLORE_TAGLINE_FALLBACK='Chaque seconde est un souvenir'). Comments describe an older watch brand; trust the code, not the prose.
- getProductBySlug (products.ts:127) applies NO promo and NO early-access embargo (documented 121-126) — any new caller that renders product content to the public must gate it itself or it leaks embargoed/mis-priced products.
- mapAndEnrichRows must NOT be used for the PDP (double-discount risk, products.ts:809-816). The PDP intentionally uses bare mapProductRows + its own enrichment — easy to get wrong when adding a new PDP-adjacent read.
- Public pagination must use rawCount, not products.length (embargoed pages come back thinned/empty; products.ts:243-251). A client paging on products.length will stop early and miss rows.
- No OpenAPI spec — the ERP REST contract these reads back is pinned only by src/lib/db/tests/* (erp-api/order-api/keyset-cursor tests). Changing a serializer silently breaks ERP consumers unless the tests are kept as the source of truth.
- attribute-validation.ts living under lib/api/ is misleading — it is a mutation validator, not a read; a reader auditing 'the read layer' could wrongly treat it as such.
- Several readers swallow errors to [] / {} / null (cms.ts, nav-composer dead-link pruning, content bundle) to fail-open and never blank the chrome — good for resilience but means a broken DB read degrades silently rather than erroring; watch when debugging 'missing' nav/banner data.

</details>


---

## 6. REST API Surface (src/app/api/**)

### What it is (and is not)

The HTTP surface is a **Next.js App Router Route Handler** layer (`app/<path>/route.ts`, Node.js runtime — node-postgres, `node:crypto`, the S3 client and `sharp` are not edge-safe; see `src/app/api/README.md:1`). It exists only for the cases that genuinely need a URL: ERP/integration consumers, payment webhooks, cron, file uploads, `curl`-able ops, Better-Auth emailed links, and SEO/agent surfaces. The **customer transactional surface (cart / checkout / account / favorites / auth-credential flows) is deliberately NOT here** — those are Server-Action-only (`src/lib/actions/*`, 394 actions catalogued in `src/lib/api-auth/internal-api-catalog.ts:11`). The REST surface is best read as **ERP/integration + headless-content/public-read**, never a full storefront API.

There is **no OpenAPI spec**: the contract is the test suite under `src/lib/db/tests/` — `external-api-contract.test.ts`, `erp-api.test.ts`, `headless-api.test.ts`, `order-api.test.ts`, `route-invariants.test.ts`, `reserved-routes.test.ts`. Change a route and these are what fail.

### The single source of truth: `route-catalog.ts`

`src/lib/api-auth/route-catalog.ts` is the authoritative inventory. It drives three things so they can't drift (`route-catalog.ts:18`): the admin route-inventory tab, the per-route public toggle, and **request enforcement (scope lookup by id)**. Every external handler calls `enforceExternalApi(request, "<routeId>")` where `<routeId>` is a catalog `id`; an unknown/non-external id fails closed with a 500 (`enforce.ts:37`).

Three **tiers** (`route-catalog.ts:25`):
- **`external`** — the key-gated public data API. Reads are key-required *by default* but an admin may toggle individual READ routes public; **writes are never public**. Each carries a concrete scope. Arrays: `EXTERNAL_API_ROUTES` (`route-catalog.ts:99`, the 60-odd scoped routes).
- **`first-party`** — the storefront's own browser routes: only `GET /api/store/search` and `POST /api/track`. Same-origin + per-IP rate-limited, no key.
- **`infra`** — auth catch-all, payment webhooks, cron, admin-session routes, unsubscribe. Each keeps its own guard; documented in `OTHER_ROUTES` (`route-catalog.ts:184`).

Two further arrays catalogue real HTTP endpoints that live *outside* `src/app/api` so the `/api` disk-invariant doesn't cover them: `APP_METADATA_ROUTES` (`route-catalog.ts:229` — sitemap.xml, robots.txt, manifest.webmanifest, icon.svg, llms.txt) and `APP_ROUTE_HANDLERS` (`route-catalog.ts:245` — `/admin/orders/export`, `/admin/system/audit/export`, `/cdn/[...path]`, `/feeds/[file]`, `/md/[...path]`, `/promo/[slug]`). `ALL_ROUTES` (`route-catalog.ts:256`) = external+other (drives enforcement); `ALL_HTTP_ENDPOINTS` (`:259`) = everything (drives the admin inventory UI).

### The external API: auth & authorization model

Flow for every external route (`src/lib/api-auth/enforce.ts:36`):
1. Resolve route in catalog; unknown/non-external → **500** fail-closed.
2. **Global kill-switch**: `apiSettingsService.get().apiEnabled` false → **503**, *nothing* passes (not even a valid key or a public route) (`enforce.ts:51`).
3. **Public read path**: if `route.canBePublic` AND the route id is in `settings.publicRoutes` AND the caller presents **no** credential (`presentsApiKey`, `enforce.ts:30`) → allowed anonymously, with a per-IP limit of 60/min (`enforce.ts:73`). Subtlety: a caller that *presents* a key on a public route is authenticated as a keyed caller (so a headless front-end keeps the ERP view — drafts visible, `externalRef` present — rather than being silently downgraded to the public view; `enforce.ts:64`).
4. Otherwise a **scoped key is mandatory** via `requireApiKey(req, route.scope)` (`enforce.ts:97`).

`requireApiKey` (`src/lib/api-auth/require-api-key.ts:55`): extracts `Authorization: Bearer <key>` or `X-API-Key` (`:45`); `apiKeyService.findActiveByPlaintext`; checks expiry; `hasScope`; **per-key rate limit 120/min** (fail-open on limiter error, but logged); then a **request-time creator re-check** (`:118`) — the key's scopes were bounded at mint time against the creator's RBAC, so it re-verifies the creator *still* holds the dashboard grants that scope maps to (`actorMayGrantScope`); a disabled/deleted creator → denied, an `admin` enum owner → `*` always passes. Stamps `last_used_at` at most once/minute. Every denial emits a best-effort `api_key.auth_failed` bus event (reason+scope+IP, **never the key value**), with the attacker-floodable reasons (`invalid`/`rate_limited`) sampled at 5% so a probe storm can't amplify into `audit_log` INSERTs (`:24`, `:66`). Never leaks key-exists vs wrong (both → 401).

**Scope grammar** (`src/lib/api-auth/scopes.ts`): per-resource `"<resource>:<action>"` plus coarse `read` / `write` / `full`; `write` implies `read` (`scopes.ts:96`). Resources: products, categories, stock, brands, collections, attributes, orders, customers, warranty, loyalty, content, blog, reviews (`:19`). `content`/`blog`/`reviews`/`loyalty` are read-only domains (no write route wired). `SCOPE_RBAC` (`scopes.ts:138`) maps each scope to the admin RBAC grants it is equivalent to (e.g. `orders:write` ⇔ `orders:manage`; `loyalty:read` ⇔ `customers:view`); this is the mint-time and request-time bound ("no privilege above your own").

**Writes = thin wrappers over the same workflows the dashboard uses** (`src/workflows/*`), attributed to the key's creator (`actorUserId`), so audit + cache invalidation + events fire identically. A write by a key with **no associated user** (`created_by` null) is refused 403 by `requireApiActor` (`src/lib/api-auth/actor.ts:13`) — such keys are read-only. Bodies go through `readJsonObject` (enforces a plain JSON object → 400) and the workflow's own `safeParse`; `workflowResponse`/`workflowErrorStatus` translate workflow `fail()` codes to HTTP (validation→400, not_found→404, forbidden→403, a large 409 conflict set, 422 for order-push policy rejections, 503 for `payment_unverified`) — `src/lib/api-auth/respond.ts` + `enforce.ts:103`. Every new fail code reachable from a route must be mapped in `workflowErrorStatus` or `erp-api.test.ts` fails.

### External route groups (all key-gated; reads toggleable unless noted)

- **Catalog CRUD** — products (`/api/products` + `/[slug]` + `/[slug]/attributes`), categories (+`/[slug]/attributes`), brands, collections, attributes (+`/values`). Full GET/POST/PUT(upsert-by-ref)/PATCH/DELETE(archive, soft). PUT upsert matches by `externalRef|sku|gtin` (products) or `externalRef|slug` (`src/app/api/products/route.ts:134`). Reads expose uuid `id`, `externalRef`, `stockQty` (`ApiProduct`) for ERP round-trip; keyed callers see drafts, public callers see published only.
- **Stock** — `GET/PATCH /api/stock` (`{stockDelta:±N}` atomic or absolute set, delegates to the product update workflow) + `GET /api/stock/movements` (keyset ledger, **key-only** `canBePublic:false`).
- **Orders (ERP)** — `GET /api/orders` (incremental sync by composite keyset `?since=&sinceId=`, or by `?externalRef=`/`?orderNumber=`; `src/app/api/orders/route.ts:34`), `POST /api/orders` (ERP/POS order push → `createFromLines` → `placeOrderWorkflow`), `GET /api/orders/[id]`, and substreams `/shipments` `/refunds` `/returns` `/history` (GET reads) + writes `/shipments` `/refunds` `/returns`(POST+PATCH) `/status`(PATCH) `/delivery-outcome`(POST). All order reads are **key-only (PII)**. `PATCH /status` runs the same payment-aware state machine as the dashboard and also stamps/links `externalRef` via `order.set_external_ref` (`src/app/api/orders/[id]/status/route.ts:38`).
- **Customers (ERP)** — `GET /api/customers` (keyset sync or by `externalRef|email|phone`), `GET /api/customers/[id]` (+addresses+loyalty), POST/PUT/PATCH writes, `GET /api/customers/[id]/loyalty` (coin ledger). **Key-only (PII)**; `admin_notes` never serialized.
- **Warranty claims (SAV/RMA)** — `/api/warranty-claims` (list/create) + `/[id]` (get/patch). Two-way ERP SAV sync; key-only reads.
- **Loyalty** — `GET /api/loyalty/movements` (global coin feed, keyset). Read-only, key-only.
- **Headless content (public-read)** — `GET /api/content` (render bundle: banners/nav/logo + public settings subset, secrets filtered — `src/app/api/content/route.ts`), `GET /api/blog` + `/[slug]`, `GET /api/reviews` (approved reviews + summary). These have empty RBAC read-sets (storefront-public) and are the natural candidates for the public toggle.

PII reads are pinned `canBePublic:false` (`route-catalog.ts:140,144,161,167,172,173`) so an admin can never accidentally expose them via the settings panel. `TOGGLEABLE_PUBLIC_ROUTES`/`TOGGLEABLE_PUBLIC_IDS` (`route-catalog.ts:268`) are the validated public-toggle surface.

### First-party routes

`GET /api/store/search` (`src/app/api/store/search/route.ts`) and `POST /api/track` (`src/app/api/track/route.ts`) call `requireFirstParty` (`src/lib/api-auth/same-origin.ts:42`) — a CSRF speed-bump (Sec-Fetch-Site, then Origin/Referer host == Host), **explicitly not authentication**; the real controls are the per-IP rate limit (60/min) + (for track) the consent gate. Search is site-gate-aware (returns nothing when the store is in maintenance/coming-soon), early-access-filters product hits, and sets `private, no-store` for signed-in viewers vs a short shared cache for anonymous. Track is a no-op (`serverMirrorActive()` false in prod) until a fan-out sink is wired — it does not persist to `audit_log`.

### Infra routes

- **`/api/auth/[...all]`** — Better-Auth catch-all (`src/app/api/auth/[...all]/route.ts`). Serves get-session, sign-out, social sign-in, OAuth callbacks, verify-email, reset links, 2FA. **Email/password credential endpoints are disabled here** (`disabledPaths`) — the app calls `auth.api.*` in-process from server actions to add throttles/audit/invariants. Rewrites `X-Forwarded-For` to the single trusted hop so both limiters key on the same unspoofable IP.
- **`/api/webhooks/flouci` and `/api/webhooks/clictopay`** (GET+POST) — both delegate to `src/lib/payments/webhook-handler.ts` (`handleGatewayWebhook`). Neither gateway signs its callback; the payload is **not trusted** — the handler looks the order up by the reference stored at init and **re-verifies against the provider's API** (Flouci `verify_payment`, ClicToPay `getOrderStatusExtended.do`), with amount check + idempotent transition deduped via `webhook_events`. Backed up by the customer-return verify and the `payment_reconcile` cron.
- **`/api/unsubscribe/one-click`** (`src/app/api/unsubscribe/one-click/route.ts`) — RFC 8058 one-click unsubscribe; the **signed HMAC token in the URL is the authorization** (no session/same-origin — mailbox providers POST from their own servers). POST unsubscribes (anti-enumeration: all tokens → 200, only a genuine DB failure → 500); GET only 303-redirects to `/se-desabonner` (a GET never unsubscribes).
- **`/api/admin/*`** — all session-gated via `requirePermission(module, action)` (NOT a blanket `requireAdmin`), which **404s** when the caller lacks the permission so the endpoint stays invisible. Routes: `bootstrap` (token-gated `ADMIN_BOOTSTRAP_TOKEN`, constant-time, rate-limited, grants super_admin — the only non-permission guard), `metrics` (`system_performance:view`), `media` (`media:view`) + `media/upload` & `media/import-url` (`media:create` **+ `assertSameOrigin`**), `customers/export` (`customers:export`), `customers/guests/export` (`invites:export`), `customers/favorites/export` (`favorites:export`), `newsletter/export`, `segments/[id]/export`, `import/template` (`system_import:view`), `system/demo` (`system_demo:manage` **+ `assertSameOrigin`**). CSV exports for orders/audit live at `/admin/orders/export` & `/admin/system/audit/export` (outside `/api`).

### Cron (`/api/cron/*`) — one heartbeat, per-job routes kept for parity

All gated by `guardCron` (`src/lib/cron/guard.ts:42`): per-IP rate limit 10/60s **first**, optional `CRON_ALLOWED_IPS` allowlist, **503 if `CRON_SECRET` unset** (never runs unguarded), then constant-time `Bearer` compare (`timingSafeEqual`).

`POST /api/cron/dispatch` (`src/app/api/cron/dispatch/route.ts`) is **THE single heartbeat** — point one Coolify Scheduled Task (every ~2 min) at it. It reads `SCHEDULED_JOBS` (`src/lib/jobs/registry.ts:64`), computes which external jobs are due from their machine cadence (`dispatch` field, pure math in `src/lib/jobs/dispatch-schedule.ts`), and runs them sequentially in a background `after()` sweep via the shared `runScheduledJob` center (per-job kill-switch + `job_run_log` row). An in-process `dispatchInFlight` lock (claimed before the first `await`) prevents overlapping sweeps; it fails *safe* (a DB blip skips the tick rather than firing the whole schedule). Long drains (`mailing_queue`, `webhook_dispatch`) run last.

The **12 per-job routes still exist for manual curl / "run now" parity** — each just calls `runScheduledJob("<key>", "cron")`:

| Route | Job key | Cadence |
| --- | --- | --- |
| `/api/cron/mailing` | `mailing_queue` | ~2 min |
| `/api/cron/webhooks` | `webhook_dispatch` | ~2 min |
| `/api/cron/promotion-announce` | `promotion_announce_sweep` | ~5 min |
| `/api/cron/payments` | `payment_reconcile` | ~12 min |
| `/api/cron/abandoned-orders` | `abandoned_orders` | ~60 min |
| `/api/cron/retention` | `retention_purge` | daily 03:00 (destructive) |
| `/api/cron/detourage` | `product_detourage` | daily 04:00 (destructive) |
| `/api/cron/birthday` | `birthday_email` | daily 00:10 |
| `/api/cron/life-event-anniversary` | `life_event_anniversary_email` | daily 00:15 |
| `/api/cron/wishlist-campaign` | `wishlist_campaign_email` | daily 00:20 |
| `/api/cron/review-request` | `review_request` | daily 09:30 |

(`review_generation` is an **internal** `instrumentation.ts` timer — no cron route.)

### Non-`/api` endpoints that act like endpoints

- **`/cdn/[...path]`** (GET+HEAD, `src/app/cdn/[...path]/route.ts`) — same-origin proxy to the SeaweedFS S3 gateway (`S3_ENDPOINT`/`S3_BUCKET`). Public objects only, **no auth/presigning** except kept originals (`*.original.*`, staff-only via `media:view`); anti-traversal segment check; `redirect:"manual"` SSRF guard; 10s header timeout (not body); success → `public, max-age=31536000, immutable`, errors never cached.
- **`/feeds/[file]`** (`src/app/feeds/[file]/route.ts`) — one catch-all serving Google Merchant RSS (XML) OR OpenAI ACP (JSON), selected by matching the admin-configured + enabled filename (SEO → Flux); unknown/disabled → 404. ISR 30 min, `noindex`, site-gate-aware (no staff bypass — must not vary per viewer).
- **`/robots.txt`** (`src/app/robots.txt/route.ts`) — raw handler, `force-dynamic`; indexing switch + admin Disallow + feed/markdown Allow carve-outs + llms.txt pointer; `Disallow: /` when site gated.
- **`/llms.txt`** (`src/app/llms.txt/route.ts`) — AEO/GEO map generated from live catalog+settings (or full override via `seo.llms_txt`); minimal body when gated.
- **`/md/[...path]`** (`src/app/md/[...path]/route.ts`) — "Markdown for Agents"; the edge proxy (`proxy.ts`) rewrites `Accept: text/markdown`/`.md` here; regenerates from the data layer (never scrapes HTML), `noindex` + canonical to the HTML twin, site-gate + early-access aware, `private, no-store` for signed-in viewers.
- **`/promo/[slug]`** (`src/app/promo/[slug]/route.ts`) — route handler (not a page, so it can set a cookie): honors an admin redirect, looks up a live URL-trigger promo, drops httpOnly `gz.promo` cookie (lookup key only; cart re-validates), 307 → `/`; unknown slug → `/` silently with no cookie.
- **`/facture/[id]`** (`src/app/(documents)/facture/[id]/page.tsx`) — NOT a route handler, it's a **page** in the layout-less `(documents)` group. Printable customer receipt with full PII; registered orders gated to owner or `orders:view` staff, guest orders use the UUID-bearer model (v7 uuid, unguessable). Listed in neither catalog array — treat it as part of the orders/account surface, not the REST API.

### Response/caching conventions
Keyed external reads → `private, no-store`; only an opted-public read sets a short shareable `s-maxage`/`stale-while-revalidate`. Error/`no-store` paths never cached. External data routes don't declare `dynamic` (reading the auth header already forces dynamic); webhooks/cron/robots/llms/md declare `force-dynamic`. Money in all payloads is integer **millimes** (columns named `*_cents` hold millimes — never divide by 100; `src/lib/price.ts`).


<details>
<summary><strong>6. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- src/lib/api-auth/route-catalog.ts — SOURCE OF TRUTH for route auth/inventory
- src/lib/api-auth/enforce.ts — enforceExternalApi gate + kill-switch + workflowErrorStatus
- src/lib/api-auth/require-api-key.ts — key auth, scope, rate-limit, creator re-check
- src/lib/api-auth/scopes.ts — scope grammar + SCOPE_RBAC mint bound
- src/lib/api-auth/actor.ts — requireApiActor (writes need key owner)
- src/lib/api-auth/respond.ts — readJsonObject/workflowResponse/workflowInput/pickId
- src/lib/api-auth/same-origin.ts — requireFirstParty (search/track)
- src/lib/cron/guard.ts — guardCron (CRON_SECRET, IP allowlist, rate limit)
- src/lib/jobs/registry.ts — SCHEDULED_JOBS (cron job definitions + cadence)
- src/app/api/cron/dispatch/route.ts — the single cron heartbeat
- src/app/api/products/route.ts — representative external CRUD handler
- src/app/api/orders/[id]/status/route.ts — ERP status push + externalRef link
- src/app/api/auth/[...all]/route.ts — Better-Auth catch-all (credential paths disabled)
- src/lib/payments/webhook-handler.ts — shared re-verifying gateway webhook handler
- src/app/cdn/[...path]/route.ts — same-origin S3 media proxy
- src/app/api/README.md — prose digest (partly STALE: mentions /api/aide)
- src/lib/db/tests/{external-api-contract,erp-api,headless-api,order-api,route-invariants,reserved-routes}.test.ts — the real contract

**Models / tables**

- api_key (src/modules/api-key) — hashed key, scopes[], expires_at, created_by, last_used_at
- api_settings (src/modules/api-settings) — apiEnabled, webhooksEnabled, outboundWebhooksEnabled, publicRoutes[]
- job_run_log (src/modules/jobs) — cron/job run outcomes (status, started_at) read by the dispatch heartbeat
- webhook_events — inbound-payment settlement dedup + outbound webhook delivery queue
- audit_log — written by key-attributed writes + api_key.auth_failed events
- search_log — first-party /recherche telemetry (not autocomplete)
- DTOs serialized by the surface: ApiProduct/ApiBrand/ApiCollection/ApiCategory (src/lib/api/*), serializeOrder (src/lib/api/orders.ts), getContentBundle (src/lib/api/content.ts)
- order + order_item (src/modules/order) — reached via serializeOrder for ERP order reads/substreams

**Sources of truth**

- src/lib/api-auth/route-catalog.ts — every route's tier/domain/scope/canBePublic; drives enforcement, inventory, public toggle
- apiSettings (src/modules/api-settings) — apiEnabled kill-switch + publicRoutes[] (which reads are public); read via apiSettingsService.get() in enforce.ts
- api_key table (src/modules/api-key) — key hash, scopes[], expires_at, created_by, last_used_at
- src/lib/api-auth/scopes.ts SCOPE_RBAC — scope→RBAC-grant equivalence (mint + per-request bound)
- src/lib/jobs/registry.ts SCHEDULED_JOBS — cron job keys, dispatch cadence, kill-switch/runnable flags
- src/lib/db/tests/*.test.ts — the API contract (no OpenAPI); statically checks fail-code→status mapping and route/disk invariants
- env: CRON_SECRET, CRON_ALLOWED_IPS, ADMIN_BOOTSTRAP_TOKEN, S3_ENDPOINT/S3_BUCKET, BETTER_AUTH_SECRET

**Editable / removable**

- Adding/removing an external route is a two-step edit: add/remove the ext(...) entry in route-catalog.ts AND the handler file; external-api-contract.test.ts + route-invariants.test.ts enforce they match (removing a handler without the catalog entry, or vice-versa, fails tests).
- Handlers are intentionally thin — business logic lives in src/workflows/* and src/lib/api/*; to change behavior edit the workflow/lib, not the route. Writes share the dashboard workflows, so a change there affects both admin UI and API.
- The per-job cron routes (/api/cron/<job> except dispatch) are REMOVABLE in principle (dispatch covers scheduling) but are kept for manual curl / dashboard 'run now' parity — removing one breaks run-now for that job unless rewired.
- Making a read public = add its route id to apiSettings.publicRoutes via the admin panel (data, not code); only ids in TOGGLEABLE_PUBLIC_IDS are accepted. PII reads are hard-pinned canBePublic:false and cannot be toggled — do not relax this.
- The customer transactional surface is NOT in this subsystem — do not add cart/checkout/account mutation routes here; they belong in Server Actions (src/lib/actions/*) which add throttles/audit the raw HTTP layer lacks.
- Legacy cookie/id names are load-bearing: gz.promo (promo/[slug]), gz.session_token / gz.cart_token elsewhere, gz_ ids — safe to read but do NOT rename without a migration.
- /api/auth credential endpoints are disabled on purpose (disabledPaths); do not re-enable — the in-process auth.api.* path carries the throttles/audit/signup invariants.
- internal-api-catalog.ts and event-catalog.ts are GENERATED (scripts/gen-*.mjs) — never hand-edit; regenerate after adding actions/events.

**Gaps / risks**

- src/app/api/README.md is partly STALE vs code: it lists /api/aide + /api/aide/[slug] with an aide:read scope that does NOT exist anywhere in code (grep confirms 'aide' appears only in the README); it also says admin routes 'Most gate on requireAdmin' whereas every admin API route actually uses the finer requirePermission(module, action) (404 on lack). Trust route-catalog.ts + the handlers over the README.
- Rate-limit guards (per-key 120/min, per-IP 60/min public, cron 10/60s) FAIL OPEN on a limiter/DB error (logged, not blocked) — a sustained DB stress disables throttling with only a console.error trail; a noted SECURITY TODO in require-api-key.ts:21 to route the invalid/rate_limited firehose off audit_log is unimplemented.
- requireFirstParty (search/track) is explicitly a CSRF speed-bump, not auth — a non-browser client can forge Sec-Fetch-Site/Origin. It must never be the sole guard on anything sensitive; both routes lean on the IP rate limit + consent gate instead.
- /api/track is dormant in production (serverMirrorActive() false) — it validates+gates but only console.logs in dev and never persists; any future analytics fan-out must honor the consent gate already wired there.
- /facture/[id] is a layout-less PAGE (not a route handler) carrying full order PII; guest orders rely entirely on the v7-UUID being an unguessable bearer capability (a signed guest link is a deferred decision) — the UUID must never leak to third-party tags (redact-url.ts scrubs it).
- Payment webhooks are unsigned by both gateways by design — security rests entirely on the server-side re-verification in webhook-handler.ts; do not add trust in the raw callback payload.
- A key with created_by = null is read-only (requireApiActor refuses writes); the per-request creator re-check means demoting/deleting a key's creator silently revokes that key's writes — expected, but can surprise ERP integrators.
- Kill-switch (apiSettings.apiEnabled=false) 503s the ENTIRE external API including valid keys and public reads — a single toggle can take down all ERP/headless integrations.
- Money fields are millimes in columns misleadingly named *_cents — any new serializer must not divide by 100 (see src/lib/price.ts).

</details>


---

## 7. Modules & Domain Model (src/modules/** — 44 modules, 135 tables)

The backend is a **Medusa-inspired modular monolith**: one folder per business domain under `src/modules/<name>/`, each owning its own Postgres tables, a CRUD service, read queries, and a public barrel. There are **44 module folders** and **135 `pgTable` definitions total** (127 inside `src/modules/**` + 8 in `src/associations/**`; the rest of the 135 are the sub-module tables under `catalog/` and `cms/`). The canonical spec is `docs/modules.md` — but that doc is **stale** (still titled "Tokyo Store", uses Rolex/Submariner examples and Windows paths); the CODE is the source of truth.

### (a) The `{schema, service, queries, index}.ts` convention

Worked against the **catalog/product** sub-module and the **order** module (both read in full):

- **`schema.ts`** — Drizzle table definitions + enums + inferred row types. This is the only place columns are declared. Example: `src/modules/catalog/product/schema.ts:59` defines `products`, `:276` `product_variants`, `:351` `product_variant_values`; `src/modules/order/schema.ts:66` defines `orders`, `:234` `order_items`, `:282` `order_status_history`, `:304` `order_refunds`, `:329` `shipments`, `:352` `shipment_items`. Each file exports `XRow`/`NewXRow` types via `$inferSelect`/`$inferInsert` (e.g. `product/schema.ts:369-374`). Shared column builders come from `src/lib/db/columns.ts`: `id()` = UUID v7 PK (`uuid_generate_v7()`), `timestamps()` = created/updated, `softDelete()` = `deleted_at` nullable marker.
- **`service.ts`** — a `server-only` class instance exposing **CRUD + query helpers**; the low-level data-access layer. `src/modules/catalog/product/service.ts:49` `class ProductService` → exported singleton `productService` (`:523`); `src/modules/order/service.ts:95` `class OrderService` → `orderService` (`:1081`). Methods take an optional `DbOrTx` so they compose inside a workflow transaction (e.g. `product/service.ts:164 lockStock`, `order/service.ts:497 transitionStatusInTx`). Per the "services hide, workflows orchestrate" rule, services are **NOT** re-exported from parent barrels — workflows import them directly via `@/modules/<x>/service` (22 call-sites import `order/service`, 19 `customer/service`; see `src/workflows/**`).
- **`queries.ts`** — the `server-only` **read surface that pages/RSC may import directly** (mutations must go through workflows). Header comment at `src/modules/catalog/product/queries.ts:14` says exactly this. Functions are plain exported async fns tuned to specific indexes (e.g. `listPublishedProducts` at `:19`, `stockStateSql` at `:191`, `listVariantsForProducts` at `:253`). `order/queries.ts` is the order read surface.
- **`index.ts`** — the public barrel. Convention: re-export `queries` under a namespace + the row types, and **deliberately not the service**. `catalog/product/index.ts:1` = `export * as productQueries from "./queries"` + `export type { ProductRow }`; `order/index.ts:1` = `export * as orderQueries from "./queries"` + types.

**Convention deviations (real, intentional):**
- `catalog/` and `cms/` are **parent barrels over sub-modules** and have **no top-level `service.ts`**. Catalog spans `attribute, brand, category, collection, content-gen, product, product-gen, review` — each a full `{schema,service,queries,index}` unit; `catalog/index.ts` only re-exports brand/category/product (`src/modules/catalog/index.ts:24-26`); attribute/review are reachable only by direct import. CMS spans `banner, faq, navigation, page, setting, trust_badge`.
- Only **18 modules carry a `queries.ts`** (appointments, audit, auth, authors, blog, cart, currency, customer, delivery, loyalty, mailing, media, newsletter, order, promotion, redirects, search, tax); the rest expose reads via their service.
- **`api-settings`** is an outlier: only `service.ts`, **no tables, no index** (settings helper). `business` and `rbac` have **no `index.ts`** (consumers import service/schema directly).
- Several modules keep extra files: `catalog/review` (config/generation/schedule services), `mailing` (14 files — brand/campaign/dispatch/flows/render/templates), `media` (processor, storage, url-resolver, white-bg, settings), `search` (embedding.service, vector, aliases), `order` (returns.schema+service, export, returns-reasons).

### (b) The 44 modules grouped by domain

- **Catalog & inventory** — `catalog` (product/variant/attribute/brand/category/collection/review + AI gen), `search` (FTS + pgvector embeddings + telemetry), `stock-location` (multi-location, opt-in), `stock-movement` (append-only ledger), `stock-transfer` (inter-location), `import` (XML/CSV feed jobs), `showcase` (manual product pins), `currency` (global active currency).
- **Orders / checkout / fulfilment / money** — `order` (orders, items, status history, refunds, shipments, returns), `cart` + `cart-event`, `payment` (provider credentials), `delivery` (agents, zones, pickup locations), `tax` (per-attribute-value rule cascade), `document` (gapless fiscal sequences: factures/avoirs/BL), `gift-card`, `credit` (store-credit wallet ledger).
- **Customers / identity / access** — `auth` (Better-Auth tables), `customer` (profiles, addresses, segments), `rbac` (roles, permissions, assignments), `business` (B2B companies + members + levels), `loyalty` ("Le Cercle de Famille" tiers + life-stage claims), `oauth` (social-login credentials), `api-key` (external HTTP API keys), `appointments` (rendez-vous).
- **Content / editorial / media** — `cms` (settings, banners, faq, nav, pages + hero/text/stats/timeline/cta section tables, trust badges), `blog`, `authors`, `media` (image rows + settings).
- **Marketing / engagement** — `promotion` (unified discount engine), `mailing` (campaigns/flows/templates/logs/suppressions/sends), `newsletter`, `redirects` (admin URL redirects + 404).
- **Platform / automation / observability** — `audit` (audit_log), `jobs` (cron run history), `webhook` (inbound event log) + `webhook-endpoints` (outbound push + delivery queue), `instance` (uptime heartbeats), `warranty-claim` (SAV), `ai` (provider settings + call logs + feature prompts), `ai-assign` (auto-classification jobs), `ai-jobs` (shared per-item AI job feed), `api-settings` (settings helper, no table).

### (c) Tables owned per module (full 135-table inventory)

Catalog is the heaviest at **20 tables**: `products`, `product_variants`, `product_variant_values`, `product_tier_release`, `product_attributes`, `product_attribute_values`, `product_attribute_assignments`, `product_attribute_scalars`, `category_attribute_filters`, `brands`, `categories`, `collections`, `product_reviews`, `review_schedule`, `review_generation_jobs`, `review_generation_drafts`, `product_generation_jobs`, `product_generation_drafts`, `catalog_content_gen_jobs`, `catalog_content_gen_drafts`. **cms (16):** `site_settings`, `banners`, `faqs`, `faq_categories`, `nav_menus`, `nav_items`, `pages`, `page_sections`, `hero_sections`, `text_sections`, `stats_sections`, `stats_section_items`, `timeline_sections`, `timeline_section_items`, `cta_sections`, `trust_badges`. **order (8):** `orders`, `order_items`, `order_status_history`, `order_refunds`, `order_returns`, `order_return_items`, `shipments`, `shipment_items`. **business (6):** `businesses`, `business_members`, `business_levels`, `business_level_allocations`, `business_applications`, `business_join_requests`. **mailing (6):** `email_campaigns`, `email_flows`, `email_logs`, `email_suppressions`, `email_template_overrides`, `mailing_sends`. **auth (5):** `users`, `sessions`, `accounts`, `verifications`, `two_factors`. **blog (5):** `blog_posts`, `blog_categories`, `blog_tags`, `blog_post_tags`, `blog_comments`. **promotion (4):** `promotions`, `promotion_redemptions`, `promotion_targets`, `promotion_scope_targets`. **rbac (4):** `roles`, `role_permissions`, `user_roles`, `user_permissions`. **customer (4):** `customer_profiles`, `addresses`, `customer_segments`, `customer_segment_members`. **delivery (4):** `delivery_agents`, `delivery_zones`, `delivery_agent_zone_rates`, `pickup_locations`. **ai (3):** `ai_provider_settings`, `ai_call_logs`, `ai_feature_prompts`. **appointments (3):** `appointments`, `appointment_locations`, `appointment_reasons`. **2-table:** `cart`(`carts`,`cart_items`), `loyalty`(`loyalty_levels`,`loyalty_life_stage_claims`), `media`(`media`,`media_settings`), `search`(`search_log`,`search_aliases`), `stock-location`(`stock_locations`,`stock_levels`), `stock-transfer`(`stock_transfers`,`stock_transfer_items`), `wishlist`(`wishlists`,`wishlist_items`), `webhook-endpoints`(`webhook_endpoints`,`webhook_deliveries`), `ai-assign`(`ai_assign_jobs`,`ai_assign_proposals`). **1-table:** `gift-card`(`gift_cards`), `credit`(`customer_credit_entries`), `currency`(`currencies`), `tax`(`tax_rules`), `document`(`document_sequences`), `payment`(`payment_provider_settings`), `oauth`(`oauth_provider_settings`), `api-key`(`api_keys`), `audit`(`audit_log`), `authors`(`authors`), `cart-event`(`cart_events`), `import`(`import_jobs`), `instance`(`app_instance_heartbeats`), `jobs`(`job_run_log`), `newsletter`(`newsletter_subscriptions`), `redirects`(`redirects`), `showcase`(`showcase_pins`), `stock-movement`(`stock_movements`), `warranty-claim`(`warranty_claims`), `webhook`(`webhook_events`), `ai-jobs`(`ai_job_logs`). **associations (8):** see (d).

### (d) The no-cross-module-FK rule and `src/associations/*`

**The rule (enforced):** no module `schema.ts` declares `.references()` to another module's table. Verified: the only 4 `.references()` calls in the whole `src/modules + src/associations` tree are **all auth-internal** (`sessions/accounts/twoFactors → users.id` in `src/modules/auth/schema.ts:65,86,138`). Everything else that crosses a module boundary is a **bare `uuid`/`text` soft link** — e.g. `orders.user_id` (`order/schema.ts:71`, text soft-link to `auth.users`), `cart_items.product_id` (`cart/schema.ts:65`), `order_items.product_id`/`variant_id` (`order/schema.ts:239,252`), `customer_profiles.loyalty_level_id` (`customer/schema.ts:68`). The actual DB FKs for these links are a **fixed set written in migration SQL**, not in Drizzle code (documented inline, e.g. `customer-user.ts:16-18`, `loyalty-referral.ts:16-27`).

**`src/associations/`** is the Module-Link layer — join tables + a service that owns the stitching logic:
- **Product stitching** (schemas): `product-category.ts` (`product_categories`, M2M + `is_primary`), `product-brand.ts` (`product_brands`, modelled 1:1 via a join), `product-media.ts` (`product_media`, ordering + primary flag), `product-related.ts` (`product_related`, curated "Vous aimerez aussi" for `related_mode` manual/ai), `product-complementary.ts` (`product_complementary`, curated accessories), `product-collection.ts` (`product_collections`, M2M + display_order). All logic lives in `src/associations/catalog.service.ts` (875 lines) exposing `productCategoryLinks`, `productBrandLink`, `productMediaLink`, `productRelatedLinks`, `productComplementaryLinks`, `productCollectionLinks` — set/list/count/delete + tree-walking reads (`listPublishedProductIdsInCategoryTreePaged`, etc.).
- **customer ↔ user**: `customer-user.ts` (`customer_user_links`, 1:1, unique on both sides) + `customer-user.service.ts`. Header notes the **NAME-MIRROR invariant**: `users.name` is a denormalised copy of the profile name, kept in sync one-way by a `customer.profile_updated` subscriber.
- **loyalty ↔ referral**: `loyalty-referral.ts` (`loyalty_referrals`, user↔user "Cercle" graph) + `loyalty-referral.service.ts`. Modelled as an association (not inside loyalty) because it's a cross-user link; consent/anti-abuse CHECKs live in migrations 0140/0144.

### Cross-cutting invariants worth internalising before editing
- **Money = integer MILLIMES.** Every `*_cents` column (products, variants, orders, credit, gift-card, promotions…) holds millimes (1 TND = 1000). The `_cents` name is legacy; never divide by 100. See `src/lib/price.ts`.
- **Soft deletes + UUID v7 PKs everywhere** via `src/lib/db/columns.ts`. Uniqueness is typically a **partial unique index `WHERE deleted_at IS NULL`** so a tombstone frees a slug/sku/ref for reuse.
- **Snapshotting**: `order_items` snapshots product/variant/warranty/tax at purchase so orders survive later catalog edits (`order/schema.ts:240-268`); orders snapshot the shipping address + chosen agent/pickup.
- **Denormalised read-fields kept in lockstep with ledgers** inside one transaction: `products.rating`/`reviews_count` from `product_reviews`; `customer_profiles.credit_balance_cents` from `customer_credit_entries`; `customer_profiles.cumulative_spend_cents`/`paid_order_count`/`loyalty_level_id` from paid orders; stock `stock_qty` vs `stock_movements`/`stock_levels`.
- **Many enums are plain `text` + a migration CHECK, not `pgEnum`**, specifically so adding a value needs no migration: credit kinds (`credit/schema.ts:24` CREDIT_ENTRY_KINDS), gift-card origin/status, customer segment `kind`, product `condition`, `related_mode`. True `pgEnum`s exist for order status/payment/delivery/channel and promotion scope/trigger/discount-type.


<details>
<summary><strong>7. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- src/lib/db/schema.ts — Drizzle graph barrel; re-exports every module schema (INCOMPLETE, see gaps)
- src/lib/db/columns.ts — id()/timestamps()/softDelete() shared column builders (UUID v7)
- src/modules/catalog/product/schema.ts — products, product_variants, variant_values; canonical schema example
- src/modules/catalog/product/{service,queries,index}.ts — CRUD vs read-surface vs barrel convention
- src/modules/catalog/index.ts — parent barrel pattern (no top-level service)
- src/modules/order/schema.ts — orders + 5 related tables; snapshot + fiscal-doc model
- src/modules/order/service.ts — 1000+ line OrderService (status transitions, shipments, refunds)
- src/associations/catalog.service.ts — all product↔{category,brand,media,collection,related,complementary} join logic
- src/associations/customer-user.ts — customer_profiles ↔ auth.users soft link + name-mirror invariant
- src/associations/loyalty-referral.ts — user↔user Cercle referral graph association
- src/modules/customer/schema.ts — profiles, addresses, segments; loyalty/credit denorm fields
- src/modules/promotion/schema.ts — unified single-table discount engine (scope/trigger/target tables)
- src/modules/credit/schema.ts — append-only store-credit ledger (kinds as plain text)
- docs/modules.md — convention spec (STALE branding; read with skepticism)
- src/lib/db/migrations/*.sql — authoritative FKs/CHECKs/indexes (hand-authored)

**Models / tables**

- orders / order_items / order_status_history / order_refunds / shipments / shipment_items / order_returns / order_return_items (order)
- products / product_variants / product_variant_values / product_tier_release (catalog/product)
- product_attributes / product_attribute_values / product_attribute_assignments / product_attribute_scalars / category_attribute_filters (catalog/attribute)
- brands / categories (self-nesting parent_id) / collections / product_reviews (catalog)
- carts / cart_items (cart); cart_events (cart-event)
- customer_profiles / addresses / customer_segments / customer_segment_members (customer)
- users / sessions / accounts / verifications / two_factors (auth, Better-Auth, camelCase fields)
- roles / role_permissions / user_roles / user_permissions (rbac — permission KEYS in code, not DB)
- promotions / promotion_redemptions / promotion_targets / promotion_scope_targets (promotion)
- loyalty_levels / loyalty_life_stage_claims (loyalty); customer_credit_entries (credit); gift_cards (gift-card)
- stock_locations / stock_levels (stock-location); stock_movements (stock-movement); stock_transfers / stock_transfer_items (stock-transfer)
- businesses / business_members / business_levels / business_level_allocations / business_applications / business_join_requests (business)
- Association tables: product_categories, product_brands, product_media, product_related, product_complementary, product_collections, customer_user_links, loyalty_referrals

**Sources of truth**

- Table/column definitions: each module's schema.ts (and catalog/cms sub-module schema.ts files)
- Cross-module joins: src/associations/*.ts (6 product-* + customer-user + loyalty-referral)
- Drizzle graph for type inference: src/lib/db/schema.ts barrel — but it OMITS gift-card and loyalty-referral (see gaps)
- FKs, CHECK constraints, trigram/GIN/partial-unique/functional indexes: ONLY in src/lib/db/migrations/*.sql — NOT fully in schema.ts (drizzle meta frozen at 0007, db:generate disabled)
- Mutation entrypoints (true write API): src/workflows/** calling module services inside db.transaction()
- Convention spec: docs/modules.md (authoritative on rules, stale on branding/examples)
- Contract/behavior tests: src/lib/db/tests/*

**Editable / removable**

- SAFE to edit per-module: add columns to a module's schema.ts, but you MUST hand-author the matching src/lib/db/migrations/NNNN_*.sql + _journal.json entry — never run db:generate (guarded by scripts/guard-generate.ts; meta frozen at 0007).
- Services (service.ts) are internal — safe to extend; callers are workflows only. Reads added to queries.ts are directly RSC-importable.
- A module's index.ts re-exports only queries + types by design; keep services out of barrels.
- REMOVING a whole module is NOT a simple folder delete: a soft-linked uuid/text column in another module (e.g. orders.user_id, promotions.business_id, customer_profiles.loyalty_level_id) and an association table may point at it. Grep soft links + src/associations + the DB FKs in migrations before dropping.
- Association tables in src/associations are the join layer — removing product-complementary or product-related only drops a PDP cross-sell rail (curated-only), low blast radius; removing product-category/product-media/product-brand breaks catalog navigation and cards.
- catalog/ and cms/ are parent barrels of independent sub-modules — a sub-module (e.g. catalog/review, catalog/product-gen) can be edited/removed with less risk than touching catalog/product.
- Legacy-but-load-bearing, DO NOT remove: products.currency (frozen 'TND'), products.platform (legacy tag), the *_cents column NAMES (hold millimes), partial-unique WHERE deleted_at IS NULL indexes (they enable slug/sku reuse after soft delete).

**Gaps / risks**

- BARREL IS INCOMPLETE: src/lib/db/schema.ts does NOT re-export src/modules/gift-card/schema.ts (gift_cards, migration 0147) nor src/associations/loyalty-referral.ts (loyalty_referrals, migration 0140). Tables exist (verified in migrations) and are used by importing them directly, so runtime queries work — but db's relational schema union / db.query typing won't include them, and any future drizzle-kit introspection would miss them. Likely an oversight worth a one-line fix each.
- schema.ts is NOT the full source of truth for constraints. FKs, CHECKs, and many indexes (trigram GIN, functional lower()/upper(), several partial uniques like addresses_one_default_*, orders_external_ref_uniq, the business/segment/loyalty cross-module FKs) live ONLY in src/lib/db/migrations/*.sql. Drizzle meta is frozen at 0007 and db:generate is disabled (scripts/guard-generate.ts) — the in-code index/constraint declarations are documentation/parity, not generators. To know real DB integrity you MUST read the migration SQL.
- docs/modules.md is stale: titled 'Tokyo Store', uses watch/Rolex/Submariner examples and a Windows OneDrive path for its reference corpus. The RULES are current but examples/branding predate the tokyo/high-tech rebrand. Treat code as truth.
- Legacy identifiers intentionally retained: products.currency frozen at 'TND' (per-product currency removed, display currency is store-global via currency module), products.platform legacy free-text tag superseded by attributes. Do not 'clean these up' without checking.
- Denormalisation coupling: several hot read-fields must be updated in lockstep with their ledger inside one transaction (credit_balance_cents↔customer_credit_entries, cumulative_spend/paid_order_count/loyalty_level_id↔paid orders, products.rating/reviews_count↔product_reviews, stock_qty↔stock_movements/stock_levels). Editing write paths without preserving the paired update will drift balances/levels.
- Variant stock has two modes (products.shared_variant_stock) and purchase-qty caps aggregate across a product's variant lines at place-order — editing checkout/stock logic must respect both or you can oversell.
- The modular-monolith soft-FK design means orphan-prevention is application-level (no delete-user path; accounts are disabled, not deleted). Hard-deleting rows a soft link points at (e.g. a product referenced by curated product_related) relies on migration-declared CASCADE FKs that are invisible in schema.ts — verify in SQL before relying on cascade behavior.
- Sub-module isolation: catalog sub-modules must not cross-import each other's schema; shared types go in src/modules/catalog/_shared/types.ts. A careless import across sub-modules silently violates the convention.

</details>


---

## 8. Workflows — the orchestration / mutation API

Workflows are the **single, authoritative place every state mutation goes through**. Both transports that can mutate — Server Actions (`src/lib/actions/*`) and the REST API (`src/app/api/**`) — do their auth/shaping and then `await workflows.<domain>.<fn>(...)`. RSC reads never mutate, so they don't touch this layer. If the owner is changing **what the store does** (pricing math, stock rules, what gets emailed, what an order is allowed to do), the edit almost always lands here, not in the module services (which are thin data-access) or the UI.

**124 files import `@/workflows`** (the registry). The business logic is centralised: a module service like `orderService` exposes CRUD-ish primitives (`insertOrder`, `transitionStatusInTx`), and the *rules* (stock gates, tax cascade, promo revalidation, loyalty reversal) live in the workflow that composes them.

### (a) Structure

- **`src/workflows/index.ts`** (`src/workflows/index.ts:253`) builds one frozen `workflows` object: `workflows.auth.*`, `workflows.order.*`, `workflows.cart.*`, `workflows.catalog.*`, `workflows.cms.*`, `workflows.promotion.*`, etc. This is the import surface. Callers do `import { workflows } from "@/workflows"`. **Not every workflow file is in the registry** — see below.
- **`src/workflows/shared.ts`** — the spine every workflow imports:
  - `WorkflowResult<T> = WorkflowOk<T> | WorkflowFail` (`shared.ts:42`). Workflows **return** `ok(data)` / `fail(code, message, fieldErrors?)` for *expected* failures (validation, business rules) and **throw** only for genuine bugs/infra (`shared.ts:24-32`).
  - `workflow(name, fn)` (`shared.ts:66`) — a thin wrapper that try/catches the body and maps a thrown error to a structured `fail`: `uniqueViolationFail` (Postgres 23505 → friendly per-constraint conflict, `shared.ts:146`), `dbContentionFail` (23514 stock CHECK → "Stock insuffisant"; 40P01/55P03 deadlock/lock-timeout → retry, `shared.ts:168`), `foreseeableInputFail` (22P02 bad UUID, 23503 FK, 22007/22008 bad date → 400 validation, `shared.ts:197`); anything else → `fail("internal", …)` + `console.error`. It walks the drizzle-wrapped `.cause` chain up to 6 deep.
  - French zod localisation is set **process-wide** via `z.config({ customError })` at module load (`shared.ts:21`) — deliberately `customError`, not `localeError`, because Next loads several zod instances and `localeError` would be reset to English (`shared.ts:5-21`). `flattenZodError` / `zodValidationFail` / `ZOD_FR` build the `fieldErrors` map.
- **`src/workflows/helpers.ts`** — tiny; just re-exports `slugify`/`slugSchema` from the isomorphic `@/lib/slug` so server-only catalog workflows and the admin client preview share one slug algorithm (`helpers.ts:10`).
- **Per-domain folders** (28): `ai`, `appointments`, `audit`, `auth`, `authors`, `blog`, `blog_comments`, `business`, `cart`, `catalog`, `cms`, `customer`, `data`, `delivery`, `demo`, `import`, `media`, `newsletter`, `order`, `payment`, `promotion`, `rbac`, `search`, `showcase`, `tax`. `order` is by far the largest and most load-bearing (`place-order.ts` alone is 1469 lines).

**Two shapes of "workflow" live here:**
1. **Registry workflows** — wrapped with `workflow(...)`, return `WorkflowResult`, invoked by actions/REST. These are the transactional mutators.
2. **Non-registry orchestrators / jobs** (`grep -rL "export const.*Workflow"`): `data/run-data-job.ts`, `import/run-product-import.ts`, `catalog/{content-gen,product-gen,review-gen,auto-assign}/*`, `media/reprocess-product-white-bg.ts`, `demo/purge-relaunch.ts`, `data/segments.ts`, `data/sth-stock.ts`. These are **fire-and-forget background runners** called from admin actions (`src/lib/actions/{data-jobs,import,ai-assign,product-generation,review-generation,content-generation}.ts`); they are plain async functions that persist progress onto a job row (`markRunning → updateProgress → complete/fail`, `data/run-data-job.ts:36-69`) rather than returning a result. `restock.ts` and `reconcile-loyalty-promos.ts` are **shared tx-helpers** (take the caller's `tx`), not standalone workflows. `promotion/{index,manage,redeem}.ts` and `catalog/create-brand.ts` etc. define multiple workflows per file.

**Cron-driven workflows** (`order/reconcile-pending-payments.ts`, `order/sweep-abandoned-orders.ts`, `audit/purge.ts`, `search/purge-log.ts`) are in the registry but reached through a **job center**, not the HTTP route directly: `POST /api/cron/payments` → `guardCron` → `runScheduledJob("payment_reconcile", "cron")` (`src/app/api/cron/payments/route.ts:30`). The job center (`src/lib/jobs/run-job.ts`) maps a `job_key` to the workflow, adding a kill-switch + run-now dashboard parity. Many other crons exist (`abandoned-orders`, `detourage`, `dispatch`, `mailing`, `review-request`, `retention`, `promotion-announce`, `wishlist-campaign`, `birthday`, `life-event-anniversary`, `webhooks`).

### (b) The workflow pattern + the most important flows

**Canonical pattern** (seen in nearly every mutator): `safeParse` the zod schema → `fail("validation", …)` on miss → do **reads up front** (outside the tx) → `db.transaction(async (tx) => { … })` for **all writes** passing `tx` to every service call → **emit events after commit** via `bus.emit(...)`. **33 workflow files open a `db.transaction`.** A recurring, deliberate convention: *reads that hit settings/config caches are done BEFORE the tx* (e.g. `getSharedStockDefault()`, `getActiveCurrency()`) because a cold-cache read inside a held tx would grab a second pool connection and can pool-deadlock under concurrency (`place-order.ts:861-868`, `refund-order.ts:84-89`, `transition-status.ts:74-79`).

**Order placement — `order/place-order.ts` (the crown jewel, 1469 lines).** Input is a cart id + contact/shipping/delivery/promo/credit/business-tax fields (`placeOrderSchema`, `place-order.ts:85`). Context carries `actorUserId` (the customer), `operatorUserId` (staff placing on their behalf — audit actor only), `deliveryChannel`, `channel` (`storefront`/`operator`/`erp`), `source` — **these are context args, NOT schema inputs, so a crafted storefront request can't forge `channel: "erp"`** (`place-order.ts:319-338`). Sequence:
1. **Up-front reads** (all outside the tx): batched product/variant/media lookups (`place-order.ts:357`), warranty cascade snapshot (product→category chain→global, `place-order.ts:424-441`), tax config + per-product rate cascade (`place-order.ts:393-402`), early-access embargo re-check for storefront (`place-order.ts:460-470`), per-line snapshot building with stock/availability/variant guards (`place-order.ts:472-554`), purchase-qty limits aggregated **per product across sibling variants** (`place-order.ts:561`), gift-card-needs-email guard (`place-order.ts:586`), **live auto-promo re-resolution** (closes the stale-cart-price window — a flash-sale price baked into a cart line must not persist after the window closes, `place-order.ts:615-628`), subtotal/discount-base (gift cards excluded from every discount base, `place-order.ts:640-655`), store policy (min-order, require-account), **per-line TVA** (`place-order.ts:688-702`), **server-side coupon revalidation** via the shared `evaluateCouponEligibility` (`place-order.ts:746-792`), **authoritative delivery resolution** via `resolveDelivery` (client never sends a shipping fee, `place-order.ts:807-818`), member/loyalty benefit + store-credit context (`place-order.ts:824-850`), order number.
2. **The transaction** (`place-order.ts:870`): **claim the cart FIRST** — `lockForCheckout` + `clear` with RETURNING, the idempotency guard against double-submit; empty claim → `"Ce panier a déjà été commandé."`, and `sameCartLines` aborts if another tab changed the cart (`place-order.ts:881-891`). Then: compute member discount + stacking, free-shipping, order-level TVA and totals including the additive « entreprise » TVA (`place-order.ts:957-987`); `insertOrder` + `insertItems` (full snapshots: name/slug/sku/image/warranty/variant/tax frozen onto each line so later catalog edits never change historical orders, `place-order.ts:999-1088`); **atomic stock decrement** with a `stock_qty >= qty` guard and deterministic global lock order (variant-id else product-id) to avoid AB/BA deadlock; shared-stock variable products draw from the parent pool (`place-order.ts:1090-1194`); **store-credit settlement AFTER the stock loop** (lock order stock→profile matches the undo paths, `place-order.ts:1196-1227`); seed `order_status_history` with the initial `pending` row (`place-order.ts:1233`); **atomic coupon redemption** — per-user cap re-checked under a promo row lock, global cap folded into the UPDATE, redemption row logged (`place-order.ts:1259-1313`).
3. **Post-commit, best-effort**: `bus.emit("order.created")` → low-stock alerts (`product.stock_low`/`product.stock_depleted`) → `emitProductStockCacheBust` → shipping-address auto-save → `bus.emit("promotion.redeemed")` (`place-order.ts:1318-1455`). Business-rule failures bubble as a `PlaceOrderError` sentinel class (`place-order.ts:269`) mapped back to `fail(code, frenchMessage)`; anything else rethrows into `workflow()`'s internal catch (`place-order.ts:1458-1467`).

**`order/place-quick-order.ts`** stages an ephemeral `qb-<idempotencyKey>` cart for one product and delegates to `placeOrderWorkflow` — the unique `carts.token` is the replay guard (`place-quick-order.ts:34-40`).

**`order/create-from-lines.ts`** (ERP/POS order push, `POST /api/orders`) resolves + **live-prices** each line by reference (sku/gtin/externalRef/id + variant), merges duplicate lines, builds an ephemeral `erp_*` cart, runs the **same `placeOrderWorkflow`** with `{ deliveryChannel: "operator", channel: "erp" }`, disposes the cart in a `finally`, confirms the order, then settles offline (cash/bank_transfer → `paid`, cod → pending). `externalRef` written inside the placement tx so the unique index is the race backstop (`create-from-lines.ts:95-320`).

**Payment init/verify — `order/gateway-payment.ts`.** `initiatePaymentWorkflow` (`:77`): only a `pending` online order with `amountDueCents > 0`; a re-init of an order that already minted a session first runs the fail-closed safety pre-flight; rejects a localhost origin (dead return URL); creates the gateway session, persists `payment_reference`, emits `order.payment_initiated`. `confirmPaymentWorkflow` (`:216`) is **idempotent and called from both the customer return page and the webhook**: verifies against the gateway, checks the amount against `amountDueCents` (not `total_cents` — credit-settled orders), **claims via `webhookEventService.claim`** so only one confirmation transitions the order, then calls `transitionOrderStatusWorkflow(→ paid)`; **releases the claim on any failure OR throw** so a crash can't strand the order (`:271-288`). `assertPendingOnlineOrderNotCaptured` (`:330`) is the **fail-CLOSED pre-flight shared by every destructive exit** on a pending online order (customer cancel, admin dropdown, the PATCH status route, the abandoned sweep, re-init): it re-verifies and refuses the destructive action unless the gateway *definitively* reports not-captured — a transient gateway outage can never strand a real capture. `settleZeroTotalOrderWorkflow` (`:186`) settles a 0-due online order straight to `paid`. `detectLateCaptureOnCancelledOrder` (`:418`) logs a structured ERROR when a capture lands on an already-cancelled order (manual refund needed).

**Status transitions — `order/transition-status.ts`.** The authoritative state machine. Runs the fail-closed gateway pre-flight before any `pending → cancelled` (`:60-72`), then in a **row-locked tx** (`findById … forUpdate`): re-validates the transition against `orderTransitionsFor(status, paymentMethod, deliveryMethod)` (`:128`), blocks forward moves of a fully-refunded-unshipped order, requires a **full** refund ledger for `→ refunded`, blocks cancel once a shipment exists, reconciles gift cards on undo, persists payment reference, transitions, and **on cancel: restocks (unless a prior refund already restocked) + `reconcileOrderLoyaltyAndPromos`** (`:277-310`). Post-commit emits `order.status_changed`, and `order.paid` whenever `paid_at` is stamped (incl. COD settling at `delivered`), with a `settledAt` of `gateway`/`manual`/`delivery` (`:333-364`). **Circular import with gateway-payment is intentional and safe** (both deref at call time, `:17-19`).

**Refund — `order/refund-order.ts`.** Append-only, positive-only `order_refunds` rows; does **not** change status. In a locked tx: only money actually captured (`paid_at` set) is refundable; caps to `refundableCeilingCents = total − credit_applied` (credit returns to wallet, not cash); optional `destination: "credit"` routes to the store-credit wallet. When cumulative refunds reach the ceiling → **full undo**: restock the unshipped remainder (shipped units recovered via Returns), `reconcileOrderLoyaltyAndPromos`, void unredeemed gift cards (`refund-order.ts:233-286`). Emits `order.refunded` with `destination`.

**Returns (SAV) — `order/returns.ts`.** `createReturn` (two kinds: `after_sale`, `shipment`/RTO) validates each line against shipped-minus-already-returned ceilings in a locked tx; `receiveReturn` restocks restockable lines (idempotent per-line via `restocked_at`) and, for an RTO, **cancels the order in the same tx** using the low-level status setter (deliberately not the full-restock cancel path, since the return already restocked the shipped units); `rejectReturn` is a no-restock terminal flip. All guard-before-write because a returned `fail` from a managed tx **commits** (only a throw rolls back) — a recurring, explicitly-documented hazard across the order workflows (`returns.ts:384-401`, `edit-items.ts:30-44` has an `EditItemsAbort` throw class for exactly this).

**Restock mirror — `order/restock.ts`.** `restockOrderLines(tx, …)` is the exact mirror of the placement decrement (shared by cancel + full-refund), with deterministic lock order, shared-pool handling, tracked-only/non-deleted guards, and `in_stock` re-enable only on a sold-out crossing. `emitRestockEvents` fires `product.updated` (cache bust) + `product.restocked` (back-in-stock waitlist) post-commit.

**Catalog create/update — `catalog/create-product.ts`.** Representative of the catalog pattern: validate up front (purchase-qty window, GTIN format, variable-can't-publish, attribute refs, slug availability via `checkSlugAvailability`), then **one tx** inserting the product and wiring all cross-module links through association services (`productCategoryLinks.set`, `productBrandLink.set`, `productMediaLink.set`, `attributeService.set*`, `productRelatedLinks.set`, `productTierRelease.setForProduct`) — all passed `tx` (`create-product.ts:343-430`). Post-commit emits `product.created` (+ `product.published` if live). `updateProduct` additionally emits `product.restocked`/`published`/`unpublished` on the relevant transitions; `deleteProduct` soft-deletes and emits `product.deleted`.

### (c) Event emission & what re-runs

Events are emitted **after commit** (`src/events/bus.ts`), an **in-process, async, non-blocking** bus: `bus.emit` fans out to `Promise.allSettled`, logs rejections, never propagates to the emitter (`bus.ts:52-81`). **Required steps call a service directly inside the tx; only side-effects go through the bus** (`bus.ts:5-13`). A `*` wildcard feeds the audit subscriber. Handlers are stored on `globalThis` to survive dev HMR, and registration is guarded once-per-process on `globalThis.__gz_subscribers_registered` (`src/events/subscribers/index.ts:61`, `bus.ts:28`). ~40 subscribers (`src/events/subscribers/`): emails (`send-order-receipt`, `send-order-confirmed`, `send-order-status`, `send-tier-up-email`, …), **audit** (`audit-everything` + `audit-trail`), **outbound webhooks** (`dispatch-webhooks`), **cache invalidation** (`invalidate-catalog-cache`, `-cms-`, `-media-`, `-blog-`, `-attribute-`, `-promotion-`), **loyalty** (`accrue-loyalty`, `grant-engagement-credit`), gift-card issuance (`issue-gift-cards` on `order.paid`), BL on ship, depot decrement, re-embedding for semantic search, back-in-stock/low-stock notifications. Event names + payloads are typed in `src/events/types.ts` (the contract). Order workflows emit `order.created`, `order.paid`, `order.status_changed`, `order.confirmed`, `order.refunded`, `order.return.{created,received,rejected}`, `order.payment_initiated`, `promotion.redeemed`, `product.{stock_low,stock_depleted,restocked}`; catalog/cms/blog/etc. each emit their own `<entity>.{created,updated,deleted}`.

### (d) Idempotency / transaction / error-mapping conventions (load-bearing invariants)

- **Idempotency**: cart-claim on placement (`lockForCheckout` + delete-with-RETURNING); `qb-<key>` / `erp_*` unique cart tokens; `webhook_events.claim` on payment confirm; per-line `restocked_at` on returns; `loyalty_accrued_at` stamp gating loyalty reversal (`reconcile-loyalty-promos.ts:20-26`); `confirmOrder` no-ops when `confirmed_at` set.
- **Transactions**: all writes in one `db.transaction`; `forUpdate` row locks on the order/profile for serialisation; **deterministic global id lock order** on stock rows; config/cache reads hoisted **before** the tx to avoid pool deadlock; a returned `fail` inside a managed tx **commits** — guards that must block a write therefore run *before* the first write, or throw a sentinel (`PlaceOrderError`, `EditItemsAbort`) to force rollback.
- **Error mapping**: expected → `fail(code, frenchMessage, fieldErrors?)`; bugs/infra → throw → `workflow()` maps PG 23505/23514/40P01/55P03/22P02/23503/22007/22008 to clean 4xx-ish fails, else `fail("internal")`. REST serialises via `workflowResponse(result)` (`src/lib/api-auth/respond.ts`); actions map to `ActionState { ok, error, message }`. **The contract has no OpenAPI — the test suite under `src/lib/db/tests/*.test.ts` is the spec** (e.g. `checkout-correctness`, `workflow-error-mapping`, `reconcile-loyalty-promos`, `invoice-tax`), and many tests import workflow files directly.


<details>
<summary><strong>8. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- src/workflows/index.ts — the `workflows` registry (import surface)
- src/workflows/shared.ts — ok/fail, workflow() wrapper, PG error mapping, zod-fr
- src/workflows/helpers.ts — slug re-export only
- src/workflows/order/place-order.ts — the core placement flow (1469 lines)
- src/workflows/order/gateway-payment.ts — init/verify, fail-closed capture pre-flight
- src/workflows/order/transition-status.ts — authoritative order state machine
- src/workflows/order/refund-order.ts — append-only refunds + full-undo
- src/workflows/order/returns.ts — SAV returns + RTO cancel
- src/workflows/order/restock.ts — shared restock mirror (tx helper)
- src/workflows/order/reconcile-loyalty-promos.ts — shared undo of loyalty/promo/credit
- src/workflows/order/create-from-lines.ts — ERP/POS order push via placeOrder
- src/workflows/order/{reconcile-pending-payments,sweep-abandoned-orders}.ts — cron backstops
- src/workflows/cart/add-to-cart.ts — add/setQty/remove with IDOR + stock guards
- src/workflows/catalog/create-product.ts — catalog create/update/delete pattern (1037 lines)
- src/workflows/promotion/{index,manage,redeem}.ts — promotion CRUD + evaluate
- src/workflows/data/run-data-job.ts — fire-and-forget background job runner
- src/events/bus.ts — in-process async event bus
- src/events/subscribers/index.ts — subscriber registration (~40 subscribers)
- src/events/types.ts — typed event names/payloads (the event contract)

**Models / tables**

- orders (status, payment_method/reference, paid_at/confirmed_at, subtotal/shipping/discount/tax/total/credit_applied _cents, business_tax_*, delivery_*, channel/source, external_ref)
- order_items (full product/variant/warranty/tax snapshots frozen at placement)
- order_status_history (status ledger, seeded with initial 'pending' row)
- order_refunds (append-only positive-only refund ledger)
- order_returns + order_return_items (SAV/RTO returns, restocked_at per line)
- carts + cart_items (ephemeral qb-*/erp_* carts for quick-buy & ERP push)
- products + product_variants (stock_qty/in_stock decremented/restocked here; shared_variant_stock pool mode)
- promotions + promotion redemptions (uses_count, per-user cap, free_shipping/shipping_waived rows)
- customer_profiles (credit_balance_cents, loyalty_spend_cents, paid_order_count, niveau)
- credit ledger entries (spend / spend_reverse / refund kinds)
- gift cards (minted on order.paid, voided on full undo)
- webhook_events (payment confirmation idempotency claims)
- stock_movements (append-only inventory ledger: order/cancellation/refund/return reasons)

**Sources of truth**

- src/workflows/index.ts — the authoritative list of registered mutations (workflows.<domain>.<fn>)
- src/workflows/shared.ts:94 UNIQUE_VIOLATION_MESSAGES — PG constraint → user message map
- The workflow body itself is the source of truth for each mutation's rules (stock/tax/promo/loyalty); module services are thin data access
- src/events/types.ts — the event name + payload contract consumed by every subscriber and outbound webhook
- src/lib/db/tests/*.test.ts — the de-facto spec (no OpenAPI); checkout-correctness, workflow-error-mapping, reconcile-loyalty-promos, invoice-tax, etc.
- order_status_history + order_refunds + order_returns tables are the ledgers downstream workflows key on (not the order status column alone)
- webhook_events table (webhookEventService.claim/release) — payment-confirmation idempotency

**Editable / removable**

- EDIT HERE for backend behavior: pricing/discount math, stock gates, tax cascade, delivery resolution, loyalty/credit rules all live in the workflow bodies — editing a module service is usually the wrong layer.
- To add a mutation: create src/workflows/<domain>/<fn>.ts wrapped in workflow(), then register it in index.ts; callers reach it via workflows.<domain>.<fn>.
- Safe/localised edits: fail() message strings and fieldErrors keys, the ORDER_FIELD_LABELS/ORDER_FIELD_MAX caps, UNIQUE_VIOLATION_MESSAGES entries, the order-number prefix default ('TK', place-order.ts:243).
- Removable with care: whole domain folders whose feature is being cut (e.g. appointments, blog_comments, authors, demo, showcase) — but first grep src/lib/actions + src/app/api for callers AND remove the registry entry in index.ts, or the build breaks.
- LOAD-BEARING, do not casually reorder: the cart-claim-first ordering, the stock→profile lock order, 'reads before the tx' hoisting, guard-before-write (a returned fail commits the tx), the webhook claim/release on payment confirm, and the fail-closed assertPendingOnlineOrderNotCaptured pre-flight. Changing any of these can cause oversell, double-refund, or kept-money-no-order.
- Legacy identifiers are intentional: cookies gz.session_token/gz.cart_token, gz_ ids, globalThis.__gz_* bus guards — do not 'rebrand' these.
- Non-registry runners (data/*, import/*, catalog/{content,product,review}-gen/*, auto-assign/*) are detached jobs invoked from admin actions; they persist to a job row, not a WorkflowResult — don't wrap them in workflow() expecting a return value.

**Gaps / risks**

- A returned `fail` from inside db.transaction COMMITS the transaction (drizzle only rolls back on throw). Every order workflow works around this by guarding before the first write or throwing a sentinel (PlaceOrderError, EditItemsAbort). Any new in-tx guard that `return fail(...)`s AFTER a write will silently persist a half-mutation — the single biggest footgun in this layer.
- Cross-module integrity is by convention only: there are NO cross-module FKs, so a workflow that forgets to go through an association service can orphan links; FK 23503s from catalog refs are mapped to a 400 rather than prevented.
- place-order.ts is 1469 lines and holds pricing, tax, promo, loyalty, credit, delivery and stock logic in one function — high blast radius; changes need the checkout-correctness + invoice-tax tests re-run.
- Money is integer MILLIMES in *_cents columns; never divide by 100. Discount-base excludes gift cards (bearer value sold at face) — easy to break into a 'money printer' if a new discount path forgets the giftCardSubtotal exclusion (place-order.ts:634-655).
- The multi-tab older-session paid-capture case is explicitly NOT handled (gateway-payment.ts:324-328) — assertPendingOnlineOrderNotCaptured only verifies the CURRENT payment_reference; needs an attempt-history table.
- Known return limitation (returns.ts:138-145): a partially-BL'd order marked delivered leaves line B recoverable only via full refund, not per-line return — do not 'fix' by falling back to ordered qty (would double-restock).
- The event bus is in-process + best-effort: a subscriber failure is logged, never retried, and lost on process death. Emails/webhooks/cache busts after commit can silently not happen. The bus.ts comment says it 'graduates to pg-boss when we need persistence' — not yet done.
- Cron workflows are reached indirectly via runScheduledJob(job_key) (src/lib/jobs/run-job.ts) — the mapping from job_key to workflow lives there, not in the cron route, so grepping the route for the workflow name finds nothing.
- Env-tuned constants (ABANDONED_ORDER_HOURS=48, PAYMENT_RECONCILE_STALE_MINUTES=20 / MAX_AGE_HOURS=24) govern the stock-reservation backstop timing; mis-set they either strand stock or cancel live payments — posIntEnv guards only the abandoned-hours one.

</details>


---

## 9. Event Bus & Subscribers (src/events/**)

The event system is the project's **decoupling layer**: workflows/actions/REST mutate state, then `bus.emit()` a typed event, and ~40 independently-registered subscribers turn that one emit into side effects (emails, audit rows, cache busts, outbound webhooks, loyalty accrual, store credit, gift cards, search re-embedding, stock transfers, media cleanup). Editing or removing a feature anywhere in the app can silently drop or orphan these side effects, because the producer never names the consumer. This section maps the full chain.

### (a) How the bus works

Single file: `src/events/bus.ts` (93 lines). It is an **in-process, in-memory pub/sub** — no queue, no persistence, no cross-process fan-out.

- **Registry**: a `Map<EventName | "*", AnyHandler[]>` pinned to `globalThis.__gz_event_handlers` so it **survives dev HMR** (`bus.ts:21-28`). `bus.on(name, handler)` subscribes to one event; `bus.onAny(handler)` subscribes to `"*"` (every event) — used only by the telemetry/audit/webhook wildcard listeners.
- **Emit** (`bus.ts:52-81`): builds an `EventEnvelope` (`name`, `payload`, `occurredAt: new Date()`, `actorUserId`, `actorIp` from the `meta` arg), gathers `registry.get(name) ∪ registry.get("*")`, and runs them with **`Promise.allSettled`** (`bus.ts:72`). Every handler is wrapped in `Promise.resolve().then(() => h(env))` so a synchronous throw is also caught. Rejections are logged (`console.error("[events] subscriber for "${name}" rejected")`, `bus.ts:78`) and **never propagate to the emitter**. `emit` returns `void` by contract — callers must not depend on side-effect results.
- **Sync vs async / blocking**: `bus.emit` is `async` and **awaits all handlers** (allSettled resolves once every handler settles). So a slow subscriber *does* delay the emit's `await`. Heavy subscribers work around this by **detaching** internally (`void doWork().catch(...)`) — see `reembed-product.ts`, `detourage-main-image.ts`, `auto-transfer.ts`, `send-promotion-announcement.ts`. These explicitly cite the "STUCK-BUTTON RULE" because the admin/checkout request awaits the emit.
- **Transactional semantics**: the bus itself knows nothing about transactions. By **convention** emitters call `bus.emit` **after the DB transaction commits** — verified in `src/workflows/order/place-order.ts`: the `db.transaction(...)` returns at `place-order.ts:1316`, and the `order.created` / `product.stock_*` emits run at `place-order.ts:1318-1355`, outside and after it. Many subscriber comments assert "the bus emits AFTER commit" (e.g. `send-order-receipt.ts:22-24`, `issue-bl-on-ship.ts`). There is **no outbox / after-commit hook** enforcing this — it is a discipline, and a pre-commit emit on a rolled-back tx would fire side effects for a non-existent row (the low-stock comment at `place-order.ts:1324-1329` calls this out).
- **Durability**: none. A crash mid-fan-out loses the not-yet-run tail. The `order.status_changed → delivered` path and `order.paid` both re-drive loyalty accrual and gift-card issuance as a safety net (idempotent). The header comment (`bus.ts:11-16`) states the intended graduation path is **pg-boss** when persistence/retries/multi-process are needed — "a single-file change in this module."
- **Re-entrancy**: subscribers may emit further events, creating chains handled by the same bus: `issue-bl-on-ship.ts` emits `order.delivery_note_issued`; `sync-marketing-optin.ts` emits `newsletter.subscribed`/`newsletter.unsubscribed`; `sync-newsletter-to-profile.ts` emits `customer.profile_updated`. Loop-safety is documented per-file (the two marketing-sync subscribers are deliberately one-directional so they can't ping-pong).
- **`bus.__reset()`** (`bus.ts:84-90`) is a **test-only** helper that clears the registry AND resets `globalThis.__gz_subscribers_registered` (otherwise a re-register after reset early-returns to zero handlers).

### Typing & the severity model

- **`src/events/types.ts`** (951 lines) is the single source of truth: `EventMap` (`types.ts:26`) declares every event name → payload shape; `EventName = keyof EventMap` (`types.ts:942`); `EventEnvelope<T>` (`types.ts:945`). Adding an event = add a key here. Hard rule in the header (`types.ts:8-10`): **NEVER put secrets (passwords, tokens, raw card data) in payloads** — subscribers serialize them into audit logs / external webhooks. Passwords/emails are kept out or masked at the emit site (e.g. `user.sign_in_failed` carries `emailMasked`, `user.email_changed` carries masked addresses).
- **`src/events/severity.ts`** (200 lines, **PURE** — no `server-only`/DB, so unit-tested and importable anywhere). `severityFor(name, payload?)` (`severity.ts:167`) resolves `"debug" | "info" | "warn" | "error"` by: (0) payload-aware — a `setting.upserted` for an `isSensitiveSettingKey` → `warn`; (1) `EXPLICIT_SEVERITY` per-event override map (`severity.ts:64-139`, the security/money/fraud allowlist); (2) `isLowSignal` prefixes (`attribute_value.*`, `nav.item.*`, `page.section.changed`, `faq.updated`, `product.price_changed`, `product.restocked`) → `debug` (`severity.ts:44-57`); (3) `*.deleted` → `warn`; (4) `DOMAIN_DEFAULT` (`rbac/api/api_key/payment` → `warn`, `webhook` → `error`, `severity.ts:145-151`); (5) `info`. Severity drives three things: the structured-logger console floor, whether `audit.persist_low_signal=false` drops a debug row, and the `severity` column + audit-UI filter. `shouldLog(floor, severity)` and `passesSample(rate, rnd)` are the pure gates (`severity.ts:185-200`).

### Boot / registration

`src/events/subscribers/index.ts` → `registerAllSubscribers()` (`index.ts:61-118`). Guarded by `globalThis.__gz_subscribers_registered` (NOT a module-local boolean — a module-local guard resets on HMR and would re-append handlers, firing each event N+1 times; `index.ts:40-55`). Called from `src/instrumentation.ts:73-74` (Next.js boot hook, Node runtime only, Edge skipped). The file also self-invokes `registerAllSubscribers()` at module-eval (`index.ts:120`), and `src/lib/auth/*` imports `@/events/subscribers` as a side effect — the instrumentation call just guarantees listeners exist before the first request. **Registration order** (`index.ts:65-113`): the 4 telemetry/wildcard listeners register FIRST (structured-logger, metrics-counter, audit-everything, audit-trail) so the log line is first in any trace; order otherwise only affects the allSettled array order (all run concurrently, one failure can't starve another — `index.ts:51-55`).

### (b) Event families in `types.ts` (52 domains / 227 events)

Count is authoritative in the generated `src/lib/api-auth/event-catalog.ts` (header: "Total events: 227 across 52 domains"), regenerated by `scripts/gen-event-catalog.mjs` and completeness-checked by `src/lib/db/tests/event-catalog.test.ts`. Domains: **auth/user** (`user.*`, `auth.*` — created, verified, password/2FA, sign-in failures, rate-limits, role/permission changes), **business** (B2B accounts, applications, join requests, employee levels, allocations, promo opt-out), **rbac** (roles, `permission_denied`, grants), **customer/address**, **media** (uploaded/updated/deleted/bulk/settings), **catalog** (`brand/category/collection/product.*` incl. `price_changed`, `restocked`, `stock_low`, `stock_depleted`, published/unpublished), **stock.transfer** (requested/completed/cancelled, carry ERP-resolvable `sku`/`externalRef` line keys — `TransferEventItem`, `types.ts:18`), **attribute / attribute_value / category.filter_attributes**, **orders** (created/paid/confirmed/status_changed/refunded/payment_reference/linked/edited/shipment) + **returns** + **warranty** + **fiscal** (invoice/credit_note/delivery_note), **blog / author / blog comments**, **appointment**, **newsletter** (subscribed/unsubscribed), **CMS** (banner/faq/`setting.upserted`/page/`page.section.changed`/nav), **audit.purged / search_log.purged / data.exported / favorites.moderated**, **promotion** (CRUD + activated/redeemed/announce_requested), **loyalty** (`tier_changed`, `level.*`) + **customer.loyalty_mode_changed**, **payment gateway** (`order.payment_initiated`, `webhook.payment.unmatched/amount_mismatch`), **tax / delivery / stock_location / currency / payment.provider / ai**, **search_alias**, **catalog.review(+_gen)**, **import**, **redirect**, **job**, **api / api_key / webhook_endpoint**, **showcase / cms.trust_badge / segment / mailing**, **demo** (imported/cleared/purged), **perf.alert.raised/recovered**.

### (c) Every subscriber → events → side effect

**Telemetry / wildcard (4, `onAny`):**
- `structured-logger.ts` → ALL → one JSON line per event to `console.log`, gated by `audit.log_level` floor × payload-aware `severityFor` × debug sampling (`decideLogLine`), payload `redact()`-ed. Fully try/catch.
- `metrics-counter.ts` → ALL → `increment(env.name)` into a process-local in-memory store exposed at `/api/admin/metrics`. Resets on restart.
- `audit-everything.ts` → ALL **except the curated allowlist** → one `audit_log` row via `auditService.record`, using the pure shapers in `audit-target.ts` (`targetTypeForEvent`, `targetIdForPayload` via `TARGET_ID_KEYS` priority list, `summarizeEvent`). Gated on `audit.enabled`; drops `debug`-severity rows when `audit.persist_low_signal=false`. Payload `redactForStorage()`-ed. Skips `CURATED = AUDIT_TRAIL_EVENTS` to avoid a duplicate row (no DB unique constraint to dedupe — `audit-everything.ts:36-42`).
- `audit-trail.ts` (490 lines) → a **curated `HINTS` allowlist** (`audit-trail.ts:70-440`) of ~60 high-signal events → a richer `audit_log` row with a human summary + best-fit `target_type`/`target_id`. Ignores `persist_low_signal` (always high-signal). **Exception** (`audit-trail.ts:454-461`): even with `audit.enabled=false` it still records `setting.upserted` for `audit.*`/`debug.*` keys so disabling auditing is itself audited. Exports `AUDIT_TRAIL_EVENTS` (consumed by audit-everything to compute its skip set).

**Outbound webhooks (1, `onAny`):** `dispatch-webhooks.ts` → ALL → for each active endpoint subscribed by exact name or `["*"]`, **enqueues a durable `webhook_deliveries` row** per (event × endpoint) via `webhookEndpointService.enqueue` (a cron drain owns the signed POST + retry). Gated on `webhooks.outbound_enabled`; active endpoints cached 5s (`ENDPOINT_CACHE_MS`). **Data-minimisation**: a `"*"` subscription does NOT receive `SECURITY_DOMAINS = {auth, rbac, api_key, user, data}` (`dispatch-webhooks.ts:26`, `isSecuritySensitiveEvent`) — those PII/security events must be subscribed by exact name.

**Cache / tag invalidation (6):** all use `bustCacheTag` from `@/lib/cache/revalidate` with the shared `@/lib/cache/tags` vocabulary.
- `invalidate-catalog-cache.ts` → `product/category/brand/collection.*`, `catalog.review.*`, `catalog.review_gen.applied`, and bulk `import.products_completed`/`demo.imported`/`demo.cleared`/`demo.purged` (→ `bustStorefrontCache()`).
- `invalidate-cms-cache.ts` → `banner/setting/faq/nav/page.*` (+ `page.section.changed` does an on-demand `pageService.findById` → slug bust). NOTE (`invalidate-cms-cache.ts:15-18`): only the `site:settings` tag has a live reader today; banner/FAQ/nav/page tags are **reserved forward-wiring no-ops** (storefront CMS freshness currently comes from writers' `revalidatePath`).
- `invalidate-media-cache.ts` → `media.updated/settings_updated/deleted/bulk_deleted` → broad bust of productsList/categories/brands/collections/pages/blogPosts.
- `invalidate-blog-cache.ts` → `blog.post/category/tag.*`.
- `invalidate-attribute-cache.ts` → `attribute.*`, `attribute_value.*`, `category.filter_attributes.updated` → busts categories+products+attributes.
- `invalidate-promotion-cache.ts` → `promotion.created/updated/deleted/activated/deactivated` → `revalidatePath("/", "layout")` (no promo read is cached, so no tag to bust).

**Customer/transactional emails (10):** all route through `@/modules/mailing` `dispatchEmail` (best-effort, never throws) + a per-flow toggle `isFlowEnabled(...)`; most are idempotent via `mailingSendsService.claimOnce(flow, key)` (released on non-delivery so a later legit send isn't burned).
- `send-welcome-email.ts` → `user.created` → `welcome`.
- `send-employee-welcome.ts` → `business.members_changed` (only `change="added"`) → `employee_welcome`.
- `send-welcome-coupon.ts` → `newsletter.subscribed` (skips `reactivated` and `source="account"`) → looks up live promo by `newsletter.welcome_code` setting (fallback `WELCOME10`) → `newsletter_coupon`.
- `send-order-receipt.ts` → `order.created` → `order_confirmation` receipt (builds line-items/TVA/credit HTML; "en attente de paiement" for online).
- `send-order-status.ts` → `order.status_changed` → `order_paid/preparing/shipped/delivered/cancelled` (idempotent per order×status).
- `send-order-confirmed.ts` → `order.confirmed` → `order_confirmed` (COD acceptance; idempotent per order).
- `send-appointment-emails.ts` → `appointment.booked` → `appointment_requested`; `appointment.status_changed` → confirmed/declined/cancelled templates.
- `send-tier-up-email.ts` → `loyalty.tier_changed` (only `direction="up"` with a `toLevelId`) → `loyalty_tier_up`.
- `notify-price-drop.ts` → `product.price_changed` (drops only) → emails opted-in wishlist watchers (`wishlist_price_drop`); joins `wishlist_items → wishlists → users → customer_user_links → customer_profiles`.
- `notify-back-in-stock.ts` → `product.restocked` → `back_in_stock` to opted-in wishlist watchers (idempotent per product×user×store-day).
- `send-promotion-announcement.ts` → `promotion.announce_requested` (DETACHED) → re-checks promo is live, resolves marketing audience, one `promotion_announcement` per recipient. `runPromotionAnnounceBlast()` is **also called directly** by the scheduled-announce cron sweep and the manual "Annoncer maintenant" action (not only the event).

**Operator / staff emails (2, not consent-gated):** `notify-low-stock.ts` → `product.stock_depleted` / `product.stock_low` → emails `stock.alert_recipients` (fallback: active admins); `notify-transfer.ts` → `stock.transfer.requested` (only `source="auto"`) → ops email. (A third, `src/lib/telemetry/perf-alert.ts`, is NOT in `subscribers/` and is not a bus subscriber — it is a producer-side helper that both emits `perf.alert.raised/recovered` AND emails admins; the wildcard audit subscriber persists those events.)

**Loyalty / credit / gift cards (3):**
- `accrue-loyalty.ts` → `order.paid` + `order.status_changed→delivered` → `accrueSpendForOrder` (loyalty niveau spend; idempotent via `orders.loyalty_accrued_at`).
- `grant-engagement-credit.ts` → `newsletter.subscribed` (owner-actor gated, actor email must equal subscribed email) + `customer.profile_updated` (owner completing own profile) → `grantEngagementCredit` store credit (newsletter_subscribe / provide_gender / complete_profile) + Cercle referral grants.
- `issue-gift-cards.ts` → `order.paid` + `order.status_changed→delivered` → `issueGiftCardsForOrder` (mint, idempotent via advisory lock) + `sendGiftCardDeliveryEmail` (gated on `gift_card_delivery` flow; cards still minted if the flow is off).

**Data sync (3):**
- `sync-marketing-optin.ts` → `customer.profile_updated` (when `marketing_opt_in` in changedFields) → mirror into `newsletter_subscriptions`, re-emits `newsletter.subscribed`/`unsubscribed` with `source:"account"`.
- `sync-newsletter-to-profile.ts` → `newsletter.subscribed` (owner or staff `newsletter:manage` override; skips `source="account"`) → flips `customer_profiles.marketing_opt_in` back on, re-emits `customer.profile_updated`.
- `sync-user-name-from-profile.ts` → `customer.profile_updated` (first/last name) → one-way mirror into `users.name` (`authService.update`).

**Media pipeline (2):** `cleanup-media-storage.ts` → `media.deleted` / `media.bulk_deleted` → `deleteObject` on each variant key (keys referenced by order-line snapshots are pinned/kept); `detourage-main-image.ts` → `product.created`/`product.updated` (DETACHED, only when gallery `media` changed + white-bg-main-only settings on) → background détourage of the main image.

**Search (1):** `reembed-product.ts` → `product.created/updated`, `brand/category.updated+deleted`, `attribute.*`, `attribute_value.*`, `import.products_completed` → re-embed or mark products needing embedding (DETACHED). The embedded-field vocabulary + `changedFieldsAffectEmbedding` live in pure sibling `reembed-fields.ts` (must stay in sync with `embed-input.ts` — enforced by a test).

**Stock transfers (3):** `auto-transfer.ts` registers TWO — `registerAutoTransferSubscriber` (`order.created`, DETACHED → `autoRequestTransfersForOrder`) and `registerOrderCancelTransferSubscriber` (`order.status_changed→cancelled` → cancel linked non-terminal transfers). `ship-depot-decrement.ts` → `order.shipment_created` / `order.status_changed→shipped` → per-location depot `stock_levels` decrement (per_location mode only). `issue-bl-on-ship.ts` → `order.status_changed→shipped` → `ensureOrderDeliveryNoteNumber` then **re-emits `order.delivery_note_issued`**.

### (d) Ordering, failure semantics, coupling

- **Ordering**: no guarantees beyond "telemetry wildcard listeners registered first." All handlers for an event start in registration order but are awaited together via `allSettled` — effectively concurrent. Do not rely on one subscriber running before another (e.g. audit vs webhook vs cache).
- **Failure isolation**: a subscriber throw/reject is caught by the bus and logged, never surfaced to the emitter. Every subscriber additionally wraps its body in try/catch and/or uses `.catch()` — "never break the emitter / the write already committed" is the universal contract. Consequence: **side effects fail silently** (a down mail provider, a cache-bust from a detached runner where `revalidateTag` has no live request, a half-finished promo blast after a restart) — they are logged, not retried (except the loyalty/gift-card `delivered` safety-net re-drive).
- **Coupling this creates**: the bus is where otherwise-independent modules touch. `order.*` events reach mailing, loyalty, gift-card, stock-transfer, stock-location, fiscal-document, audit, and webhook code. `product.*` reach catalog cache, search embeddings, détourage, price-drop/back-in-stock mail, low-stock alerts, audit, webhooks. `customer.profile_updated` reaches THREE subscribers (marketing sync, name sync, engagement credit) plus audit. This is exactly why removing/editing a feature is risky: deleting an emit silently removes an audit trail, a cache bust, an email, AND an outbound-webhook delivery at once; adding a new mutation path that forgets to emit silently loses all of them.


<details>
<summary><strong>9. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- src/events/bus.ts — in-process pub/sub, allSettled fan-out (93 lines)
- src/events/types.ts — EventMap single source of truth (951 lines, 227 events)
- src/events/severity.ts — PURE severity model, severityFor() (200 lines)
- src/events/subscribers/index.ts — registerAllSubscribers, boot order + HMR guard
- src/events/subscribers/audit-trail.ts — curated high-signal audit allowlist (490 lines)
- src/events/subscribers/audit-everything.ts — wildcard long-tail audit writer
- src/events/subscribers/audit-target.ts — PURE audit row shapers (TARGET_ID_KEYS)
- src/events/subscribers/dispatch-webhooks.ts — outbound webhook enqueue + security-domain gate
- src/events/subscribers/structured-logger.ts & metrics-counter.ts — wildcard telemetry
- src/events/subscribers/invalidate-*-cache.ts — 6 cache-tag invalidators
- src/events/subscribers/send-*/notify-* .ts — 12 email subscribers via @/modules/mailing
- src/events/subscribers/accrue-loyalty.ts, grant-engagement-credit.ts, issue-gift-cards.ts — money/credit side effects
- src/events/subscribers/reembed-product.ts & reembed-fields.ts — search embedding freshness
- src/events/subscribers/auto-transfer.ts, ship-depot-decrement.ts, notify-transfer.ts, issue-bl-on-ship.ts — stock-transfer reactions
- src/instrumentation.ts:73 — where registerAllSubscribers() is called at boot
- src/lib/api-auth/event-catalog.ts — GENERATED runtime list of all 227 events

**Models / tables**

- audit_log (modules/audit) — written by audit-everything.ts + audit-trail.ts (event_name, actor_user_id, actor_ip, target_type, target_id, summary, severity, metadata)
- webhook_deliveries + webhook_endpoints (modules/webhook-endpoints) — dispatch-webhooks.ts enqueues rows; cron drains
- mailing_sends (modules/mailing) — idempotency ledger for claimOnce/release across email subscribers
- newsletter_subscriptions (modules/newsletter) — written by sync-marketing-optin.ts
- customer_profiles.marketing_opt_in / users.name (modules/customer, modules/auth) — synced by the two sync-* subscribers
- orders.loyalty_accrued_at + loyalty spend/tier tables (modules/loyalty) — accrue-loyalty.ts idempotency + loyalty.tier_changed
- store-credit ledger (lib/credit) — grant-engagement-credit.ts
- gift_cards (modules/gift-card) — issue-gift-cards.ts (mint + sent_at)
- stock_levels / stock_transfers (modules/stock-location, modules/stock-transfer) — ship-depot-decrement.ts + auto-transfer.ts
- product embeddings/fingerprint (modules/search) — reembed-product.ts
- in-memory: globalThis.__gz_event_handlers (bus registry), metrics-store Map (metrics-counter.ts)

**Sources of truth**

- src/events/types.ts EventMap — authoritative event names + payload shapes (compile-time type only)
- src/lib/api-auth/event-catalog.ts — the GENERATED runtime list of events (227/52 domains); regenerate via scripts/gen-event-catalog.mjs, checked by src/lib/db/tests/event-catalog.test.ts
- src/events/severity.ts EXPLICIT_SEVERITY + DOMAIN_DEFAULT + isLowSignal — authoritative severity rules
- src/events/subscribers/index.ts registerAllSubscribers() — authoritative registered-subscriber set + order
- src/events/subscribers/audit-trail.ts HINTS / AUDIT_TRAIL_EVENTS — authoritative curated-audit allowlist (and audit-everything's skip set)
- src/events/subscribers/dispatch-webhooks.ts SECURITY_DOMAINS — authoritative wildcard-webhook exclusion set
- globalThis.__gz_event_handlers (handler registry) + globalThis.__gz_subscribers_registered (one-shot guard) — runtime state
- Admin runtime config (audit.enabled, audit.persist_low_signal, audit.log_level, webhooks.outbound_enabled, per-flow mailing toggles) gates most subscribers, read via @/lib/audit/runtime-config + @/modules/mailing isFlowEnabled

**Editable / removable**

- bus.ts is small and load-bearing — DO NOT change emit() to fire-and-forget or stop awaiting handlers without auditing every DETACHED subscriber; the allSettled await is relied on by idempotency safety-nets (loyalty/gift-card re-drive) and by subscribers that re-emit.
- Removing an event emit is high-risk: one emit typically feeds audit (trail+everything), structured log, metrics, outbound webhooks, AND a domain reaction. Grep both the emit site and bus.on('<name>') before deleting.
- To remove a feature's side effect, delete/guard the specific subscriber file AND remove its register call in index.ts — removing only the file breaks the import in index.ts (build error).
- Safe to edit in isolation: email copy/templates (via @/modules/mailing), the cache-tag lists in invalidate-*-cache.ts, severity mappings in severity.ts (changing a mapping does NOT rewrite already-stored audit rows — append-only).
- audit-target.ts and reembed-fields.ts are PURE helper modules (no server-only), imported by registered subscribers AND by lib code — they are NOT themselves registered, so do not add them to index.ts.
- Adding a new event: add the key to types.ts EventMap, regenerate event-catalog.ts (scripts/gen-event-catalog.mjs), and add a severity override only if non-default; otherwise it inherits domain/info.
- Cache busts from a DETACHED/background runner are best-effort (no live request scope for revalidateTag) — don't rely on them for correctness; the storefront self-heals within cacheLife.
- The structured-logger, metrics-counter, audit, and dispatch-webhooks wildcard listeners see EVERY event — a new event is automatically logged/audited/metered/deliverable with no extra wiring (this is intended).

**Gaps / risks**

- No persistence/retry/outbox: a crash mid-fan-out drops the not-yet-run tail; only loyalty accrual + gift-card issuance have an explicit re-drive safety net. Durability upgrade path is pg-boss (noted in bus.ts:11-16) but not implemented.
- 'Emit after commit' is a convention, not enforced. A future emitter that fires inside a transaction (or before commit) would trigger real side effects (emails, webhooks, credit) for a row that may roll back. No lint/guard catches this.
- bus.emit AWAITS all subscribers, so any subscriber that forgets to detach heavy work will block the emitting request (checkout/admin save). The mitigation is per-file discipline (void...catch) — easy to get wrong when adding a subscriber.
- Cache invalidation in invalidate-cms-cache.ts is largely forward-wiring: only site:settings has a live cached reader; banner/FAQ/nav/page tag busts are no-ops today (comment at invalidate-cms-cache.ts:15-18). Storefront CMS freshness actually relies on writers' revalidatePath, so removing those writers' revalidation would NOT be covered by the event busts.
- Dedup relies on an in-memory/DB mailing_sends ledger and on best-effort claim/release; a crash between claim and send can burn a key (suppressing a legit email) — the release-on-failure paths mitigate but don't eliminate this.
- metrics-counter and the structured logger are process-local and reset on restart — not a source of truth (explicitly stated); don't build reporting on /api/admin/metrics.
- The warranty.claim.* events note (types.ts:404-407) says the ERP pushWarranty toggle does NOT yet gate webhook delivery (Phase-2 posture) — control is only via endpoint subscribe/unsubscribe. Potential surprise for integrators.
- perf-alert.ts (src/lib/telemetry) looks subscriber-adjacent but is a PRODUCER helper, not registered in subscribers/index.ts — easy to overlook when auditing where perf.alert.* side effects live.
- severity.ts and types.ts can drift from the generated event-catalog.ts if someone adds an event without regenerating; the event-catalog.test.ts guards completeness but only runs in the test suite (the true contract per project convention).

</details>


---

## 10. Database, Schema, Migrations & Money/ID Conventions

The persistence layer lives under `src/lib/db/**`. Postgres 16 (+ `pgvector`) via Drizzle ORM 0.45 on the `pg` (node-postgres) driver. The schema source of truth is the **per-module `schema.ts` files**, assembled into one Drizzle graph by a barrel; the SQL migration chain is **hand-authored and the drizzle meta-snapshots are frozen at 0007**, so `db:generate`/`db:push` are deliberately disabled.

### (a) Drizzle config, DB client/pool, PgBouncer, pgvector

**`drizzle.config.ts`** (`drizzle.config.ts:24-44`): `schema: "./src/lib/db/schema.ts"` (the single barrel — confirmed, no second barrel), `out: "./src/lib/db/migrations"`, `dialect: "postgresql"`, `casing: "snake_case"`, `strict: true`. Reads `DATABASE_URL` directly (not through the Zod env validator) so generate can run with a minimal env; dev fallback URL is `postgresql://tokyo:tokyo_dev_pwd@localhost:5434/tokyo` (note: **stale legacy `tokyo` creds** here, vs. the `tokyo`/`tokyo_dev_pwd` used by `script-client.ts` and docker-compose). A `tablesFilter: ["*", "!app_secrets", "!rate_limit_buckets", "!tmp_*"]` is defense-in-depth so even a raw `drizzle-kit push` can't DROP the raw-SQL tables that live outside the barrel (`drizzle.config.ts:38`).

**Runtime client — `src/lib/db/client.ts`** (`import "server-only"`): one `pg.Pool` per Node process, cached on `globalThis.__gz_pool` to survive HMR (`client.ts:144-148`; note the legacy `gz_` prefix, kept on purpose). `drizzle({ client: pool, schema, casing: "snake_case" })` exports **`db`** (`client.ts:150`). Pool sizing/timeouts come from `posIntEnv()` so a blank Coolify env can't zero a safety bound: `POOL_MAX` prod 12 / dev 5, `STATEMENT_TIMEOUT_MS` 10 000, idle 15 000, connect 3 000, keepalive on (`client.ts:62-73`). Statement timeout is enforced **twice** — server-side `statement_timeout` startup param AND node-postgres client-side `query_timeout` — because the client-side abort also covers the PgBouncer path where startup params are ignored (`client.ts:40-47, 107-108`). `idle_in_transaction_session_timeout=30000` + `lock_timeout=3000` are set via the libpq startup `options` packet (not a post-connect `SET`, which races the first query) and are also backstopped by role-level defaults from migration 0117 when behind PgBouncer (`client.ts:109-117`).

Key exports: `db`, `DB`/`Tx`/`DbOrTx` types for threading a pool-or-transaction through service methods (`client.ts:174-175`), `POOL_CONFIG`/`getPoolStats()` for the admin Database diagnostics tab (`client.ts:79-86, 157-164`), `closePool()` for SIGTERM handling, and **`withLongStatement(ms, fn)`** (`client.ts:192-213`) which opens a dedicated short-lived `pg.Client` outside the pool (the pool-wide 10s `query_timeout` can't be lifted per-query through Drizzle) and runs `fn` in a transaction with `SET LOCAL statement_timeout` — the only form that survives PgBouncer transaction pooling. Reserved for operator-triggered bulk jobs; `lock_timeout`/idle-in-txn keep defaults so slow non-DB work inside `fn` would be reaped at 30s.

**TLS — `src/lib/db/ssl.ts`**: `pgConnectionConfig(url)` returns `{ connectionString, ssl }` and is the mandatory entry point (pool, migrator, init-secrets all call it). It strips the URL's `sslmode` params when an explicit `ssl` object applies, because `pg` lets the URL's sslmode silently REPLACE the object (`ssl.ts:111-152`). Posture: no `sslmode=require` → plain (localhost/private net); `require` + `DB_SSL_CA` → verified TLS; `require` + no CA → encrypted-unverified with a prod warning; `verify-ca`/`verify-full` without a usable CA → **fail closed at boot** (`ssl.ts:29-78`). `resolveDbSslPosture()` mirrors this without throwing for the Sécurité scorecard.

**PgBouncer**: not wired in by default. `docker-compose.dev.yml` and `docker-compose.coolify.yml` both ship a commented/optional `edoburu/pgbouncer` service on host `6432`; today `DATABASE_URL` and `MIGRATION_DATABASE_URL` both point straight at Postgres `:5432`/`:5434` (`docker-compose.coolify.yml:62-68`). The whole pooler-aware design (statement timeout belt-and-suspenders, `MIGRATION_DATABASE_URL`, role-level 0117 defaults) exists so the app can be moved onto the pooler later while migrations stay on a direct connection.

**pgvector**: dev + prod Postgres is a custom `tokyo-pgvector:16.14-alpine` image (`docker/pgvector/Dockerfile`), host port **5434** in dev. The `vector` extension and `products.embedding vector(1536)` column + partial HNSW cosine index are added by migration **0112** (`src/lib/db/migrations/0112_product_embedding.sql`), with `max_parallel_maintenance_workers=0` around the index build to avoid a `/dev/shm` overflow.

### (b) Migration model (hand-authored, snapshots frozen)

- **202 migration files**, `0000_squash_baseline.sql` → `0201_order_business_tax.sql`, each paired with an entry in `src/lib/db/migrations/meta/_journal.json` (202 entries, `version:"7"`, hand-picked `when` timestamps).
- **Snapshots frozen at 0007**: `meta/` contains only `0000,0003–0007_snapshot.json`. Everything from 0008 on is hand-written SQL with a journal entry but NO snapshot. `drizzle-kit generate` diffs against the last *snapshot* (the 0007 state), so running it would emit a massively destructive migration.
- **Guards** (`src/lib/db/scripts/guard-generate.ts`, `guard-push.ts`): `pnpm db:generate` and `pnpm db:push` are remapped to these scripts, which only print an explanation and `process.exit(1)`. Escape hatches `db:generate:force` / `db:push:force` call drizzle-kit directly. `push` is dangerous because `app_secrets`, `rate_limit_buckets`, `tmp_*` (and — see risks — `gift_cards`) are absent from the barrel and would be offered for DROP.
- **Applying migrations — `src/lib/db/migrate.ts`** (`pnpm db:migrate`, or bundled `db-runner/migrate.cjs` in the Docker image): uses a bare-Node-safe relative import (no `@/*`, no `import.meta.url`), finds `migrations/` next to `process.argv[1]`. Prefers `MIGRATION_DATABASE_URL` over `DATABASE_URL` so the app can use a pooler while migrations stay direct (`migrate.ts:31-33`). Takes a **cross-process advisory lock** `ADVISORY_LOCK_KEY = 72707468` via `pg_try_advisory_lock` in a 30×2s retry loop so concurrent Coolify replicas serialize (`migrate.ts:70, 138-156`); 2-connection pool (one holds the lock, one runs SQL), 60s connect-retry for a co-deploying Postgres, TLS errors fail fast (`migrate.ts:42-56`), per-connection `lock_timeout=120s statement_timeout=0 idle_in_transaction=0` to let big DDL run. Drizzle's own `drizzle.__migrations` ledger makes re-runs idempotent, but note (per `migration-journal.test.ts`) the migrator only compares each entry's `when` vs the newest-applied row — a non-increasing `when` is silently skipped on already-migrated DBs, which is why strictly-increasing `when` is a load-bearing invariant.
- **`src/lib/db/init-secrets.ts`** (`pnpm db:init-secrets` / `db-runner/init-secrets.cjs`): bootstraps `BETTER_AUTH_SECRET`, `PAYMENT_ENCRYPTION_KEY` (AES-256-GCM key for payment creds), and the one-shot `ADMIN_BOOTSTRAP_TOKEN` into the raw-SQL `app_secrets` table (env override wins → DB lookup → generate+persist). Emits `export KEY='val'` lines for the entrypoint to `eval`. One-shot token is burned once `app_secrets.ADMIN_BOOTSTRAP_CLOSED` exists (written by `src/lib/bootstrap/default-admin.ts`), after which any leftover row is deleted.
- **`src/lib/db/seed-catalog.ts`** (`pnpm db:seed:catalog`): idempotent (slug-matched) recursive insert of `CATALOG_TREE` from `src/lib/db/catalog-tree.ts` plus a `STARTER_BRANDS` list, using `script-client.ts`. **This file is stale vs. the high-tech rebrand** — its tree/brands are still the watch-store taxonomy (Casio, Festina, watch categories) and comments reference `tokyostore.tn` "watch" migration.
- **`src/lib/db/script-client.ts`**: a `server-only`-FREE Drizzle client (`scriptDb`/`scriptPool`, `max:2`) for `pnpm db:*` scripts only. `bench-catalog.ts` + `catalog-tree.ts` are the other script-side helpers.

### (c) Conventions: money, ids, soft-delete, timestamps, generated columns

- **Money = integer MILLIMES** (`src/lib/price.ts`). `MINOR_PER_DINAR = 1000` is the single scale definition (`price.ts:22`). Columns named `*_cents` hold millimes, NOT centimes — the name is legacy from a pre-rebrand ×10 migration and was never renamed (`price.ts:11-13`, echoed in `product/schema.ts:55-57`). **Never divide by 100**; use `minorToDinars`/`dinarsToMinor` (×/÷1000, rounded) and the formatters: `formatMoney` (storefront, fr-FR grouped, currency+position relabel), `formatCents` (whole-TND default), `formatMoneyExact` (invoices, decimals only when fractional), `formatMoneyMachine` (feed/JSON-LD plain decimal, never below 3dp), `formatMoneyWithCurrency` (dynamic currency; TND→3dp, foreign→2dp). `MONEY_MAX_DECIMALS=3` derived from the scale. `~27` `*_cents` columns across 10 module schemas (order, customer, credit, promotion, product, business, gift-card, loyalty, cart, delivery). The millime scale is store-global; per-product `currency` is a frozen `'TND'` legacy column (`product/schema.ts:114-118`).
- **IDs — `src/lib/db/columns.ts`**: `id()` = `uuid` PK defaulting to `uuid_generate_v7()` (a plpgsql function defined in the baseline preamble using `pgcrypto.gen_random_bytes`) — time-ordered v7 for index locality (`columns.ts:21-31`, `0000_squash_baseline.sql:10-37`). Better-auth tables (`users`, `sessions`, `accounts`, `verifications`) are the exception: **`text` PKs**, not uuid (`0000_squash_baseline.sql:84-119`).
- **Timestamps / soft-delete**: `timestamps()` → `created_at`/`updated_at` `timestamptz NOT NULL DEFAULT now()` (`updated_at` touched by the service layer, not a trigger). `softDelete()` → nullable `deleted_at` (NULL = live). Partial unique indexes keyed on `WHERE deleted_at IS NULL` let a tombstoned row free its slug/sku/gtin for reuse (e.g. `product/schema.ts:228-235, 335-340`).
- **Generated columns (DB-only, absent from Drizzle)**: `search_vector tsvector GENERATED ALWAYS AS (…) STORED` on `products`, `brands`, `categories`, `pages`, `blog_posts`, `aid_articles` using a custom `fr_unaccent` text-search config (french_stem + unaccent, weighted A–D) — built in the baseline preamble (`0000_squash_baseline.sql:39-61, 1204-1209`). `products.embedding vector(1536)` + `embedding_input_hash` (migration 0112). **These columns, plus `pg_trgm` GIN indexes, are intentionally NOT in the per-module Drizzle schema** (Drizzle can't express `GENERATED`/`gin_trgm_ops`/`vector`); the `search` module notes it owns only `search_log`, and search_vector columns "live on indexed tables" (`src/lib/db/schema.ts:136-138`).

### (d) Schema assembly from per-module `schema.ts`

`src/lib/db/schema.ts` is a barrel of **64 `export * from` lines** re-exporting every module's tables (plus cross-module join tables from `src/associations/*`). This is the ONLY graph drizzle-kit reads, so a new module/table MUST be added here or it's invisible to tooling — the header comments call out past "hidden table" bugs (tax/serial, product-gen, content-gen, tier-release). There are **58** `schema.ts`/`*.schema.ts` files under `src/modules/`. Some modules split tables across multiple files (`order/schema.ts` + `order/returns.schema.ts`; `catalog/product/schema.ts` + `tier-release.schema.ts`; `media/schema.ts` + `settings.schema.ts`), each separately re-exported. Tables use `$type<…>()` for enum-ish text columns and `$inferSelect`/`$inferInsert` row types (`product/schema.ts:369-374`). **No cross-module FKs**; joins live in `src/associations/` (customer-user, product-category, product-brand, product-media, product-related, product-complementary, product-collection).

### (e) `src/lib/db/tests/**` — the de-facto contract (no OpenAPI)

~290 `*.test.ts` files, each a **standalone tsx script** (its own `check()` counter, `main()`, `process.exit(1)` on failure — no Jest/Vitest). Two chains in `package.json`:
- **`test:pure`** (`test:pure:1`, `:2`) — DB-free, run with `tsx --conditions=react-server <file>` only.
- **`test:db`** (`test:db:1`,`:2`,`:3`) — need a live DB, run with the extra `--env-file-if-exists=.env.local`. They `import "server-only"` + `@/lib/db/client`, place real rows, and self-clean via distinctive prefixes (`__cltest…`, `__gc…`); they must be pointed at a throwaway DB via `DATABASE_URL`.
- `test` = `test:db && test:pure`. The `--conditions=react-server` flag is what lets these scripts import RSC/server-only modules under tsx. Chains are split into numbered sub-scripts because cmd.exe caps a command line at ~8191 chars.
- **Self-guarding meta-tests**: `test-chain-integrity.test.ts` asserts every file in the dir is wired into exactly one chain (catches orphaned, never-run tests); `migration-journal.test.ts` asserts journal↔file parity, contiguous `idx`, strictly-increasing `when`. There is no shared DB-reset harness — each test manages its own fixtures/cleanup inline.


<details>
<summary><strong>10. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- src/lib/db/client.ts:150 — exports `db`, pool, withLongStatement
- src/lib/db/schema.ts — the ONE Drizzle barrel (64 re-exports)
- src/lib/db/columns.ts — id()=uuid v7, timestamps(), softDelete()
- src/lib/price.ts — millime money SSOT (MINOR_PER_DINAR=1000)
- src/lib/db/migrate.ts — advisory-locked migration runner
- src/lib/db/ssl.ts:132 — pgConnectionConfig TLS entry point
- src/lib/db/scripts/guard-generate.ts, guard-push.ts — frozen-snapshot guards
- src/lib/db/init-secrets.ts — app_secrets bootstrap
- src/lib/db/migrations/0000_squash_baseline.sql — extensions, uuid_generate_v7, fr_unaccent, raw-SQL tables
- src/lib/db/migrations/meta/_journal.json — 202 hand-authored entries
- src/lib/db/migrations/0112_product_embedding.sql — pgvector/HNSW
- src/modules/<domain>/schema.ts (58 files) — the real schema source of truth
- src/lib/db/tests/ (~290 standalone tsx tests) — the de-facto DB contract
- src/lib/db/script-client.ts — server-only-free client for db:* scripts
- src/lib/db/env-num.ts:12 — posIntEnv blank-env hardening

**Models / tables**

- products / product_variants / product_variant_values (catalog/product/schema.ts) — price_cents/old_price_cents in millimes; DB-only search_vector + embedding(1536) columns
- app_secrets (raw SQL, baseline 0006) — key/value secrets store; NOT in barrel
- rate_limit_buckets (raw SQL, migration 0010) — NOT in barrel
- better-auth tables: users/sessions/accounts/verifications — TEXT PKs, not uuid
- gift_cards / gift-card redemptions (src/modules/gift-card/schema.ts, migration 0147) — defines pgTables but is NOT re-exported in the barrel
- drizzle.__migrations — Drizzle's applied-migration ledger (schema `drizzle`)
- ~27 `*_cents` money columns across order, customer, credit, promotion, product, business, gift-card, loyalty, cart, delivery schemas
- Cross-module join tables in src/associations/* (product-category, product-brand, product-media, product-related, product-complementary, product-collection, customer-user)

**Sources of truth**

- Schema shape: the per-module `src/modules/**/schema.ts` files (NOT migrations — those are frozen/hand-authored)
- drizzle-kit's view of the schema: `src/lib/db/schema.ts` barrel (only graph it reads)
- Applied-migration ledger: Postgres `drizzle.__migrations` table + `src/lib/db/migrations/meta/_journal.json`
- Money scale: `MINOR_PER_DINAR=1000` in `src/lib/price.ts`
- ID/timestamp/soft-delete conventions: `src/lib/db/columns.ts`
- DB-only objects (search_vector generated cols, pg_trgm GIN indexes, vector embedding, app_secrets, rate_limit_buckets): the raw SQL in `migrations/*.sql`, deliberately absent from the barrel
- Runtime secrets (BETTER_AUTH_SECRET, PAYMENT_ENCRYPTION_KEY, ERP/AI keys): `app_secrets` table + env override
- Behavioral contract / invariants: the `src/lib/db/tests/**` suite (no OpenAPI spec exists)

**Editable / removable**

- SAFE to edit: per-module `schema.ts` column/index declarations — but a schema change is NOT applied until you hand-author a matching `migrations/NNNN_name.sql` + a `_journal.json` entry with a strictly-greater `when`, then `pnpm db:migrate`. Editing schema.ts alone changes types only, not the DB.
- SAFE to edit: formatters/scale helpers in `src/lib/price.ts` behavior, and pool/timeout tuning via env (`DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, etc.) with no code change.
- DO NOT rename `*_cents` columns casually — ~27 columns + all `$inferSelect` row types + every money formatter assume the millime scale; a rename needs a migration AND audit of all readers. Reading `_cents` as centimes (dividing by 100) is the classic bug this layer guards against.
- DO NOT run `pnpm db:generate` / `db:push` (or the `:force` variants) against a real DB — snapshots are frozen at 0007, so generate emits a destructive diff and push offers to DROP app_secrets/rate_limit_buckets/gift_cards.
- DO NOT remove `app_secrets` or `rate_limit_buckets` — raw-SQL tables holding live secrets/rate state, protected by both the push guard and drizzle.config `tablesFilter`.
- DO NOT reorder/renumber or reuse migration files, and never give a new `_journal.json` entry a `when` <= the previous one (it is silently skipped on already-migrated DBs). Append-only.
- LOAD-BEARING: `uuid_generate_v7()`, the `fr_unaccent` text-search config, and the generated `search_vector` columns are defined only in the baseline SQL — editing search weighting means a new migration that drops+re-adds the generated column.
- When adding a table/module: you MUST add an `export * from` line to `src/lib/db/schema.ts` or drizzle tooling + typed relations won't see it; and add any new test file to a `package.json` test chain or `test-chain-integrity.test.ts` fails.

**Gaps / risks**

- `gift_cards` (and its redemption table) in `src/modules/gift-card/schema.ts` is NOT re-exported in `src/lib/db/schema.ts` — confirmed: 64 `export * from` lines, none for gift-card. It works at runtime (the module imports its own schema directly) and generate is frozen, but it is the SAME class of latent footgun as app_secrets: a `db:push:force` or any future snapshot unfreeze would see `gift_cards` as an orphan table to DROP, and it is NOT in the drizzle.config `tablesFilter`. Add it to the barrel (or to the tablesFilter) to be safe.
- `drizzle.config.ts:21` dev fallback URL uses stale `tokyo:tokyo_dev_pwd@...:5434/tokyo` while `script-client.ts:18` and docker-compose use `tokyo:tokyo_dev_pwd@...:5434/tokyo`. In practice `DATABASE_URL` is always set so the fallback rarely fires, but the two script-side fallbacks disagree — a bare `db:studio` with no env could hit a non-existent `tokyo` DB.
- `src/lib/db/seed-catalog.ts` is stale vs. the high-tech rebrand: it still seeds watch-store categories/brands (Casio, Festina, etc.) and references `tokyostore.tn` 'watch' migration. The live (tokyo) storefront reads from bundled JSON (src/storefront/data/*) regenerated by scripts/tokyo-*.ts, so this seed is likely dead/legacy for the new design but still present.
- The `gz_`/`gz.` legacy identifiers (globalThis.__gz_pool in client.ts:89; cookie names in the task context) are load-bearing and intentional — do not 'tidy' them.
- No OpenAPI/schema snapshot of the live DB to diff against — the only machine-checkable schema↔DB contract is the db/tests/** suite plus drift tests (e.g. gift-card-schema-drift.test.ts asserts TS enum arrays match DB CHECK literals). If you change a CHECK/enum you must update both the migration and the TS const array or the drift test fails.
- Migrations are strictly append-only with hand-picked `when` timestamps; the `when`-ordering invariant is subtle (non-increasing `when` → silently skipped on prod, applied on fresh/CI DBs → divergent schemas). `migration-journal.test.ts` is the only guard — always run `pnpm test:pure` after adding a migration.
- Soft-delete is app-enforced (`deleted_at`), not DB-enforced — queries that forget `WHERE deleted_at IS NULL` will read tombstoned rows. Partial unique indexes assume the filter is applied consistently.
- `updated_at` is bumped by the service layer, not a DB trigger — a raw SQL UPDATE or a service path that forgets to set it will leave `updated_at` stale (keyset-pagination/activity-ordering queries rely on it).

</details>


---

## 11. Auth, RBAC, Sessions & API-Key Access

This subsystem is **security-critical and load-bearing for the frontend** (login/register/2FA/account all route through it). It has three pillars: (1) **better-auth** for authentication, (2) a **code-registry RBAC engine** for authorization, and (3) **API-key auth** for the external/ERP REST surface. A guiding design choice runs through it all: *"a user is a user"* — one account per email, no login-portal audience gate; the only real boundary is the RBAC gate on `/admin`.

### (a) better-auth setup — `src/lib/auth/server.ts`

`buildAuth()` (`server.ts:196`) constructs the betterAuth instance; it is **lazily built and process-cached** via `getAuth()` (`server.ts:798`) and dropped by `resetAuthInstance()` (`server.ts:804`) whenever admin-tunable inputs change (social creds, session policy, email-verification toggle) — so changes apply next request with **no redeploy**. The build is async because social creds + session policy are read from the DB.

Config highlights:
- **Email+password** enabled (`server.ts:357`), scrypt hashing managed by better-auth. `minPasswordLength:12` / `maxPasswordLength:128` (`AUTH_POLICY`, `policy.ts:9-10`), `autoSignIn:false` (forces email-verify before first session), `revokeSessionsOnPasswordReset:true` (`server.ts:375`), `resetPasswordTokenExpiresIn = 60min` (`server.ts:381`).
- **Email verification** mandatory by default (`emailVerification`, `server.ts:431`): `sendOnSignUp`, `autoSignInAfterVerification`, 24h expiry. `afterEmailVerification` (`server.ts:446`) claims guest orders + emits `user.email_verified`.
- **Self-serve email change** (`server.ts:496`) uses `sendChangeEmailConfirmation` to the CURRENT address (anti-takeover); completion audited in `databaseHooks.user.update.after` (`server.ts:550`).
- **drizzleAdapter** maps better-auth models → module tables: `user→users, session→sessions, account→accounts, verification→verifications, twoFactor→two_factors` (`server.ts:345-355`).
- **Plugins** (`server.ts:759`): `twoFactor({period:30, digits:6, backupCodes:10, skipVerificationOnEnable:false})` then `nextCookies()` — order matters; `nextCookies()` MUST be last (flushes Set-Cookie from server actions).
- **Cookies** (`advanced`, `server.ts:750`): `cookiePrefix:"gz"`, `sameSite:"lax"`, `httpOnly:true`, `useSecureCookies` only in production.
- **trustedOrigins** (`buildTrustedOrigins`, `server.ts:73`): always `BETTER_AUTH_URL` + `NEXT_PUBLIC_SITE_URL`, plus validated `BETTER_AUTH_TRUSTED_ORIGINS` CSV (https-only in prod, malformed entries dropped). No CORS config — **same-origin assumption**.
- **rateLimit** `storage:"memory"` (`server.ts:337`) — **single-instance only**; scaling to multiple pods requires Redis/secondary-storage (flagged in-code).

**ENABLED vs DISABLED flows.** `AUTH_HTTP_DISABLED_PATHS` (`policy.ts:127-149`) is fed into `disabledPaths` (`server.ts:209`). These credential endpoints **404 over HTTP** and are instead served **in-process** (`auth.api.*`) by server actions/workflows that add Postgres per-IP/per-account throttles, audit events, and signup invariants: `sign-in/email, sign-up/email, request-password-reset, reset-password, send-verification-email, change-password, change-email, update-user, delete-user, verify-password, two-factor/{verify-backup-code,generate-backup-codes,get-totp-uri,send-otp,verify-otp}`. **Reachable over HTTP** (`route.ts:11-16`): `get-session, sign-out, sign-in/social, callback/*, verify-email, GET reset-password/:token, two-factor/{enable,verify-totp,disable}` (the /account 2FA card).

**OAuth / social** (`buildSocialProviders`, `server.ts:126`): Google + Facebook, registered **only when BOTH creds resolve AND the admin toggle `auth.social.<provider>_enabled` is on** — fail-closed. Creds resolved by `resolveSocialCredentials()` (`social-config.ts:100`) with **env-wins-over-encrypted-DB** precedence; stored in `oauth_provider_settings` (`src/modules/oauth`). Account-linking restricted to **Google only** (`trustedLinkingProviders`, `policy.ts:39`); Facebook never auto-links. Three security hooks guard the social path:
- `account.create.before` (`server.ts:647`) — the **2FA-bypass-via-Google-link gate**, decided by the pure, unit-tested `oauthAutolinkGate()` (`policy.ts:55`): a 2FA account is ALWAYS blocked from a silent link; otherwise gated by the user's `oauthAutolink` opt-in (default ON since migration 0157).
- `session.create.before` (`server.ts:605`) — single chokepoint for EVERY sign-in path: refuses a session for a **soft-disabled** account (better-auth doesn't know about `disabledAt`), and blocks a 2FA account on the OAuth callback (forces full password+TOTP). OAuth refusals 302 to `/login?error=` via `oauthLoginRedirect` (`server.ts:832`).
- `account.create.after` (`server.ts:678`) — mirrors the signup workflow for social sign-ups (creates customer profile + link, emits `user.created`), skipping internal accounts.

**2FA** is opt-in TOTP, default OFF for all accounts, available to customers AND staff. Enrolment flag flips only after a verified code. Admin lockout-recovery: `authService.clearTwoFactor()` (`service.ts:123`) can clear (never read) the secret. Per-challenge brute-force cap keyed on the signed pending-challenge cookie (`two-factor-challenge.ts`, enforced in `hooks.before`, `server.ts:243`).

### (b) Sessions & cookies

- Session cookie = **`gz.session_token`** / `__Secure-gz.session_token` (`proxy.ts:43-44`); cart cookie = **`gz.cart_token`** (`src/lib/cart/session.ts:9`). The `gz.` prefix and `gz.cart_token` are **intentional legacy identifiers** kept on purpose.
- `sessions` table (`src/modules/auth/schema.ts:59`): token (unique), userId (FK→users ON DELETE CASCADE), expiresAt, ip/userAgent. Expired sessions are only lazily evicted by better-auth, so `purgeExpiredSessions()` (`service.ts:164`, batched) runs from the daily retention cron.
- **Admin-tunable session policy** (`SESSION_POLICY_BOUNDS`, `policy.ts:89`): `expiresDays` (def 7, 1-90), `updateAgeDays` (def 1, 1-60), `cookieCacheMinutes` (def 5, 0-30). Saved to `site_settings` by `saveSessionPolicyAction` (`src/lib/actions/session-policy.ts`, gated `users:policy`), clamped on write and independently ignored-if-out-of-range on read (`resolveSessionPolicy`, `server.ts:164`; pure mirror in `session-policy.ts`).
- The **cookie cache only caches the session payload**; every gated request re-reads the user row (see gates below), so **disable is the immediate kill switch** and role/permission changes take effect live — the cache window only delays an explicit force-logout of a non-disabled user.

### (c) Session gates — `src/lib/auth/session.ts`

Server-side helpers used ~172× across admin pages and actions:
- `getSession()` (raw), `getCurrentUser()` (`session.ts:61` — re-fetches row, returns null if `disabledAt`).
- `requireSession()` (`session.ts:71`) — redirects to `/login?from=…`; re-reads row and bounces disabled accounts with `?disabled=1`.
- `requireAdminArea()` (`session.ts:104`) — admin-AREA gate (any non-empty permission set); **404s** on deny so routes stay undiscoverable.
- `requirePermission(module, action)` (`session.ts:125`) — the per-page/per-action gate; 404s on deny and emits `rbac.permission_denied` for authenticated staff (privilege-probing trail). `requirePermissionAny([...])` (`session.ts:147`) for OR-gated surfaces.

Authorization is resolved **LIVE per request** via the RBAC engine (one indexed lookup, React-`cache()`-memoized per request), so revoking a role / disabling a user bites on the next request with no token regeneration.

### Identity model: customer vs admin vs staff

- `users` (`src/modules/auth/schema.ts:26`) carries **NO role column** — the legacy `users.role` enum (customer|staff|admin) was retired in migration 0193. Fields: text PK `id` (better-auth-generated), `email` (unique), `name` (denormalized `${first} ${last}` mirror of the linked profile, kept in sync one-way by the `sync-user-name-from-profile` subscriber), `emailVerified`, `twoFactorEnabled`, `oauthAutolink` (default true since 0157), `disabledAt` (**soft-disable; no hard-delete path exists**), timestamps.
- **customer↔user link** = `customer_user_links` (`src/associations/customer-user.ts`) — a soft text link with NO FK, 1 user ↔ 0-or-1 profile. Created by the signup/invite/social-signup paths. Admin & B2B users may have no profile.
- **Account type is DERIVED, never stored** (`account-type.ts:21`): `admin` = holds `*`, `staff` = non-empty set, `customer` = empty. Batched forms for the Utilisateurs list live in `roster.ts` (`isInternalAccount`, `accountTypesForUsers`, `accountTypeCounts`).
- **Admin login** (`src/app/admin-login/`) is a separate entry point at `/admin-login`, OUTSIDE the gated `/admin/*` segment. An operator can hide it behind a secret `ADMIN_LOGIN_PATH` (`src/lib/auth/admin-path.ts`, Edge-safe); `src/proxy.ts` rewrites the secret path to the physical route and 404s the default. The shared sign-in action handles both customer and staff; a non-admin who signs in at `/admin-login` simply 404s at `/admin` (`signin.ts:11-19`).

### (d) RBAC — `src/lib/rbac/*` + `src/modules/rbac/*`

**Two sources of truth, deliberately split:**
1. **What permissions EXIST** = the CODE registry `src/lib/rbac/registry.ts` (`PERMISSION_MODULES`, ~60 modules keyed by admin-nav id; `PERMISSION_ACTIONS = view|create|update|delete|manage|export|roles|policy`). Adding a privilege is a one-line edit — no migration. Wildcards `*` (everything) and `<module>:*` (all actions on a module).
2. **Who HOLDS what** = DB GRANTS in `src/modules/rbac/schema.ts`: `roles` (system vs editable via `is_system`), `role_permissions` (free-text key per role, incl. wildcards), `user_roles` (soft text link to users.id, no FK), and the per-user overlay `user_permissions` (allow/deny deltas, migration 0191). Stale keys self-heal (ignored at authorize).

**The `super_admin` role (is_system=true) is the SOLE source of `*`** — seeded in migration 0033. Migration 0195 seeds four **editable, non-wildcard** starter roles (`administrateur, manager, web_master, support`), all `is_system=false`.

**Engine** (`authorize.ts`): `resolveUserPermissions(userId)` (`authorize.ts:45`) = `union(role grants) ∪ allow − deny`, via the pure `applyPermissionOverlay` (`overlay.ts:31`). A disabled account resolves to the empty set. `permissionSetAllows()` honours both wildcard forms. The deny×wildcard subtlety: a deny **materializes** every wildcard to concrete keys first (`overlay.ts:45`) — so a role-`*` holder with any deny is NOT a literal `*` holder, which the last-admin floor must (and does) account for.

**Admin gating.** `/admin/layout.tsx` calls `resolveAdminShellAccess()` (`authorize.ts:127`) — 404s non-admins and hands the shell the expanded `grantedKeys` to scope the sidebar (`nav-access.ts` keeps nav↔page-guard parity via `visibleWhen` grant lists; `dashboard-access.ts` is the pure per-block matrix for the dashboard). Store-wide destructive ops add a `*` **step-up** on top of their module grant via `requireSuperAdmin`/`checkSuperAdmin` (`super-admin.ts`).

**Escalation & last-admin guards** (`guards.ts`) — the "no privilege above your own" rules the coarse `users:*` gate can't express, applied by every account-mutating workflow:
- `assertActorOutranksTarget` (`guards.ts:90`) — uses `latentTargetPerms` (does NOT zero a disabled target, so a lesser actor can't seize a disabled super_admin).
- `assertActorMayAssignRoles` (`users:roles` grant-power slice), `assertActorMayGrantRole` (system roles need `*`; custom roles need every key the role carries), `assertActorMayGrantPermissionKeys`.
- **Last-admin floor**: `countEffectiveWildcardAdmins` (`guards.ts:178`, excludes disabled + deny-override "phantoms" via `WITHOUT_DENY_OVERRIDE`), `countWildcardAdminsExcludingRole`, `assertDisableKeepsAnAdmin`, `assertRoleChangeKeepsAnAdmin`, `assertRoleWildcardRemovalKeepsAnAdmin`. These prevent removing/disabling the last `*` holder → lockout. (Documented small-N TOCTOU residual.)

Workflows wiring these: `src/workflows/rbac/{assign-roles,manage-roles,set-user-permissions}.ts` and `src/workflows/auth/{disable-user,create-user,invite-user,set-password,set-email}.ts`. Admin action entry points: `src/lib/actions/rbac.ts` (role CRUD + assign gated `users:roles`; create gated `users:create`) and `src/lib/actions/auth.ts` (disable/enable/force-logout/verify/reset gated `users:manage`). De-escalation (role removed or overlay shrank) force-revokes the target's sessions AND API keys so the reduced grant set takes effect actively (`assign-roles.ts:120`, `set-user-permissions.ts:114`).

**First-admin bootstrap**: `POST /api/admin/bootstrap` (`src/app/api/admin/bootstrap/route.ts`) — token-gated (`ADMIN_BOOTSTRAP_TOKEN`, constant-time compare), truly one-shot (404s once any active `*` holder exists or the door is burned), grants `super_admin` + marks verified.

### (e) API-key auth — `src/modules/api-key` + `src/lib/api-auth`

For the **external HTTP/ERP API** only (`/api/products`, `/api/orders`, …) — in-process RSC/Server-Action access never uses keys.
- `api_keys` table (`src/modules/api-key/schema.ts`): stores **only the SHA-256 hash** (`key_hash`, unique); plaintext (`gz_live_…`, 40 chars) shown once at creation. `prefix` is a non-secret fingerprint (NOT a slice of the secret). `scopes[]`, `expires_at`, `revoked_at` (never reactivated), `created_by` (the workflow actor for writes).
- **Scope model** (`scopes.ts`): coarse `read`/`write`/`full` + per-resource `<resource>:<action>`. `hasScope()` decides grant; `SCOPE_RBAC` maps each scope to the equivalent dashboard RBAC keys; `rbacKeysForScope`/`actorMayGrantScope` bound minting (an operator may only mint a scope whose keys they hold).
- **Request guard** `requireApiKey` (`require-api-key.ts:55`): extract bearer/x-api-key → active + unexpired + has-scope → per-key rate limit (120/60s, fail-open-but-logged) → **request-time re-check that the key's CREATOR still holds the RBAC grants behind the scope** (`actorMayGrantScope` against the creator's CURRENT perms — a demoted/disabled creator's keys stop working) → stamp last-used (≤1/min). Never leaks key-exists vs wrong (both 401). Failed auths emit sampled `api_key.auth_failed`.
- **Single entry gate** `enforceExternalApi` (`enforce.ts:36`): resolves the route from `route-catalog.ts`, applies the **global kill-switch** (`apiEnabled`), then either an IP-rate-limited public read (admin-opted, `canBePublic` reads only, never if a key is presented) or a mandatory scoped key. `requireApiActor` (`actor.ts`) refuses writes from a key with no `created_by`.
- **Route catalog** `route-catalog.ts` is the **REST contract source of truth** (no OpenAPI): three tiers — `external` (key-gated, `enforceExternalApi`), `first-party` (same-origin storefront routes, `same-origin.ts isFirstParty` + IP limit, NOT authentication), `infra` (auth catch-all, webhooks, cron — own guards). Used 30× (`enforceExternalApi`) and 19× (`requireApiActor`).
- **Offboarding kill-switch**: bearer keys authenticate on hash+scope alone and never traverse the login ban, so `disableUserWorkflow` calls `apiKeyService.revokeAllForUser()` (`disable-user.ts:54`).

### Frontend login/register wiring (load-bearing)

The (tokyo) storefront is wired to the real backend via **Server Actions**, keeping the same contract regardless of the redesign:
- `/login` → `login-form.tsx` → `signinAction` (`src/lib/actions/auth.ts:121`) → `workflows.auth.signin`. FormData fields: `email`, `password`, `rememberMe`, `from` (same-origin redirect validated by `safeRedirectPath`, `auth.ts:263`). 2FA → redirects to `/login/2fa`.
- `/login/2fa` → `verifyTwoFactorAction` (`auth.ts:197`) — per-IP + per-challenge brute-force caps; mints session via `auth.api.verifyTOTP`/`verifyBackupCode`.
- Signup → `signupAction` (`auth.ts:58`) → `workflows.auth.signup` (per-IP + per-email throttle, anti-enumeration).
- `<SocialAuthButtons>` renders `null` unless an admin enabled a provider; page supplies flags via `getAuthPagesConfig()` with a fallback (social off) on DB outage.
- Client auth instance `src/lib/auth/client.ts` (`authClient`, same-origin) — for the /account 2FA panel and social buttons only.


<details>
<summary><strong>11. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- src/lib/auth/server.ts — the ONE better-auth config (buildAuth, all hooks)
- src/lib/auth/policy.ts — pure policy constants, disabled-paths, oauthAutolinkGate
- src/lib/auth/session.ts — getSession/requireSession/requirePermission gates
- src/lib/actions/auth.ts — signin/signup/2fa/reset + admin user actions
- src/lib/rbac/registry.ts — CODE source of truth for all permissions
- src/lib/rbac/authorize.ts — permission-resolution engine (live, memoized)
- src/lib/rbac/guards.ts — escalation + last-admin-floor guards
- src/lib/rbac/overlay.ts — pure allow/deny overlay + wildcard materialization
- src/modules/rbac/{schema,service}.ts — roles/grants/assignments/overlay CRUD
- src/modules/auth/{schema,service,types}.ts — users/sessions/accounts/2fa tables
- src/lib/api-auth/require-api-key.ts — bearer-key request guard + creator re-check
- src/lib/api-auth/enforce.ts — external-API single gate + kill-switch
- src/lib/api-auth/scopes.ts — scope vocabulary + scope→RBAC bound
- src/lib/api-auth/route-catalog.ts — REST contract source of truth (3 tiers)
- src/modules/api-key/{schema,service}.ts — hashed API keys
- src/app/api/auth/[...all]/route.ts — better-auth catch-all handler
- src/proxy.ts — Edge cookie-gate + secret admin-login rewrite
- src/app/admin/layout.tsx — admin-shell RBAC gate + nav scoping
- src/workflows/auth/* and src/workflows/rbac/* — the true mutation API
- src/associations/customer-user.ts — customer↔user soft link (no FK)

**Models / tables**

- users (src/modules/auth/schema.ts) — NO role column (enum retired migration 0193); id text PK, email unique, name (profile mirror), emailVerified, twoFactorEnabled, oauthAutolink, disabledAt (soft disable)
- sessions — token-unique, userId FK→users CASCADE, expiresAt, ip/userAgent; expired rows purged by cron
- accounts — better-auth credential/OAuth rows (providerId 'credential' = password; password hash here, unique (providerId, accountId))
- verifications — email-verify/reset/change-email tokens (purged by cron)
- two_factors — one-per-user (unique) encrypted TOTP secret + backup codes
- roles / role_permissions / user_roles (src/modules/rbac/schema.ts) — RBAC grants; intra-module FKs CASCADE, user_id is soft text link
- user_permissions (migration 0191) — per-user allow/deny overlay, soft text link, never stores global '*'
- api_keys (src/modules/api-key/schema.ts) — SHA-256 hash only, scopes[], expires_at, revoked_at, created_by
- oauth_provider_settings (src/modules/oauth) — encrypted google/facebook client id/secret
- customer_user_links (src/associations/customer-user.ts) — customer_profile ↔ user, soft text link, no FK, 1:0..1

**Sources of truth**

- Auth policy VALUES: AUTH_POLICY + SESSION_POLICY_BOUNDS + AUTH_HTTP_DISABLED_PATHS + AUTH_RATE_LIMITS in src/lib/auth/policy.ts (the better-auth config builds itself from these, so displayed policy never drifts)
- What permissions EXIST: the CODE registry src/lib/rbac/registry.ts (PERMISSION_MODULES/PERMISSION_ACTIONS) — not a DB table
- Who HOLDS what: DB GRANT tables role_permissions / user_roles / user_permissions (modules/rbac/schema.ts)
- The sole `*` (super-admin): the seeded super_admin role, migration 0033; default role catalog in migration 0195
- Admin-tunable session policy + email-verification toggle + social toggles: site_settings keys (auth.session.*, auth.email_verification_required, auth.social.*_enabled)
- Social OAuth credentials: env vars OR encrypted oauth_provider_settings (resolved by src/lib/auth/social-config.ts, env wins)
- REST API surface + per-route public toggle: src/lib/api-auth/route-catalog.ts; contract enforced by the test suite (no OpenAPI)
- API-key secrets: only the SHA-256 hash in api_keys.key_hash (plaintext shown once)
- Session + account state: sessions / users tables (users.disabledAt is the live disable switch)

**Editable / removable**

- LOAD-BEARING, do not weaken: AUTH_HTTP_DISABLED_PATHS (policy.ts) — removing an entry re-opens an un-throttled, un-audited HTTP credential endpoint that bypasses the in-process server actions
- LOAD-BEARING: the last-admin floor guards (guards.ts) and the super_admin role's is_system flag — removing risks a hard admin lockout; super_admin must never be renamed/deleted
- LOAD-BEARING: the three social hooks in server.ts (account.create.before 2FA gate, session.create.before disable+2FA block, account.create.after profile mirror) — each closes a specific bypass documented inline
- LOAD-BEARING legacy identifiers kept ON PURPOSE: cookiePrefix 'gz', gz.session_token, gz.cart_token — renaming logs every user out / breaks the proxy gate
- Frontend-safe to restyle: login-form.tsx / register / 2fa forms — but the Server Action contract (FormData field names email/password/rememberMe/from/code) and the /login/2fa route path must stay; signinAction/verifyTwoFactorAction read them by name
- Safe to edit/remove per store policy: the four default roles from migration 0195 (administrateur/manager/web_master/support) are is_system=false — editable/deletable; social providers render null when disabled, so the social-button block can be dropped if OAuth is unused
- Adding/removing a permission is a one-line registry edit (registry.ts) with no migration; stale grants self-heal at authorize time — but a page/action still references its module:action key, so remove the gate call too
- Session policy, email-verification requirement, and social toggles are admin-editable at runtime (no code change) — they live in site_settings and trigger resetAuthInstance()

**Gaps / risks**

- better-auth rateLimit uses in-memory storage (server.ts:337) — correct only for the single-instance Coolify deploy; scaling to multiple pods silently weakens throttling until switched to Redis/secondary-storage
- The OAuth auto-link gate is UNVERIFIED against a real Google flow in production (Google is off until creds are set) — server.ts:644 explicitly says to validate on a staging deploy before relying on it
- Several invariants depend on specific better-auth 1.6 behaviors that a library upgrade could change: the SYNTHETIC-user response for duplicate signups (signup.ts:96 / invite-user.ts:125) and sendChangeEmailConfirmation-to-current-address (server.ts:496); upgrades need regression checks
- Documented small-N TOCTOU residual on the last-admin floor: two simultaneous last-two removals could both pass the read before either writes (guards.ts:276) — acceptable but real
- SECURITY TODO in require-api-key.ts:20 — sampled invalid/rate_limited API-key failures should be routed to a separate high-volume telemetry stream + an aggregate metric; today a key-guessing storm is only partially visible
- same-origin.ts is explicitly a CSRF speed-bump, NOT authentication — a non-browser client can spoof Sec-Fetch-Site/Origin; it must never be the sole guard on anything state-changing (the real controls are IP rate limit + consent gate)
- users.name is a denormalized mirror of the customer profile kept in sync ONE-WAY by a subscriber (associations/customer-user.ts:20) — a dropped event leaves name drift in admin lists/audit actor names
- No hard-delete path for users (accounts are only soft-disabled); user_roles/user_permissions are soft text links with no FK, so a hypothetical hard delete would orphan grant rows (roster.ts accounts for this by JOINing users by PK)
- The REST contract has no OpenAPI — the ONLY contract is the test suite under src/lib/db/tests/* (erp-api / external-api-contract); edits to route-catalog.ts or the enforce.workflowErrorStatus switch must be kept in lockstep with those tests
- cookieCacheMinutes > 0 delays an explicit force-logout (session-row delete) by up to that window for a NON-disabled user; disable/role-change are still live — a subtle operational nuance when reasoning about revocation latency

</details>


---

## 12. Media, Image Pipeline & Storage (sharp + SeaweedFS + /cdn)

The media subsystem is a self-contained Medusa-style module (`src/modules/media/`) plus three orchestration workflows (`src/workflows/media/`), one same-origin CDN proxy route (`src/app/cdn/[...path]/route.ts`), two admin JSON routes, and three event subscribers. It owns image upload, sharp processing (variants + background-removal "détourage"), S3-compatible storage (SeaweedFS), public URL resolution, and media↔content garbage-collection. Everything funnels through a single `media` table and a `media_settings` singleton.

### 1. Data model (source of truth = DB tables)

**`media` table** — `src/modules/media/schema.ts:37-80`. One row per uploaded asset. Columns:
- `id` uuid v7 PK, `kind` enum (`image|video|document|other`, default `image` — in practice only `image` is ever written, see `upload-media.ts:199`).
- `storage_key` — the PRIMARY variant's bucket key, e.g. `products/<uuid>-watch.jpg` (also carries the primary's extension).
- `url` NOT NULL — canonical public URL, normally the quality-controlled JPEG as `/cdn/<key>`.
- `filename`, `mime_type`, `size_bytes` (bigint), `width`, `height`, `alt_text`, `uploaded_by` (soft link to `users.id`, NO FK, never surfaced in any admin view — `schema.ts:23-27`).
- Variant columns: `webp_url`/`webp_size_bytes`, `avif_url`/`avif_size_bytes`, `original_url`/`original_size_bytes`/`original_mime_type`. NULL = "variant not generated".
- `url_override` — admin escape hatch; when set, resolvers use it verbatim and skip variant resolution (for CDN migration).
- `...timestamps()` + `...softDelete()` (soft deletes via `deleted_at`).
- Single index `media_live_idx` — partial composite `(created_at desc, id desc) WHERE deleted_at IS NULL`, backs keyset pagination + live count + orphan ORDER BY (`schema.ts:69-79`). A `media_filename_trgm` GIN index (migration 0028) backs filename search.

**`media_settings` table** — `src/modules/media/settings.schema.ts:44-99`. Singleton, `id` forced to `00000000-0000-0000-0000-000000000001` by a CHECK constraint (`media_settings_singleton`). Runtime knobs, all editable at `/admin/media/settings` with NO deploy:
- `generate_webp` (default true), `generate_avif` (default true), `keep_original` (default false).
- `product_white_bg` (default false) — détourage toggle; column name is **frozen/historical** (was white-only, algorithm now removes ANY uniform sweep).
- `product_white_bg_main_only` (default false) — restrict détourage to the product MAIN image at save time instead of every upload.
- `max_width_px`/`max_height_px` (default 2400 each) — two INDEPENDENT axis caps, `fit:"inside"`, 0 = no cap.
- `webp_quality` (82), `avif_quality` (60), `jpeg_quality` (85) — clamped 30-100 by the service.
- `strip_exif` (default true), `max_upload_mb` (default `DEFAULT_MAX_UPLOAD_MB`=8).
- `default_alt_text`, `cdn_base_url` (optional public-URL prefix override).

The row is materialised lazily on first read via INSERT…ON CONFLICT (`settings.service.ts:35-67`); a wiped row never crashes uploads. Read through `mediaSettingsService.get()` with a 30 s in-process cache; `update()` clamps qualities/sizes and invalidates the cache (`settings.service.ts:78-110`).

### 2. Upload flow (TRUE mutation API = workflows)

Both admin routes call `workflows.media.upload` / `workflows.media.importFromUrl` — the module service is never mutated directly from routes.

**`uploadMediaWorkflow`** (`src/workflows/media/upload-media.ts:67-234`):
1. Validate size against `getMaxUploadBytes()` (settings-driven, `processor.ts:100-108`) and MIME against `isAcceptedImageMime` (`processor.ts:87`).
2. `processImage(buffer, mime, {scope})` → up to 4 variants.
3. Build an extension-less `baseKey` via `buildStorageKey({scope, filename})` (`storage.ts:52-69`), then PUT each variant under sibling keys (`variantKey`, `storage.ts:95-101`): `<base>.jpg` (primary), `<base>.webp`, `<base>.avif`, `<base>.original.<ext>` (kept original is a DISTINCT key so a same-ext source can't overwrite the primary).
4. **Abort/cleanup discipline**: `variantUploadKeys` (`storage.ts:115-125`) computes EVERY candidate key BEFORE the first PUT; on any failed PUT or a post-PUT insert throw, `purgeUploadedObjects()` deletes the full candidate set (harmless no-op on keys never written). This is the ONLY reclamation for a failed upload — **there is no bucket-wide orphan sweep** (`upload-media.ts:44-48,110-143`).
5. Insert one `media` row, emit `media.uploaded`.

**`importMediaFromUrlWorkflow`** (`src/workflows/media/import-url.ts`): downloads via SSRF-hardened `fetchRemoteImage`, wraps bytes in a `File`, and hands off to the EXACT same `uploadMediaWorkflow`.

**Admin routes** (both admin-only, same-origin CSRF-guarded, rate-limited 30/60s per user):
- `POST /api/admin/media/upload` (`src/app/api/admin/media/upload/route.ts`) — multipart; `requirePermission("media","create")`; scope validated against the allow-list; returns `{id, url}` JSON.
- `POST /api/admin/media/import-url` (`src/app/api/admin/media/import-url/route.ts`) — JSON `{url, scope?, altText?}`.
- `GET /api/admin/media` (`src/app/api/admin/media/route.ts`) — `requirePermission("media","view")`; the `<MediaPicker>` browser (keyset cursor or `ids=` hydration); maps rows through the canonical resolvers.

### 3. sharp processing pipeline

**`processImage`** (`src/modules/media/processor.ts:132-372`):
- Pre-stage: `sharp(input, {failOn:"error", ...SHARP_DECODE_LIMITS}).rotate()`. `SHARP_DECODE_LIMITS` caps decode at ~50 MP (`MAX_INPUT_PIXELS = 50_000_000`, `image-safety.ts:22-25`) — a decompression-bomb guard mapped to `ImageTooLargeError`.
- **Format re-validation on DECODED bytes**, not caller MIME: `isAcceptedDecodedFormat` (`image-safety.ts:72-75`) accepts jpeg/png/webp/avif/gif and genuine AVIF (reports as `heif`+`av1`), rejects mislabeled SVG/TIFF/HEIC → `UnsupportedImageFormatError`.
- Resize: two independent axis caps (`fit:"inside"`, `withoutEnlargement`), only when exceeded.
- EXIF: `strip_exif` on → sharp's default drops all metadata; off → `.keepMetadata()`. (Gotcha noted inline: never use `.withMetadata({})` — it PRESERVES.)
- Variants emitted per settings: quality-controlled **JPEG** (mozjpeg, the universal fallback and canonical `url`), **WebP**, **AVIF**, optional **kept original**. GIFs are EXEMPT from jpeg/webp/avif (sharp flattens animation) — they keep the original.
- **Canonical primary = JPEG ?? original** (`processor.ts:358-369`); never webp/avif, because the resolver serves avif/webp FIRST and only falls back to `url` for non-capable clients, so `url` must be universal.
- Kept original with `strip_exif` on is re-encoded metadata-free at max fidelity via `encodeStrippedOriginal` (`image-safety.ts:132-154`) — JPEG→q100 4:4:4, WebP→lossless, else→PNG — so the publicly-derivable `.original.<ext>` sibling can't leak GPS/device EXIF.

### 4. Détourage (background removal)

**Algorithm** — `src/modules/media/white-bg.ts:109-321` (`removeUniformBackground`): a HEURISTIC, NOT AI segmentation. Samples the border's MEDIAN colour, gates on border uniformity (`minBorderUniformity` 0.7), 4-connected flood-fill of backdrop-coloured pixels from the edges → alpha 0, with colour-distance graded anti-aliased edge. Bails (`changed:false`, original bytes) when the border isn't uniform or the filled fraction is <4% or >96%. Returns RAW RGBA (no PNG round-trip) on success. Handles any flat sweep (white/black/grey/colour); interior regions matching the backdrop (e.g. white dial on white sweep) survive.

**Three invocation paths:**
1. **At upload** — `processor.ts:237-252`, gated on `product_white_bg && !product_white_bg_main_only && scope==="products" && !isGif`. WebP/AVIF keep transparency; JPEG primary is flattened onto white (`processor.ts:272-273`).
2. **Main-image-only at product save** — when `product_white_bg_main_only` is on, upload-time détourage is skipped; `registerDetourageMainImageSubscriber` (`src/events/subscribers/detourage-main-image.ts`) listens on `product.created`/`product.updated` (only when `changedFields` includes `"media"`), resolves the MAIN image (`is_primary` desc, then lowest `display_order`), and calls `detourageProductMainImage` (`reprocess-product-white-bg.ts:213-279`). Detached/best-effort so Save never blocks on sharp.
3. **Bulk reprocess of existing packshots** — `runProductWhiteBgReprocess` (`reprocess-product-white-bg.ts:281-386`), fired from `/admin/media/settings` or the `product_detourage` cron.

**Reprocess core** is split so the in-app job and the offline `scripts/reprocess-product-white-bg.ts` can't drift:
- `src/modules/media/reprocess-detourage.ts` — `isReprocessIneligible` (skip GIF / url_override-pinned), `buildReprocessedDetourage` (re-encode under fresh `-nobg` keys as a cache-bust; honours settings for qualities + which formats to emit; lists old keys to reap incl. the kept original).
- `src/modules/media/reprocess-source.ts` — source selection: skip already-transparent images (probe webp/avif alpha via `hasTransparency`), prefer the kept ORIGINAL normalised like the upload pre-stage (`prepareOriginalSource`), re-key the original beside the new `-nobg` family so `variantStorageKeys` still reaps it.
- Reprocess repoints the row at `-nobg` keys, then deletes old objects EXCEPT keys an order line still displays (`listOrderReferencedStorageKeys`), and busts product + `media.updated` caches.

**Cron**: `runScheduledProductDetourage` (`reprocess-product-white-bg.ts:401-442`) — registry key `product_detourage` (`src/lib/jobs/registry.ts:197`), dispatched via `JOB_WORK.product_detourage` (`src/lib/jobs/run-job.ts:155`). No-op `skipped` unless `product_white_bg` is on; shares `import_jobs` single-flight; idempotent (skips `-nobg` keys).

### 5. Storage (SeaweedFS S3)

`src/modules/media/storage.ts` — `@aws-sdk/client-s3` `S3Client`, memoised (`getS3Client`). Config from `serverEnv` (`src/lib/env.ts:109-118`): `S3_ENDPOINT` (default `http://localhost:8333`), `S3_REGION`, `S3_BUCKET` (default `tokyo`), `S3_ACCESS_KEY`/`S3_SECRET_KEY` (dev placeholders `seaweedfs`/`seaweedfs_dev_secret` — env.ts refuses these in production, `env.ts:197-216`), `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_URL` (default `http://localhost:8333/tokyo`, carries the bucket path). Helpers: `putObject` (1-year immutable cache-control), `getObjectBytes` (signed GetObject — used to inline the logo for printables, see §8), `deleteObject`, and the key-shape functions (`buildStorageKey`, `variantKey`, `variantUploadKeys`, `variantStorageKeys`, `publicUrlFor`). `buildStorageKey` de-dots/de-fangs filenames (`..`, `.original`, `-nobg`) to avoid traversal + reserved-shape collisions (`storage.ts:37-69`). Scopes: `products|categories|brands|cms|uploads` — interpolated VERBATIM as the key prefix, so the scope is validated everywhere.

### 6. The /cdn same-origin proxy

`src/app/cdn/[...path]/route.ts` — GET + HEAD. Browser-facing `/cdn/<key>` → internal `${S3_ENDPOINT}/${S3_BUCKET}/<key>`. Exists to sidestep Next 16's SSRF guard on the image optimizer (can't fetch loopback/private hosts) and keep CSP at `img-src 'self'`. Defenses: rejects path segments starting with `.`, containing `..` or `\0` (400); `redirect:"manual"` (a 3xx → 502, never relayed); 10 s time-to-first-byte deadline cleared once headers arrive (so large bodies aren't truncated); generic 502 body (never leaks the internal object-store host). Caching: success/304 → `public, max-age=31536000, immutable`; errors → `no-store`.
- **Kept-original gate**: keys matching `KEPT_ORIGINAL_RE = /\.original\.[a-z0-9]+$/i` are STAFF-ONLY — served only to a session holding `media:view` (`canViewKeptOriginals`), else 404; and marked `private, no-store` (`route.ts:48-64,101-104,174-176`). These are never a storefront URL (every resolver reaches `url` before `original_url`).
- **CDN allowlist** (`src/modules/media/cdn-allowlist.ts`) is a BUILD-TIME host allow-list (the hosts `next/image` remotePatterns + CSP were compiled with, from `S3_PUBLIC_URL` + `MEDIA_CDN_URL` at `next build`). It is NOT about the `/cdn` route directly — it gates whether an admin `cdn_base_url` or a `url_override` host is usable; a base outside it is silently dropped back to the same-origin proxy (`cdn-base.ts:42-54`) because `next/image` would 400 it. `next.config.ts:229-281` builds the matching remotePatterns; `BUILD_S3_PUBLIC_URL`/`BUILD_MEDIA_CDN_URL` are inlined for runtime read.

### 7. URL resolution (DISPLAY/THUMB/SOCIAL)

`src/modules/media/url-resolver.ts` — three synchronous resolvers, all `firstNonEmpty`-based (empty-string-safe, not `??`) through `normalizePublicUrl` + `getCdnBaseSync()`:
- `resolveMediaUrl` (DISPLAY, AVIF-first): `url_override → avif_url → webp_url → url → original_url`. For on-page `<Image>`.
- `resolveMediaThumbUrl` (THUMB, WebP-first, never AVIF): for raw `<img>` admin grids.
- `resolveMediaSocialUrl` (OG/JSON-LD/email, delegates to thumb): AVIF-avoiding for scrapers/mail clients.
- `resolveMediaAlt`: trimmed `alt_text` or null (callers fall back to a semantic name, never the filename).

**CDN base precedence** (`src/modules/media/cdn-base.ts`): DB `media_settings.cdn_base_url` (PRIMARY) → `MEDIA_CDN_URL` env (first entry) → `""` (same-origin `/cdn`). Because resolvers are sync, the base is memoised (30 s TTL) and must be primed by `primeCdnBase()` before a batch of sync resolves; `invalidateCdnBase()` is called on settings change. `normalizePublicUrl` (`src/lib/utils/public-url.ts`) also rewrites any leftover absolute object-store URL (localhost/private/docker/S3 host) back to `/cdn/<key>`, then applies the CDN base.

Batch read helpers live in `src/modules/media/queries.ts`: `findMediaByIds`, `resolveUrlById`, `resolveUrlMap`, `resolveSocialUrlMap`, `resolveUrlAltMap`, `resolveSocialUrlAltMap` (all prime the CDN base, project only the URL columns on hot paths).

### 8. Storefront image resolution

The (tokyo) storefront reads catalog data from a bundled JSON (`src/storefront/data/products.json`) regenerated by `scripts/tokyo-export-catalog.ts`. Product images are NOT resolved live: the export calls `listApiProducts` (which resolves the primary `product_media` row via `resolveMediaUrl` → `/cdn/<key>`, `src/lib/api/products.ts:1443-1456`) and writes the resolved URL into each product's `image` field via `imageUrl()` (`src/types/catalog.ts:280`). So **storefront product image URLs are frozen at export time** — a détourage reprocess or CDN-base change requires a re-export to take effect in the (tokyo) JSON (the live backend-backed admin/legacy chrome does re-resolve). `getSiteLogoUrl` (`src/lib/api/cms.ts:223-233`) resolves `site.logo_media_id` live and is passed into the (tokyo) `<Header>` (`src/app/(shop)/(tokyo)/layout.tsx:38-55`); `getSiteLogoDataUrl` (`cms.ts:248-265`) inlines the logo as base64 (capped 1.5 MB) for auto-printing documents via `getObjectBytes`.

### 9. References, orphans & garbage-collection (lockstep invariant)

`src/modules/media/queries.ts` is the reference-tracking source of truth. Media is linked to content TWO ways: `*_media_id` soft text columns (no FK; `media.id` is uuid so they cast `m.id::text`, except `product_media.media_id` which is a real uuid FK) AND inline `/cdn/<key>` references spliced into rich-HTML bodies (no media_id — matched on the storage-key BASE via `bodyRefMatch`). Plus JSON blobs: `value_props` icons, landing trust cards, `home.blocks`, `pages.blocks`, `nav_items.config`.

Three functions MUST stay in LOCK-STEP (tested):
- `orphanMediaWhere` → `listOrphans`/`countOrphans` (`queries.ts:375-496`) — the Médiathèque orphans view. Missing a source here only OVER-counts orphans (safe).
- `listReferencedMediaIds` (`queries.ts:517-561`) — destructive sweeps filter candidates through this AFTER deleting their own owning rows. Missing a source here is NOT safe (would delete an in-use image).
- `countMediaReferences` (`queries.ts:627-683`) — the delete-confirm count.

`listOrderReferencedStorageKeys` (`queries.ts:583-617`) protects order-line thumbnail snapshots (order_items store the resolved `/cdn/<key>` URL, not a media id) from every object-purge path.

**Delete/GC flow**: `deleteMediaWorkflow` soft-deletes the row (tombstone for referential safety) then emits `media.deleted` with `variantStorageKeys(row)`. `registerMediaStorageCleanupSubscriber` (`src/events/subscribers/cleanup-media-storage.ts`) purges those objects from S3, skipping order-referenced keys; if the order lookup fails, nothing is purged (a leaked object only costs storage). Bulk delete (`bulkDeleteMediaAction`, `src/lib/actions/catalog.ts:1658`) runs one `media.delete` per row (so each reaps its own objects) then emits a summary `media.bulk_deleted` with EMPTY `storageKeys`. `deleteByIds` (hard delete, `service.ts:133-165`) captures variant keys before deleting and returns them for the caller to emit. `registerMediaCacheSubscriber` (`invalidate-media-cache.ts`) busts broad storefront list tags on `media.updated`/`settings_updated`/`deleted`/`bulk_deleted`.

### 10. Tests = the contract (no OpenAPI)

`src/lib/db/tests/`: `media-orphans-count.test.ts`, `media-body-references.test.ts`, `media-reference-lockstep.test.ts` (the three-function lock-step), `media-storage-keys.test.ts`, `media-resolver.test.ts`, `media-keyset-cursor.test.ts` (µs cursor back-compat), `media-safety.test.ts` + `media-safety-db.test.ts` (decode limits, format gating, SSRF, scheduled détourage), `media-detourage-main.test.ts`, `home-blocks-media-coverage.test.ts`, `page-blocks-media-coverage.test.ts`.


<details>
<summary><strong>12. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- src/modules/media/schema.ts — `media` table (one row/asset, variant columns, soft delete)
- src/modules/media/settings.schema.ts — `media_settings` singleton (all runtime knobs)
- src/modules/media/processor.ts — sharp pipeline, variant selection, détourage hook
- src/modules/media/white-bg.ts — flood-fill background-removal heuristic
- src/modules/media/storage.ts — S3 client + key-shape functions (single source of truth)
- src/modules/media/url-resolver.ts — the 3 resolvers (display/thumb/social)
- src/modules/media/cdn-base.ts + cdn-allowlist.ts — CDN base precedence + build-time host gate
- src/modules/media/queries.ts — orphan/reference lockstep, order-key protection
- src/modules/media/reprocess-detourage.ts + reprocess-source.ts — shared reprocess core
- src/workflows/media/upload-media.ts — upload/delete/update workflows (true mutation API)
- src/workflows/media/import-url.ts + reprocess-product-white-bg.ts — URL import + détourage jobs/cron
- src/workflows/media/settings.ts — settings update workflow (cdn_base_url build-gate guard)
- src/app/cdn/[...path]/route.ts — same-origin S3 proxy (traversal guard, kept-original gate)
- src/app/api/admin/media/{upload,import-url,route}.ts — admin JSON endpoints
- src/events/subscribers/{cleanup-media-storage,detourage-main-image,invalidate-media-cache}.ts — GC, main-image détourage, cache busting
- src/lib/media/fetch-remote-image.ts — SSRF-hardened remote fetch for import-url
- src/lib/api/cms.ts — getSiteLogoUrl / getSiteLogoDataUrl
- scripts/tokyo-export-catalog.ts — freezes resolved product image URLs into storefront JSON
- src/modules/media/image-safety.ts + limits.ts + validation.ts — decode caps, upload ceiling, scope/url_override validation

**Models / tables**

- media (src/modules/media/schema.ts) — the one asset table; uuid v7 PK, soft delete, variant URL/size columns, url_override
- media_settings (src/modules/media/settings.schema.ts) — singleton config row (CHECK-pinned id), 30s-cached
- Referencing columns (owned elsewhere, joined by queries.ts): product_media.media_id (real uuid FK, ON DELETE CASCADE), products.{video_poster_media_id,og_image_media_id}, product_variants.image_media_id, brands.{logo,hero,og_image,icon}_media_id, categories.{hero,og_image,icon,boutique_image}_media_id, collections.{image,og_image,icon}_media_id, banners.{image,image_mobile}_media_id, pages.og_image_media_id, hero_sections.image_media_id, cta_sections.background_image_media_id, blog_posts.featured_image_media_id, authors.avatar_media_id, site_settings (key LIKE '%media_id'), order_items.{product,variant}_image_url (URL snapshots)
- JSON reference blobs: categories/brands/collections.value_props (iconMediaId), site_settings home.blocks + landing trust keys, pages.blocks, nav_items.config
- import_jobs — the shared job row backing reprocess/détourage progress + single-flight (module import)

**Sources of truth**

- `media` table (one row per asset; URL/variant columns) — src/modules/media/schema.ts
- `media_settings` singleton row (id 00000000-...-0001; all pipeline knobs; lazily materialised) — src/modules/media/settings.schema.ts + settings.service.ts
- Bucket key shapes (primary/webp/avif/original, upload/cleanup key sets) — src/modules/media/storage.ts (variantKey/variantUploadKeys/variantStorageKeys)
- Effective CDN base precedence (DB cdn_base_url → MEDIA_CDN_URL env → same-origin /cdn) — src/modules/media/cdn-base.ts
- Build-time media host allow-list (next/image remotePatterns + CSP) — next.config.ts buildRemotePatterns() + BUILD_S3_PUBLIC_URL/BUILD_MEDIA_CDN_URL; mirrored in src/modules/media/cdn-allowlist.ts
- S3 connection config — serverEnv (S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY/SECRET_KEY/FORCE_PATH_STYLE/PUBLIC_URL) in src/lib/env.ts:109-118
- Media↔content reference graph (the lock-step trio) — src/modules/media/queries.ts (orphanMediaWhere, listReferencedMediaIds, countMediaReferences)
- Order-line image snapshots that pin objects from GC — order_items.product_image_url/variant_image_url via listOrderReferencedStorageKeys
- Storefront (tokyo) product image URLs — FROZEN in src/storefront/data/products.json, regenerated by scripts/tokyo-export-catalog.ts (not resolved live)
- The REST/behaviour contract — src/lib/db/tests/media-*.test.ts (no OpenAPI)

**Editable / removable**

- SAFE TO EDIT via /admin/media/settings (no deploy): all media_settings — toggle webp/avif/keep_original/strip_exif, qualities, resize caps, max_upload_mb, détourage on/off + main-only, cdn_base_url. Changes take effect within the 30 s settings cache.
- LOAD-BEARING column names: `product_white_bg` is frozen/historical (means any-uniform-sweep détourage, not white-only); `*_cents`-style naming does NOT apply here but size columns are bigint millimes elsewhere — media sizes are honest byte counts.
- LOAD-BEARING key shapes: variantKey/variantUploadKeys/variantStorageKeys must stay mutually consistent — they are the lock-step between upload-abort cleanup and media.deleted reaping. Editing one key-shape function without the others leaks or 404s objects.
- LOAD-BEARING lock-step: the three reference functions in queries.ts (orphanMediaWhere, listReferencedMediaIds, countMediaReferences) MUST be kept in sync when adding/removing any media-referencing content type — a missing source in listReferencedMediaIds causes irreversible deletion of in-use images. media-reference-lockstep.test.ts guards this.
- REMOVABLE with care: the détourage feature (white-bg.ts, reprocess-*.ts, detourage-main-image subscriber, product_detourage cron) is self-contained and off by default; could be removed if the store never wants background removal, but the reprocess scripts and cron registry entry must go together.
- REMOVABLE legacy: `kind` enum has video/document/other values but only `image` is ever written — the non-image branches are effectively dead but harmless.
- DO NOT remove the /cdn proxy or its kept-original 404 gate — the storefront CSP is img-src 'self' and next/image cannot fetch the internal object store directly; removing it breaks every image. The kept-original gate is the only thing preventing anonymous EXIF-laden original downloads.
- When editing storefront product images: remember they are frozen in products.json — re-run scripts/tokyo-export-catalog.ts after any media/détourage/CDN change, or the (tokyo) UI keeps the old URLs.

**Gaps / risks**

- NO bucket-wide orphan sweep exists: the only reclamation for a failed upload is the workflow's purgeUploadedObjects, and the only reclamation on delete is the cleanup-media-storage subscriber. An object whose delete fails (logged) leaks in the bucket until removed by hand (upload-media.ts:44-48, cleanup-media-storage.ts:27-29).
- Storefront (tokyo) product images are STALE by design: products.json freezes resolved /cdn URLs at export time. A détourage reprocess re-keys objects to `-nobg` AND deletes the old objects — if the catalog isn't re-exported, the (tokyo) storefront points at deleted keys (404). The live admin/legacy chrome re-resolves and is fine; the gap is only the exported JSON.
- CDN-base footgun: an admin cdn_base_url outside the build-time allow-list is silently dropped back to /cdn (warned once) because next/image remotePatterns + CSP are compiled at build. Pointing at a new CDN host requires MEDIA_CDN_URL as a BUILD ARG + rebuild (not a restart). The settings workflow rejects a non-allowlisted base on save (settings.ts:81-87), but a value set before a host was removed from the build would just stop working.
- Reference-lockstep is a manual invariant across 3 functions + several JSON-blob matchers; adding a new media-referencing feature (new block type, new settings key) without updating listReferencedMediaIds risks permanent deletion of in-use media. Mitigated by media-reference-lockstep.test.ts + home/page-blocks-media-coverage tests, but new JSON shapes aren't auto-covered.
- uploaded_by is written on every upload but surfaced NOWHERE (reserved for a future column) — dead provenance data today.
- The détourage heuristic is explicitly NOT AI segmentation: a subject pixel matching the backdrop and edge-connected to it (e.g. a white strap running off-frame on a white sweep) gets removed. It is gated to products-scope + uniform borders, but a borderline packshot can be mis-cut; the reprocess DELETES the old objects so a bad cut is irreversible unless keep_original was on.
- keep_original originals are publicly derivable keys served only behind the RBAC gate in the /cdn route; the gate adds an auth/RBAC lookup on an otherwise anonymous hot path (lazily imported, but still per-request for any `.original.` key). Defence-in-depth relies on strip_exif also re-encoding originals metadata-free.
- docs/media.md is referenced from schema.ts:21 but was not verified in this analysis — treat any prose there as potentially stale vs. the code above (CODE IS SOURCE OF TRUTH).
- GIF handling is special-cased in many places (no webp/avif/jpeg, original preserved, excluded from détourage/reprocess) — editing the variant logic without preserving every GIF guard (processor, reprocess-detourage isReprocessIneligible, scan WHERE clauses) can silently freeze animations into static images that then win the resolver chain.

</details>


---

## 13. CMS, Site Settings, Theme & Identity — the config sources of truth

This subsystem owns everything that controls **who the store says it is** (brand, contacts, legal entity), **what appears in its chrome and content pages** (nav, footer, banners, trust badges, CMS pages), and **how it looks** (theme tokens). It is the primary home of "sources of truth." The single most important structural fact for the owner: **config is DB-backed and admin/seed-editable, but the *new* Tokyo storefront bypasses large parts of the CMS** — content pages and the home page are hardcoded TypeScript, not DB-driven blocks, and the storefront theme CSS is scoped to the retired `.storefront` chrome, not `.tokyo`. Those gaps are detailed below and in gaps_or_risks.

### 1. Site settings — the identity/brand/contact/legal source of truth

**Storage.** One typed key/value table, `site_settings` (`src/modules/cms/setting/schema.ts:21`): columns `key` (unique, `settings_key_unique`), `value` (nullable text), `type` enum (`text|number|boolean|media`), `group_key`, `label`, `description`, `display_order`, timestamps. Everything is stored as a string; readers coerce. There is **no group index** — panels read the whole table and narrow by key prefix.

**Read path.** `getSettingsMap()` (`src/modules/cms/setting/queries.ts:19`) does a single `SELECT * FROM site_settings` and returns a flat `Record<key, value|null>`, wrapped in React `cache()` so one request's many consumers (layout, SEO, theme, nav, footer, checkout) share one query. `getAllSettingsServerOnly()` (`src/lib/api/cms.ts:212`) is the thin server-only public wrapper. **This map carries secrets** (`mail.*_enc`, `payment.*`, promo codes, raw tracking HTML) — it must never be serialized to a client component; use `pickSettings(map, prefixes)` (`src/lib/settings/pick-settings.ts`), which filters by prefix **and** always strips secret-bearing keys via `isSecretSettingKey` (`src/lib/cms/sensitive-settings.ts:64`).

**Write path.** All writes go through two workflows in `src/workflows/cms/setting.ts`: `upsertSettingWorkflow` ("cms.setting.upsert") and `upsertSettingsBatchWorkflow` ("cms.setting.upsert_batch"). The batch validates **every** key up front (Zod + `validateSiteSetting`), writes only **changed** rows in one transaction (no-op re-saves are skipped so panels that re-submit all their keys don't spam audit rows), then emits `setting.upserted` per changed key on the event bus. Sensitive keys (`isSensitiveSettingKey`, `SENSITIVE_SETTING_KEYS` in `src/lib/cms/sensitive-settings.ts:33`) carry `from`/`to` values into the audit row at `warn` severity; everything else is a name-only `info` row. `settingService.upsert` (`src/modules/cms/setting/service.ts:32`) is an atomic `onConflictDoUpdate` on the unique key.

**Server Actions** (the `"use server"` seam the admin forms call) live in `src/lib/actions/`: `site.ts` (identity/contact/social/legal), `seo.ts`, `theme.ts`, `footer.ts`, `home.ts`, `checkout-settings.ts`, `showcase-settings.ts`, `nav-builder.ts`, plus `ai/api/audit/auth/catalog/express/payment/perf/search/stock/tax-settings.ts`. Each validates, calls the batch workflow, and `revalidatePath`s both the admin page and the storefront layout.

**Namespaced keys (the identity source of truth).** Field definitions for the "Réglages site" form are in `src/lib/cms/site-fields.ts` (`SITE_TEXT_FIELDS`): `site.name`, `site.tagline`, `site.description`, `site.logo_media_id`, `site.whatsapp`, `site.hours`, `site.map_embed_url`, `social.{instagram,facebook,x,youtube,tiktok,linkedin}`, `business.legal_name`, `business.tax_id`. Multi-value contacts are handled separately (next section). Validators in `validateSiteSetting` (`src/workflows/cms/setting.ts:41`) gate `site.contact_email`, `site.contact_phone`, `seo.site_url`, and `site.map_embed_url` (which must be a Google Maps embed URL because `/help` iframes it under a strict CSP `frame-src`). Other namespaces: `seo.*` (SEO hub), `theme.*` + `admin.theme.*` (appearance), `checkout.*` (delivery/copy), `auth.*` (login/register copy), `consent.*`, `redirects.*`, `site.mode` (availability), `home.*` + `storefront.*` (listing config), `credit.*` (tri-state `FeatureMode`, `src/lib/settings/feature-mode.ts`).

**Multi-value contacts.** `src/lib/cms/contact-list.ts` stores phones/emails/addresses as JSON arrays of `{v, f}` under `site.contact_phones` / `site.contact_emails` / `site.addresses`, while mirroring the first entry into the legacy single keys `site.contact_phone` / `site.contact_email` / `site.address` (which SEO, invoices, llms.txt, the legal page and page-builder contact block still read). `getSiteContacts(settings)` resolves the lists; `footerEntries()` filters the `f` (show-in-footer) flag. Save logic in `src/lib/cms/contact-list-save.ts`.

### 2. Identity defaults and the brand const (IMPORTANT correction to the task brief)

`DEFAULT_SITE_NAME` in `src/lib/seo/config.ts:22` is **`"Tokyo Store"`**, and `DEFAULT_TITLE_TEMPLATE = "%s · Tokyo Store"`. The task brief's claim that it is test-pinned to the legacy brand name is **stale** — there are zero occurrences of that legacy name anywhere in `src/`. It is nonetheless **test-pinned**: `src/lib/db/tests/seo-title.test.ts:22` hardcodes `BRAND = "Tokyo Store"` and asserts brand-suffix de-duplication against it, so changing the const breaks that test. It is also consumed as a hard fallback in `src/app/layout.tsx:39`, `src/app/llms.txt/route.ts`, and `src/lib/auth/server.ts:199,769` (better-auth `appName`/TOTP issuer). **Correct identity via seeding, not the const**: `scripts/tokyo-seed-identity.ts` upserts the real brand into `site_settings` (`site.name=Tokyo Store`, `business.legal_name=TOKYO STORE`, `business.tax_id=1702961F/A/M/000`, `contact@tokyostore.tn`, socials, SEO keys, auth copy). It is a one-off **overwrite** (unlike the editable-settings seed). Logo helpers `getSiteLogoUrl` / `getSiteLogoDataUrl` (`src/lib/api/cms.ts:223,248`) resolve `site.logo_media_id` from the médiathèque (the data-URL variant is for auto-printing documents).

### 3. Theme & appearance

Two independent, DB-driven theme layers, both injected as validated inline `<style>` in the **root** layout (`src/app/layout.tsx:133-156`):

- **Storefront theme** — `src/lib/theme/config.ts`. `getThemeConfig()` reads `theme.*` keys (`primary_color`, `primary_foreground`, `accent_color`, `accent_foreground`, `foreground_color`, `border_radius_base`, `font_family`, `dark_mode`, `favicon_media_id`). `buildThemeCss` emits a **`.storefront{…}`-scoped** rule. Defaults `THEME_DEFAULTS` (`config.ts:55`) are still the **legacy olive/gold watch palette** (`#4E6F3D` Vert Olive, `#886E5C` gold) and must stay byte-identical to the `.storefront` block in `globals.css` (cold-DB fallback). Fonts come from the curated `THEME_FONT_STACKS` allowlist; colors must pass a strict hex regex; radius is clamped 0–28 (`radiusPx`). `theme.default_og_media_id` is intentionally **not** on `ThemeConfig` — `getSeoConfig` reads it directly for the OG fallback chain.
- **Admin-panel theme** — `src/lib/theme/admin-config.ts`. `getAdminThemeConfig()` reads `admin.theme.*` and `buildAdminThemeCss` emits a **`.admin{…}`-scoped** rule. `ADMIN_THEME_DEFAULTS` (`admin-config.ts:24`) is the **Tokyo crimson** high-tech palette (`accentColor:#d40530`, `accentStrong:#b00020`, neutral `#EEF0F3`/`#F4F5F7`, Montserrat body). Also carries `admin.theme.logo_media_id`.

Dark-mode pre-paint script: `src/lib/theme/dark-mode-init.ts`. Favicon/theme-color metadata is driven by `getThemeConfig` in `generateMetadata`/`generateViewport` (`src/app/layout.tsx:37-126`).

### 4. CMS / page-builder (largely DORMANT on the Tokyo storefront)

**Block model.** `src/lib/pages/block-model.ts` is the shared, pure composer core (block sub-shapes, `ProductSource`, `BlockPresentation`, `parseBlockList`, `BLOCK_LIST_CAP = 40`, image reco hints). Two surfaces build on it: `src/lib/pages/page-blocks.ts` (`PAGE_BLOCK_TYPES`: hero, rich_text, editorial, quote, cta_band, stats, timeline, gallery, fifty_fifty, feature_cards, trust, steps, faq, banner, **contact_channels**, stores, jobs, rendez_vous, product_grid, collections, categories, brands — with `PAGE_BLOCK_META` palette) and `src/lib/pages/home-blocks.ts` (home composer). Many list/landing configs live alongside: `home-page-config.ts`, `home-config-defaults.ts`, `collection-page-config.ts`, `boutique-landing-config.ts`, `listing-settings-keys.ts`, `reserved-routes.ts`.

**Page storage.** `src/modules/cms/page/schema.ts`: `pages` (slug, meta, `is_published`, `is_system`, `blocks` JSON column, `canonical_url`, `noindex`, soft delete). The relational `page_sections` + `hero/text/cta/stats/timeline_sections` tables are **read-only legacy** — the composer writes only `pages.blocks`; `getPageForRender` synthesises blocks from the legacy rows when `blocks` is null. System legal slugs have a code fallback: `SYSTEM_PAGE_DEFAULTS` / `SYSTEM_PAGE_SLUGS` in `src/lib/legal/system-page-content.ts` (cgu, cgv, cookies, privacy, mentions-legales, help), turned into a single rich_text block when no published DB override exists.

**Where blocks actually render.** The renderers `src/components/storefront/page/page-blocks-render.tsx`, `src/components/legal-page-renderer.tsx`, and `src/components/storefront/home/home-blocks-render.tsx` are imported **only** by the admin composer preview (`src/app/admin/cms/pages/[id]/page-composer.tsx`). **No `(shop)` route mounts them**, and `getPageForRender`/`pageService` has **no caller under `src/app/(shop)`**. The page-builder still feeds three *non-HTML* surfaces: the `/md` markdown-twin route (`src/app/md/[...path]/route.ts` → `src/lib/seo/markdown/generate.ts`), `src/app/sitemap.ts`, and `src/lib/seo/page-metadata.ts` (`<title>`/meta). So for the legal slugs, **the HTML page (authored TS) and the DB-driven /md twin + sitemap + metadata can diverge** — see gaps.

**Other CMS modules (DB-backed, admin-editable, and live in chrome):**
- **Banners** — `src/modules/cms/banner/schema.ts` (`banners` table; `placement` enum home_hero/header_strip/category_grid/footer + deprecated checkout/nav_*; scheduling, mobile crop, video, `buttons` JSON). Read seam `src/lib/api/cms.ts` (`listHomeHeroSlides`, `listHeaderStripBanners`, `listCategoryGridBanners`, `listFooterBanners`). Model/coercers in `src/lib/cms/banner-model.ts`. Workflow `src/workflows/cms/banner.ts`.
- **Trust badges** — `src/modules/cms/trust_badge/schema.ts` (`trust_badges`; lucide icon from `TRUST_ICON_NAMES`, `kind`, `visibility` always/in_stock). Read via `listActiveTrustBadges`. Workflow `src/workflows/cms/trust-badge.ts`.
- **Navigation** — `src/modules/cms/navigation/schema.ts` (`nav_menus` keyed by `key`, `nav_items` with self-ref `parent_id`, `internal_kind`+`internal_ref` or `href`, `config` jsonb mega-menu `NavRootConfig`). Fixed system keys in `src/lib/cms/nav-menus.ts` (`MAIN_NAV_MENU_KEY`, `FOOTER_COLUMNS` [footer-shop/support/society], `MAISON_EXPLORE_MENU_KEY`, with `MAISON_EXPLORE_DEFAULTS`). Composer model `src/lib/cms/nav-composer-model.ts`, defaults `nav-defaults.ts`, dead-link pruning `nav-link-liveness.ts`. Read seams `listMainMenu`, `listFooterColumns`, `getMaisonExploreNav` in `src/lib/api/cms.ts`.
- **Showcase pins** — `src/modules/showcase/schema.ts` (`showcase_pins`: manual product pins for nouveautes/top-ventes/promotions).
- **FAQ** — `src/modules/cms/faq/`, model `src/lib/cms/faq-items.ts`.
- **Footer** — `src/lib/cms/footer-fields.ts`, `footer-appearance.ts`.
- Workflows for all of these: `src/workflows/cms/{banner,faq,navigation,page,setting,trust-badge}.ts`. Admin UIs: `src/app/admin/cms/{settings,theme,banners,footer,home,showcase,trust-badges,pages,nav-menu}` and `src/app/admin/system/seo`.

### 5. SEO layer

`src/lib/seo/config.ts` `getSeoConfig()` (React-cached) is the aggregated SEO source of truth, reading `seo.*` plus reused `site.*`/`business.*`/`social.*`. It drives: every page's metadata (via `src/app/layout.tsx` + `src/lib/seo/page-metadata.ts`), the JSON-LD graph (`src/lib/seo/jsonld.ts`, `review-jsonld.ts`, `same-as.ts`, `offer-validity.ts`), `robots.txt` (`src/lib/seo/robots-txt.ts` — `PRIVATE_AREAS`, feed carve-outs, `/md` gating, `siteClosed` kill-switch), `llms.txt` (`src/lib/seo/llms-txt.ts` + `src/app/llms.txt/route.ts`), product/merchant feeds (`src/lib/seo/feeds/` + `src/app/feeds`), the markdown-for-agents twins (`src/lib/seo/markdown/` + `src/app/md`), and title de-duplication (`src/lib/seo/title.ts`). Supporting: `settings-normalize.ts` (org type, geo, sitemap/disallow lists), `url-guards.ts` (canonical `seo.site_url` change guard). Redirects engine: `src/modules/redirects` + `src/lib/redirects/config.ts` (`redirects.enabled`), consulted by nav-link liveness and slug-rename 301s.

### 6. How the Tokyo storefront consumes config

The new chrome layout `src/app/(shop)/(tokyo)/layout.tsx:38-51` reads, in parallel: shipping config (`getStorefrontShippingConfig`), the full settings map, and the resolved logo — then builds `FooterData` from `site.name`, `site.tagline`, footer-flagged contacts (`getSiteContacts`/`footerEntries`) and passes the logo+brand to `Header`. Shipping: `src/lib/checkout/shipping.ts:47` `getStorefrontShippingConfig()` reads `checkout.delivery.free_threshold_cents` / `checkout.delivery.default_fee_cents` (millimes; see money note) and is seeded into the client through `ShippingConfigProvider` (`src/storefront/lib/shipping-config.tsx`, fallback `{fee:7, freeFrom:250}`). **Content pages** (`cgu`, `cgv`, `cookies`, `privacy`, `mentions-legales`, `help`, `notre-histoire`, `nos-boutiques`, `carrieres`, `service-client`, `garantie-retours`) are **hardcoded Next routes** under `(tokyo)/` that import **authored TS `ContentDoc`s from `src/storefront/content/*`** and render them with `src/storefront/components/storefront/content-page`. These routes inject only *identity* from settings (e.g. `mentions-legales/page.tsx` pulls `business.legal_name`/`business.tax_id`/contacts, with `LEGAL_IDENTITY_FALLBACK`). **The body copy is NOT in `pages.blocks`.** The home page `(tokyo)/page.tsx` is hardcoded components over the static catalog (JSON-LD brand string hardcoded "Tokyo Store"); `[slug]` is a catalog (category/product) resolver, not a CMS page resolver.

### Availability gate
`site.mode` drives `live|maintenance|coming_soon` via `src/lib/site-mode/{parse,config,gate-exempt}.ts` (fail-open to `live`; staff bypass fails closed; gate-exempt paths for auth/unsubscribe). It also forces `robots.txt` to `Disallow: /` and empties feeds/sitemap when closed.


<details>
<summary><strong>13. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- src/modules/cms/setting/schema.ts — site_settings typed KV table
- src/modules/cms/setting/queries.ts:19 — getSettingsMap (React-cached whole-table read)
- src/modules/cms/setting/service.ts:32 — atomic upsert / deleteByKeys
- src/lib/api/cms.ts:212 — getAllSettingsServerOnly + logo/nav/footer/banner/trust read seams
- src/workflows/cms/setting.ts — upsert + batch workflows, validation, setting.upserted events
- src/lib/cms/site-fields.ts — SITE_TEXT_FIELDS (identity/contact/social/legal keys)
- src/lib/cms/contact-list.ts — multi-value phones/emails/addresses model
- src/lib/cms/sensitive-settings.ts — secret vs sensitive key classification
- src/lib/settings/pick-settings.ts — prefix-narrow + secret-strip for client payloads
- src/lib/seo/config.ts:22,145 — DEFAULT_SITE_NAME const + getSeoConfig aggregator
- src/lib/theme/config.ts — storefront theme (.storefront scope, THEME_DEFAULTS)
- src/lib/theme/admin-config.ts — admin crimson theme (.admin scope, ADMIN_THEME_DEFAULTS)
- src/app/layout.tsx:37-156 — metadata + both theme <style> injections
- src/lib/pages/block-model.ts + page-blocks.ts + home-blocks.ts — CMS composer catalogs
- src/modules/cms/page/schema.ts — pages table + legacy page_sections (read-only)
- src/lib/legal/system-page-content.ts — SYSTEM_PAGE_DEFAULTS legal fallback
- src/components/storefront/page/page-blocks-render.tsx + legal-page-renderer.tsx — block renderers (admin-preview only)
- src/modules/cms/{banner,trust_badge,navigation,faq}/schema.ts + src/modules/showcase/schema.ts — DB-backed CMS content
- src/lib/cms/nav-menus.ts + nav-composer-model.ts — fixed menu keys + mega-menu model
- src/app/(shop)/(tokyo)/layout.tsx — Tokyo chrome: settings+logo+contacts+shipping consumption
- src/storefront/content/*.ts — AUTHORED TS content docs for Tokyo legal/info pages (NOT pages.blocks)
- src/lib/checkout/shipping.ts:47 + src/storefront/lib/shipping-config.tsx — checkout.delivery.* → storefront display
- scripts/tokyo-seed-identity.ts — one-off identity overwrite into site_settings
- src/lib/site-mode/{parse,config,gate-exempt}.ts — site.mode availability gate

**Models / tables**

- site_settings (key/value/type/group_key/label/description) — the typed KV identity/config store
- pages (slug, title, meta_*, is_published, is_system, blocks JSON, canonical_url, noindex, softDelete)
- page_sections + hero_sections/text_sections/cta_sections/stats_sections(+items)/timeline_sections(+items) — READ-ONLY legacy section tables
- banners (placement enum, scheduling, image/mobile/video, buttons JSON, targeting)
- trust_badges (kind, label, lucide icon, visibility, is_active, display_order)
- nav_menus (key, name, description) + nav_items (parent_id self-ref, internal_kind/internal_ref or href, icon, config jsonb NavRootConfig)
- showcase_pins (slug, product_id CASCADE FK, position) — manual pins for nouveautes/top-ventes/promotions
- FAQ table under src/modules/cms/faq
- SiteSettingRow / NewSiteSettingRow types; SettingType enum (text|number|boolean|media)

**Sources of truth**

- Identity / brand / contact / legal: the site_settings DB table (site.*, social.*, business.*), seeded by scripts/tokyo-seed-identity.ts; hard code fallback is DEFAULT_SITE_NAME='Tokyo Store' in src/lib/seo/config.ts:22
- SEO config: site_settings seo.* (+ reused site.*/business.*/social.*) via getSeoConfig (src/lib/seo/config.ts)
- Storefront theme tokens: site_settings theme.* via getThemeConfig; cold-DB fallback THEME_DEFAULTS (src/lib/theme/config.ts:55) MUST mirror the .storefront block in src/app/globals.css
- Admin-panel theme: site_settings admin.theme.* via getAdminThemeConfig; fallback ADMIN_THEME_DEFAULTS (crimson, src/lib/theme/admin-config.ts:24)
- Tokyo content pages (cgv, privacy, mentions-legales, help, etc.): AUTHORED TypeScript in src/storefront/content/*.ts (NOT the DB) — only legal identity is injected from settings
- CMS page blocks (admin editor + /md twin + sitemap + page metadata only): pages.blocks column + SYSTEM_PAGE_DEFAULTS (src/lib/legal/system-page-content.ts)
- Navigation & footer: nav_menus/nav_items tables (fixed keys in src/lib/cms/nav-menus.ts)
- Banners / trust badges / showcase pins / FAQ: their respective module tables under src/modules/cms/* and src/modules/showcase
- Shipping fee/threshold displayed by storefront: checkout.delivery.* settings via src/lib/checkout/shipping.ts (order workflow re-computes authoritatively)
- Site availability: the site.mode setting via src/lib/site-mode/parse.ts
- Settings-key labels/groups registry (admin form field lists): src/lib/cms/site-fields.ts, src/lib/actions/seo.ts, src/lib/pages/listing-settings-keys.ts — these are the canonical per-panel key lists

**Editable / removable**

- EDITABLE via admin or seed (DB, no code change): all site.* / seo.* / theme.* / admin.theme.* / social.* / business.* / checkout.* / auth.* / consent.* / redirects.* / site.mode / home.* / storefront.* settings; plus banners, trust badges, nav menus/items, CMS pages, showcase pins, FAQ. Change brand/identity by running/editing scripts/tokyo-seed-identity.ts or the admin 'Réglages site' form — NOT by editing consts.
- DO NOT EDIT DEFAULT_SITE_NAME in src/lib/seo/config.ts:22 — it is pinned by src/lib/db/tests/seo-title.test.ts (BRAND='Tokyo Store') and is the auth appName/TOTP issuer fallback; override identity via the site.name setting instead.
- LOAD-BEARING consts to leave alone: THEME_DEFAULTS (must stay in sync with the .storefront rule in globals.css), FOOTER_COLUMNS keys + MAISON_EXPLORE_MENU_KEY + MAIN_NAV_MENU_KEY (src/lib/cms/nav-menus.ts), SYSTEM_PAGE_SLUGS (src/lib/legal/system-page-content.ts), SITE_MODES, BLOCK_LIST_CAP, and the legacy gz.* cookie names mentioned in project context.
- To change a Tokyo content page's visible body (e.g. CGV wording), edit the TS file in src/storefront/content/*.ts — editing the page in /admin/cms/pages will NOT change the HTML a visitor sees (it only affects the /md twin, sitemap and <title>/meta).
- REMOVABLE WITH CARE: legacy page_sections + hero/text/cta/stats/timeline_sections tables are read-only synthesis fallbacks — safe to retire only after confirming no un-migrated pages rely on them; deprecated banner placements ('checkout', 'nav_*') and the dormant setNavFeaturedWorkflow are kept only for pre-migration rows.
- The whole CMS page-builder (pages table, page-blocks.ts, renderers) is NOT mounted by any storefront HTML route — but it is NOT safe to delete outright because it still feeds /md twins, sitemap.ts and page-metadata.ts. Removing it requires also removing or re-pointing those three consumers.
- The storefront theme.* settings and buildThemeCss are effectively DEAD for the visible Tokyo UI (scope mismatch, see gaps) — before 'removing' them, note that the legacy (shell) group and the admin root still consume them.

**Gaps / risks**

- TASK-BRIEF CORRECTION: DEFAULT_SITE_NAME is 'Tokyo Store', not the legacy brand name the brief states; zero legacy-brand strings exist in src/. It IS test-pinned (seo-title.test.ts hardcodes BRAND='Tokyo Store'), so the 'do not edit' guidance still holds — just for the right reason.
- BIGGEST GAP: the CMS page-builder is DORMANT on the storefront. No (shop) route renders pages.blocks; getPageForRender has no (shop) caller. Tokyo content pages are hardcoded TS (src/storefront/content/*). Editing a page in /admin/cms/pages changes ONLY the /md markdown twin, sitemap.ts, and the HTML <title>/meta (src/lib/seo/page-metadata.ts) — so the visible HTML body and the DB-driven metadata/twin for the SAME legal slug (cgv, privacy, mentions-legales, etc.) can silently DIVERGE.
- THEME SCOPE MISMATCH: getThemeConfig/buildThemeCss emit a '.storefront'-scoped rule (injected in root layout), but the new chrome is wrapped in '.tokyo' (src/app/(shop)/(tokyo)/layout.tsx:54). So admin theme.* edits (primary color, radius, font, dark_mode) do NOT reach the visible Tokyo UI — they only affect the retired (shell) group and the admin root. Verify before telling an operator that the Théme panel recolors the live store.
- STALE DEFAULTS: THEME_DEFAULTS (src/lib/theme/config.ts:55) is still the legacy olive/gold watch palette while the shipped design is Tokyo crimson (ADMIN_THEME_DEFAULTS #d40530). The storefront cold-DB fallback therefore does not match the intended brand look.
- STALE COMMENTS from the rebrand: scripts/tokyo-seed-identity.ts header says it renders 'Tokyo Store' 'instead of the bundled Tokyo Store watch-shop defaults' (nonsensical post-rebrand); src/lib/legal/system-page-content.ts:17 still references 'Tokyo Watch Store'. Cosmetic but misleading.
- HOME COMPOSER ALSO DORMANT for Tokyo: home.blocks + home-blocks-render.tsx feed only the legacy (shell) home; the Tokyo home (page.tsx) is fixed components over the static catalog, with a hardcoded JSON-LD brand string.
- SECURITY FOOTGUN: getSettingsMap()/getAllSettingsServerOnly() returns the whole table including mail.*_enc, payment.*, promo codes and raw tracking HTML. Any new client component must use pickSettings() (which also hard-strips secrets) — never pass the raw map across the RSC boundary.
- IDENTITY DEPENDS ON SEED: footer/header read settings['site.name'] directly (null if unseeded); only the SEO/auth paths fall back to DEFAULT_SITE_NAME. A fresh DB that never ran tokyo-seed-identity.ts shows a blank brand in the chrome. money note: checkout.delivery.*_cents columns hold MILLIMES not cents (getStorefrontShippingConfig divides by 1000).
- Two parallel contact representations (JSON list keys + legacy single keys) are kept in sync only through the save path (contact-list-save.ts); a direct DB edit to one without the other will desync footer vs invoices/SEO.

</details>


---

## 14. Admin Panel (src/app/admin/**) — Shell, RBAC Gating, and Full Tab/Section Map

The admin panel is the staff back-office at `/admin`. It is a Next.js App Router segment with **one layout** (`src/app/admin/layout.tsx`), **one presentational shell** (`src/app/admin/_components/admin-shell.tsx`), and ~80 page files across 10 sidebar groups. It owns **no database tables of its own** — every page reads through the modular-monolith transports (RSC direct imports of `@/modules/*` queries/services + `getSettingsMap`) and writes through **Server Actions** in `src/lib/actions/*` that re-gate permission and then call `@/workflows` (the true mutation API). The whole thing is French-labelled and forced light-theme.

### 1. The shell: layout → access gate → nav scoping

`src/app/admin/layout.tsx:28-73` wraps every `/admin/*` page:
- `getSession()` → `notFound()` if no user (`:30`).
- `resolveAdminShellAccess(userId)` (`src/lib/rbac/authorize.ts:127-134`) → `notFound()` if the user holds **zero** permissions (`:32`). This keeps all admin routes undiscoverable to non-staff. It returns `grantedKeys`: `null` for the wildcard super-admin (sees everything), otherwise the fully-expanded list of concrete `<module>:<action>` keys the user holds.
- Resolves the sidebar logo (`admin.theme.logo_media_id` → `site.logo_media_id` → bundled `/tokyo-logo.png`, `:40-48`) and a runtime feature gate: when the loyalty program is OFF, `/admin/marketing/loyalty/rewards` is added to `hiddenHrefs` (`:51-52`).
- `<ClearStorefrontDark/>` (`src/app/admin/_components/clear-storefront-dark.tsx`) clears the storefront `dark` class so dark storefront state can't bleed into admin chrome via bfcache.

`AdminShell` (`admin-shell.tsx:347`) is `"use client"` and **purely presentational** — all real enforcement is server-side. It holds the master nav definition `NAV_GROUPS` (`:107-323`), a hardcoded array of 10 groups. Key behaviors:
- **Nav visibility** is computed in `visibleGroups` (`:392-407`) via `isNavItemVisible(item, grantedKeys)` (`src/lib/rbac/nav-access.ts:112-121`): an item shows when the user holds `<item.id>:view`, OR — for items whose page guard is not `<id>:view` — when they hold any grant in the item's explicit `visibleWhen` list. `grantedKeys === null` (super-admin) shows everything. Empty groups are dropped. `hiddenHrefs` then removes feature-gated links.
- **Active link** uses a longest-prefix match (`isNavActive`, `:332-345`) so nested routes (e.g. `/admin/orders/returns`) don't light up their parent.
- **Accordion sidebar**: first group flat, rest collapsible; collapse-to-rail; mobile drawer with signout (`signoutAction` from `@/lib/actions/auth`).
- **Bare passthrough for printable routes** (`:387-390`, `:446`): invoice / delivery-note / stock-transfer-print routes render with no sidebar/header so the chrome never leaks onto the PDF. Regex: `/^\/admin\/orders\/[^/]+\/(invoice|delivery-note)$/` and `/^\/admin\/catalog\/stock\/transfers\/[^/]+\/print$/`.
- The topbar page title is derived from the active nav item's label (`activeTitle`, `:414-419`).

**Critical invariant (documented in the code):** nav `id`s map 1:1 to the RBAC permission registry, and each group's `label` must match the registry module's `group` field so the role editor mirrors the sidebar (`admin-shell.tsx:100-106`). An item's `visibleWhen` must be the SAME constant its page passes to `requirePermissionAny` — see the shared constants in `nav-access.ts` (`ORDER_NEW_VIEW_GRANTS:35`, `LOYALTY_REWARDS_VIEW_GRANTS:48`, `USER_SETTINGS_VIEW_GRANTS:63`, `IMPORT_DATA_VIEW_GRANTS:79`). Nav and page guard read one list so they cannot drift.

### 2. RBAC gating model (how access is enforced)

- **Registry = source of truth**: `src/lib/rbac/registry.ts`. A permission is `<module>:<action>`; `module` equals the nav id, `action` ∈ `["view","create","update","delete","manage","export","roles","policy"]` (`:36`). `PERMISSION_MODULES` (`:54-193`) lists every module with its allowed actions and group. Adding a privilege is a one-line edit — no migration (the DB stores only grants). Grants may be `*` (super_admin), `<module>:*`, or `<module>:<action>`.
- **Engine**: `src/lib/rbac/authorize.ts`. `resolveUserPermissions(userId)` (`:45-55`) is React-`cache()`d (one DB hit per request) and computes effective set = `union(role grants) ∪ allow − deny` via the per-user overlay (`applyPermissionOverlay`, `src/lib/rbac/overlay.ts`). A disabled account → empty set. `permissionSetAllows` (`:86-94`) honours wildcards.
- **Page guards**: `src/lib/auth/session.ts`. Every admin page calls one of:
  - `requirePermission(module, action)` (`:125-139`) — 404s on deny and records a security-trail event for authenticated staff (`emitPermissionDenied`, `:20-30`).
  - `requirePermissionAny([...])` (`:147-164`) — OR over grants (used by orders/new, users/settings, loyalty/rewards, import-data).
  - `requireAdminArea()` (`:104-116`) — any-grant gate, ONLY for the dashboard (`/admin`) and the Système index (`/admin/system`), which render no isolated module data (dashboard gates each block, system index is just tiles). An allow-list of these is kept in `route-invariants.test.ts`.
- **Super-admin step-up**: `src/lib/auth/super-admin.ts`. `isSuperAdmin`/`checkSuperAdmin` require the `*` wildcard on top of a module grant for irreversible store-wide ops (the import-data purge; payment credentials are super-admin-only to EDIT — a delegate sees them read-only, `system/payments/page.tsx:63-65`).
- **Dashboard sub-gating**: `src/lib/rbac/dashboard-access.ts` — `dashboard:view` is a master switch; each block additionally needs the view grant of the module it summarises (revenue→analytics, orders→orders, new customers→customers, low-stock→stock|products, reviews→reviews). Hidden blocks' queries are skipped (`src/app/admin/page.tsx:64-109`).

**Read/write pattern (uniform across sections):** the page `requirePermission(module,"view")`, then resolves extra grants for UI honesty (e.g. `canUpdate`/`canManage`) so a view-only operator never sees a control whose action would 404 mid-flow (`catalog/products/page.tsx:77-79`, `media/page.tsx:31-36`, `orders/[id]/page.tsx:118-123`). Data is fetched in RSC via module queries/services and `getSettingsMap()` (the `site_settings` key-value store). Mutations go through Server Actions in `src/lib/actions/*` (85 files; **75 re-call `requirePermission`**, **65 import `@/workflows`**). Settings pages persist via `workflows.cms.upsertSetting`; secrets are encrypted at rest (`decryptSecret`), and a set env var force-overrides+locks the matching field (`system/payments/page.tsx`).

### 3. Full hierarchical tab map (sidebar groups → pages → RBAC guard)

Guard shown as `module:action`; `ANY(...)` = `requirePermissionAny`; `area` = `requireAdminArea`.

**① Tableau de bord**
- `/admin` — `area` (blocks gated per `dashboard-access.ts`) · `src/app/admin/page.tsx`
- `/admin/analytics` — `analytics:view`

**② Catalogue**
- `/admin/catalog/products` — `products:view` · workspace with 3 views: product list, "Réglages catalogue" header button (`products:update`, panel from `system/catalog/catalog-settings-panel`), bulk AI generation (`products:manage`). Sub-pages: `/new` (`products:create`), `/[id]` (`products:view`; promotions panel needs `promotions`).
- `/admin/catalog/stock` — `stock:view` · tabbed (`?tab=emplacements` = multi-location CRUD, formerly `/catalog/locations`). Transfers: `/catalog/stock/transfers/[id]/print` (`stock:view`, **bare printable**).
- `/admin/catalog/collections` — `collections:view` · `/new` create, `/[id]` update
- `/admin/catalog/categories` — `categories:view` · `/new` create, `/[id]` update
- `/admin/catalog/brands` — `brands:view` · `/new` create, `/[id]` update
- `/admin/catalog/drip` — `products:view` (release/exclusivity config; reuses `products` id)
- `/admin/catalog/gift-cards` — `products:view` (issued bearer cards; reuses `products` id)
- `/admin/catalog/attributes` — `attributes:view` · `/new` create, `/[id]` view
- `/admin/catalog/reviews` — `reviews:view`
- `/admin/media` — `media:view` (sub-tabs: library / orphans / réglages; réglages subtab needs `system_media:view`). `/media/settings` — `system_media:view`

**③ Commandes**
- `/admin/orders/new` — `ANY(orders_new:view, orders:manage)` (manual/remote order entry)
- `/admin/orders` — `orders:view` · `/[id]` (`orders:view`; conditionals for `orders:manage`/`update`/`returns:manage`), `/[id]/invoice` & `/[id]/delivery-note` (`orders:view`, **bare printable**), `/export` (CSV **route.ts**, orders:view)
- `/admin/cart` — `cart:view` (read-only diagnostic) · `/[id]` `cart:view`
- `/admin/orders/returns` — `returns:view` · `/returns/expedition` `returns:view`
- `/admin/promotions` — `promotions:view` · `/new` create, `/[id]` view
- `/admin/system/payments` — `system_payments:view` (credentials edit = super-admin)
- `/admin/system/express` — `system_express:view`
- `/admin/system/delivery` — `system_delivery:view`
- `/admin/system/tax` — `system_tax:view`
- `/admin/system/currency` — `system_currency:view`
- `/admin/system/checkout` — `checkout:view`

**④ Rendez-vous** (all `appointments:view`; mutations split: moderation=`manage`, réglages=`update`)
- `/admin/rendez-vous` · `/rendez-vous/moderation` · `/rendez-vous/reglages`

**⑤ Clients**
- `/admin/customers` — `customers:view` · `/[id]` `customers:view`
- `/admin/customers/guests` — `invites:view`
- `/admin/customers/favorites` — `favorites:view`
- `/admin/marketing/segments` — `promotions:view` (reuses `promotions` id)
- `/admin/marketing/loyalty` — `loyalty:view`
- `/admin/marketing/loyalty/rewards` — `ANY(loyalty:update)`; runtime-hidden when program off
- `/admin/newsletter` — `newsletter:view`
- `/admin/users/settings` ("Connexion & comptes" shortcut) — `ANY(users:view, users:policy, system_auth:view)` (panels: session policy `users:policy`, auth/social `system_auth:update`)

**⑥ Entreprises** (B2B; all `businesses:view`; stays visible when feature off to allow enabling)
- `/admin/businesses` · `/[id]` · `/businesses/levels` · `/businesses/applications` · `/businesses/stats` · `/businesses/settings`

**⑦ Contenu & Design**
- `/admin/cms/home` — `home:view`
- `/admin/cms/pages` — `pages:view` · `/[id]` view
- `/admin/cms/banners` — `banners:view` · `/[id]` view
- `/admin/cms/showcase` — `showcase:view`
- `/admin/cms/trust-badges` — `trust_badges:view`
- `/admin/cms/nav-menu` — `navigation:view` (header menu + featured images; editor `_components/nav-menu-editor.tsx`)
- `/admin/cms/footer` — `navigation:view` (footer columns + newsletter banner)
- `/admin/cms/theme` — `settings_theme:view`
- `/admin/cms/settings` — `settings_site:view`

**⑧ Blog**
- `/admin/blog/posts` — `blog_posts:view` · `/new` create, `/[id]` view
- `/admin/blog/categories` — `blog_cats:view` · `/[id]` view
- `/admin/blog/tags` — `blog_tags:view`
- `/admin/blog/authors` — `blog_authors:view` · `/new` create, `/[id]` update
- `/admin/blog/comments` — `blog_comments:view`

**⑨ Système**
- `/admin/users` — `users:view` · `/[id]` view, `/[id]/access` **`users:roles`** (grant assignment/overlay), `/users/roles` view
- `/admin/system/ai` — `system_ai:view` (encrypted provider keys; embeddings config)
- `/admin/marketing/mailing` — `system_mail:view` (provider/templates/automations/logs/campaigns)
- `/admin/system/jobs` — `system_jobs:view` (internal+external crons)
- `/admin/system/seo` — `system_seo:view`
- `/admin/system/redirects` — `system_redirects:view` (incl `?tab=maintenance` = site-mode/launch countdown)
- `/admin/system/cookies` — `system_cookies:view`
- `/admin/system/analytics` — `system_analytics:view` (tracking tags)
- `/admin/system/search` — `system_search:view`
- `/admin/system/audit` — `system_audit:view` · `/audit/export` (CSV)
- `/admin/system/import-data` — `ANY(system_import:view, system_demo:view)`; purge = super-admin `*`
- `/admin/system` (index tiles) — `area`

**⑩ Infrastructure** (read-only diagnostics)
- `/admin/system/api` — `system_api:view` · `/database` `system_database:view` · `/resources` `system_resources:view` · `/performance` `system_performance:view` · `/security` `system_security:view`

### 4. Redirect stubs (kept for old bookmarks, NOT in nav)
- `/admin/system/auth` → `/admin/users/settings` (308)
- `/admin/system/import` → `/admin/system/import-data` (308)
- `/admin/system/import-demo` → `/admin/system/import-data` (308)
- `/admin/system/catalog` → `/admin/catalog/products`
- `/admin/catalog/locations` → `/admin/catalog/stock?tab=emplacements`

These are pure `permanentRedirect`/`redirect` stubs with no guard (the target carries it). Safe to keep; safe to delete only if you're certain no external links/bookmarks exist.


<details>
<summary><strong>14. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- src/app/admin/layout.tsx — segment gate + nav scoping (grantedKeys, hiddenHrefs, logo)
- src/app/admin/_components/admin-shell.tsx — NAV_GROUPS master nav + accordion/rail/bare-printable logic
- src/app/admin/_components/clear-storefront-dark.tsx — one-shot dark-class clear
- src/lib/rbac/registry.ts — PERMISSION_MODULES/ACTIONS, the privilege source of truth
- src/lib/rbac/nav-access.ts — nav↔guard parity + shared OR-grant constants
- src/lib/rbac/authorize.ts — resolveUserPermissions, resolveAdminShellAccess, permissionSetAllows
- src/lib/rbac/dashboard-access.ts — per-block dashboard gating matrix
- src/lib/auth/session.ts — requirePermission / requirePermissionAny / requireAdminArea gates
- src/lib/auth/super-admin.ts — isSuperAdmin/checkSuperAdmin step-up for irreversible ops
- src/lib/actions/*.ts — 85 Server Action files (75 re-gate, 65 call @/workflows)
- src/app/admin/page.tsx — dashboard RSC, block-gated KPIs/charts
- src/app/admin/system/page.tsx — Système index tile grid
- src/components/admin/ — shared admin UI (page-header, forms, pager, media-picker, charts)
- src/app/admin/cms/_components/nav-menu-editor.tsx — header/nav builder UI

**Models / tables**

- role_permissions (role→permission grants; read by rbacService.listPermissionsForUser)
- user_permission_overrides (per-user allow/deny overlay; applyPermissionOverlay)
- roles (role definitions edited via /admin/users/roles, users:roles)
- users / auth tables (authService.findById; disabledAt enforced live)
- site_settings (CMS key-value store; getSettingsMap + workflows.cms.upsertSetting — backs most settings pages)
- NOTE: the admin segment defines no tables itself; it is a consumer of every module's schema via queries/services and workflows

**Sources of truth**

- src/lib/rbac/registry.ts PERMISSION_MODULES — the authoritative list of admin modules/actions; nav ids and group labels must match it
- src/app/admin/_components/admin-shell.tsx NAV_GROUPS — the authoritative sidebar structure (what tab exists, under which group, with which id)
- site_settings table via getSettingsMap() + workflows.cms.upsertSetting — the backing store for nearly all settings pages (payments, auth, SEO, analytics, checkout, theme, etc.)
- DB tables role_permissions + user_permission_overrides (+ roles, users) — the live grants that resolveUserPermissions reads; revoking takes effect next request
- src/lib/rbac/nav-access.ts shared grant constants (ORDER_NEW/LOYALTY_REWARDS/USER_SETTINGS/IMPORT_DATA_VIEW_GRANTS) — one list read by both the sidebar visibleWhen and the page's requirePermissionAny
- route-invariants.test.ts — the allow-list of pages permitted to use requireAdminArea instead of a module guard

**Editable / removable**

- Sidebar grouping/labels/icons/order in NAV_GROUPS (admin-shell.tsx:107-323) are purely visual — regrouping is safe and changes only the blocks, NOT the ids/grants. But every item.id MUST stay a real registry id and every group.label should match the registry group field or the role editor mislabels the capability.
- To REMOVE a section safely: delete its NAV_GROUPS item(s) AND its page files AND (if the module is now unused) its registry entry. Leaving a registry module with no page is harmless; leaving a nav item whose page is gone yields a 404 link (nav is keyed by href, so duplicate ids are fine).
- Reused-id items (Drip, Gift-cards reuse `products`; Segments reuse `promotions`; B2B/RDV items share one id) are load-bearing: the duplicate id only feeds the visibility gate because the shell keys links by href — do not 'dedupe' the ids.
- Redirect stubs (system/auth, system/import, system/import-demo, system/catalog, catalog/locations) are safe to keep; delete only if no external bookmarks rely on them.
- Bare-printable route regexes (admin-shell.tsx:387-390) are load-bearing: renaming invoice/delivery-note/transfers-print routes without updating the regex re-introduces admin chrome into printed PDFs.
- Per-page UI-honesty perm resolution (canUpdate/canManage) can be edited freely — it only hides controls; the Server Action is the real gate. Never rely on it for security.
- The admin layout's whole-segment gate and each page's own requirePermission are BOTH load-bearing (defense in depth) — do not drop the per-page guard assuming the layout covers it; the layout only checks area access.

**Gaps / risks**

- Registry modules with NO sidebar page: `warranty` (Garanties) and `credit` (Crédit client) are defined in registry.ts:106,133 and grouped (Commandes/Clients) but have no /admin/warranty or /admin/credit page — warranty lives at the /api/warranty-claims scope + order lookups, credit on the customer fiche. The role editor will show these capabilities with no corresponding nav tab. Confirm this is intentional before 'cleaning up'.
- `system_media` (Médiathèque réglages) is a registry module whose only UI is the Media page's réglages sub-tab + /admin/media/settings — not a standalone nav item; easy to overlook when auditing tabs.
- Nav/registry drift is only partially test-guarded: the code comments assert parity but enforcement depends on route-invariants.test.ts and the shared nav-access constants. Editing a page's guard without updating its NAV_GROUPS visibleWhen (or vice-versa) can silently create links that 404 or hide reachable pages.
- Many mutating Server Actions re-gate (75/85) but 10 action files do NOT call requirePermission directly — verify each either is a pure helper (types.ts, coerce.ts) or gates via another mechanism (e.g. super-admin check, keyed API) before assuming all writes are guarded.
- Settings pages deliberately do NOT fail-soft on their settings read (no .catch) so a swallowed read can't persist code-defaults over live config (noted in payments/users-settings). When adding a settings page, follow this: catch only reads that don't pre-fill a save form.
- The Système index (system/page.tsx) tile list is a SEPARATE hand-maintained array from NAV_GROUPS — adding/removing a Système page requires updating both, and the tiles are NOT RBAC-filtered (every tile shows to any area-access user; the target page 404s on deny).
- Sidebar group count is 10 and several groups exceed the documented '~8-item soft cap' (Commandes, Catalogue); the Système/Infrastructure split exists to relieve this — keep it in mind when adding tabs.

</details>


---

## 15. Build, Config, Ops, Scripts & Tests-as-Contract

This is the non-feature plumbing: how the app compiles, boots, is configured, is deployed, and how its contract is enforced. The governing principle throughout is **single-source config** (one literal shared by `next.config.ts` and the admin diagnostics tabs so displayed config can't drift from served config) and **tests-as-contract** (there is no OpenAPI; the test suite under `src/lib/db/tests/**` *is* the spec).

### (a) Build & static config

**`next.config.ts`** (`next.config.ts:14`) — the heart of build config. Key facts:
- **Type-checking is decoupled from bundling**: `typescript.ignoreBuildErrors: true` (`next.config.ts:35`). This is NOT "type safety off" — the `Dockerfile` runs `tsc --noEmit` as a *separate* layer after the build (`Dockerfile:115`) so peak memory never stacks. Next 16 never lints during build; `pnpm lint` is its own step.
- **Build runs on WEBPACK, not Turbopack**: `package.json` pins `"build": "next build --webpack"` (`package.json:7`); dev uses `--turbopack` (`package.json:6`). Rationale (`Dockerfile:9-16`): Turbopack's working set is native Rust memory that `--max-old-space-size` cannot bound → silent OOM kill on the memory-constrained Coolify VPS. Webpack's heap is V8-bounded. `build:turbo` exists as an escape hatch (`package.json:8`).
- **`serverExternalPackages: ["isomorphic-dompurify", "jsdom"]`** (`next.config.ts:46`) — keeps jsdom's `fs.readFileSync(__dirname+…)` asset loads working at runtime (webpack rewrites `__dirname` otherwise → `ENOENT default-stylesheet.css`).
- **Redirects** (`next.config.ts:59`): 308 permanent redirects for the URL restructure — `/category/:slug`→`/:slug`, `/product/:slug`→`/:slug`, and `/niveaux-avantages`→`/fidelite`. This is where legacy-URL compatibility lives.
- **Security headers / CSP** (`next.config.ts:91`) are built by `buildSecurityHeaders()` from `src/lib/security/headers.ts` — the SAME source the admin Security tab reads. CSP is **compiled at `next build`** from `S3_PUBLIC_URL`/`MEDIA_CDN_URL`/`CSP_EXTRA_HOSTS`, which must therefore be **Docker build arguments** — changing them needs a rebuild, not a restart.
- **Image config** (`next.config.ts:113`): `buildRemotePatterns()` whitelists YouTube + the S3/CDN hosts from env; `dangerouslyAllowLocalIP` auto-enables only when `S3_PUBLIC_URL` is a private/loopback host (`s3PublicUrlIsLocal()`, `next.config.ts:288`) so dev/staging work but prod keeps Next 16's image-optimizer SSRF guard.
- **`env` block** (`next.config.ts:124`): inlines `NEXT_PUBLIC_SITE_URL` + `BUILD_S3_PUBLIC_URL`/`BUILD_MEDIA_CDN_URL`/`BUILD_CSP_EXTRA_HOSTS` — build-time snapshots so runtime CDN-allowlist checks (`src/modules/media/cdn-allowlist.ts`) compare against what was actually compiled.
- **`experimental`** (`next.config.ts:163`): `useCache: true` (incremental `'use cache'` adoption WITHOUT the full Cache Components model — `cacheComponents` stays OFF, see the long rationale at `next.config.ts:139`); `webpackMemoryOptimizations: true`; `proxyClientMaxBodySize`/`serverActions.bodySizeLimit` both = 16mb; `staleTimes`; `optimizePackageImports: ["lucide-react"]`.

**`src/lib/config/next-runtime.ts`** — the single-source module behind the above. Exports literals `STALE_TIMES {dynamic:30, static:300}`, `PROXY_CLIENT_MAX_BODY "16mb"`, `SERVER_ACTION_BODY_LIMIT` (aliased to the proxy cap), `IMAGE_FORMATS ["image/avif","image/webp"]`, `IMAGE_MIN_CACHE_TTL 2_592_000` (30 days), `NEXT_OUTPUT "standalone"`, `NEXT_COMPRESS true`, `CACHE_COMPONENTS false`. Imported by both `next.config.ts` and the admin Infrastructure→Performance tab. **16 MB is a coupled constant** — raising `PROXY_CLIENT_MAX_BODY` requires also raising `MAX_UPLOAD_MB_CEILING` in `src/modules/media/limits.ts` (`next-runtime.ts:28`).

**`tsconfig.json`**: `target ES2022`, `strict`, `noEmit`, `moduleResolution: bundler`, path alias `@/* → ./src/*` (`tsconfig.json:27`), includes `.next/types/**` + `.next/dev/types/**` (so the post-build `tsc` sees generated types). `src/components/ui/**` is lint-ignored (shadcn).

**`eslint.config.js`** (flat config): `js.recommended` + `typescript-eslint.recommended` + prettier. Only `react-hooks/recommended` + `react/no-danger` (warn) + `react-hooks/set-state-in-effect` (warn, pending useSyncExternalStore refactor) are ON; next/jsx-a11y plugins are registered for *rule-name resolution in disable comments only* (`eslint.config.js:17`). `no-explicit-any` and `no-unused-vars` are warnings. Ignores `.next`, `node_modules`, `.claude/**` (agent worktrees — ~18k false errors otherwise), `.tmp/**`, `src/components/ui/**`. `scripts/**/*.mjs` get Node globals + `ban-ts-comment` off.

**`postcss.config.mjs`**: Tailwind v4 via the single `@tailwindcss/postcss` plugin — no `tailwind.config.js` exists (Tailwind v4 is CSS-first; theme lives in `src/app/globals.css`). **`components.json`**: shadcn "new-york" style, RSC on, baseColor slate, CSS vars, `css: src/app/globals.css`, `config: ""` (empty — confirms no JS tailwind config), lucide icons, aliases mirror tsconfig.

**`package.json` deps worth noting**: Next `^16`, React `^19.2`, Drizzle `^0.45`, better-auth `^1.4`, `pg`, `sharp ^0.34.5`, `@aws-sdk/client-s3`, `resend`+`nodemailer`, `isomorphic-dompurify`, `zod ^4`. **`pnpm.overrides`** (`package.json:86`) force-bump `postcss`/`esbuild` (build hygiene) and security-critical `dompurify >=3.4.12` (active anti-XSS control) + `undici >=7.28.0` — every range is top-bounded (a bare floor is NOT a pin). `sharp` is deliberately NOT force-bumped (0.34→0.35 native/libvips move needs a pipeline check). `browserslist` targets modern evergreen (Chrome/Edge ≥111, Safari ≥16.4) to drop ~12 KiB of polyfills. `packageManager: pnpm@9.15.0`.

### (b) Runtime plumbing

**`src/instrumentation.ts`** — Next 16 `register()`, runs once per server boot before any route. Guards `NEXT_RUNTIME === "edge"` by *inverse* check (standalone doesn't reliably set `="nodejs"`, `instrumentation.ts:14`). Lazily imports and runs (each wrapped in try/catch so a boot task failing never crashes the server): `ensureDefaultAdmin` → `ensureSystemContentPages` → `ensureSystemNavMenus` → `ensureHeaderNavRoots` → `ensureMaisonRendezvousLink` → `registerAllSubscribers` (event bus listeners — telemetry + cache invalidators) → `startReviewScheduler` (self-contained AI-review timer, no external cron) → `startRuntimeSampler` (RAM/CPU/event-loop/DB-latency metrics). Installs a **graceful-drain SIGTERM/SIGINT handler** (`instrumentation.ts:108`) that drains the review scheduler, stops the sampler (marks the instance cleanly stopped so a redeploy isn't counted as downtime), then `closePool()`.

**`src/proxy.ts`** — Next 16's middleware replacement, runs on Edge. **This is the only middleware** (no `middleware.ts` exists). Env/cookie-only, NO DB (real authz is per-page RBAC). Three jobs: (1) cookie gate for `/admin` + `/account` segments — missing session on `/account` → 302 `/login`; on `/admin` → 404 if a secret `ADMIN_LOGIN_PATH` is set (a redirect would leak the slug), else 302 `/admin-login`; (2) rewrite of the secret admin-login path to the physical `/admin-login` route + 404 the default; (3) markdown content-negotiation (`.md` suffix or `Accept: text/markdown`) → rewrite to `/md` route. Every forwarded request is stamped with `SITE_PATH_HEADER` on a clone (`proxy.ts:60`) so the `(shop)` layout can exempt auth pages from the maintenance gate (client can't spoof it). Session cookies are `gz.session_token` / `__Secure-gz.session_token` — **the legacy `gz.` prefix is load-bearing** (`proxy.ts:43`). Matcher excludes `_next/static`, `_next/image`, `favicon.ico`, `images/`, `api/auth`, `robots.txt`, `sitemap.xml` (`proxy.ts:144`).

**`src/lib/bootstrap/`** — idempotent insert-if-missing boot seeders (never clobber admin edits): `default-admin.ts` (creates `DEFAULT_ADMIN_EMAIL` with a random password printed to the container log on first boot; burns the bootstrap token once an admin exists), `system-content-pages.ts` + `.data.ts` (64KB of Maison/policy/CGV page copy), `system-nav-menus.ts`, `header-nav-roots.ts` (one-time materialize of mega-menu roots, gated by a `nav.header.materialized` flag), `maison-rendezvous-link.ts` (one-time patch).

**`src/lib/env.ts`** — Zod env validation, **lazy** via a Proxy (`serverEnv`, `env.ts:452`) so `next build` page-data collection doesn't need prod env. `isBuildTime` (`NEXT_PHASE === "phase-production-build"`, `env.ts:46`) relaxes required strings to defaults during build; runtime enforces strictly. `optional()` helper (`env.ts:35`) preprocesses Coolify's empty-string blanks to `undefined`. **`assertProductionSecrets()`** (`env.ts:194`) is the prod boot guard: refuses to start if `S3_SECRET_KEY`/`S3_ACCESS_KEY` are dev placeholders, `BETTER_AUTH_SECRET` is weak (<40 chars, <16 distinct chars, or matches `isPlaceholderSecret`), or `DATABASE_URL`/`BETTER_AUTH_URL`/`NEXT_PUBLIC_SITE_URL` point at localhost / non-https. `S3_PUBLIC_URL` private-host is now only a warning (many valid topologies serve media via the `/cdn` proxy).

**`src/lib/db/client.ts`** — one pg `Pool` per process (HMR-safe via `globalThis.__gz_pool`). Pool max 12 prod / 5 dev, 10s statement timeout enforced **twice** (server `statement_timeout` startup param + client `query_timeout`, the latter covering the PgBouncer path). Startup `options` packet sets `idle_in_transaction_session_timeout=30000 -c lock_timeout=3000`. `withLongStatement(ms, fn)` (`client.ts:192`) runs legitimate long jobs on a dedicated out-of-pool connection with `SET LOCAL statement_timeout`. `POOL_CONFIG` is exported for the Database diagnostics tab. Tunables read directly from `process.env` via `posIntEnv` (`src/lib/db/env-num.ts`, hardened against Coolify blank-string → `Number("")===0`).

**`src/app/api/health/route.ts`** — `GET /api/health` is a static 200 liveness probe (never touches env/DB — the Docker/compose HEALTHCHECK points here). `?ready=1` is an opt-in readiness probe: validates env + runs `SELECT 1` (2s timeout), 503 on failure, result cached 5s with in-flight de-dup so a probe flood can't drain the pool.

### (c) Environment variables (`.env.example`, `.env.coolify.example`)

Groups (full enumeration in `.env.example`):
- **Site**: `NEXT_PUBLIC_SITE_URL` (build-arg, baked), `CSP_EXTRA_HOSTS` (build-arg), `NEXT_PUBLIC_BUILD_SHA`.
- **Database**: `DATABASE_URL` (dev default `postgresql://tokyo:tokyo_dev_pwd@localhost:5434/tokyo`), `MIGRATION_DATABASE_URL` (direct URL for migrator — must bypass PgBouncer), `DB_SSL_CA`, pool tunables `DB_POOL_MAX`/`DB_STATEMENT_TIMEOUT_MS`/`DB_IDLE_TIMEOUT_MS`/`DB_CONNECTION_TIMEOUT_MS`/`DB_KEEPALIVE`/`DB_APPLICATION_NAME`.
- **Auth**: `BETTER_AUTH_SECRET` (auto-generated+persisted to `app_secrets` in Coolify — leave empty), `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`.
- **Social login**: `GOOGLE_CLIENT_ID/SECRET`, `FACEBOOK_CLIENT_ID/SECRET` (env force-overrides the encrypted admin value).
- **Payment (Tunisia)**: `PAYMENT_ENCRYPTION_KEY` (auto-gen, AES-256-GCM for secrets at rest — do NOT rotate once secrets stored), `CLICTOPAY_USERNAME/PASSWORD/TEST_MODE` (Monétique Tunisie/SMT), `FLOUCI_APP_TOKEN/APP_SECRET/TEST_MODE`. Amounts sent in **millimes** (no scaling — matches the app's internal unit).
- **AI**: `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (also encrypted-admin-configurable; semantic search reuses these, only OpenRouter/OpenAI can embed, requires pgvector image).
- **Admin/bootstrap**: `DEFAULT_ADMIN_EMAIL` (default `houssem@kawn.me`), `DISABLE_DEFAULT_ADMIN`, `ADMIN_BOOTSTRAP_TOKEN` (one-shot), `ADMIN_LOGIN_PATH` (secret staff-login slug).
- **Cron**: `CRON_SECRET` (bearer for `/api/cron/retention` etc; unset → 503), `CRON_ALLOWED_IPS` (defence-in-depth IP allowlist), `ABANDONED_ORDER_HOURS`/`PAYMENT_RECONCILE_STALE_MINUTES`/`PAYMENT_RECONCILE_MAX_AGE_HOURS`.
- **Email**: `EMAIL_PROVIDER` (`resend`|`smtp`|`internal`|`console`, dev default console), `EMAIL_FROM`, `EMAIL_REPLY_TO`, `RESEND_API_KEY`, `SMTP_*`, `SENDMAIL_PATH`.
- **Storage (SeaweedFS/S3)**: `S3_ENDPOINT`/`S3_REGION`/`S3_BUCKET`(tokyo)/`S3_ACCESS_KEY`/`S3_SECRET_KEY`/`S3_FORCE_PATH_STYLE`/`S3_PUBLIC_URL`, `MEDIA_CDN_URL` (fallback CDN base; admin `media_settings.cdn_base_url` is primary).
- **Misc**: `REVIEW_SCHEDULER_TICK_MS`.

`.env.coolify.example` maps these to Coolify's `${SERVICE_PASSWORD_*}`/`${SERVICE_USER_*}` auto-generated magic vars (`PUBLIC_URL`, `SERVICE_PASSWORD_POSTGRES`, `SERVICE_USER_SEAWEEDFS`, `SERVICE_PASSWORD_SEAWEEDFS`) and stresses that `NEXT_PUBLIC_SITE_URL`/`S3_PUBLIC_URL`/`MEDIA_CDN_URL`/`CSP_EXTRA_HOSTS` must ALSO be set as **Build Arguments**.

### (d) Docker & deploy

**`Dockerfile`** — 3-stage (deps/builder/runner), standalone output, ~140-180 MB. Builder: `pnpm build` (webpack) then `tsc --noEmit` as a separate memory-isolated layer, then esbuilds `migrate.ts`+`init-secrets.ts` into self-contained **CJS** bundles (`--format=cjs`, `--external:pg-native`) because `pg` uses dynamic `require()` of Node builtins that ESM bundling breaks (`Dockerfile:120`). `NODE_BUILD_MEMORY` build-arg (default 4096) is a V8 heap ceiling — the long comment (`Dockerfile:77-101`) explains the OOM-kill-vs-clean-heap-error diagnosis: LOWER it on a small box that gets SIGKILL'd, RAISE only on a clean "JavaScript heap out of memory". Runner: non-root `nextjs:nodejs` uid 1001, inline heredoc **`entrypoint.sh`** that (1) optionally applies `NODE_RUNTIME_MEMORY`, (2) runs `migrate.cjs`, (3) captures-then-evals `init-secrets.cjs` output (a bare `eval "$(…)"` under `set -e` would swallow failures and boot without secrets — `Dockerfile:199`), (4) `exec node server.js`. HEALTHCHECK hits `/api/health` with a 120s `start_period` (cold boot = migration + secret bootstrap + admin creation + JIT = 60-90s).

**`docker-compose.dev.yml`** (project name `tokyo-dev`) — `pnpm db:up` starts:
- **postgres** (`tokyo-postgres`): built from `docker/pgvector/Dockerfile` (Postgres 16.14-alpine + pgvector 0.8.0), tuned for a 4vCPU/8GB dev box, mapped to host **:5434** (avoids colliding with local 5432/5433), volume `tokyo_pgdata`.
- **pgbouncer** (`tokyo-pgbouncer`, `--profile pooler` only): transaction-mode pooler on :6432, client pool 200 / server 25, `IGNORE_STARTUP_PARAMETERS` lists the timeout GUCs the app's pool forwards.
- **seaweedfs** (`tokyo-seaweedfs`): single `weed server` (master+volume+filer+S3), S3 API :8333, filer :8888, volume `tokyo_seaweedfs`, entrypoint bind-mounted from `docker/seaweedfs/entrypoint.sh`.

**`docker-compose.coolify.yml`** — the single paste-into-Coolify stack: `app` (built from Dockerfile, `read_only` rootfs + tmpfs for `/tmp` and `.next/cache`, `cap_drop: ALL`, `no-new-privileges`), `postgres` (same pgvector image, prod tuning incl. `pg_stat_statements`, JIT thresholds, LZ4 TOAST), `seaweedfs` (identities config **INLINED** not bind-mounted — Coolify rewrites relative bind sources, `docker-compose.coolify.yml:368`), `seaweedfs-init` (one-shot idempotent bucket create), `pgbouncer` (pooler profile). `MIGRATION_DATABASE_URL` always stays on direct `postgres:5432` even when `DATABASE_URL` moves to the pooler (migrator needs the session advisory lock). **Deploy-order gotcha** (`docker-compose.coolify.yml:240`): redeploy the DB on the pgvector image BEFORE the app deploy that runs `CREATE EXTENSION vector`.

**`docker/`**: `pgvector/Dockerfile` (builds pgvector v0.8.0 on the exact `postgres:16.14-alpine` base — same musl collation so it's a drop-in over existing volumes, no reindex) and `seaweedfs/entrypoint.sh` (renders `s3.json` identities from env each boot: an `app` identity with Admin/Read/Write/List and an `anonymous` identity with `Read:<bucket>` only — the `/cdn` proxy fetches unsigned; no anon LIST/WRITE).

### (e) `scripts/` directory

**Catalog generators (CI/contract-critical)** — `package.json: "gen:api-catalog"` runs both:
- `gen-internal-api-catalog.mjs` → rewrites `src/lib/api-auth/internal-api-catalog.ts` by parsing every `"use server"` export in `src/lib/actions/*.ts` (TS AST), deriving each action's RBAC permission from its guard calls. Completeness enforced by `internal-api-catalog.test.ts`.
- `gen-event-catalog.mjs` → rewrites `src/lib/api-auth/event-catalog.ts` by regex-scanning `src/events/types.ts` EventMap keys (the EventMap is a type with no runtime form). Enforced by `event-catalog.test.ts`.

**Tokyo rebrand / storefront-bridge scripts** (the in-repo swap plumbing):
- `tokyo-export-catalog.ts` — **the data bridge**: regenerates `src/storefront/data/{products,categories,taxonomy}.json` from the live DB (via `listApiProducts` + `categoryService`). Re-run after any catalogue change. Prices = major-unit dinars; images = same-origin `/cdn` URLs (CSP-safe).
- `tokyo-build-categories.ts` — builds the nested category tree from the Google-Merchant feed (using the importer's own `parseGoogleFeed`) and wipes the old watch-demo seed.
- `tokyo-import-feed.ts` — headless `startProductImportAction` equivalent (no admin session / 8MB cap); creates ~2.6k products + brands + downloads images through the SSRF-hardened sharp→webp/avif→SeaweedFS pipeline.
- `tokyo-seed-identity.ts` — OVERWRITES `site_settings` brand identity (name/tagline/SEO/contact) to Tokyo Store high-tech values.
- `tokyo-clean-page-meta.ts` — rewrites system `pages` meta from legacy watch/Sfax copy to high-tech (feeds `search_vector`).
- `tokyo-seed-appointments.ts` — seeds remote (phone/visio) rendez-vous location + brand-correct motifs.
- `tokyo-copy-bucket.mjs` — one-off S3 bucket copy for the infra rebrand.

**Seed / demo scripts**: `seed-demo.ts` (watch demo import workflow + waits on the job), `seed-editable-settings.ts` (exposes storefront copy as editable `site_settings`, idempotent), `seed-logo.ts` (ingests logo through the real media pipeline → `site.logo_media_id`), `seed-system-pages.ts` (dev FORCE re-seed of system pages), `seed-tokyo-design.ts` (seeds "Tokyo Lovable 2" design content — mega-menu banners, home blocks, loyalty levels via raw pg), `verify-seed.ts` (counts products/brands/cats/images), `export-content-snapshot.ts` (exports DB content → `public/demo-assets/tokyo-content.json` with `@@IMG:<stem>@@` media-remap tokens for the one-click Import-data feature), `patch-nav-fix.ts` (one-off nav de-dup repair).

**Maintenance / media**: `dedupe-product-images.ts` (collapses same-photo-different-resolution gallery dupes), `reprocess-product-white-bg.ts` (offline backdrop removal for pre-existing media). **ETL**: `etl-sth-stock.py` (Python/openpyxl; `.xlsx` stock workbook → `public/demo-assets/sth-stock.json` consumed by `src/workflows/data/sth-stock.ts`).

**`package.json` db:* scripts**: `db:up/down/logs` (compose), `db:generate` / `db:push` are **GUARDED** (`src/lib/db/scripts/guard-generate.ts` / `guard-push.ts` both `process.exit(1)` with instructions) — the Drizzle meta-snapshot chain is **frozen at `0007_snapshot.json`**; migrations 0008+ are hand-authored SQL with `_journal.json` entries but no snapshots (there are **202 migrations**, 6 snapshots). `db:generate`/`push` would diff against stale 0007 state and emit DESTRUCTIVE drops (incl. the barrel-absent `app_secrets`/`rate_limit_buckets`/`tmp_*` tables — `drizzle.config.ts:37` `tablesFilter` is a second layer). Escape hatches: `db:generate:force`/`db:push:force`. Real path: `db:migrate` (runs `src/lib/db/migrate.ts` — advisory-locked, retrying, direct-connection migrator). Also `db:init-secrets`, `db:studio`, `db:seed:catalog`, `db:bench:catalog`.

### (f) The test suite AS the contract

**296 `*.test.ts` files** under `src/lib/db/tests/`. There is **no OpenAPI, no vitest/jest** — each test is a standalone `tsx`-run script with a bespoke `check(label, cond)` idiom that tallies `passed`/`failed` and `process.exit(1)` on any failure. They run **sequentially** via giant `&&` chains in `package.json`.

**Two chains** (`package.json:26-33`):
- **`test:pure`** (`test:pure:1`/`:2`) — DB-free, network-free; run with only `--conditions=react-server`. Pure logic, parsing, static-AST invariants.
- **`test:db`** (`test:db:1`/`:2`/`:3`) — need a live DB; add `--env-file-if-exists=.env.local` so they hit the dev DB on :5434. They self-provision/clean fixtures with random UUIDs (no shared isolation harness; `external-api-contract` mutates + restores two global settings and warns "run against the isolated test DB only").
- **`test`** = `test:db && test:pure`. The split exists because Windows cmd.exe caps a command line at ~8191 chars, so chains are sub-numbered.

**`test-chain-integrity.test.ts`** is the meta-guard: asserts every file in the dir appears in **exactly one** chain, every reference resolves to a real file, and `test` runs both — this is what stops an orphaned (never-run) test from hiding a stale assertion.

**Categories present** (grouped from the chains):
- **security/rbac**: `rbac-escalation`, `rbac-last-admin`, `rbac-capping-matrix`, `privilege-escalation`, `auth-hardening`, `auth-policy`, `b2b-security`, `mailing-security`, `promo-security`, `payments-hardening`, `security-posture`, `security-helpers`, `ssrf-fetch`, `ssrf-ip-classifier`, `public-gating`, `identity-privacy`, `data-clean-scoping`, `settings-actor`, `settings-fail-closed`, `permission-overlay`, `oauth-autolink`, `sanitize-img`, `editorial-sanitize`, `redact`.
- **money / finance**: `money-format`, `tax`, `invoice-tax`, `business-tax`, `delivery-fee`, `recompute-totals`, `order-edit-money`, `discountable-subtotal`, `member-discount`, `revenue-buckets`, `credit-ledger`, `credit-checkout-settlement`.
- **catalog**: `catalog-admin`, `taxonomy`, `pdp-category`, `product-generation`, `product-discount`, `variant-match`, `variant-stock`, `listing-engine(-db)`, `attribute-*`, `catalog-deletion-fanout`, `stock-*`.
- **cms / content**: `cms-correctness`, `cms-admin`, `content-public`, `home-blocks-*`, `page-blocks-*`, `banner-*`, `nav-composer-*`, `footer-*`, `trust-badge-*`, `system-pages`, `blog`.
- **checkout / orders**: `checkout-parse`, `checkout-correctness`, `cart-*`, `order-*`, `confirm-payment-decision`, `quick-buy-payment`, `switch-to-cod`.
- **loyalty / b2b**: `loyalty-*`, `level-benefits`, `credit-*`, `cercle-*`, `tier-access`, `business-*`, `gift-card-*`.
- **mailing**: `mailing-dispatch-logging`, `mailing-flows(-consent)`, `mailing-drain`, `mailing-audience`, `mailing-campaign-send`, `mailing-newsletter-sync`, `mailing-unsubscribe`, `mailing-admin`.
- **api-contract (OpenAPI substitute)**: `external-api-contract` (the ERP/headless surface — scope matrix, keyed-caller auth, per-viewer cache headers, ERP order-link idempotency/409s, webhook kill-switch), `headless-api`, `erp-api`, `order-api`, `internal-api-catalog`, `event-catalog`, `payment-gateway-completeness`.
- **static invariants**: `route-invariants` (API catalog ⇔ disk parity, admin-nav ⊆ RBAC registry, nav⇔page-guard parity, every admin page + every server-action export opens with an RBAC guard as its first awaited call, owner-only step-ups still wired — all read from the TS AST so a guard name in a comment never counts); `wiring-matrix` (email-flow toggles gated, scheduled-jobs↔cron-route↔adapter parity, `["*"]` webhook subscription never gets auth/PII domains, settings read⇒write coverage, CMS audit-actor forwarding).

**REST source of truth**: `src/lib/api-auth/route-catalog.ts` (273 lines) classifies every `src/app/api/**` route into tiers `external` (key-required by default, admin-toggleable public reads, writes never public, each carries a concrete scope), `first-party` (same-origin + IP rate-limited), `infra` (auth catch-all, payment webhook, cron, admin-session). `route-invariants.test.ts` enforces catalog⇔disk both ways.


<details>
<summary><strong>15. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- next.config.ts:14 — webpack build, CSP/headers, images, redirects, experimental flags
- src/lib/config/next-runtime.ts — single-source runtime tunables (16mb cap, staleTimes)
- src/instrumentation.ts — boot seeders, subscribers, schedulers, SIGTERM drain
- src/proxy.ts — the only middleware (admin/account gate, md rewrite, gz. cookies)
- src/lib/env.ts:194 — lazy Zod env + assertProductionSecrets prod boot guard
- src/lib/db/client.ts — pg Pool, dual statement-timeout, withLongStatement
- src/lib/db/migrate.ts — advisory-locked direct-connection migrator (CJS-bundled)
- src/lib/db/init-secrets.ts — app_secrets bootstrap (BETTER_AUTH_SECRET etc.)
- src/lib/db/scripts/guard-generate.ts + guard-push.ts — block destructive drizzle-kit
- Dockerfile — 3-stage webpack build, separate tsc, entrypoint migrate+secrets
- docker-compose.dev.yml — tokyo-postgres:5434 / seaweedfs:8333 / pgbouncer:6432
- docker-compose.coolify.yml — single-paste prod stack, read-only rootfs, inlined seaweed config
- docker/pgvector/Dockerfile + docker/seaweedfs/entrypoint.sh — PG16.14+pgvector, S3 identities
- scripts/gen-internal-api-catalog.mjs + gen-event-catalog.mjs — regenerate the two catalogs
- scripts/tokyo-export-catalog.ts — storefront data bridge (DB → products/categories/taxonomy.json)
- src/lib/api-auth/route-catalog.ts — REST source of truth (273 lines, 3 tiers)
- src/lib/db/tests/route-invariants.test.ts — static RBAC/route AST invariants
- src/lib/db/tests/wiring-matrix.test.ts — registry⇔code wiring invariants
- src/lib/db/tests/external-api-contract.test.ts — the ERP/headless API contract (OpenAPI substitute)
- src/lib/db/tests/test-chain-integrity.test.ts — guards every test is wired into a chain
- src/app/api/health/route.ts — liveness (static 200) + ?ready=1 readiness
- src/lib/cron/guard.ts — shared /api/cron/* gate (rate-limit → IP allowlist → bearer)

**Models / tables**

- app_secrets (raw-SQL, outside schema barrel) — key/value/created_at; holds BETTER_AUTH_SECRET, PAYMENT_ENCRYPTION_KEY, ADMIN_BOOTSTRAP token + ADMIN_BOOTSTRAP_CLOSED flag
- rate_limit_buckets (raw-SQL, outside barrel) — used by src/lib/rate-limit (cron guard, etc.)
- tmp_* (transient import tables, outside barrel)
- drizzle.__migrations — the migrator's applied-SQL ledger (idempotency)
- site_settings — target of most seed-*/tokyo-* scripts (identity, home blocks, nav config, SEO); read⇒write coverage enforced by wiring-matrix
- media_settings.cdn_base_url — primary runtime CDN base (MEDIA_CDN_URL is only the build-baked fallback/allowlist)
- pages / nav_menus / nav_items — system content + nav seeded by instrumentation bootstrap and seed-system-pages/patch-nav-fix

**Sources of truth**

- next.config.ts + src/lib/config/next-runtime.ts + src/lib/security/headers.ts — build/runtime config, mirrored to admin diagnostics tabs
- src/lib/env.ts buildSchema() — the authoritative env-var contract (what's required vs optional, prod guards)
- .env.example + .env.coolify.example — documented env surface for dev vs Coolify
- src/lib/api-auth/route-catalog.ts — REST API surface (tiers, scopes, public-toggle keys)
- src/lib/api-auth/internal-api-catalog.ts (generated) + src/lib/actions/*.ts — internal write API
- src/lib/api-auth/event-catalog.ts (generated) + src/events/types.ts EventMap — bus events
- src/lib/db/migrations/*.sql + meta/_journal.json — hand-authored migration chain (202 migrations, snapshots frozen at 0007)
- src/lib/db/schema.ts (barrel) + src/modules/<m>/schema.ts — Drizzle schema (NOTE: app_secrets/rate_limit_buckets/tmp_* exist only as raw SQL, absent from barrel)
- src/lib/jobs/registry.ts SCHEDULED_JOBS (14) + src/app/api/cron/** — scheduled-job contract
- src/storefront/data/{products,categories,taxonomy}.json — (tokyo) storefront catalog snapshot, regenerated by tokyo-export-catalog.ts
- The test suite src/lib/db/tests/** — THE API contract (no OpenAPI); package.json test:pure/test:db chains
- app_secrets table — runtime-generated secrets (BETTER_AUTH_SECRET, PAYMENT_ENCRYPTION_KEY) persisted across redeploys

**Editable / removable**

- SAFE TO EDIT: next.config.ts redirects() (URL-compat 308s) — add/remove freely; but editing headers/images/CSP inputs requires a REBUILD in Docker (build-time compiled), not a restart.
- SAFE TO EDIT but COUPLED: src/lib/config/next-runtime.ts literals feed BOTH next.config.ts and admin tabs — 16mb cap is pinned to MAX_UPLOAD_MB_CEILING in src/modules/media/limits.ts; change both together.
- LOAD-BEARING, DO NOT CHANGE casually: the 'gz.' cookie prefix (src/proxy.ts:43), uuid-v7 PKs, millime money unit — legacy identifiers kept on purpose.
- LOAD-BEARING: typescript.ignoreBuildErrors:true is NOT a license to ship type errors — Dockerfile runs tsc --noEmit separately and FAILS the deploy on errors. Removing the separate tsc step silently drops type safety.
- LOAD-BEARING: build must stay `next build --webpack` (package.json:7) — switching to turbopack reintroduces the native-memory OOM-kill on constrained boxes.
- REMOVABLE (dev-only, not in deploy path): most seed-*.ts, verify-seed.ts, dedupe-product-images.ts, reprocess-product-white-bg.ts, tokyo-copy-bucket.mjs — one-off/dev tools; removing them does not affect prod boot (instrumentation.ts bootstrap seeders are the prod path).
- DEPENDED-ON (do not remove): scripts/gen-internal-api-catalog.mjs + gen-event-catalog.mjs — the catalogs they emit are test-enforced; a stale catalog fails internal-api-catalog.test.ts / event-catalog.test.ts.
- DEPENDED-ON: scripts/tokyo-export-catalog.ts regenerates the (tokyo) storefront's JSON data; the storefront reads the committed JSON, so edits to the live catalog need a re-run to appear in the new UI.
- DO NOT run db:generate / db:push (even the :force variants in prod) — the frozen-snapshot chain means they emit destructive drops incl. app_secrets. Add migrations by hand (NNNN_name.sql + _journal.json entry + schema edit + db:migrate).
- REMOVABLE WITH CARE: the pgbouncer service is behind the `pooler` profile (off by default) — only needed when scaling past 1 app instance; MIGRATION_DATABASE_URL must stay direct if enabled.
- When ADDING a test file: it MUST be appended to a package.json chain (test:pure/test:db:N) or test-chain-integrity.test.ts fails — and append to the LAST sub-script to respect the ~8191-char cmd.exe cap.
- When ADDING an api route or server action: update route-catalog.ts (routes) or re-run gen:api-catalog (actions) or route-invariants/internal-api-catalog tests fail; every admin page + server-action export must open with an RBAC guard (enforced by route-invariants).

**Gaps / risks**

- drizzle.config.ts:21 default DATABASE_URL still uses the LEGACY `tokyo:tokyo_dev_pwd@.../tokyo` credentials/db name — stale relative to the tokyo rebrand (every other default uses tokyo:tokyo_dev_pwd/.../tokyo). Harmless when DATABASE_URL is set, but misleading and a footgun for db:generate:force run without env.
- Dockerfile:55 builder ARG default S3_PUBLIC_URL still points at `.../tokyo` (legacy bucket path) vs the compose default `.../tokyo` — only a default (overridden by build args in real deploys) but another rebrand-residue inconsistency.
- env.ts:94 EMAIL_FROM default is '...@tokyostore.tn' while .env.example/.coolify use '...@tokyostore.com' — domain TLD mismatch across config sources; confirm the real sending domain before relying on either default.
- No automated test-DB provisioning: db tests run against whatever .env.local points at (the shared dev DB on :5434) and self-clean with random UUIDs; a crashed test mid-run (esp. external-api-contract which mutates global api-settings) can leave residue. There is no CI-managed ephemeral DB in-repo.
- Tests have no parallelism and run as one long sequential && chain (296 files) — full `pnpm test` is slow; a single early failure process.exit(1)s and aborts the rest of that sub-chain.
- The (tokyo) storefront catalog is a COMMITTED JSON snapshot (src/storefront/data/products.json ~1.4MB) regenerated only by manually re-running tokyo-export-catalog.ts — it can silently drift from the live DB; there is no runtime freshness check. This is intentional per the swap design but is a real staleness risk for the owner's edits.
- scripts/tokyo-build-categories.ts and tokyo-import-feed.ts hardcode an absolute feed path under /home/mhoussem/Desktop/... as the argv fallback — not portable; must pass the path explicitly on another machine.
- Migration meta snapshots are frozen at 0007 by design (202 migrations, 6 snapshots) — this is a deliberate but fragile setup: anyone running drizzle-kit generate/push outside the npm guards (e.g. a raw `npx drizzle-kit`) bypasses guard-generate.ts/guard-push.ts; only drizzle.config.ts tablesFilter (table-granular, not index-granular) protects the raw-SQL tables then.
- Many top-level .md docs (ANALYSIS.md, API.md, AUDIT-REPORT.md, FRONTEND-REPLACEMENT-ANALYSIS.md, PLAN.md, etc.) are untracked and may be stale planning artifacts — CODE is the source of truth; docs/ dir content was not verified here.
- seed-tokyo-design.ts header still says 'seed-tokyo-design.ts' in its usage line and the file is named seed-tokyo-design.ts — naming residue from the rebrand; functional but confusing.

</details>


---

## Appendix A — Master Sources of Truth

The authoritative location of every subsystem's state/config. When two places seem to hold the same fact, this is the one that wins. (DB table, `site_settings` key, const file, JSON snapshot, or the test suite.)

### 1. Storefront (Tokyo design) — pages, tabs & components

- Catalog display data: src/storefront/data/products.json (2595 items), categories.json (125), taxonomy.json — regenerated from the live DB by scripts/tokyo-export-catalog.ts & scripts/tokyo-build-categories.ts
- Design tokens: the .tokyo scope in src/app/globals.css:1197-1308 (light+dark); class recipes in src/storefront/components/storefront/ui-classes.ts
- Shipping fee/threshold shown in UI: backend checkout settings via getStorefrontShippingConfig() seeded in (tokyo)/layout.tsx through ShippingConfigProvider
- Footer/mentions-legales identity: backend site_settings via getAllSettingsServerOnly/getSiteContacts/getSiteLogoUrl
- Cart lines: backend cart (DB/guest-cookie) via @/lib/actions/cart; Favorites: backend wishlist via @/lib/actions/wishlist
- Orders: @/lib/actions/order (placeOrderFromCartAction, trackOrderAction); Account orders: listOrdersForUser; Auth: Better Auth + getAuthPagesConfig + workflows.auth
- Ratings/review counts/discount %: NOT a source of truth — synthesized deterministically in src/storefront/lib/productMeta.ts (fakeRating/fakeStrike)
- Nav-only shelves (Bons plans, Notre sélection, Nouveautés, Gift Cards, Précommande): src/storefront/lib/navAliases.ts NAV_ALIASES
- Legal/brand page copy: structured docs in src/storefront/content/*.ts
- Mega-menu structure: generated from taxonomy.json; curated icons/blurbs only in header.tsx UNIVERSE_META

### 2. Storefront Data Bridge, Catalog Snapshots & Client Libs

- Tokyo storefront catalogue DISPLAY data: the three JSON files in src/storefront/data/ (products.json, categories.json, taxonomy.json) — a point-in-time export, NOT live DB
- Upstream of those JSON files: the live PostgreSQL catalogue (categories/products/brands tables), read only by scripts/tokyo-export-catalog.ts
- Slug space: the backend-provided product/category slugs carried through the export into products.json/categories.json/taxonomy.json (catalog.ts prefers p.slug)
- Cart lines: live backend cart via @/lib/actions/cart (DB + gz.cart_token guest cookie / user) — NOT JSON, NOT localStorage
- Favorites: live backend wishlist via @/lib/actions/wishlist — NOT localStorage
- Shipping fee/threshold shown in storefront: getStorefrontShippingConfig() in src/lib/checkout/shipping.ts, seeded server-side in (tokyo)/layout.tsx
- Tokyo Care protection plan selection: client-only localStorage key 'tokyo-cart-plans-v1' (no backend persistence)
- Synthetic nav pages (bons-plans/nouveautes/etc.): hardcoded category-slug lists in src/storefront/lib/navAliases.ts
- Product ratings / strike-through discounts / warranty text: deterministic generators in src/storefront/lib/productMeta.ts (fabricated, not DB-backed)

### 3. Legacy (shell) storefront — what remains & retirement status

- Route existence = presence of page.tsx under src/app/(shop)/(shell)/** (no page.tsx = retired, e.g. panier/checkout/favoris/account-base)
- Which chrome renders = which layout owns the route: (shell)/layout.tsx imports @/components/site-header|site-footer (legacy); (tokyo)/layout.tsx imports @/storefront/components/storefront/* (new)
- boutique/marques/collections/fidelite page CONTENT = admin CMS settings via get*LandingConfig in src/lib/pages/*-landing-config.ts, edited from src/components/admin/*-landing-settings.tsx (boutique-, marques-, collections-, fidelite-landing-settings)
- Legacy→flat/Tokyo redirects: next.config.ts:59-83 (/category,/product,/niveaux-avantages→/fidelite) + per-page permanentRedirect shims (about, brand/[slug], mes-credits, blog/category)
- B2B visibility = isBusinessEnabled() feature flag (src/lib/business/config); public favorites = favoritesPublicEnabled() (off by default); loyalty = resolveLoyaltyConfig().enabled
- Checkout→confirmation contract = src/lib/actions/order.ts:1019 returns redirectUrl /order/${id}?fresh=1 (points at shell order/[id])
- Account order-history link contract = src/storefront/components/storefront/account-view.tsx:233 → /account/orders/${id}
- Feature data modules read by shell: modules/order, modules/blog, modules/business, modules/loyalty + associations/loyalty-referral.service, modules/wishlist, modules/catalog/{collection,brand,category}, modules/search, modules/cms/setting

### 4. Server Actions Layer (`src/lib/actions/**`) — the real storefront & admin mutation API

- ActionState shape: src/lib/actions/types.ts:17 (every action returns this)
- True mutation logic + zod validation: src/workflows/* (actions are thin adapters; 65/83 files delegate here)
- Authorization: resolved live per request by src/lib/rbac/authorize.ts via the gates in src/lib/auth/session.ts (no barrel, no token-baked perms)
- Admin settings values: site_settings table, written only through workflows.cms.upsertSetting (the *-settings.ts actions)
- Rate-limit buckets: Postgres-backed via src/lib/rate-limit checkRateLimit (auth/order/account actions)
- Money: integer millimes; dinar→millime conversion at the action edge (checkout-settings.ts:15, order.ts:31)
- No OpenAPI/contract file for actions; behavioural contract is the workflow test suite under src/lib/db/tests/*

### 5. RSC Read Layer (src/lib/api/** + module queries.ts)

- Storefront Product DTO shape: mapProductRows return object (src/lib/api/products.ts:1609-1671) + src/types/catalog.ts
- ERP ApiProduct/ApiCategory/ApiBrand/ApiCollection shapes: the toApi* mappers (products.ts:182, categories.ts:456, brands.ts:48, collections.ts:43)
- Effective vs stored price rule: products.ts:156-162 (priceCents=promo-folded, basePriceCents=stored) via resolveProductDiscount
- Card-price / 'is on promotion' definition: src/lib/listing/display-pricing.ts (listingDisplayPricing, hasVisibleCompareAt)
- Public-safe settings subset: content.ts PUBLIC_SETTING_PREFIXES/SECRET_TOKENS/DENY_KEYS (lines 33/47/55)
- Incremental-sync cursor contract: cursor.ts parseIncrementalCursor + keyset.ts (KEYSET_SETTLE_SECONDS=5)
- Tokyo storefront catalog snapshot: src/storefront/data/*.json, regenerated by scripts/tokyo-export-catalog.ts from listApiProducts
- No OpenAPI: the REST contract that wraps these reads is the test suite under src/lib/db/tests/* (erp-api.test.ts, order-api.test.ts, keyset-cursor.test.ts)

### 6. REST API Surface (src/app/api/**)

- src/lib/api-auth/route-catalog.ts — every route's tier/domain/scope/canBePublic; drives enforcement, inventory, public toggle
- apiSettings (src/modules/api-settings) — apiEnabled kill-switch + publicRoutes[] (which reads are public); read via apiSettingsService.get() in enforce.ts
- api_key table (src/modules/api-key) — key hash, scopes[], expires_at, created_by, last_used_at
- src/lib/api-auth/scopes.ts SCOPE_RBAC — scope→RBAC-grant equivalence (mint + per-request bound)
- src/lib/jobs/registry.ts SCHEDULED_JOBS — cron job keys, dispatch cadence, kill-switch/runnable flags
- src/lib/db/tests/*.test.ts — the API contract (no OpenAPI); statically checks fail-code→status mapping and route/disk invariants
- env: CRON_SECRET, CRON_ALLOWED_IPS, ADMIN_BOOTSTRAP_TOKEN, S3_ENDPOINT/S3_BUCKET, BETTER_AUTH_SECRET

### 7. Modules & Domain Model (src/modules/** — 44 modules, 135 tables)

- Table/column definitions: each module's schema.ts (and catalog/cms sub-module schema.ts files)
- Cross-module joins: src/associations/*.ts (6 product-* + customer-user + loyalty-referral)
- Drizzle graph for type inference: src/lib/db/schema.ts barrel — but it OMITS gift-card and loyalty-referral (see gaps)
- FKs, CHECK constraints, trigram/GIN/partial-unique/functional indexes: ONLY in src/lib/db/migrations/*.sql — NOT fully in schema.ts (drizzle meta frozen at 0007, db:generate disabled)
- Mutation entrypoints (true write API): src/workflows/** calling module services inside db.transaction()
- Convention spec: docs/modules.md (authoritative on rules, stale on branding/examples)
- Contract/behavior tests: src/lib/db/tests/*

### 8. Workflows — the orchestration / mutation API

- src/workflows/index.ts — the authoritative list of registered mutations (workflows.<domain>.<fn>)
- src/workflows/shared.ts:94 UNIQUE_VIOLATION_MESSAGES — PG constraint → user message map
- The workflow body itself is the source of truth for each mutation's rules (stock/tax/promo/loyalty); module services are thin data access
- src/events/types.ts — the event name + payload contract consumed by every subscriber and outbound webhook
- src/lib/db/tests/*.test.ts — the de-facto spec (no OpenAPI); checkout-correctness, workflow-error-mapping, reconcile-loyalty-promos, invoice-tax, etc.
- order_status_history + order_refunds + order_returns tables are the ledgers downstream workflows key on (not the order status column alone)
- webhook_events table (webhookEventService.claim/release) — payment-confirmation idempotency

### 9. Event Bus & Subscribers (src/events/**)

- src/events/types.ts EventMap — authoritative event names + payload shapes (compile-time type only)
- src/lib/api-auth/event-catalog.ts — the GENERATED runtime list of events (227/52 domains); regenerate via scripts/gen-event-catalog.mjs, checked by src/lib/db/tests/event-catalog.test.ts
- src/events/severity.ts EXPLICIT_SEVERITY + DOMAIN_DEFAULT + isLowSignal — authoritative severity rules
- src/events/subscribers/index.ts registerAllSubscribers() — authoritative registered-subscriber set + order
- src/events/subscribers/audit-trail.ts HINTS / AUDIT_TRAIL_EVENTS — authoritative curated-audit allowlist (and audit-everything's skip set)
- src/events/subscribers/dispatch-webhooks.ts SECURITY_DOMAINS — authoritative wildcard-webhook exclusion set
- globalThis.__gz_event_handlers (handler registry) + globalThis.__gz_subscribers_registered (one-shot guard) — runtime state
- Admin runtime config (audit.enabled, audit.persist_low_signal, audit.log_level, webhooks.outbound_enabled, per-flow mailing toggles) gates most subscribers, read via @/lib/audit/runtime-config + @/modules/mailing isFlowEnabled

### 10. Database, Schema, Migrations & Money/ID Conventions

- Schema shape: the per-module `src/modules/**/schema.ts` files (NOT migrations — those are frozen/hand-authored)
- drizzle-kit's view of the schema: `src/lib/db/schema.ts` barrel (only graph it reads)
- Applied-migration ledger: Postgres `drizzle.__migrations` table + `src/lib/db/migrations/meta/_journal.json`
- Money scale: `MINOR_PER_DINAR=1000` in `src/lib/price.ts`
- ID/timestamp/soft-delete conventions: `src/lib/db/columns.ts`
- DB-only objects (search_vector generated cols, pg_trgm GIN indexes, vector embedding, app_secrets, rate_limit_buckets): the raw SQL in `migrations/*.sql`, deliberately absent from the barrel
- Runtime secrets (BETTER_AUTH_SECRET, PAYMENT_ENCRYPTION_KEY, ERP/AI keys): `app_secrets` table + env override
- Behavioral contract / invariants: the `src/lib/db/tests/**` suite (no OpenAPI spec exists)

### 11. Auth, RBAC, Sessions & API-Key Access

- Auth policy VALUES: AUTH_POLICY + SESSION_POLICY_BOUNDS + AUTH_HTTP_DISABLED_PATHS + AUTH_RATE_LIMITS in src/lib/auth/policy.ts (the better-auth config builds itself from these, so displayed policy never drifts)
- What permissions EXIST: the CODE registry src/lib/rbac/registry.ts (PERMISSION_MODULES/PERMISSION_ACTIONS) — not a DB table
- Who HOLDS what: DB GRANT tables role_permissions / user_roles / user_permissions (modules/rbac/schema.ts)
- The sole `*` (super-admin): the seeded super_admin role, migration 0033; default role catalog in migration 0195
- Admin-tunable session policy + email-verification toggle + social toggles: site_settings keys (auth.session.*, auth.email_verification_required, auth.social.*_enabled)
- Social OAuth credentials: env vars OR encrypted oauth_provider_settings (resolved by src/lib/auth/social-config.ts, env wins)
- REST API surface + per-route public toggle: src/lib/api-auth/route-catalog.ts; contract enforced by the test suite (no OpenAPI)
- API-key secrets: only the SHA-256 hash in api_keys.key_hash (plaintext shown once)
- Session + account state: sessions / users tables (users.disabledAt is the live disable switch)

### 12. Media, Image Pipeline & Storage (sharp + SeaweedFS + /cdn)

- `media` table (one row per asset; URL/variant columns) — src/modules/media/schema.ts
- `media_settings` singleton row (id 00000000-...-0001; all pipeline knobs; lazily materialised) — src/modules/media/settings.schema.ts + settings.service.ts
- Bucket key shapes (primary/webp/avif/original, upload/cleanup key sets) — src/modules/media/storage.ts (variantKey/variantUploadKeys/variantStorageKeys)
- Effective CDN base precedence (DB cdn_base_url → MEDIA_CDN_URL env → same-origin /cdn) — src/modules/media/cdn-base.ts
- Build-time media host allow-list (next/image remotePatterns + CSP) — next.config.ts buildRemotePatterns() + BUILD_S3_PUBLIC_URL/BUILD_MEDIA_CDN_URL; mirrored in src/modules/media/cdn-allowlist.ts
- S3 connection config — serverEnv (S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY/SECRET_KEY/FORCE_PATH_STYLE/PUBLIC_URL) in src/lib/env.ts:109-118
- Media↔content reference graph (the lock-step trio) — src/modules/media/queries.ts (orphanMediaWhere, listReferencedMediaIds, countMediaReferences)
- Order-line image snapshots that pin objects from GC — order_items.product_image_url/variant_image_url via listOrderReferencedStorageKeys
- Storefront (tokyo) product image URLs — FROZEN in src/storefront/data/products.json, regenerated by scripts/tokyo-export-catalog.ts (not resolved live)
- The REST/behaviour contract — src/lib/db/tests/media-*.test.ts (no OpenAPI)

### 13. CMS, Site Settings, Theme & Identity — the config sources of truth

- Identity / brand / contact / legal: the site_settings DB table (site.*, social.*, business.*), seeded by scripts/tokyo-seed-identity.ts; hard code fallback is DEFAULT_SITE_NAME='Tokyo Store' in src/lib/seo/config.ts:22
- SEO config: site_settings seo.* (+ reused site.*/business.*/social.*) via getSeoConfig (src/lib/seo/config.ts)
- Storefront theme tokens: site_settings theme.* via getThemeConfig; cold-DB fallback THEME_DEFAULTS (src/lib/theme/config.ts:55) MUST mirror the .storefront block in src/app/globals.css
- Admin-panel theme: site_settings admin.theme.* via getAdminThemeConfig; fallback ADMIN_THEME_DEFAULTS (crimson, src/lib/theme/admin-config.ts:24)
- Tokyo content pages (cgv, privacy, mentions-legales, help, etc.): AUTHORED TypeScript in src/storefront/content/*.ts (NOT the DB) — only legal identity is injected from settings
- CMS page blocks (admin editor + /md twin + sitemap + page metadata only): pages.blocks column + SYSTEM_PAGE_DEFAULTS (src/lib/legal/system-page-content.ts)
- Navigation & footer: nav_menus/nav_items tables (fixed keys in src/lib/cms/nav-menus.ts)
- Banners / trust badges / showcase pins / FAQ: their respective module tables under src/modules/cms/* and src/modules/showcase
- Shipping fee/threshold displayed by storefront: checkout.delivery.* settings via src/lib/checkout/shipping.ts (order workflow re-computes authoritatively)
- Site availability: the site.mode setting via src/lib/site-mode/parse.ts
- Settings-key labels/groups registry (admin form field lists): src/lib/cms/site-fields.ts, src/lib/actions/seo.ts, src/lib/pages/listing-settings-keys.ts — these are the canonical per-panel key lists

### 14. Admin Panel (src/app/admin/**) — Shell, RBAC Gating, and Full Tab/Section Map

- src/lib/rbac/registry.ts PERMISSION_MODULES — the authoritative list of admin modules/actions; nav ids and group labels must match it
- src/app/admin/_components/admin-shell.tsx NAV_GROUPS — the authoritative sidebar structure (what tab exists, under which group, with which id)
- site_settings table via getSettingsMap() + workflows.cms.upsertSetting — the backing store for nearly all settings pages (payments, auth, SEO, analytics, checkout, theme, etc.)
- DB tables role_permissions + user_permission_overrides (+ roles, users) — the live grants that resolveUserPermissions reads; revoking takes effect next request
- src/lib/rbac/nav-access.ts shared grant constants (ORDER_NEW/LOYALTY_REWARDS/USER_SETTINGS/IMPORT_DATA_VIEW_GRANTS) — one list read by both the sidebar visibleWhen and the page's requirePermissionAny
- route-invariants.test.ts — the allow-list of pages permitted to use requireAdminArea instead of a module guard

### 15. Build, Config, Ops, Scripts & Tests-as-Contract

- next.config.ts + src/lib/config/next-runtime.ts + src/lib/security/headers.ts — build/runtime config, mirrored to admin diagnostics tabs
- src/lib/env.ts buildSchema() — the authoritative env-var contract (what's required vs optional, prod guards)
- .env.example + .env.coolify.example — documented env surface for dev vs Coolify
- src/lib/api-auth/route-catalog.ts — REST API surface (tiers, scopes, public-toggle keys)
- src/lib/api-auth/internal-api-catalog.ts (generated) + src/lib/actions/*.ts — internal write API
- src/lib/api-auth/event-catalog.ts (generated) + src/events/types.ts EventMap — bus events
- src/lib/db/migrations/*.sql + meta/_journal.json — hand-authored migration chain (202 migrations, snapshots frozen at 0007)
- src/lib/db/schema.ts (barrel) + src/modules/<m>/schema.ts — Drizzle schema (NOTE: app_secrets/rate_limit_buckets/tmp_* exist only as raw SQL, absent from barrel)
- src/lib/jobs/registry.ts SCHEDULED_JOBS (14) + src/app/api/cron/** — scheduled-job contract
- src/storefront/data/{products,categories,taxonomy}.json — (tokyo) storefront catalog snapshot, regenerated by tokyo-export-catalog.ts
- The test suite src/lib/db/tests/** — THE API contract (no OpenAPI); package.json test:pure/test:db chains
- app_secrets table — runtime-generated secrets (BETTER_AUTH_SECRET, PAYMENT_ENCRYPTION_KEY) persisted across redeploys


---

## Appendix B — Edit & Remove Playbook

Consolidated *what is safe to change vs. load-bearing* notes, per subsystem — the direct answer to the goal of editing and removing sections. Read the subsystem section for the surrounding context.

### 1. Storefront (Tokyo design) — pages, tabs & components

- Remove/reorder home sections by editing src/app/(shop)/(tokyo)/page.tsx (top-level 5 sections) and home-extras.tsx (inner stack) — each is an isolated component, safe to drop.
- Home shelf CONTENTS are controlled by category-slug lists in each *-tabs.tsx (iphone/gaming/telephonie/gift-card) and accessory-carousel.tsx ACCESSORY_CATEGORIES/BRAND_TIERS — edit freely; they just filter the bundled catalog.
- HeroCarousel slides[], PromoGrid FeatureCards/stores/promises, HomeExtras banners are hardcoded arrays — safe to edit copy/images/hrefs in place.
- Footer link columns (footer.tsx columns[]/legalLinks[]) are hardcoded with real route hrefs — editable; items with no href degrade to plain text, so removing a target page won't 404.
- Legal/brand/help page copy: edit the ContentDoc objects in src/storefront/content/*.ts; the page files are thin wrappers.
- LOAD-BEARING, do NOT lightly change: src/storefront/lib/catalog.ts slug derivation (the whole /[slug] URL space + cart/favorites keys depend on stable slugs); the Product DTO in types/catalog.ts (the backend-swap contract); the .tokyo class on the layout wrapper (removing it strips the entire design system); ui-classes.ts (shared by every component).
- LOAD-BEARING: the data/*.json + their generator scripts — editing JSON by hand will be overwritten on next regen; change the DB and re-run scripts instead.
- header.tsx is huge and tightly coupled (mega-menu sizing, hover-intent, product-bar coordination) — change surgically.
- Backend seams (cart.ts, favorites.ts, checkout-view.tsx, account, auth forms, track-order, rendez-vous) call real Server Actions — removing/altering them affects real orders/data; the cartTotals protection-exclusion (display==charge) is intentional, keep it until a real protection system exists.

### 2. Storefront Data Bridge, Catalog Snapshots & Client Libs

- SAFE TO EDIT: navAliases.ts slug lists, categorySeo.ts copy, productMeta.ts warranty/FAQ/highlight text, shipping DEFAULT_SHIPPING safety net, socials.ts / content/*.ts — pure config/content, no DB coupling
- DO NOT hand-edit the 3 JSON files: they are generated output; manual edits are overwritten on the next tokyo-export-catalog run. Change the DB (admin/import) then re-export
- catalog.ts is LOAD-BEARING: ~17 modules + the CatalogSource facade depend on its exports (products, slugify, getProductsForSlug, findProductBySlug, findCategory); the entire /[slug] routing hinges on getProductsForSlug roll-up and the slug map
- REMOVABLE (dead): http-source.ts is a never-reached stub (NEXT_PUBLIC_DATA_SOURCE is never set). The whole data/ abstraction + api/ facades could in principle be collapsed to direct catalog.ts imports, but [slug]/page.tsx and p/[id]/page.tsx currently depend on the async facade — update those two routes first
- platform-map.ts: used ONLY by the legacy (shell) route; removable once (shell) is retired, not before
- price.ts minorToDinars/dinarsToMinor: vestigial for the static path but imported by http-source and used elsewhere in the platform — keep
- Tokyo Care (cart.ts protectionPlans/setLinePlan + localStorage): removable as a unit since it is excluded from totals and not persisted server-side — but cart-view UI references it
- Server Actions (@/lib/actions/cart, @/lib/actions/wishlist) and getStorefrontShippingConfig are the real backend wiring — treat as load-bearing contracts; the storefront hook API intentionally mirrors them

### 3. Legacy (shell) storefront — what remains & retirement status

- SAFE TO DELETE NOW (dead, zero runtime importers): src/app/(shop)/(shell)/panier/cart-panel.tsx, panier/coupon-form.tsx, checkout/checkout-form.tsx, and the empty favoris/ directory — Tokyo owns these routes
- account/account-client.tsx + its sibling *-card.tsx/*-panel.tsx are dead UI, but deleting account-client.tsx first breaks src/lib/db/tests/identity-low.test.ts:238 (reads it as source) — remove that sourceInvariants block in the same change. KEEP account/orders/[id]/ (live)
- SHIM routes (about, brand/[slug], mes-credits, blog/category/[slug]) are safe to drop if losing old-link/SEO 301s is acceptable — they implement no feature, only redirects into Tokyo / flat namespace
- DO NOT remove order/[id] without first repointing src/lib/actions/order.ts:1019 — it is the checkout success page for BOTH storefronts; removing breaks every completed order
- DO NOT remove account/orders/[id] without first repointing src/storefront/components/storefront/account-view.tsx:233 — it is the only order-detail view, linked from the Tokyo account
- Content routes (boutique, marques, collections, collection/[slug], fidelite, blog*, auteur, pro*, recherche, parrainage, u) are each the ONLY implementation — removing one deletes that feature, not a duplicate. They look unused because Tokyo chrome does not link them, but they are live via direct URL / sitemap / admin legacy nav
- Legacy chrome src/components/site-header.tsx + site-footer.tsx (and mega-menu/mobile-bottom-bar) is LIVE on all ~16 shell routes and imported only by (shell)/layout.tsx — removable only after every live shell route is migrated to Tokyo or deleted
- _components/category-client.tsx is shared by collection/[slug] + recherche and by catalog/listing libs — treat as load-bearing, not a per-route component
- Editing landing-page content (boutique/marques/collections/fidelite) means editing admin settings, not the page.tsx — the pages are block renderers driven by src/lib/pages/*-landing-config.ts

### 4. Server Actions Layer (`src/lib/actions/**`) — the real storefront & admin mutation API

- SAFE TO EDIT: validation/guard logic and French `message` strings inside an action — they are client-facing copy, not business logic. Keep the returned `error` codes stable (clients branch on them).
- SAFE TO EDIT independently: each *-settings.ts field list — adding/removing a key only changes which site_settings keys that admin page writes.
- LOAD-BEARING — do NOT change: cart.ts uses refresh() not revalidatePath on purpose (cart.ts:14-23); swapping it re-introduces site-wide cache expiry on every cart click.
- LOAD-BEARING: the authoritative re-validation in placeOrderFromCartAction (order.ts:624-684) and the rate-limit buckets in auth.ts — they are the server-side enforcement behind UI-only guards; removing them opens enumeration/abuse holes.
- LOAD-BEARING: safeRedirectPath (auth.ts:263) is an open-redirect guard; do not loosen the regex.
- REMOVABLE with care: an action is removable once `grep -rln 'actions/<file>"'` shows no importers. Several admin actions are only reachable from src/app/admin/** — removing the admin page and the action together is clean.
- When removing a Tokyo section, the seam is one bridge file: drop the import in src/storefront/lib/{cart,favorites}.ts or the relevant (tokyo) form; the underlying action can stay (the legacy (shell) UI and/or workflow tests may still use it).
- No barrel to update — deleting a file only breaks its direct importers, which the grep above enumerates exactly.

### 5. RSC Read Layer (src/lib/api/** + module queries.ts)

- Editing ANY exported fn in src/lib/api/** changes the RSC page, the SEO feed, AND the REST endpoint at once (REST routes wrap the same fns) — never assume a change is UI-only.
- src/lib/listing/display-pricing.ts + facet-availability.ts + banner-rotation.ts are PURE and imported by BOTH server (promotion pools) and client (CategoryPageClient) — a change hits both; they are load-bearing shared contracts, not safe to tweak for one surface.
- mapProductRows (products.ts:1259) is the batching core — changing the fixed query set risks reintroducing N+1 across every listing page; keep the input-order/length invariant that enrichWithLivePromos relies on (products.ts:284).
- getAllSettingsServerOnly (cms.ts:212) returns secrets (mail.*_enc, payment.*) — never serialize it to a client/JSON route; the (tokyo) layout consumes it server-side only. Removing/altering the content.ts allow/deny lists can leak secrets via /api/content.
- attribute-validation.ts is a WRITE-path helper misfiled in lib/api — safe to move, but it is depended on by both the attributes PUT and the product workflows (keep them in sync).
- Tokyo (tokyo) catalog reads are decoupled: editing products.ts/categories.ts does NOT change (tokyo) pages until scripts/tokyo-export-catalog.ts is re-run and *.json committed. Treat the JSON as a build artifact, not hand-edited.
- The legacy (shell) route group is the primary request-time consumer of this layer and is being retired — reads used ONLY by (shell) (e.g. getMaisonExploreNav, some banner readers) may become removable once (shell) is gone; verify no REST route / Tokyo layout also uses them first.
- ERP-only serializers (orders.ts, order-substreams.ts, customers.ts, warranty-claims.ts, movements.ts) and the keyset/cursor helpers feed the REST ERP surface, not the storefront — safe to leave untouched when editing the storefront, but their shape is locked by src/lib/db/tests/*.

### 6. REST API Surface (src/app/api/**)

- Adding/removing an external route is a two-step edit: add/remove the ext(...) entry in route-catalog.ts AND the handler file; external-api-contract.test.ts + route-invariants.test.ts enforce they match (removing a handler without the catalog entry, or vice-versa, fails tests).
- Handlers are intentionally thin — business logic lives in src/workflows/* and src/lib/api/*; to change behavior edit the workflow/lib, not the route. Writes share the dashboard workflows, so a change there affects both admin UI and API.
- The per-job cron routes (/api/cron/<job> except dispatch) are REMOVABLE in principle (dispatch covers scheduling) but are kept for manual curl / dashboard 'run now' parity — removing one breaks run-now for that job unless rewired.
- Making a read public = add its route id to apiSettings.publicRoutes via the admin panel (data, not code); only ids in TOGGLEABLE_PUBLIC_IDS are accepted. PII reads are hard-pinned canBePublic:false and cannot be toggled — do not relax this.
- The customer transactional surface is NOT in this subsystem — do not add cart/checkout/account mutation routes here; they belong in Server Actions (src/lib/actions/*) which add throttles/audit the raw HTTP layer lacks.
- Legacy cookie/id names are load-bearing: gz.promo (promo/[slug]), gz.session_token / gz.cart_token elsewhere, gz_ ids — safe to read but do NOT rename without a migration.
- /api/auth credential endpoints are disabled on purpose (disabledPaths); do not re-enable — the in-process auth.api.* path carries the throttles/audit/signup invariants.
- internal-api-catalog.ts and event-catalog.ts are GENERATED (scripts/gen-*.mjs) — never hand-edit; regenerate after adding actions/events.

### 7. Modules & Domain Model (src/modules/** — 44 modules, 135 tables)

- SAFE to edit per-module: add columns to a module's schema.ts, but you MUST hand-author the matching src/lib/db/migrations/NNNN_*.sql + _journal.json entry — never run db:generate (guarded by scripts/guard-generate.ts; meta frozen at 0007).
- Services (service.ts) are internal — safe to extend; callers are workflows only. Reads added to queries.ts are directly RSC-importable.
- A module's index.ts re-exports only queries + types by design; keep services out of barrels.
- REMOVING a whole module is NOT a simple folder delete: a soft-linked uuid/text column in another module (e.g. orders.user_id, promotions.business_id, customer_profiles.loyalty_level_id) and an association table may point at it. Grep soft links + src/associations + the DB FKs in migrations before dropping.
- Association tables in src/associations are the join layer — removing product-complementary or product-related only drops a PDP cross-sell rail (curated-only), low blast radius; removing product-category/product-media/product-brand breaks catalog navigation and cards.
- catalog/ and cms/ are parent barrels of independent sub-modules — a sub-module (e.g. catalog/review, catalog/product-gen) can be edited/removed with less risk than touching catalog/product.
- Legacy-but-load-bearing, DO NOT remove: products.currency (frozen 'TND'), products.platform (legacy tag), the *_cents column NAMES (hold millimes), partial-unique WHERE deleted_at IS NULL indexes (they enable slug/sku reuse after soft delete).

### 8. Workflows — the orchestration / mutation API

- EDIT HERE for backend behavior: pricing/discount math, stock gates, tax cascade, delivery resolution, loyalty/credit rules all live in the workflow bodies — editing a module service is usually the wrong layer.
- To add a mutation: create src/workflows/<domain>/<fn>.ts wrapped in workflow(), then register it in index.ts; callers reach it via workflows.<domain>.<fn>.
- Safe/localised edits: fail() message strings and fieldErrors keys, the ORDER_FIELD_LABELS/ORDER_FIELD_MAX caps, UNIQUE_VIOLATION_MESSAGES entries, the order-number prefix default ('TK', place-order.ts:243).
- Removable with care: whole domain folders whose feature is being cut (e.g. appointments, blog_comments, authors, demo, showcase) — but first grep src/lib/actions + src/app/api for callers AND remove the registry entry in index.ts, or the build breaks.
- LOAD-BEARING, do not casually reorder: the cart-claim-first ordering, the stock→profile lock order, 'reads before the tx' hoisting, guard-before-write (a returned fail commits the tx), the webhook claim/release on payment confirm, and the fail-closed assertPendingOnlineOrderNotCaptured pre-flight. Changing any of these can cause oversell, double-refund, or kept-money-no-order.
- Legacy identifiers are intentional: cookies gz.session_token/gz.cart_token, gz_ ids, globalThis.__gz_* bus guards — do not 'rebrand' these.
- Non-registry runners (data/*, import/*, catalog/{content,product,review}-gen/*, auto-assign/*) are detached jobs invoked from admin actions; they persist to a job row, not a WorkflowResult — don't wrap them in workflow() expecting a return value.

### 9. Event Bus & Subscribers (src/events/**)

- bus.ts is small and load-bearing — DO NOT change emit() to fire-and-forget or stop awaiting handlers without auditing every DETACHED subscriber; the allSettled await is relied on by idempotency safety-nets (loyalty/gift-card re-drive) and by subscribers that re-emit.
- Removing an event emit is high-risk: one emit typically feeds audit (trail+everything), structured log, metrics, outbound webhooks, AND a domain reaction. Grep both the emit site and bus.on('<name>') before deleting.
- To remove a feature's side effect, delete/guard the specific subscriber file AND remove its register call in index.ts — removing only the file breaks the import in index.ts (build error).
- Safe to edit in isolation: email copy/templates (via @/modules/mailing), the cache-tag lists in invalidate-*-cache.ts, severity mappings in severity.ts (changing a mapping does NOT rewrite already-stored audit rows — append-only).
- audit-target.ts and reembed-fields.ts are PURE helper modules (no server-only), imported by registered subscribers AND by lib code — they are NOT themselves registered, so do not add them to index.ts.
- Adding a new event: add the key to types.ts EventMap, regenerate event-catalog.ts (scripts/gen-event-catalog.mjs), and add a severity override only if non-default; otherwise it inherits domain/info.
- Cache busts from a DETACHED/background runner are best-effort (no live request scope for revalidateTag) — don't rely on them for correctness; the storefront self-heals within cacheLife.
- The structured-logger, metrics-counter, audit, and dispatch-webhooks wildcard listeners see EVERY event — a new event is automatically logged/audited/metered/deliverable with no extra wiring (this is intended).

### 10. Database, Schema, Migrations & Money/ID Conventions

- SAFE to edit: per-module `schema.ts` column/index declarations — but a schema change is NOT applied until you hand-author a matching `migrations/NNNN_name.sql` + a `_journal.json` entry with a strictly-greater `when`, then `pnpm db:migrate`. Editing schema.ts alone changes types only, not the DB.
- SAFE to edit: formatters/scale helpers in `src/lib/price.ts` behavior, and pool/timeout tuning via env (`DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, etc.) with no code change.
- DO NOT rename `*_cents` columns casually — ~27 columns + all `$inferSelect` row types + every money formatter assume the millime scale; a rename needs a migration AND audit of all readers. Reading `_cents` as centimes (dividing by 100) is the classic bug this layer guards against.
- DO NOT run `pnpm db:generate` / `db:push` (or the `:force` variants) against a real DB — snapshots are frozen at 0007, so generate emits a destructive diff and push offers to DROP app_secrets/rate_limit_buckets/gift_cards.
- DO NOT remove `app_secrets` or `rate_limit_buckets` — raw-SQL tables holding live secrets/rate state, protected by both the push guard and drizzle.config `tablesFilter`.
- DO NOT reorder/renumber or reuse migration files, and never give a new `_journal.json` entry a `when` <= the previous one (it is silently skipped on already-migrated DBs). Append-only.
- LOAD-BEARING: `uuid_generate_v7()`, the `fr_unaccent` text-search config, and the generated `search_vector` columns are defined only in the baseline SQL — editing search weighting means a new migration that drops+re-adds the generated column.
- When adding a table/module: you MUST add an `export * from` line to `src/lib/db/schema.ts` or drizzle tooling + typed relations won't see it; and add any new test file to a `package.json` test chain or `test-chain-integrity.test.ts` fails.

### 11. Auth, RBAC, Sessions & API-Key Access

- LOAD-BEARING, do not weaken: AUTH_HTTP_DISABLED_PATHS (policy.ts) — removing an entry re-opens an un-throttled, un-audited HTTP credential endpoint that bypasses the in-process server actions
- LOAD-BEARING: the last-admin floor guards (guards.ts) and the super_admin role's is_system flag — removing risks a hard admin lockout; super_admin must never be renamed/deleted
- LOAD-BEARING: the three social hooks in server.ts (account.create.before 2FA gate, session.create.before disable+2FA block, account.create.after profile mirror) — each closes a specific bypass documented inline
- LOAD-BEARING legacy identifiers kept ON PURPOSE: cookiePrefix 'gz', gz.session_token, gz.cart_token — renaming logs every user out / breaks the proxy gate
- Frontend-safe to restyle: login-form.tsx / register / 2fa forms — but the Server Action contract (FormData field names email/password/rememberMe/from/code) and the /login/2fa route path must stay; signinAction/verifyTwoFactorAction read them by name
- Safe to edit/remove per store policy: the four default roles from migration 0195 (administrateur/manager/web_master/support) are is_system=false — editable/deletable; social providers render null when disabled, so the social-button block can be dropped if OAuth is unused
- Adding/removing a permission is a one-line registry edit (registry.ts) with no migration; stale grants self-heal at authorize time — but a page/action still references its module:action key, so remove the gate call too
- Session policy, email-verification requirement, and social toggles are admin-editable at runtime (no code change) — they live in site_settings and trigger resetAuthInstance()

### 12. Media, Image Pipeline & Storage (sharp + SeaweedFS + /cdn)

- SAFE TO EDIT via /admin/media/settings (no deploy): all media_settings — toggle webp/avif/keep_original/strip_exif, qualities, resize caps, max_upload_mb, détourage on/off + main-only, cdn_base_url. Changes take effect within the 30 s settings cache.
- LOAD-BEARING column names: `product_white_bg` is frozen/historical (means any-uniform-sweep détourage, not white-only); `*_cents`-style naming does NOT apply here but size columns are bigint millimes elsewhere — media sizes are honest byte counts.
- LOAD-BEARING key shapes: variantKey/variantUploadKeys/variantStorageKeys must stay mutually consistent — they are the lock-step between upload-abort cleanup and media.deleted reaping. Editing one key-shape function without the others leaks or 404s objects.
- LOAD-BEARING lock-step: the three reference functions in queries.ts (orphanMediaWhere, listReferencedMediaIds, countMediaReferences) MUST be kept in sync when adding/removing any media-referencing content type — a missing source in listReferencedMediaIds causes irreversible deletion of in-use images. media-reference-lockstep.test.ts guards this.
- REMOVABLE with care: the détourage feature (white-bg.ts, reprocess-*.ts, detourage-main-image subscriber, product_detourage cron) is self-contained and off by default; could be removed if the store never wants background removal, but the reprocess scripts and cron registry entry must go together.
- REMOVABLE legacy: `kind` enum has video/document/other values but only `image` is ever written — the non-image branches are effectively dead but harmless.
- DO NOT remove the /cdn proxy or its kept-original 404 gate — the storefront CSP is img-src 'self' and next/image cannot fetch the internal object store directly; removing it breaks every image. The kept-original gate is the only thing preventing anonymous EXIF-laden original downloads.
- When editing storefront product images: remember they are frozen in products.json — re-run scripts/tokyo-export-catalog.ts after any media/détourage/CDN change, or the (tokyo) UI keeps the old URLs.

### 13. CMS, Site Settings, Theme & Identity — the config sources of truth

- EDITABLE via admin or seed (DB, no code change): all site.* / seo.* / theme.* / admin.theme.* / social.* / business.* / checkout.* / auth.* / consent.* / redirects.* / site.mode / home.* / storefront.* settings; plus banners, trust badges, nav menus/items, CMS pages, showcase pins, FAQ. Change brand/identity by running/editing scripts/tokyo-seed-identity.ts or the admin 'Réglages site' form — NOT by editing consts.
- DO NOT EDIT DEFAULT_SITE_NAME in src/lib/seo/config.ts:22 — it is pinned by src/lib/db/tests/seo-title.test.ts (BRAND='Tokyo Store') and is the auth appName/TOTP issuer fallback; override identity via the site.name setting instead.
- LOAD-BEARING consts to leave alone: THEME_DEFAULTS (must stay in sync with the .storefront rule in globals.css), FOOTER_COLUMNS keys + MAISON_EXPLORE_MENU_KEY + MAIN_NAV_MENU_KEY (src/lib/cms/nav-menus.ts), SYSTEM_PAGE_SLUGS (src/lib/legal/system-page-content.ts), SITE_MODES, BLOCK_LIST_CAP, and the legacy gz.* cookie names mentioned in project context.
- To change a Tokyo content page's visible body (e.g. CGV wording), edit the TS file in src/storefront/content/*.ts — editing the page in /admin/cms/pages will NOT change the HTML a visitor sees (it only affects the /md twin, sitemap and <title>/meta).
- REMOVABLE WITH CARE: legacy page_sections + hero/text/cta/stats/timeline_sections tables are read-only synthesis fallbacks — safe to retire only after confirming no un-migrated pages rely on them; deprecated banner placements ('checkout', 'nav_*') and the dormant setNavFeaturedWorkflow are kept only for pre-migration rows.
- The whole CMS page-builder (pages table, page-blocks.ts, renderers) is NOT mounted by any storefront HTML route — but it is NOT safe to delete outright because it still feeds /md twins, sitemap.ts and page-metadata.ts. Removing it requires also removing or re-pointing those three consumers.
- The storefront theme.* settings and buildThemeCss are effectively DEAD for the visible Tokyo UI (scope mismatch, see gaps) — before 'removing' them, note that the legacy (shell) group and the admin root still consume them.

### 14. Admin Panel (src/app/admin/**) — Shell, RBAC Gating, and Full Tab/Section Map

- Sidebar grouping/labels/icons/order in NAV_GROUPS (admin-shell.tsx:107-323) are purely visual — regrouping is safe and changes only the blocks, NOT the ids/grants. But every item.id MUST stay a real registry id and every group.label should match the registry group field or the role editor mislabels the capability.
- To REMOVE a section safely: delete its NAV_GROUPS item(s) AND its page files AND (if the module is now unused) its registry entry. Leaving a registry module with no page is harmless; leaving a nav item whose page is gone yields a 404 link (nav is keyed by href, so duplicate ids are fine).
- Reused-id items (Drip, Gift-cards reuse `products`; Segments reuse `promotions`; B2B/RDV items share one id) are load-bearing: the duplicate id only feeds the visibility gate because the shell keys links by href — do not 'dedupe' the ids.
- Redirect stubs (system/auth, system/import, system/import-demo, system/catalog, catalog/locations) are safe to keep; delete only if no external bookmarks rely on them.
- Bare-printable route regexes (admin-shell.tsx:387-390) are load-bearing: renaming invoice/delivery-note/transfers-print routes without updating the regex re-introduces admin chrome into printed PDFs.
- Per-page UI-honesty perm resolution (canUpdate/canManage) can be edited freely — it only hides controls; the Server Action is the real gate. Never rely on it for security.
- The admin layout's whole-segment gate and each page's own requirePermission are BOTH load-bearing (defense in depth) — do not drop the per-page guard assuming the layout covers it; the layout only checks area access.

### 15. Build, Config, Ops, Scripts & Tests-as-Contract

- SAFE TO EDIT: next.config.ts redirects() (URL-compat 308s) — add/remove freely; but editing headers/images/CSP inputs requires a REBUILD in Docker (build-time compiled), not a restart.
- SAFE TO EDIT but COUPLED: src/lib/config/next-runtime.ts literals feed BOTH next.config.ts and admin tabs — 16mb cap is pinned to MAX_UPLOAD_MB_CEILING in src/modules/media/limits.ts; change both together.
- LOAD-BEARING, DO NOT CHANGE casually: the 'gz.' cookie prefix (src/proxy.ts:43), uuid-v7 PKs, millime money unit — legacy identifiers kept on purpose.
- LOAD-BEARING: typescript.ignoreBuildErrors:true is NOT a license to ship type errors — Dockerfile runs tsc --noEmit separately and FAILS the deploy on errors. Removing the separate tsc step silently drops type safety.
- LOAD-BEARING: build must stay `next build --webpack` (package.json:7) — switching to turbopack reintroduces the native-memory OOM-kill on constrained boxes.
- REMOVABLE (dev-only, not in deploy path): most seed-*.ts, verify-seed.ts, dedupe-product-images.ts, reprocess-product-white-bg.ts, tokyo-copy-bucket.mjs — one-off/dev tools; removing them does not affect prod boot (instrumentation.ts bootstrap seeders are the prod path).
- DEPENDED-ON (do not remove): scripts/gen-internal-api-catalog.mjs + gen-event-catalog.mjs — the catalogs they emit are test-enforced; a stale catalog fails internal-api-catalog.test.ts / event-catalog.test.ts.
- DEPENDED-ON: scripts/tokyo-export-catalog.ts regenerates the (tokyo) storefront's JSON data; the storefront reads the committed JSON, so edits to the live catalog need a re-run to appear in the new UI.
- DO NOT run db:generate / db:push (even the :force variants in prod) — the frozen-snapshot chain means they emit destructive drops incl. app_secrets. Add migrations by hand (NNNN_name.sql + _journal.json entry + schema edit + db:migrate).
- REMOVABLE WITH CARE: the pgbouncer service is behind the `pooler` profile (off by default) — only needed when scaling past 1 app instance; MIGRATION_DATABASE_URL must stay direct if enabled.
- When ADDING a test file: it MUST be appended to a package.json chain (test:pure/test:db:N) or test-chain-integrity.test.ts fails — and append to the LAST sub-script to respect the ~8191-char cmd.exe cap.
- When ADDING an api route or server action: update route-catalog.ts (routes) or re-run gen:api-catalog (actions) or route-invariants/internal-api-catalog tests fail; every admin page + server-action export must open with an RBAC guard (enforced by route-invariants).


---

## Appendix C — Risk Register & Known Gaps

Every pitfall, stale doc, silent coupling, mock, and TODO surfaced during the sweep. The top 10 cross-cutting ones are in §D; this is the full per-subsystem list.

### 1. Storefront (Tokyo design) — pages, tabs & components

- Newsletter form (newsletter.tsx:20-30) is a MOCK — validates email client-side and shows success but never subscribes anywhere. No backend integration.
- QuickBuyForm (quick-buy-form.tsx:118-139) is a MOCK — the PDP 'Achat rapide' express flow validates then fakes success with setTimeout; it does NOT create an order, unlike /checkout. A customer using it believes they ordered but no order exists.
- Star ratings, review counts, and discount/strike prices across ALL cards and PDPs are SYNTHESIZED placeholders (productMeta.ts fakeRating/fakeStrike), not real data — misleading if taken as genuine; must be replaced when real reviews/pricing land.
- ReelsView data is hardcoded mock reels with Unsplash posters + Google sample videos — not real content.
- Two parallel catalog access paths (sync catalog.ts for client, async lib/api for server) read the same JSON but could drift; the async http-source.ts is a stub (static-only today).
- Store addresses/phones are hardcoded in multiple places (promo-grid.tsx stores[], product-view.tsx stores[], quick-buy-form.tsx stores[], SHOP_TEL constants) — the footer pulls stores from backend site_settings, so the home/PDP store lists can disagree with the footer. Single source would be safer.
- products.json is 2595 products on a single line and bundled into the client via catalog.ts — this ships the full catalog to the browser (bundle-size/perf consideration) and means price/stock are only as fresh as the last scripts/tokyo-export-catalog.ts run, not live.
- Cart Tokyo Care protection plan is a localStorage-only overlay never sent to the order; deliberately excluded from totals — a known placeholder that will need backend support.
- The (shell) legacy group still owns real flows the (tokyo) design lacks a replacement for (order confirmation /order/[id], pro/B2B, fidélité, blog, collections, parrainage) — some footer/account links cross back into legacy chrome; retiring (shell) requires porting these first.
- Header is 2061 lines with intricate interdependent animation/measurement effects — high regression risk on edits.
- catalog.ts slug de-duplication is order-dependent on products.json; reordering/regenerating the JSON could in theory shift a fallback-derived slug (mitigated by backend-provided slugs being preferred).

### 2. Storefront Data Bridge, Catalog Snapshots & Client Libs

- STALE-SNAPSHOT RISK (biggest): products.json/categories.json/taxonomy.json are a point-in-time DB export. Admin catalogue edits, price/stock changes, and new products do NOT appear in the Tokyo storefront until scripts/tokyo-export-catalog.ts is re-run. No automation/CI hook exists; it is a manual raw pnpm tsx command documented only in file headers.
- FAKE DISCOUNTS: productMeta.fakeStrike invents the struck-through 'was' price and % off from a seed; the real backend promo price is already baked into products.json 'price' (promo-folded), but the displayed discount badge is fabricated. The 'bons-plans' nav page is built entirely on these fake percentages.
- BROKEN 'precommande' ALIAS: navAliases precommande filters availability === 'backorder', but tokyo-export-catalog only ever writes 'in_stock' | 'out_of_stock' (RawProduct type line ~33 and mapping line ~99). So the Précommande page almost certainly renders EMPTY. stockState() also has dead 'backorder' handling.
- FULL CATALOGUE SHIPS TO CLIENT: catalog.ts statically imports the ~1.4 MB products.json and is imported by client components (cart.ts 'use client', header.tsx, product-card.tsx). The entire 2,595-product array is bundled into the client JS — a real bundle-size/perf concern that grows with the catalogue.
- DEAD CODE: http-source.ts throws on every call and is unreachable (NEXT_PUBLIC_DATA_SOURCE/NEXT_PUBLIC_API_URL never set). The CatalogSource abstraction's stated purpose (flip to a live HTTP backend) is unrealised; the real 'live backend' path chosen instead was the JSON re-export + Server Actions.
- price.ts helpers are vestigial on the active path and the header comments still describe a 'future backend swap' that was superseded by the in-repo JSON bridge — docs lag the actual architecture.
- DESTRUCTIVE PIPELINE ORDERING: tokyo-build-categories.ts soft-deletes ALL categories/brands/products before rebuilding; running it out of order (or without the subsequent import) wipes the catalogue. The 3 scripts have an implicit build→import→export ordering with no guard.
- Tokyo Care protection is a placeholder: client-only localStorage, excluded from totals, never sent to the order — any future real implementation must fold it back into cartTotals.total AND the order.
- Two divergent code paths read the same data (async facade in 2 routes vs. direct sync catalog.ts imports elsewhere); a change to data shape must satisfy both. The legacy (shell) route additionally reads the DB live via platform-map, so (shell) and (tokyo) can show different data for the same product until the export is refreshed.

### 3. Legacy (shell) storefront — what remains & retirement status

- /recherche is orphaned: the Tokyo header search runs on the local static catalog and on Enter goes to the best-match product — src/storefront/components/storefront/header.tsx:838 literally comments 'the full results page doesn't exist yet'. So full server-side search results are unreachable from the Tokyo UI even though the page is live.
- All shell CONTENT routes (blog, fidelite, collections, boutique, marques, pro, parrainage, u) are orphaned from the Tokyo chrome — the Tokyo footer/header link only to Tokyo routes + category slugs (footer.tsx links: /help,/garantie-retours,/suivi-de-commande,/service-client,/notre-histoire,/nos-boutiques,/carrieres,/mentions-legales,/cgv,/cgu,/privacy,/cookies). They can look dead but are live via direct URL, sitemap, legacy chrome, and admin-configured nav — do not delete them as 'unused'.
- Dual-chrome UX hazard: crossing from a Tokyo page into a shell route swaps the whole header/footer/design system (.tokyo crimson ↔ .storefront legacy). This is the main reason to migrate, not delete, the live shell routes.
- account/account-client.tsx is 74 KB of dead code kept alive ONLY by a source-invariant test (identity-low.test.ts:238); easy to mistake for live account UI (the live account is (tokyo)/account).
- Feature-flag masking: pro/* (isBusinessEnabled), u/[slug] (favoritesPublicEnabled, off by default), parrainage/[token] + fidelite (loyalty enabled) return 404/thin when their flag is off — they may appear dead in a default/dev config while being real features.
- Hard couplings to shell from Toksyo that are easy to miss when 'removing sections': checkout success (actions/order.ts:1019 → /order/[id]) and account order detail (account-view.tsx:233 → /account/orders/[id]). Grep both before touching those routes.
- Retired routes left orphan files (panier/checkout/favoris/account) — editors may edit these stale copies thinking they are live; the live versions are under (tokyo).
- Several shell pages are SEO/sitemap-registered; dropping them without 301s (they have resolveRedirect hooks) will create dead indexed URLs.

### 4. Server Actions Layer (`src/lib/actions/**`) — the real storefront & admin mutation API

- Delegation is inconsistent: most mutations go through workflows, but toggleWishlistAction (wishlist.ts:42-49) writes via wishlistService directly (no workflow → no audit/event path), and cart.ts reads via cartService/productService directly. If the owner adds audit/event hooks at the workflow layer, these direct-service paths bypass them.
- Tokyo account is incomplete: account-view.tsx uses only signoutAction. The production-ready customer.ts profile/address/password/email actions are still wired ONLY to the legacy (shell) account-client — the Tokyo account page cannot yet edit profile/addresses. Wiring them is a frontend task; the backend actions already exist.
- Tokyo Care protection plan shown at checkout is a client-only overlay NOT sent to or charged by placeOrderFromCartAction (storefront cart.ts:237-251) — display==charge by design today, but a real protection feature means threading new fields through order.ts + workflows.order.place.
- Tokyo checkout hardcodes region = city (checkout-view.tsx:303) to satisfy the backend's governorate requirement; this feeds bogus zone data into delivery pricing/routing. Real governorate selection is needed before relying on zone-based delivery.
- Validation lives mostly in workflows (only 3 action files use zod). Editing an action's input shape without updating the workflow schema will fail at the workflow, not the action — trace both layers when changing a payload.
- order.ts is doing double duty (customer checkout + ~15 admin order ops, 1131 lines); splitting customer vs admin would reduce the chance an admin-gate change touches the public checkout path.
- cancelMyPendingOrderAction is restricted to online payment methods (order.ts:1041); a guest COD order remains cancellable by any UUID-holder via other paths — noted in the action's own comment as a known rough edge.
- business.ts auto-generates employee-account passwords (business.ts generateEmployeePassword) — any change to AUTH_POLICY min length must stay compatible with that generator.

### 5. RSC Read Layer (src/lib/api/** + module queries.ts)

- Request-time decoupling trap: the (tokyo) storefront serves a STALE JSON snapshot of the catalog. Any backend/read-layer edit is invisible in (tokyo) until scripts/tokyo-export-catalog.ts re-runs. This is the single biggest gotcha for 'editing both frontend and backend'.
- http-source.ts is an unimplemented stub that throws (lines 37-43); flipping NEXT_PUBLIC_DATA_SOURCE=http would break the storefront. The 'redeploy-time flip' promised in index.ts:7-14 does not exist yet.
- Doc-comment staleness: legacy watch-store vocabulary persists in comments (e.g. products.ts:62-64 references a /montres breadcrumb; cms.ts MAISON_EXPLORE_TAGLINE_FALLBACK='Chaque seconde est un souvenir'). Comments describe an older watch brand; trust the code, not the prose.
- getProductBySlug (products.ts:127) applies NO promo and NO early-access embargo (documented 121-126) — any new caller that renders product content to the public must gate it itself or it leaks embargoed/mis-priced products.
- mapAndEnrichRows must NOT be used for the PDP (double-discount risk, products.ts:809-816). The PDP intentionally uses bare mapProductRows + its own enrichment — easy to get wrong when adding a new PDP-adjacent read.
- Public pagination must use rawCount, not products.length (embargoed pages come back thinned/empty; products.ts:243-251). A client paging on products.length will stop early and miss rows.
- No OpenAPI spec — the ERP REST contract these reads back is pinned only by src/lib/db/tests/* (erp-api/order-api/keyset-cursor tests). Changing a serializer silently breaks ERP consumers unless the tests are kept as the source of truth.
- attribute-validation.ts living under lib/api/ is misleading — it is a mutation validator, not a read; a reader auditing 'the read layer' could wrongly treat it as such.
- Several readers swallow errors to [] / {} / null (cms.ts, nav-composer dead-link pruning, content bundle) to fail-open and never blank the chrome — good for resilience but means a broken DB read degrades silently rather than erroring; watch when debugging 'missing' nav/banner data.

### 6. REST API Surface (src/app/api/**)

- src/app/api/README.md is partly STALE vs code: it lists /api/aide + /api/aide/[slug] with an aide:read scope that does NOT exist anywhere in code (grep confirms 'aide' appears only in the README); it also says admin routes 'Most gate on requireAdmin' whereas every admin API route actually uses the finer requirePermission(module, action) (404 on lack). Trust route-catalog.ts + the handlers over the README.
- Rate-limit guards (per-key 120/min, per-IP 60/min public, cron 10/60s) FAIL OPEN on a limiter/DB error (logged, not blocked) — a sustained DB stress disables throttling with only a console.error trail; a noted SECURITY TODO in require-api-key.ts:21 to route the invalid/rate_limited firehose off audit_log is unimplemented.
- requireFirstParty (search/track) is explicitly a CSRF speed-bump, not auth — a non-browser client can forge Sec-Fetch-Site/Origin. It must never be the sole guard on anything sensitive; both routes lean on the IP rate limit + consent gate instead.
- /api/track is dormant in production (serverMirrorActive() false) — it validates+gates but only console.logs in dev and never persists; any future analytics fan-out must honor the consent gate already wired there.
- /facture/[id] is a layout-less PAGE (not a route handler) carrying full order PII; guest orders rely entirely on the v7-UUID being an unguessable bearer capability (a signed guest link is a deferred decision) — the UUID must never leak to third-party tags (redact-url.ts scrubs it).
- Payment webhooks are unsigned by both gateways by design — security rests entirely on the server-side re-verification in webhook-handler.ts; do not add trust in the raw callback payload.
- A key with created_by = null is read-only (requireApiActor refuses writes); the per-request creator re-check means demoting/deleting a key's creator silently revokes that key's writes — expected, but can surprise ERP integrators.
- Kill-switch (apiSettings.apiEnabled=false) 503s the ENTIRE external API including valid keys and public reads — a single toggle can take down all ERP/headless integrations.
- Money fields are millimes in columns misleadingly named *_cents — any new serializer must not divide by 100 (see src/lib/price.ts).

### 7. Modules & Domain Model (src/modules/** — 44 modules, 135 tables)

- BARREL IS INCOMPLETE: src/lib/db/schema.ts does NOT re-export src/modules/gift-card/schema.ts (gift_cards, migration 0147) nor src/associations/loyalty-referral.ts (loyalty_referrals, migration 0140). Tables exist (verified in migrations) and are used by importing them directly, so runtime queries work — but db's relational schema union / db.query typing won't include them, and any future drizzle-kit introspection would miss them. Likely an oversight worth a one-line fix each.
- schema.ts is NOT the full source of truth for constraints. FKs, CHECKs, and many indexes (trigram GIN, functional lower()/upper(), several partial uniques like addresses_one_default_*, orders_external_ref_uniq, the business/segment/loyalty cross-module FKs) live ONLY in src/lib/db/migrations/*.sql. Drizzle meta is frozen at 0007 and db:generate is disabled (scripts/guard-generate.ts) — the in-code index/constraint declarations are documentation/parity, not generators. To know real DB integrity you MUST read the migration SQL.
- docs/modules.md is stale: titled 'Tokyo Store', uses watch/Rolex/Submariner examples and a Windows OneDrive path for its reference corpus. The RULES are current but examples/branding predate the tokyo/high-tech rebrand. Treat code as truth.
- Legacy identifiers intentionally retained: products.currency frozen at 'TND' (per-product currency removed, display currency is store-global via currency module), products.platform legacy free-text tag superseded by attributes. Do not 'clean these up' without checking.
- Denormalisation coupling: several hot read-fields must be updated in lockstep with their ledger inside one transaction (credit_balance_cents↔customer_credit_entries, cumulative_spend/paid_order_count/loyalty_level_id↔paid orders, products.rating/reviews_count↔product_reviews, stock_qty↔stock_movements/stock_levels). Editing write paths without preserving the paired update will drift balances/levels.
- Variant stock has two modes (products.shared_variant_stock) and purchase-qty caps aggregate across a product's variant lines at place-order — editing checkout/stock logic must respect both or you can oversell.
- The modular-monolith soft-FK design means orphan-prevention is application-level (no delete-user path; accounts are disabled, not deleted). Hard-deleting rows a soft link points at (e.g. a product referenced by curated product_related) relies on migration-declared CASCADE FKs that are invisible in schema.ts — verify in SQL before relying on cascade behavior.
- Sub-module isolation: catalog sub-modules must not cross-import each other's schema; shared types go in src/modules/catalog/_shared/types.ts. A careless import across sub-modules silently violates the convention.

### 8. Workflows — the orchestration / mutation API

- A returned `fail` from inside db.transaction COMMITS the transaction (drizzle only rolls back on throw). Every order workflow works around this by guarding before the first write or throwing a sentinel (PlaceOrderError, EditItemsAbort). Any new in-tx guard that `return fail(...)`s AFTER a write will silently persist a half-mutation — the single biggest footgun in this layer.
- Cross-module integrity is by convention only: there are NO cross-module FKs, so a workflow that forgets to go through an association service can orphan links; FK 23503s from catalog refs are mapped to a 400 rather than prevented.
- place-order.ts is 1469 lines and holds pricing, tax, promo, loyalty, credit, delivery and stock logic in one function — high blast radius; changes need the checkout-correctness + invoice-tax tests re-run.
- Money is integer MILLIMES in *_cents columns; never divide by 100. Discount-base excludes gift cards (bearer value sold at face) — easy to break into a 'money printer' if a new discount path forgets the giftCardSubtotal exclusion (place-order.ts:634-655).
- The multi-tab older-session paid-capture case is explicitly NOT handled (gateway-payment.ts:324-328) — assertPendingOnlineOrderNotCaptured only verifies the CURRENT payment_reference; needs an attempt-history table.
- Known return limitation (returns.ts:138-145): a partially-BL'd order marked delivered leaves line B recoverable only via full refund, not per-line return — do not 'fix' by falling back to ordered qty (would double-restock).
- The event bus is in-process + best-effort: a subscriber failure is logged, never retried, and lost on process death. Emails/webhooks/cache busts after commit can silently not happen. The bus.ts comment says it 'graduates to pg-boss when we need persistence' — not yet done.
- Cron workflows are reached indirectly via runScheduledJob(job_key) (src/lib/jobs/run-job.ts) — the mapping from job_key to workflow lives there, not in the cron route, so grepping the route for the workflow name finds nothing.
- Env-tuned constants (ABANDONED_ORDER_HOURS=48, PAYMENT_RECONCILE_STALE_MINUTES=20 / MAX_AGE_HOURS=24) govern the stock-reservation backstop timing; mis-set they either strand stock or cancel live payments — posIntEnv guards only the abandoned-hours one.

### 9. Event Bus & Subscribers (src/events/**)

- No persistence/retry/outbox: a crash mid-fan-out drops the not-yet-run tail; only loyalty accrual + gift-card issuance have an explicit re-drive safety net. Durability upgrade path is pg-boss (noted in bus.ts:11-16) but not implemented.
- 'Emit after commit' is a convention, not enforced. A future emitter that fires inside a transaction (or before commit) would trigger real side effects (emails, webhooks, credit) for a row that may roll back. No lint/guard catches this.
- bus.emit AWAITS all subscribers, so any subscriber that forgets to detach heavy work will block the emitting request (checkout/admin save). The mitigation is per-file discipline (void...catch) — easy to get wrong when adding a subscriber.
- Cache invalidation in invalidate-cms-cache.ts is largely forward-wiring: only site:settings has a live cached reader; banner/FAQ/nav/page tag busts are no-ops today (comment at invalidate-cms-cache.ts:15-18). Storefront CMS freshness actually relies on writers' revalidatePath, so removing those writers' revalidation would NOT be covered by the event busts.
- Dedup relies on an in-memory/DB mailing_sends ledger and on best-effort claim/release; a crash between claim and send can burn a key (suppressing a legit email) — the release-on-failure paths mitigate but don't eliminate this.
- metrics-counter and the structured logger are process-local and reset on restart — not a source of truth (explicitly stated); don't build reporting on /api/admin/metrics.
- The warranty.claim.* events note (types.ts:404-407) says the ERP pushWarranty toggle does NOT yet gate webhook delivery (Phase-2 posture) — control is only via endpoint subscribe/unsubscribe. Potential surprise for integrators.
- perf-alert.ts (src/lib/telemetry) looks subscriber-adjacent but is a PRODUCER helper, not registered in subscribers/index.ts — easy to overlook when auditing where perf.alert.* side effects live.
- severity.ts and types.ts can drift from the generated event-catalog.ts if someone adds an event without regenerating; the event-catalog.test.ts guards completeness but only runs in the test suite (the true contract per project convention).

### 10. Database, Schema, Migrations & Money/ID Conventions

- `gift_cards` (and its redemption table) in `src/modules/gift-card/schema.ts` is NOT re-exported in `src/lib/db/schema.ts` — confirmed: 64 `export * from` lines, none for gift-card. It works at runtime (the module imports its own schema directly) and generate is frozen, but it is the SAME class of latent footgun as app_secrets: a `db:push:force` or any future snapshot unfreeze would see `gift_cards` as an orphan table to DROP, and it is NOT in the drizzle.config `tablesFilter`. Add it to the barrel (or to the tablesFilter) to be safe.
- `drizzle.config.ts:21` dev fallback URL uses stale `tokyo:tokyo_dev_pwd@...:5434/tokyo` while `script-client.ts:18` and docker-compose use `tokyo:tokyo_dev_pwd@...:5434/tokyo`. In practice `DATABASE_URL` is always set so the fallback rarely fires, but the two script-side fallbacks disagree — a bare `db:studio` with no env could hit a non-existent `tokyo` DB.
- `src/lib/db/seed-catalog.ts` is stale vs. the high-tech rebrand: it still seeds watch-store categories/brands (Casio, Festina, etc.) and references `tokyostore.tn` 'watch' migration. The live (tokyo) storefront reads from bundled JSON (src/storefront/data/*) regenerated by scripts/tokyo-*.ts, so this seed is likely dead/legacy for the new design but still present.
- The `gz_`/`gz.` legacy identifiers (globalThis.__gz_pool in client.ts:89; cookie names in the task context) are load-bearing and intentional — do not 'tidy' them.
- No OpenAPI/schema snapshot of the live DB to diff against — the only machine-checkable schema↔DB contract is the db/tests/** suite plus drift tests (e.g. gift-card-schema-drift.test.ts asserts TS enum arrays match DB CHECK literals). If you change a CHECK/enum you must update both the migration and the TS const array or the drift test fails.
- Migrations are strictly append-only with hand-picked `when` timestamps; the `when`-ordering invariant is subtle (non-increasing `when` → silently skipped on prod, applied on fresh/CI DBs → divergent schemas). `migration-journal.test.ts` is the only guard — always run `pnpm test:pure` after adding a migration.
- Soft-delete is app-enforced (`deleted_at`), not DB-enforced — queries that forget `WHERE deleted_at IS NULL` will read tombstoned rows. Partial unique indexes assume the filter is applied consistently.
- `updated_at` is bumped by the service layer, not a DB trigger — a raw SQL UPDATE or a service path that forgets to set it will leave `updated_at` stale (keyset-pagination/activity-ordering queries rely on it).

### 11. Auth, RBAC, Sessions & API-Key Access

- better-auth rateLimit uses in-memory storage (server.ts:337) — correct only for the single-instance Coolify deploy; scaling to multiple pods silently weakens throttling until switched to Redis/secondary-storage
- The OAuth auto-link gate is UNVERIFIED against a real Google flow in production (Google is off until creds are set) — server.ts:644 explicitly says to validate on a staging deploy before relying on it
- Several invariants depend on specific better-auth 1.6 behaviors that a library upgrade could change: the SYNTHETIC-user response for duplicate signups (signup.ts:96 / invite-user.ts:125) and sendChangeEmailConfirmation-to-current-address (server.ts:496); upgrades need regression checks
- Documented small-N TOCTOU residual on the last-admin floor: two simultaneous last-two removals could both pass the read before either writes (guards.ts:276) — acceptable but real
- SECURITY TODO in require-api-key.ts:20 — sampled invalid/rate_limited API-key failures should be routed to a separate high-volume telemetry stream + an aggregate metric; today a key-guessing storm is only partially visible
- same-origin.ts is explicitly a CSRF speed-bump, NOT authentication — a non-browser client can spoof Sec-Fetch-Site/Origin; it must never be the sole guard on anything state-changing (the real controls are IP rate limit + consent gate)
- users.name is a denormalized mirror of the customer profile kept in sync ONE-WAY by a subscriber (associations/customer-user.ts:20) — a dropped event leaves name drift in admin lists/audit actor names
- No hard-delete path for users (accounts are only soft-disabled); user_roles/user_permissions are soft text links with no FK, so a hypothetical hard delete would orphan grant rows (roster.ts accounts for this by JOINing users by PK)
- The REST contract has no OpenAPI — the ONLY contract is the test suite under src/lib/db/tests/* (erp-api / external-api-contract); edits to route-catalog.ts or the enforce.workflowErrorStatus switch must be kept in lockstep with those tests
- cookieCacheMinutes > 0 delays an explicit force-logout (session-row delete) by up to that window for a NON-disabled user; disable/role-change are still live — a subtle operational nuance when reasoning about revocation latency

### 12. Media, Image Pipeline & Storage (sharp + SeaweedFS + /cdn)

- NO bucket-wide orphan sweep exists: the only reclamation for a failed upload is the workflow's purgeUploadedObjects, and the only reclamation on delete is the cleanup-media-storage subscriber. An object whose delete fails (logged) leaks in the bucket until removed by hand (upload-media.ts:44-48, cleanup-media-storage.ts:27-29).
- Storefront (tokyo) product images are STALE by design: products.json freezes resolved /cdn URLs at export time. A détourage reprocess re-keys objects to `-nobg` AND deletes the old objects — if the catalog isn't re-exported, the (tokyo) storefront points at deleted keys (404). The live admin/legacy chrome re-resolves and is fine; the gap is only the exported JSON.
- CDN-base footgun: an admin cdn_base_url outside the build-time allow-list is silently dropped back to /cdn (warned once) because next/image remotePatterns + CSP are compiled at build. Pointing at a new CDN host requires MEDIA_CDN_URL as a BUILD ARG + rebuild (not a restart). The settings workflow rejects a non-allowlisted base on save (settings.ts:81-87), but a value set before a host was removed from the build would just stop working.
- Reference-lockstep is a manual invariant across 3 functions + several JSON-blob matchers; adding a new media-referencing feature (new block type, new settings key) without updating listReferencedMediaIds risks permanent deletion of in-use media. Mitigated by media-reference-lockstep.test.ts + home/page-blocks-media-coverage tests, but new JSON shapes aren't auto-covered.
- uploaded_by is written on every upload but surfaced NOWHERE (reserved for a future column) — dead provenance data today.
- The détourage heuristic is explicitly NOT AI segmentation: a subject pixel matching the backdrop and edge-connected to it (e.g. a white strap running off-frame on a white sweep) gets removed. It is gated to products-scope + uniform borders, but a borderline packshot can be mis-cut; the reprocess DELETES the old objects so a bad cut is irreversible unless keep_original was on.
- keep_original originals are publicly derivable keys served only behind the RBAC gate in the /cdn route; the gate adds an auth/RBAC lookup on an otherwise anonymous hot path (lazily imported, but still per-request for any `.original.` key). Defence-in-depth relies on strip_exif also re-encoding originals metadata-free.
- docs/media.md is referenced from schema.ts:21 but was not verified in this analysis — treat any prose there as potentially stale vs. the code above (CODE IS SOURCE OF TRUTH).
- GIF handling is special-cased in many places (no webp/avif/jpeg, original preserved, excluded from détourage/reprocess) — editing the variant logic without preserving every GIF guard (processor, reprocess-detourage isReprocessIneligible, scan WHERE clauses) can silently freeze animations into static images that then win the resolver chain.

### 13. CMS, Site Settings, Theme & Identity — the config sources of truth

- TASK-BRIEF CORRECTION: DEFAULT_SITE_NAME is 'Tokyo Store', not the legacy brand name the brief states; zero legacy-brand strings exist in src/. It IS test-pinned (seo-title.test.ts hardcodes BRAND='Tokyo Store'), so the 'do not edit' guidance still holds — just for the right reason.
- BIGGEST GAP: the CMS page-builder is DORMANT on the storefront. No (shop) route renders pages.blocks; getPageForRender has no (shop) caller. Tokyo content pages are hardcoded TS (src/storefront/content/*). Editing a page in /admin/cms/pages changes ONLY the /md markdown twin, sitemap.ts, and the HTML <title>/meta (src/lib/seo/page-metadata.ts) — so the visible HTML body and the DB-driven metadata/twin for the SAME legal slug (cgv, privacy, mentions-legales, etc.) can silently DIVERGE.
- THEME SCOPE MISMATCH: getThemeConfig/buildThemeCss emit a '.storefront'-scoped rule (injected in root layout), but the new chrome is wrapped in '.tokyo' (src/app/(shop)/(tokyo)/layout.tsx:54). So admin theme.* edits (primary color, radius, font, dark_mode) do NOT reach the visible Tokyo UI — they only affect the retired (shell) group and the admin root. Verify before telling an operator that the Théme panel recolors the live store.
- STALE DEFAULTS: THEME_DEFAULTS (src/lib/theme/config.ts:55) is still the legacy olive/gold watch palette while the shipped design is Tokyo crimson (ADMIN_THEME_DEFAULTS #d40530). The storefront cold-DB fallback therefore does not match the intended brand look.
- STALE COMMENTS from the rebrand: scripts/tokyo-seed-identity.ts header says it renders 'Tokyo Store' 'instead of the bundled Tokyo Store watch-shop defaults' (nonsensical post-rebrand); src/lib/legal/system-page-content.ts:17 still references 'Tokyo Watch Store'. Cosmetic but misleading.
- HOME COMPOSER ALSO DORMANT for Tokyo: home.blocks + home-blocks-render.tsx feed only the legacy (shell) home; the Tokyo home (page.tsx) is fixed components over the static catalog, with a hardcoded JSON-LD brand string.
- SECURITY FOOTGUN: getSettingsMap()/getAllSettingsServerOnly() returns the whole table including mail.*_enc, payment.*, promo codes and raw tracking HTML. Any new client component must use pickSettings() (which also hard-strips secrets) — never pass the raw map across the RSC boundary.
- IDENTITY DEPENDS ON SEED: footer/header read settings['site.name'] directly (null if unseeded); only the SEO/auth paths fall back to DEFAULT_SITE_NAME. A fresh DB that never ran tokyo-seed-identity.ts shows a blank brand in the chrome. money note: checkout.delivery.*_cents columns hold MILLIMES not cents (getStorefrontShippingConfig divides by 1000).
- Two parallel contact representations (JSON list keys + legacy single keys) are kept in sync only through the save path (contact-list-save.ts); a direct DB edit to one without the other will desync footer vs invoices/SEO.

### 14. Admin Panel (src/app/admin/**) — Shell, RBAC Gating, and Full Tab/Section Map

- Registry modules with NO sidebar page: `warranty` (Garanties) and `credit` (Crédit client) are defined in registry.ts:106,133 and grouped (Commandes/Clients) but have no /admin/warranty or /admin/credit page — warranty lives at the /api/warranty-claims scope + order lookups, credit on the customer fiche. The role editor will show these capabilities with no corresponding nav tab. Confirm this is intentional before 'cleaning up'.
- `system_media` (Médiathèque réglages) is a registry module whose only UI is the Media page's réglages sub-tab + /admin/media/settings — not a standalone nav item; easy to overlook when auditing tabs.
- Nav/registry drift is only partially test-guarded: the code comments assert parity but enforcement depends on route-invariants.test.ts and the shared nav-access constants. Editing a page's guard without updating its NAV_GROUPS visibleWhen (or vice-versa) can silently create links that 404 or hide reachable pages.
- Many mutating Server Actions re-gate (75/85) but 10 action files do NOT call requirePermission directly — verify each either is a pure helper (types.ts, coerce.ts) or gates via another mechanism (e.g. super-admin check, keyed API) before assuming all writes are guarded.
- Settings pages deliberately do NOT fail-soft on their settings read (no .catch) so a swallowed read can't persist code-defaults over live config (noted in payments/users-settings). When adding a settings page, follow this: catch only reads that don't pre-fill a save form.
- The Système index (system/page.tsx) tile list is a SEPARATE hand-maintained array from NAV_GROUPS — adding/removing a Système page requires updating both, and the tiles are NOT RBAC-filtered (every tile shows to any area-access user; the target page 404s on deny).
- Sidebar group count is 10 and several groups exceed the documented '~8-item soft cap' (Commandes, Catalogue); the Système/Infrastructure split exists to relieve this — keep it in mind when adding tabs.

### 15. Build, Config, Ops, Scripts & Tests-as-Contract

- drizzle.config.ts:21 default DATABASE_URL still uses the LEGACY `tokyo:tokyo_dev_pwd@.../tokyo` credentials/db name — stale relative to the tokyo rebrand (every other default uses tokyo:tokyo_dev_pwd/.../tokyo). Harmless when DATABASE_URL is set, but misleading and a footgun for db:generate:force run without env.
- Dockerfile:55 builder ARG default S3_PUBLIC_URL still points at `.../tokyo` (legacy bucket path) vs the compose default `.../tokyo` — only a default (overridden by build args in real deploys) but another rebrand-residue inconsistency.
- env.ts:94 EMAIL_FROM default is '...@tokyostore.tn' while .env.example/.coolify use '...@tokyostore.com' — domain TLD mismatch across config sources; confirm the real sending domain before relying on either default.
- No automated test-DB provisioning: db tests run against whatever .env.local points at (the shared dev DB on :5434) and self-clean with random UUIDs; a crashed test mid-run (esp. external-api-contract which mutates global api-settings) can leave residue. There is no CI-managed ephemeral DB in-repo.
- Tests have no parallelism and run as one long sequential && chain (296 files) — full `pnpm test` is slow; a single early failure process.exit(1)s and aborts the rest of that sub-chain.
- The (tokyo) storefront catalog is a COMMITTED JSON snapshot (src/storefront/data/products.json ~1.4MB) regenerated only by manually re-running tokyo-export-catalog.ts — it can silently drift from the live DB; there is no runtime freshness check. This is intentional per the swap design but is a real staleness risk for the owner's edits.
- scripts/tokyo-build-categories.ts and tokyo-import-feed.ts hardcode an absolute feed path under /home/mhoussem/Desktop/... as the argv fallback — not portable; must pass the path explicitly on another machine.
- Migration meta snapshots are frozen at 0007 by design (202 migrations, 6 snapshots) — this is a deliberate but fragile setup: anyone running drizzle-kit generate/push outside the npm guards (e.g. a raw `npx drizzle-kit`) bypasses guard-generate.ts/guard-push.ts; only drizzle.config.ts tablesFilter (table-granular, not index-granular) protects the raw-SQL tables then.
- Many top-level .md docs (ANALYSIS.md, API.md, AUDIT-REPORT.md, FRONTEND-REPLACEMENT-ANALYSIS.md, PLAN.md, etc.) are untracked and may be stale planning artifacts — CODE is the source of truth; docs/ dir content was not verified here.
- seed-tokyo-design.ts header still says 'seed-tokyo-design.ts' in its usage line and the file is named seed-tokyo-design.ts — naming residue from the rebrand; functional but confusing.


---

## Appendix D — Conventions & Glossary

| Term / convention | What it means | Where enforced |
|---|---|---|
| **Millimes money** | Integer money in *millimes* (1 dinar = 1000). Columns named `*_cents` hold millimes — **never ÷100**. | `src/lib/price.ts` (`MINOR_PER_DINAR=1000`); ~27 `*_cents` columns |
| **uuid v7 PKs** | Primary keys are time-ordered uuid v7 (`uuid_generate_v7()`). Also used as unguessable bearer tokens (guest order/invoice links). | baseline migration SQL; `src/lib/db/columns.ts` |
| **Soft delete** | Rows carry `deleted_at`; "delete" = tombstone. App-enforced — queries must filter `WHERE deleted_at IS NULL`. Partial-unique indexes allow slug/sku reuse after delete. | `src/lib/db/columns.ts`; per-module queries; migration SQL |
| **Modular monolith** | 44 modules, **no cross-module FKs**; cross-links are soft uuid/text columns + join services in `src/associations/*`. `index.ts` exports only queries + types. | `src/modules/*`; `docs/modules.md` (rules) |
| **Workflows = mutation API** | All writes go through `src/workflows/*` (DB transaction + event emit). Actions and REST are thin adapters over them. | `src/workflows/index.ts` |
| **Three transports** | RSC reads (`lib/api/*` + `queries.ts`), Server Actions (`lib/actions/*`, writes), REST (`app/api/**`, ERP/headless). | — |
| **`.tokyo` scope** | The entire live design system activates only inside the `.tokyo` wrapper on the `(tokyo)` layout. Removing the class strips the design. | `globals.css` `.tokyo` block; `(tokyo)/layout.tsx:54` |
| **`gz.` legacy ids** | Cookies `gz.session_token`, `gz.cart_token`, `gz.promo`; `gz_` ids; `globalThis.__gz_*`. Kept on purpose — renaming logs out users / breaks the proxy. | `src/proxy.ts`; auth cookiePrefix; bus guards |
| **Catalog snapshot** | The `(tokyo)` storefront reads a bundled JSON export, not the live DB. Regenerate with `scripts/tokyo-export-catalog.ts`. | `src/storefront/data/*.json` |
| **Contract = tests** | No OpenAPI. The spec is `src/lib/db/tests/**` (`test:pure` + `test:db` chains). | `package.json` scripts |
| **Frozen migrations** | drizzle snapshots frozen at 0007; `db:generate`/`db:push` are guard-disabled. Add migrations by hand. | `scripts/guard-*.ts`; `migrations/meta/_journal.json` |
| **Route groups** | `(tokyo)` = live new storefront; `(shell)` = legacy, being retired but still owns real features. | `src/app/(shop)/` |

### Headline numbers (approximate; code is source of truth)

- **44** domain modules · **~135** tables · **202** migrations (snapshots frozen at 0007)
- **60** REST routes · **~83** Server-Action files · **~227** bus events · **14** scheduled jobs
- **~2,595** products / **125** categories in the storefront JSON snapshot
- Admin panel: **10** sidebar groups; **296-file** test suite

---

*Generated 2026-10-08 from a 15-agent code-verified sweep. This supersedes the earlier `FRONTEND-REPLACEMENT-ANALYSIS.md` and `docs/az-analysis-2026-10-02.md` for current state. When in doubt, the code wins.*

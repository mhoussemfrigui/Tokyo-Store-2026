# Tokyo Store — A–Z analysis & verified findings (2026-10-02)

> Produced by a full-codebase pass: 20 subsystem deep-readers built a verified architecture map, then every risky finding was re-checked by two adversarial skeptics and every "dead code" claim was grep-verified against the whole repo. Baseline at time of writing: `pnpm typecheck` clean; the 9 DB-free structural invariant tests (`route-invariants`, `page-guards`, `admin-nav-access`, `internal-api-catalog`, `event-catalog`, `wiring-matrix`-family, `settings-fail-closed`, `cache-tag-readers`, `migration-journal`, `test-chain-integrity`, `reserved-routes`) all pass. Nothing in the codebase was changed.
>
> **Canonical deep reference:** `docs/architecture.md` (current, 2026-09-30) — module inventory, per-admin-section change-impact cheat sheet, cross-cutting systems. This document does **not** duplicate it; it adds (A) a synthesized understanding + dependency graph for impact-tracing, and (B–D) a **verified** issue/cleanup backlog.

---

## A. Architecture understanding (for safe targeted admin edits)

### A.0 What the system is
A single Next.js 15 (App Router / React Server Components) + TypeScript monolith, Drizzle ORM over PostgreSQL (pgvector), S3-compatible object storage (SeaweedFS), deployed via Docker/Coolify. It is a luxury **watch** e-commerce storefront + a very large French-language admin, forked from a "GameZone" (GZ) base and reskinned. Money is integer **millimes** (1 TND = 1000) in every `*_cents` column. ~1,700 TS/TSX files, 44 domain modules, 123 Drizzle tables (+ raw `app_secrets`, `rate_limit_buckets`), 177 migration files, 61 external API routes, ~60 admin sections (261 admin `.tsx`), 219 wired test files.

### A.1 The layering (and the one chain that matters)
```
app/*  (routes: (shop) storefront · admin · api · feeds/md/cdn/robots/sitemap)
  │  server action (mutation)            │  RSC read
  ▼                                       ▼
lib/actions/*.ts  (~80 "use server")     lib/api/*.ts facades + modules/<d>/queries.ts
  │  requirePermission() FIRST await      │  getSettingsMap() + typed resolvers
  ▼  parse FormData (TND→millimes)        │  'use cache' readers (8) + per-viewer layers
workflows/<d>/*  (zod safeParse →         │  (early-access embargo, live promo enrich)
  db.transaction → FOR UPDATE/ledgers →
  post-commit bus.emit)
  ▼
modules/<d>/service.ts (DbOrTx) → Drizzle → pg Pool → Postgres
  ▼
events/bus.ts → Promise.allSettled(subscribers)  // audit, webhooks, cache-bust, email
```
**The canonical mutation chain is the single most important thing to respect.** Each admin write is: guarded server action → workflow (validation + transaction) → service → post-commit event. Breaking any link (e.g. a pool read inside a tx, an event not emitted, a cache tag not busted) is how most regressions happen here.

### A.2 Cross-cutting systems you must trace through on any admin edit
- **RBAC** (`lib/rbac/*`): code registry of 60 modules × `view|create|update|delete|manage` (+ `*`, `<module>:*`). Every `"use server"` export must open with `requirePermission`/`requirePermissionAny` (enforced by `route-invariants`); denial throws `notFound()` (not an ActionState). Nav visibility ↔ page guard parity (`nav-access.ts`). Last-admin floors + escalation guards + **owner-only (`*`) step-ups** on money/phishing-relevant settings (tracking JS, mail transport, payment creds, `seo.site_url`, off-site redirects, demo purge).
- **Settings KV** (`site_settings`, dotted keys): one `SELECT *` per request (React-cached) → typed resolvers. **Fail-closed**: admin settings pages read strictly (no `.catch(()=>({}))`), panels re-write *every* key on save, `wiring-matrix` enforces "a read key has a writer". `*_media_id` suffix protects a media id from orphan purge.
- **Events / audit / outbound webhooks** (`events/*`, 214 events/49 domains): `bus.emit` **awaits** all subscribers (slow subscriber = slow request → detach heavy I/O). `*`-subscribers: structured-logger, metrics, audit-everything, dispatch-webhooks (gated, excludes `SECURITY_DOMAINS`). `event-catalog.test` keeps the generated catalog honest.
- **Cache** (`lib/cache/*`): 8 `'use cache'` readers with tags; settings/CMS/promotion writes do `revalidatePath("/", "layout")` (nukes all cache); several tags are reserved with **no reader** (see C). Bulk/detached paths bust via `bust-storefront.ts`. All caches are **process-local** (multi-replica lag).
- **Jobs/cron**: one `/api/cron/dispatch` heartbeat runs all due jobs (`dispatch-schedule`), plus per-job routes; `guardCron` + kill-switches. Retention windows fail-closed.
- **Email** (`modules/mailing`): one `dispatchEmail` chokepoint, 17 flows × 22 templates, `critical` templates owner-only & undisableable, consent backstop, HMAC unsubscribe.
- **Money/tax/currency**: millimes; `formatMoney` rounds to `price.decimals` (default 0) so **never compare displayed vs charged**; tax cascade product→attr→brand→category-chain→global; currency is relabel-only.
- **Site-mode / consent / tracking**: `site.mode` gate (fail-open on read, staff bypass fail-closed), Consent Mode v2, bearer-URL redaction before third-party tags.

### A.3 Subsystem dependency graph (impact-tracing)
"Owns" = the module(s) that hold the authoritative data; "depended on by" = who breaks if you change its shape. Use this to scope blast-radius before an edit.

| Subsystem | Owns (core tables) | Depends on | Depended on by (blast radius) |
|---|---|---|---|
| **Catalog/products** | products, variants, tier_release | associations, attribute, taxonomy, media, promotion, loyalty, stock, order(queries) | storefront PDP/grids/search/feeds/sitemap/`/md`, ERP API, order placement, cart, wishlist emails |
| **Catalog/taxonomy** (brand/category/collection/attribute) | brands, categories, collections, product_attributes* | promotion (delete guard), associations, media, tax, cms(faq) | PDP, listings, mega-menu, facets, tax/warranty cascade, sitemap, `/api/*` |
| **Reviews/showcase** | product_reviews, showcase_pins | product, settings, order, loyalty(embargo) | PDP stars/JSON-LD, `/api/reviews`, review-request mail, home/`/top-ventes` rails |
| **Orders** | orders, items, refunds, shipments, returns | product(stock), promotion, loyalty, credit, customer, stock, document, delivery, tax | order pages, invoices, emails, analytics, `/api/orders*`, webhooks `order.*` |
| **Cart/checkout/payment** | carts, cart_items, payment_provider_settings | product, promotion, order, webhook, customer, credit, gift-card, delivery, tax | `/panier`,`/checkout`, place-order, gateways (ClicToPay/Flouci), reconcile cron |
| **Promotions** | promotions, redemptions, scope_targets, targets | catalog, customer(segments), business, auth, order(prior-count) | card/PDP/feed/cart/checkout prices, `/promo`, announce mail, place-order re-price |
| **Loyalty/credit/gift-card** | loyalty_levels, customer_credit_entries, gift_cards | customer, associations, order, promotion | checkout member benefit, `/fidelite`,`/mes-credits`,`/parrainage`, order settlement, invoices |
| **Customers/B2B/segments** | customer_profiles, businesses, customer_segments | auth, loyalty, credit, order, promotions/rule-tree | `/account`,`/pro`, audiences (promo+mailing), `/api/customers*`, drip ladder |
| **Auth/RBAC/users/OAuth** | users, sessions, roles, role_permissions | better-auth, settings, customer, newsletter, loyalty, api-key | **every guard**, all storefront auth pages, admin shell visibility |
| **CMS home/pages** | pages(+blocks), site_settings(home.blocks) | media, catalog, loyalty, delivery, settings | storefront `/[slug]`, home, `/md`, sitemap, system-page bootstrap |
| **CMS chrome** (banners/nav/footer/trust/theme) | banners, nav_menus/items, trust_badges, faqs | media, catalog, redirects, settings | storefront header/footer/menu, PDP buy-box badges, home hero |
| **Media/CDN** | media, media_settings | env(S3), auth(cdn gate), ssrf-fetch | **every image**, `/cdn`, feeds, emails, OG, admin MediaPicker |
| **Inventory/stock** | stock_locations, stock_levels, stock_movements | product(authoritative totals), order, settings | availability everywhere, `/api/stock`, low/back-in-stock mail, dashboard |
| **Delivery/tax/currency** | delivery_agents, zones, tax_rules, currencies | settings, attribute/brand/category(tax tiers), price | checkout fee + snapshot, invoices, money labels, JSON-LD/feeds |
| **Mailing/newsletter/blog/aid** | email_* , newsletter_subscriptions, blog_*, aid_* | settings, crypto, email/config, promotion, customer | every email, `/blog`,`/aide`, footer signup, crons |
| **Search/SEO/feeds/docs** | search_log/aliases, redirects, document_sequences | catalog, blog, aid, cms, media, order, loyalty(embargo) | `/recherche`, metadata+JSON-LD, sitemap/robots/llms/feeds/`/md`, invoices |
| **AI generation** | ai_*, *_gen_jobs/drafts | crypto, rbac, rate-limit, bus, settings, catalog services | every AI button, bulk gen panels, semantic embeddings |
| **Jobs/webhooks/import/ERP/bus** | job_run_log, webhook_*, import_jobs | settings, api-settings, retention, mailing, order, media | all cron, outbound webhooks, ERP two-way, event side-effects |
| **Platform infra** | — (db/cache/config/security/audit/api-auth) | bus, rbac, auth, api-key/settings, audit, instance, settings | **the whole app** (pooling, cache, settings, headless API, security posture) |
| **Storefront shell/tracking** | wishlists, consent cookie | settings, auth, rbac, catalog, trust_badge, theme | the `(shop)` layout for every page, GA4/GTM/Meta, maintenance gate |

### A.4 Highest-leverage hazards when editing the admin (distilled)
1. RBAC denial **throws** (`notFound()`) — not an ActionState. Every `"use server"` export must guard first.
2. Cross-module reads at render must sit behind a `can*` pre-check or the whole page 404s for scoped roles.
3. Settings panels write **every** key; admin pages must read strictly (fail-closed). Reader default must equal panel default.
4. `bus.emit` awaits subscribers — keep new ones fast or detached.
5. Settings/CMS/promotion writes nuke **all** `'use cache'` via `revalidatePath("/", "layout")`; some tags have no reader.
6. Soft deletes cascade **only where coded** (category/brand delete refused with live promos; product delete retires variants/stock/attrs/drip). Other link tables keep pointing at tombstones.
7. Money is millimes; admin inputs are TND; `formatMoney` rounds.
8. Process-local caches/TTLs (5–30 s) ⇒ a save is not instantly visible on other replicas.
9. Adding anything structural requires lock-step edits + a generator run (`pnpm gen:api-catalog`) + the matching invariant test — see the per-section cheat sheet in `docs/architecture.md §6`.

---
## B. Verified issue backlog (risky / actionable)

Each item below was surfaced by a subsystem reader and then **independently verified by two adversarial skeptics** (one trying to reproduce, one trying to refute). `CONFIRMED` = both agreed it is real; `PARTIAL` = real but narrower/conditional than first stated. Severities are the verifiers' corrected values. Line numbers are approximate (from the audit snapshot) — confirm before editing.

### B1. High

#### brands.description & collections.description missing from media-reference matchers (orphan/in-use data-loss gap)
- **Severity:** 🔴 HIGH (high) · **Category:** data-loss · **ID:** `media (Media library, CDN proxy, image processing / détourage)#1`
- **Claim:** The rich-HTML body matcher (bodyRefMatch) and countMediaReferences cover categories.description but only cover editorial_body for brands and collections, so a média inlined into a brand/collection description (not its editorial body) is invisible to orphan tracking and the in-use count.
- **Evidence:** `src/modules/media/queries.ts:229`, `src/modules/media/queries.ts:231`, `src/modules/media/queries.ts:232`, `src/modules/media/queries.ts:625`, `src/modules/media/queries.ts:626`, `src/components/admin/brand-form.tsx:314`, `src/components/admin/collection-form.tsx:334`, `src/app/(shop)/[slug]/page.tsx:987`
- **Verified:** Reproducible path: an admin inlines a médiathèque image via raw HTML `<img src="/cdn/products/<uuid>-x.webp">` into a brand's or collection's `description` (Code mode of RichTextField, identical component to categories/products description, both of which ARE covered). The sanitizer keeps the /cdn img so it renders on the published brand/collection page. Because bodyRefMatch and countMediaReferences scan only `editorial_body` for brands/collections — never `description` — a média whose sole reference is that description is: (a) reported as 0 references by
- **Fix:** In bodyRefMatch add `OR description ILIKE '%'||base||'%'` to the brands (queries.ts:231) and collections (:232) EXISTS terms, and in countMediaReferences add `OR description ILIKE ${like}` to the brands (:625) and collections (:626) lines — bringing both into parity with categories. Fixing bodyRefMatch + countMediaReferences closes listOrphans, listReference

### B2. Medium

#### savePageBlocks can blank a published page → 200 placeholder served, still indexable
- **Severity:** 🟠 MED (medium) · **Category:** oversight · **ID:** `cms-home-pages#1`
- **Claim:** An operator can clear/hide every block on an already-published page and save; nothing re-checks content, so the public page silently renders an empty placeholder.
- **Evidence:** `src/workflows/cms/page.ts:156`, `src/lib/pages/page-blocks-data.ts:238`, `src/components/storefront/page/page-blocks-render.tsx:105`
- **Verified:** Reproduced the exact path. State: a custom (non-system) page already published (togglePagePublish enforced the visible-block guard at that moment). Operator with pages:update opens the composer, deletes every block (or toggles all hidden) and saves. savePageBlocksAction → savePageBlocksWorkflow writes pages.blocks = "[]" (or an all-hidden array) with no content/publish re-check and leaves is_published = true. On the public /[slug] route getPageForRender sees is_published true + blocks != null, parsePageBlocks returns []/all-hidden, systemDefaultBlocks re
- **Fix:** In savePageBlocksWorkflow (or savePageBlocksAction), when existing.is_published and the cleaned list has zero VISIBLE blocks and getSystemPageDefault(existing.slug) is null, either reject with the same message togglePagePublish uses, or auto-unpublish (set is_published=false) so the thin page drops out of render/sitemap/index. Reuse the exact has-content pre

#### Quick-remove-by-slug never removes the item (variant_id compared to null)
- **Severity:** 🟠 MED (medium) · **Category:** bug · **ID:** `cart-checkout-payment#1`
- **Claim:** removeCartItemBySlugAction looks for the line with `i.variant_id == null`, but simple-product lines store variant_id = "" (NOT NULL default ""), so it never matches and the item is never removed while the UI reports success.
- **Evidence:** `src/lib/actions/cart.ts:133`
- **Verified:** Every simple-product cart line is stored with variant_id = "" (column is NOT NULL default "", and the add-to-cart workflow initializes variantId to "" and only overrides it for a resolved variant). listItems returns these raw rows, so each item has variant_id === "". The remove predicate `i.variant_id == null` evaluates `"" == null`, which is false in JavaScript (loose `== null` matches only null/undefined, never ""). Because the column can never physically hold null, the predicate is false for 100% of rows, so `line` is always undefined. The function th
- **Fix:** Match the simple-product line by treating ""/undefined/null as "no variant": `i.product_id === product.id && (i.variant_id === "" || i.variant_id == null)`. Also call refreshCartViews() on the ok path so the header count stays correct even when the line was already absent.

#### Dynamic segments silently exclude account-less profiles that the Clients filter counts
- **Severity:** 🟠 MED (medium) · **Category:** inconsistency · **ID:** `customers-business-segments#1`
- **Claim:** The segmentation SQL engine resolves/counts/exports only customers who have a login account (JOIN customer_user_links JOIN users), but the Clients list/stats/export base is customer_profiles alone (no account join), so the two surfaces measure the same criteria over different populations.
- **Evidence:** `src/lib/promotions/rule-tree-sql.ts:219`, `src/lib/promotions/rule-tree-sql.ts:221`, `src/lib/customers/filter.ts:173`, `src/lib/customers/filter.ts:244`
- **Verified:** Reproducible path: an ERP push creates an account-less customer_profiles row (no customer_user_links). A Clients filter with spendMin="0" pushes `customer_profiles.cumulative_spend_cents >= 0` over the join-free base (filter.ts:114, 173-177, 244) and counts/lists/exports that profile. A dynamic segment carrying leaf spend_gte:0 compiles to `p.cumulative_spend_cents >= 0` but runs over `customer_profiles p JOIN customer_user_links cul JOIN users u` (rule-tree-sql.ts:111, 220-222); with no link row the profile is eliminated before the WHERE. So segmentCoun
- **Fix:** Make the two surfaces agree on base population. Either LEFT JOIN customer_user_links/users in the segment engine (rule-tree-sql.ts:220-222/236-238/296-298) so account-less profiles are counted/exported, letting order/life/cercle leaves that depend on u.id read NULL→false (mailing already skips emailless rows), or conversely surface in the segment builder tha

#### Risky default reviews.rating_source="all" markups AI/manual reviews as genuine
- **Severity:** 🟠 MED (medium) · **Category:** bad-practice · **ID:** `catalog-reviews-showcase#2`
- **Claim:** The shipped default for reviews.rating_source is "all", so a store that seeds AI/manual reviews and never opens the settings emits them in the PDP AggregateRating and as individual schema.org Review nodes with fabricated Person authors — advertising fake reviews to Google/shopping feeds. The admin UI itself labels "customers" as the recommended, FTC/Google-compliant option.
- **Evidence:** `src/modules/catalog/review/config-parse.ts:47`, `src/app/(shop)/[slug]/page.tsx:1480`, `src/lib/seo/review-jsonld.ts:41`
- **Verified:** Every factual claim verifies against code and the failure path reproduces with no intervening guard: a store left at the default "all" that generates+approves AI reviews will emit them in the PDP AggregateRating (via the stored aggregate that recomputeProduct fills from all approved reviews) and as schema.org Review nodes with fabricated Person authors. Not a false positive — no missed guard/caller/config overrides this. Downgraded to low because (a) it is an intentional, documented default with a one-flip shipped remediation ("customers"), and (b) the A
- **Fix:** Decouple the JSON-LD Review[]/AggregateRating source scope from the on-page display setting: always filter source!='customer' out of the structured data (and the indexed aggregate/feeds) while letting the reviews.rating_source setting govern only the on-page list. Alternatively default rating_source to "customers".

#### ERP-pushed COD order isn't confirmed → auto-cancelled by the abandoned sweep
- **Severity:** 🟠 MED (medium) · **Category:** inconsistency · **ID:** `orders#1`
- **Claim:** The ERP order-push workflow (createOrderFromLinesWorkflow) never stamps confirmed_at for a COD order, unlike its sibling createManualOrderAction which does so explicitly to keep the abandoned sweep from cancelling it.
- **Evidence:** `src/workflows/order/create-from-lines.ts:276`, `src/lib/actions/manual-order.ts:357`, `src/modules/order/service.ts:206`, `src/workflows/order/sweep-abandoned-orders.ts:56`
- **Verified:** The failure reproduces exactly. POST /api/orders (route.ts:98 passes the body straight to the workflow with no externalRef requirement) with {paymentChannel:"cod", lines, shipping, contactEmail} and no externalRef and no deliveryMethod → createOrderFromLinesWorkflow: d.externalRef is undefined, so the clash check (line 110) is skipped and placeOrderWorkflow is called with externalRef:undefined and deliveryMethod defaulting to home_delivery. place-order inserts status=pending, external_ref=NULL (:1012), delivery_method=home_delivery, and never touches con
- **Fix:** Mirror manual-order.ts: after a successful placement in createOrderFromLinesWorkflow (create-from-lines.ts, around :272 after `if (!placed.ok)`), stamp confirmed_at via `db.transaction(tx => orderService.confirmOrderInTx(tx, placed.data.orderId, actorUserId))` at least for the cod channel (an ERP push is an accepted order). Alternatively require externalRef 

#### Invalid inline audience rule is silently saved as no rule → coupon can go PUBLIC
- **Severity:** 🟠 MED (medium) · **Category:** bug · **ID:** `promotions#1`
- **Claim:** When the admin enables 'Cibler par règle d'audience' but the built tree is incomplete/invalid, the hidden audienceRuleTree input posts an empty string, the form does NOT block submit, and the workflow saves the promo with audience_rule_tree=null — turning an intended audience-restricted coupon into a public one.
- **Evidence:** `src/app/admin/promotions/promotion-form.tsx:591`, `src/workflows/promotion/manage.ts:295`, `src/lib/actions/promotion.ts:197`
- **Verified:** The claimed control-flow is accurate at every cited line. An admin creating a code/URL coupon who ticks "Cibler par règle d'audience", deletes the seeded condition (making the tree an empty group), and sets no segment/business/email target, can still submit: the empty tree serializes to "", the action coerces "" to null, the Zod refine only validates non-null trees, and requestedTargetCount excludes the audience rule so the fail-closed noValidTargets gate is bypassed. The promo is persisted with audience_rule_tree=null and the eligibility engine then tre
- **Fix:** Block submission while `audienceEnabled && !isBuilderTreeValid(audienceTree)` (add the condition to the submit button's disabled and/or an onSubmit guard). Better/defense-in-depth: post a sentinel (e.g. a separate "__audienceEnabled" flag already present as a hidden field, read server-side) so the workflow can reject "enabled but empty" instead of silently c

#### Footer/newsletter banner image is collected in admin but never rendered on the storefront
- **Severity:** 🟠 MED (medium) · **Category:** dead-feature · **ID:** `CMS — banners, nav, footer, trust badges, theme (cms-chrome)#1`
- **Claim:** The Footer admin embeds the full BannerForm (lockPlacement="footer") and explicitly advertises « + image du bandeau », but the storefront footer's newsletter row consumes only eyebrow/title/subtitle/ctaLabel — never the banner image (nor ctaHref, description, secondaryCTA).
- **Evidence:** `src/app/admin/cms/footer/footer-panel.tsx:122`, `src/app/admin/cms/footer/footer-panel.tsx:128`, `src/components/admin/banner-form.tsx:328`, `src/app/(shop)/layout.tsx:355`, `src/components/site-footer.tsx:104`, `src/lib/api/cms.ts:160`
- **Verified:** Reproducible path: operator opens CMS → Footer, Image tab offers a "Visuel" picker (footer reco 1920×480) and footer-panel.tsx:123 promises « + image du bandeau »; saving posts imageMediaId → stored in banners.image_media_id; listFooterBanners→toRenderable resolves it into RenderableBanner.image. But the sole first-party consumer that renders the storefront footer (layout.tsx → SiteFooter) drops the image: the newsletter prop (layout.tsx:355-367) carries only eyebrow/title/subtitle/cta, and site-footer.tsx renders none of the image/ctaHref/description/se
- **Fix:** Either render the footer banner image in SiteFooter's newsletter block (thread footerBanners[0].image through the newsletter prop), or gate the footer placement: hide the Image tab + remove the « + image du bandeau » copy (and the unused ctaHref/description/secondaryCTA fields) when lockPlacement==="footer", so operators aren't promised a visual the storefro

#### Nav-item nesting (parent_id) is rendered on the storefront but has no admin create path
- **Severity:** 🟠 MED (medium) · **Category:** dead-feature · **ID:** `CMS — banners, nav, footer, trust badges, theme (cms-chrome)#2`
- **Claim:** nav_items.parent_id, the workflow's parentId field, the action's optionalUuid(formData,"parentId") read, toNavLink's recursive children, and footer-columns' nested <LinkRow> all support sub-items, but the only item editor (NavItemForm) never renders a parentId input, so every item created/edited through the admin is forced top-level.
- **Evidence:** `src/modules/cms/navigation/schema.ts:37`, `src/workflows/cms/navigation.ts:86`, `src/lib/actions/cms.ts:457`, `src/app/admin/cms/_components/nav-menu-editor.tsx:417`, `src/components/storefront/footer-columns.tsx:33`, `src/lib/api/cms.ts:273`
- **Verified:** Every link in the finding's chain is accurate. The storefront fully supports footer sub-items: getMenu builds a parent_id tree, toNavLink maps children recursively, and footer-columns.tsx renders a nested <ul> for link.children (carried through FooterLink.children into SiteFooter via (shop)/layout.tsx). The workflow/schema/action all accept and persist parentId. But the only admin item editor, NavItemForm (nav-menu-editor.tsx:417-534), renders no parent-selector field, so createNavItemAction always receives parentId=null (optionalUuid of an absent field)
- **Fix:** Add a « Parent » selector to NavItemForm (options = this menu's top-level items) for menus that render children (footer columns), posting parentId; also read/set parentId in updateNavItemAction/updateNavItemWorkflow to allow reparenting. Alternatively drop the nesting plumbing if nesting is not wanted.

#### Nav/footer links to a CMS `page`/`system` target are never liveness-pruned → stale 404 links persist
- **Severity:** 🟠 MED (medium) · **Category:** oversight · **ID:** `CMS — banners, nav, footer, trust badges, theme (cms-chrome)#3`
- **Claim:** checkedNavKind() only classifies category/brand/collection; a nav item whose internalKind is `page` (or `system`) is excluded from the dead-link check, so pruneDeadMenuLinks never drops it when the backing CMS page is unpublished or deleted.
- **Evidence:** `src/lib/cms/nav-link-liveness.ts:37`, `src/lib/api/cms.ts:356`, `src/lib/links/link-target.ts:65`
- **Verified:** The full failure path reproduces from the actual code. A footer/nav item stored as internal_kind='page', internal_ref='promo' always resolves to /promo via resolveLinkHref (link-target.ts case "page"). The liveness checker only validates category/brand/collection; checkedNavKind returns null for a page kind, so pruneDeadNavItems never drops it and (for a page-only footer) hasCheckedNavRef makes pruneDeadMenuLinks skip entirely. When the operator unpublishes or deletes the backing CMS page, getPageForRender('promo') returns null — the slug is not a system
- **Fix:** Add `page` to LiveNavTargets and checkedNavKind, and have loadLiveNavTargets populate a `page` set from the published, non-deleted CMS page slugs (pageService published-slug list). Keep `system` exempt since those always render a built-in default. The existing admitRedirectedNavRefs re-admission then still protects a renamed page slug that an active redirect

#### Suggested OpenAI o-series model (o4-mini) is incompatible with the chat chokepoint
- **Severity:** 🟠 MED (medium) · **Category:** bug · **ID:** `ai-generation#2`
- **Claim:** The model datalist offers 'o4-mini', but generateText always sends max_tokens and temperature on the OpenAI-compatible path; o-series reasoning models reject max_tokens (require max_completion_tokens) and only accept temperature=1.
- **Evidence:** `src/lib/ai/models.ts:22`, `src/lib/ai/client.ts:114`, `src/lib/ai/client.ts:126`
- **Verified:** Reproducible path: admin selects "o4-mini" (offered in the datalist, unvalidated) as the OpenAI provider default or per-task model → cfg.defaultModel/config.model flows to client.ts:63 → OpenAI-compatible branch POSTs to api.openai.com/v1/chat/completions with temperature=0.7/0.1/0.9 (always sent, never 1) and, because both real callers always pass maxTokens, with max_tokens. o-series models reject both: max_tokens (require max_completion_tokens) and any temperature != 1. OpenAI returns HTTP 400, client.ts:135-136 turns it into an ok:false provider error
- **Fix:** Either drop o-series ids (o4-mini) from AI_MODEL_SUGGESTIONS.openai in models.ts, or in client.ts detect an o-series id on the OpenAI path and send max_completion_tokens instead of max_tokens while omitting temperature (or forcing temperature=1).

#### Two bulk AI flows have no per-actor cost rate limit (auto-assign, review-gen)
- **Severity:** 🟠 MED (medium) · **Category:** oversight · **ID:** `ai-generation#4`
- **Claim:** startProductGenerationAction and startContentGenerationAction throttle via checkRateLimit('ai:bulk', 10/hour), but startAutoAssignDryRunAction and startReviewGenerationAction have NO rate limit — only a single-flight (one-active-per-kind) gate.
- **Evidence:** `src/lib/actions/ai-assign.ts:97`, `src/lib/actions/review-generation.ts:130`, `src/lib/actions/product-generation.ts:93`, `src/lib/actions/content-generation.ts:123`
- **Verified:** The single-flight hasActive() gate (ai-assign.ts:108, review-generation.ts:139) rejects only a concurrent second run; after a run completes it returns false, so a system_ai:manage / reviews:manage operator can relaunch a whole-catalogue dry-run back-to-back indefinitely. Each run issues one paid AI call per product, and nothing else (no per-actor hourly cap, no provider spend/quota cap) bounds sequential spam — whereas the other two bulk flows are capped at 10/hour on the shared ai:bulk:<userId> bucket. The claimed cost path reproduces exactly. It is med
- **Fix:** Add the same checkRateLimit({ bucket: `ai:bulk:${session.user.id}`, max: 10, windowSeconds: 3600 }) (degrade-open, logged) at the top of startAutoAssignDryRunAction (ai-assign.ts) and startReviewGenerationAction (review-generation.ts), reusing the shared per-actor bucket so all four bulk AI flows share one hourly budget.

#### email_suppressions list is read by the consent gate but never populated
- **Severity:** 🟠 MED (medium) · **Category:** dead-feature · **ID:** `mailing-newsletter-blog-aid#1`
- **Claim:** Both marketing-consent gates query email_suppressions for hard bounces / spam complaints, but no code path ever INSERTs a suppression row (no provider bounce/complaint webhook exists anywhere in src).
- **Evidence:** `src/modules/mailing/schema.ts:197`, `src/lib/email/consent.ts:48`, `src/lib/email/consent.ts:103`
- **Verified:** The two marketing-consent gates both query email_suppressions as dimension 1 (hard bounce/complaint), but no production code path ever inserts a suppression row — no provider bounce/complaint webhook (only flouci/clictopay payment webhooks exist), no admin suppression-add control, and no ORM/raw insert outside test fixtures. The newsletter-panel "suppression record" is a newsletter_subscriptions row, a separate gate dimension, not email_suppressions. So an address that hard-bounces or files a spam complaint is never added, canSendMarketingTo/filterMarket
- **Fix:** Wire a Resend (or SMTP) bounce/complaint webhook route under src/app/api/webhooks/ that upserts into email_suppressions (reason bounce|complaint), and/or add an admin manual suppression-add control. Until one of those exists the suppression gate is inert.

#### wishlist_campaign email ships wishlist_items as escaped literal HTML
- **Severity:** 🟠 MED (medium) · **Category:** bug · **ID:** `mailing-newsletter-blog-aid#2`
- **Claim:** The wishlist-campaign runner passes the built `wishlist_items` HTML (<ul><li><a>…) inside dispatchEmail `variables`, but dispatch HTML-escapes every `variables` value; the template declares `wishlist_items` as isHtml:true and expects it via `htmlVariables`.
- **Evidence:** `src/lib/mailing/wishlist-campaign/run.ts:154`, `src/modules/mailing/dispatch.ts:89`, `src/modules/mailing/templates.ts:499`
- **Verified:** On a real cron run, `buildBodyVars` escapes the wishlist list HTML (`<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`) because it is passed in `variables` rather than `htmlVariables`. `renderTemplate` then inserts those entities into the body at `{{ wishlist_items }}`, so the recipient's email client renders literal text like "<ul><li>..." instead of a clickable product list. The admin test/preview routes the same variable through `htmlVariables` (unescaped), so it renders correctly — confirming the preview-vs-ship mismatch. No guard, caller, or config prevents
- **Fix:** In run.ts, move the built `wishlist_items` fragment out of `variables` into `htmlVariables: { wishlist_items }` (mirroring send-promotion-announcement's `code_block`), leaving the scalar vars (first_name, code, discount, shop_url) in `variables`.

#### deleteLocationAction lacks the pending-transfer guard that deactivation enforces
- **Severity:** 🟠 MED (medium) · **Category:** inconsistency · **ID:** `inventory-stock#1`
- **Claim:** A stock location that is the source or destination of a non-terminal transfer can be soft-deleted, permanently stranding those transfers because completion can no longer move stock through a deleted location.
- **Evidence:** `src/lib/actions/stock-locations.ts:428`, `src/lib/actions/stock-locations.ts:334`, `src/modules/stock-transfer/service.ts:333`, `src/modules/stock-location/service.ts:326`
- **Verified:** Full failure chain reproduces from actual code. Create transfer A→B (status requested/accepted/in_transit); stock has not moved yet so destination B holds 0 units. deleteLocationAction(B) passes the is_default check, locationStockUnits(B)=0 skips the evacuation/opts branch entirely, and softDelete(B) commits (deleted_at set, is_active=false) with no transfer check. Completing the transfer calls transition→moveStockTx→_applyLevelTx(dest=B); that lookup filters isNull(deleted_at), returns no row, and throws "Emplacement introuvable ou inactif.", rolling ba
- **Fix:** In deleteLocationAction, before softDelete(id), call stockTransferService.countPendingForLocation(id) and refuse (error "has_transfers") when >0 — or cancel those non-terminal transfers as part of the delete — mirroring the updateLocationAction deactivation guard at stock-locations.ts:334-345.

#### Payment-encryption key stored in same DB as the ciphertext it protects; scorecard reports pass
- **Severity:** 🟠 MED (medium) · **Category:** security · **ID:** `Platform: db, cache, config/settings, security, audit, headless API, bootstrap (platform-infra)#1`
- **Claim:** In the default zero-ceremony deploy, PAYMENT_ENCRYPTION_KEY (and BETTER_AUTH_SECRET) are auto-generated and persisted as plaintext rows in app_secrets — the SAME Postgres database that holds the AES-256-GCM-encrypted payment credentials (site_settings.*_enc) — so at-rest encryption gives no protection against the exact threat it targets (a DB dump / backup leak), yet posture.ts still reports payment-enc as a green 'pass' whenever the key is merely present.
- **Evidence:** `src/lib/db/init-secrets.ts:67`, `src/lib/crypto/secrets.ts:21`, `src/lib/security/posture.ts:101`, `src/lib/bootstrap/default-admin.ts:276`
- **Verified:** Reproducible path: a fresh Coolify deploy with no PAYMENT_ENCRYPTION_KEY/BETTER_AUTH_SECRET env vars (the documented default) → entrypoint runs init-secrets → both keys generated and stored as plaintext app_secrets rows in the same Postgres instance that later holds the AES-256-GCM ciphertext (payment_provider_settings.*_enc, plus oauth/ai/email/webhook/gift-card _enc columns). A full DB dump / backup leak therefore contains BOTH the plaintext key and the ciphertext; deriveKey = sha256(plaintext key) → decryptSecret() yields every gateway credential in c
- **Fix:** Have the posture fact distinguish source: resolve PAYMENT_ENCRYPTION_KEY/BETTER_AUTH_SECRET provenance (process.env set BEFORE init-secrets eval vs loaded from app_secrets) and downgrade payment-enc to "info"/"warn" when the key resolves from the DB rather than env; surface a scorecard note that at-rest encryption is only meaningful when the key is supplied 

#### /parrainage/<token> referral invite token leaks to GA4/GTM/Meta
- **Severity:** 🟠 MED (medium) · **Category:** security · **ID:** `storefront-shell-tracking#1`
- **Claim:** The /parrainage/<token> referral-invite landing loads third-party tags and reports its full URL (including the live invite token) to GA4/GTM and the Meta Pixel, because the route is absent from both TAG_FREE_PATHS and BEARER_PATH_RULES — unlike the parallel /pro/join/<token>.
- **Evidence:** `src/lib/tracking/redact-url.ts:25`, `src/lib/tracking/redact-url.ts:38`, `src/app/(shop)/parrainage/[token]/page.tsx:28`
- **Verified:** For /parrainage/<token>: isTagFreePath returns false (no base matches), so TrackingScripts loads GTM/GA4/Meta. redactTrackedUrl matches no BEARER_PATH_RULES regex and the token is a path segment (not in TOKEN_PARAMS {token,t,k}), so the full token URL passes verbatim into the GTM dataLayer and GA4 page_location. isSensitiveTrackedUrl returns false (not tag-free, redact.changed=false), so the Meta Pixel keeps autoConfig on and fires PageView with the raw token URL; owner custom snippets also run (customTagsAllowed=true). The invite_token is a 144-bit reus
- **Fix:** Add '/parrainage' to TAG_FREE_PATHS and a [/^\/parrainage\/[^/]+/, '/parrainage/:token'] rule to BEARER_PATH_RULES in redact-url.ts, mirroring /pro/join; audit other token-in-path (shop) routes for the same gap.

#### Wildcard webhook subscription leaks raw customer email (newsletter.*) despite data-minimization policy
- **Severity:** 🟠 MED (medium) · **Category:** security · **ID:** `jobs-cron-webhooks-import-erp#1`
- **Claim:** An outbound webhook endpoint subscribed to ["*"] receives newsletter.subscribed / newsletter.unsubscribed events whose payload contains a customer's raw (unmasked) email, even though the subscriber deliberately withholds other PII-bearing telemetry from wildcard subscribers.
- **Evidence:** `src/events/subscribers/dispatch-webhooks.ts:26`, `src/events/subscribers/dispatch-webhooks.ts:63`, `src/events/types.ts:478`, `src/events/types.ts:884`
- **Verified:** The full path is reachable: a customer toggling marketing_opt_in → customer.profile_updated → sync-marketing-optin emits newsletter.subscribed/unsubscribed with the raw, lowercased email → the wildcard dispatcher matches because "newsletter" is not in SECURITY_DOMAINS, so isSecuritySensitiveEvent returns false (dispatch-webhooks.ts:67) → the raw payload is stored (service.ts:129) and POSTed to the third-party endpoint (dispatch-drain.ts:111) with no by-name opt-in. The same email PII is explicitly masked for user.* events (types.ts:84,97), and the dispat
- **Fix:** Either add "newsletter" to SECURITY_DOMAINS in dispatch-webhooks.ts:26 so wildcard endpoints must opt in by exact name, or change the newsletter.* payloads/emit sites to carry a masked email (emailMasked) the way user.* events already do.

#### Scheduled/run-now détourage is capped at 90s withJobTimeout and falsely logged 'failed' on a bulk back-fill while the orphaned job keeps the import single-flight
- **Severity:** 🟠 MED (medium) · **Category:** bug · **ID:** `jobs-cron-webhooks-import-erp#3`
- **Claim:** product_detourage runs through runScheduledJob → withJobTimeout(work(), 90s), but runScheduledProductDetourage awaits runProductWhiteBgReprocess which re-encodes every un-processed product image serially (resize + jpeg/webp/avif via sharp). A first back-fill of more than a few dozen images exceeds 90s.
- **Evidence:** `src/lib/jobs/run-job.ts:199`, `src/lib/jobs/run-job.ts:256`, `src/workflows/media/reprocess-product-white-bg.ts:429`, `src/lib/actions/data-jobs.ts:276`
- **Verified:** The scheduled détourage path is capped at 90s by withJobTimeout (Promise.race), but the underlying runProductWhiteBgReprocess re-encodes every un-processed product image serially (flood-fill + WebP + AVIF effort-4 + mozjpeg JPEG via sharp, both variants on by default, plus S3 round-trips). A first back-fill of ~100+ images (realistic for a watch store enabling the feature) exceeds 90s. At 90s the race rejects: runAndLog records a `failed` job_run_log row (dashboard shows the product_detourage job FAILED) and re-throws. Promise.race cannot cancel the work
- **Fix:** Make the scheduled détourage fire-and-forget like startProductWhiteBgReprocessAction (create the import_jobs row, kick runProductWhiteBgReprocess detached, return an immediate ok/queued summary for the run-log and poll the import_jobs row for the real outcome), OR raise/remove the 90s ceiling specifically for product_detourage, OR checkpoint the reprocess lo

#### PDP shows all approved reviews but a customer-only count/histogram/rating
- **Severity:** 🟠 MED (medium) · **Category:** inconsistency · **ID:** `catalog-reviews-showcase#1`
- **Claim:** Under reviews.rating_source="customers", the PDP headline count, star average, histogram and JSON-LD AggregateRating count ONLY customer reviews, but the on-page review list (and the headless /api/reviews items) render ALL approved reviews (customer+manual+ai), so the displayed numbers contradict the visible list.
- **Evidence:** `src/app/(shop)/[slug]/page.tsx:1074`, `src/modules/catalog/review/service.ts:190`, `src/modules/catalog/review/queries.ts:22`, `src/components/product-reviews.tsx:131`, `src/lib/db/tests/reviews-showcase.test.ts:411`
- **Verified:** Under reviews.rating_source="customers" the stored products.reviews_count/rating (headline count + star average), the live distribution histogram, and the JSON-LD aggregateRating.reviewCount are all filtered to source='customer', but listApproved (feeding both the PDP review list via product-tabs.tsx:322 → ProductReviews and the /api/reviews items) applies no source filter, so it returns every approved review (customer+ai+manual). With the test's scenario (4 approved customer + AI/manual approved), the header shows "4 avis" and a histogram summing to 4 w
- **Fix:** When rating_source="customers", either source-filter listApproved/listProductReviews (and the /api/reviews items + the client rating-filter list) to source='customer', or keep showing all approved reviews but label the customer-only count distinctly and move AI/manual reviews into a separate section so the headline/histogram/JSON-LD count matches the visible

### B3. Low (confirmed, lower impact)

#### Home banner/cta_band wraps the whole band in <Link href="#"> when no CTA is set
- **Severity:** 🟡 LOW (low) · **Category:** bug · **ID:** `cms-home-pages#2`
- **Claim:** A decorative home banner/cta_band block with an image but no ctaHref becomes a full-area clickable link to "#".
- **Evidence:** `src/components/storefront/home/home-blocks-render.tsx:176`, `src/components/storefront/page/page-blocks-render.tsx:587`
- **Verified:** Reproducible path: operator adds a home « Bannière » (case "banner") or « Bandeau CTA » (case "cta_band") with an image but no CTA link → c.header.ctaHref is "". The block passes the line-173 render guard because image is set. At line 177-178 the renderer always wraps the entire band in next/link's `<Link>`, and `safeHref("")` evaluates to "#", so href resolves to "#". The full ~18rem clickable area becomes an anchor to "#": clicking scrolls to top / appends "#" to the URL and the band is announced as a link to assistive tech. The home-card siblings (fif
- **Fix:** In home-blocks-render.tsx's banner/cta_band case, compute a real href (e.g. realHref(h.ctaHref) from page-blocks.ts, or `const href = safeHref(h.ctaHref); const hasLink = href !== "#";`) and render the band inside `<Link>` only when hasLink is true, otherwise a plain `<div>` with the same className — mirroring CtaBlock and the two home card components. Move 

#### Late-capture log on a cancelled credit-settled order prints the wrong expected amount
- **Severity:** 🟡 LOW (low) · **Category:** bug · **ID:** `orders#2`
- **Claim:** detectLateCaptureOnCancelledOrder logs expectedMinor as toGatewayMinor(order.total_cents), but the gateway was charged amountDueCents (total_cents − credit_applied_cents).
- **Evidence:** `src/workflows/order/gateway-payment.ts:464`
- **Verified:** Concrete path: online order total_cents=100000 with credit_applied_cents=30000 → initiatePayment charges the gateway dueCents=70000. Order is cancelled while still pending (paid_at=null). A late gateway capture lands via webhook (webhook-handler.ts:154-155) or return page; detectLateCaptureOnCancelledOrder passes its guards (status==="cancelled", paid_at==null, online method, reference present — lines 433-434), verifyGatewayPayment returns status "paid" with amountMinor=70000. The ERROR log at lines 455-467 then prints paidMinor=70000 and expectedMinor=t
- **Fix:** Add credit_applied_cents to the order param type of detectLateCaptureOnCancelledOrder and compute expectedMinor as toGatewayMinor(amountDueCents(order), order.currency) instead of order.total_cents, matching initiatePayment/confirmPayment.

#### Re-voiding an already-void gift card wipes its reissue link + void reason
- **Severity:** 🟡 LOW (low) · **Category:** data-loss · **ID:** `loyalty-credit-giftcard#4`
- **Claim:** voidGiftCardOnly → giftCardService.voidCard guards only WHERE status <> 'redeemed', and unconditionally sets replaced_by_gift_card_id = input.replacedById ?? null and void_reason = reason ?? null; voiding an already-void (and previously reissued) card overwrites those to NULL.
- **Evidence:** `src/modules/gift-card/service.ts:169`, `src/lib/gift-card/reissue.ts:122`
- **Verified:** Reproduced: a reissued card A is status=void with replaced_by_gift_card_id=B and void_reason set. A direct call to voidGiftCardAction(A) → voidGiftCardOnly({reason:null}) → voidCard(A,{reason:null,replacedById:undefined}). The WHERE `status <> 'redeemed'` is TRUE for a void card, so the UPDATE matches and rewrites void_reason→NULL and replaced_by_gift_card_id→NULL (plus re-stamps voided_at/voided_by), returning the row so the action reports ok. This erases the reissue chain link and original void-reason audit exactly as claimed. It is genuinely latent: t
- **Fix:** Make voidCard conditional on `status = 'active'` (replace the `<> 'redeemed'` predicate), or have voidGiftCardOnly re-read the row and refuse any non-active card before calling voidCard. voidAndReissueGiftCard already guards status==='void'/redeemed/expired beforehand, so tightening voidCard's WHERE to `= 'active'` would not regress the reissue path.

#### First-purchase discount re-earned per COD order before first settles
- **Severity:** 🟡 LOW (low) · **Category:** money · **ID:** `loyalty-credit-giftcard#8`
- **Claim:** effectiveConsumerPct gates the one-time first-purchase % on paid_order_count <= 0, which is bumped only when an order SETTLES (order.paid/delivered); a COD buyer who places several orders before the first delivers keeps paid_order_count === 0 and re-earns the welcome discount on each.
- **Evidence:** `src/lib/loyalty/member-discount.ts:56`, `src/lib/loyalty/member-benefit.ts:122`
- **Verified:** The claimed failure reproduces from the actual code. A Le Foyer COD buyer with paid_order_count=0 places order #1: effectiveConsumerPct(0, 5, 0)=max(0,5)=5 → -5% folded into discount_cents, and place-order neither stamps a one-time flag nor increments paid_order_count. Because COD only bumps paid_order_count when the order settles (order.paid emitted at delivery), orders #2 and #3 placed before #1 delivers still see paid_order_count=0 and each re-earns the -5% welcome discount. The only guard that would stop this (a placement-tx first_purchase_discount_u
- **Fix:** If true once-only is wanted, stamp first_purchase_discount_used_at on the customer profile inside the place-order transaction when the first-purchase pct is applied, and gate effectiveConsumerPct (or a placement-time check) on that stamp instead of paid_order_count. Otherwise leave as the documented accepted tradeoff.

#### wishlist_campaign product links use non-existent /produit/<slug> route (404)
- **Severity:** 🟡 LOW (low) · **Category:** bug · **ID:** `mailing-newsletter-blog-aid#3`
- **Claim:** The wishlist-campaign email builds product links as `${origin}/produit/${slug}`, but the canonical product URL is `/<slug>` (single segment); there is no /produit route and next.config only redirects English `/product/:slug`, not French `/produit/:slug`.
- **Evidence:** `src/lib/mailing/wishlist-campaign/run.ts:139`, `src/components/product-card.tsx:109`
- **Verified:** The email hard-codes a `/produit/` prefix that has no route. `resolvePublicOrigin()` yields scheme+host with no trailing slash, so each featured link is `https://host/produit/<product-slug>` — two path segments. Next matches that to the catch-all `[slug]/[sub]` route (not the single-segment product route `[slug]`), binding slug="produit". That page calls getCategoryBySlug("produit"), which returns null (no such category), then notFound() → every wishlist link in the email is a 404. The static `/product/:slug` redirect does not help because it only covers
- **Fix:** Change run.ts:139 to use `${origin}/${it.slug}` (matching product-card.tsx and the flat route), or add a `/produit/:slug` → `/:slug` redirect in next.config.ts.

#### Détourage '-nobg' sentinel collides with user filenames containing '-nobg.'
- **Severity:** 🟡 LOW (low) · **Category:** bug · **ID:** `media (Media library, CDN proxy, image processing / détourage)#3`
- **Claim:** The reprocess scan and the main-only détourage gate exclude rows matching `notLike(storage_key, '%-nobg.%')`, but '-nobg' is also a user-reachable filename substring, so a product image whose uploaded filename contains '-nobg.' is permanently treated as 'already processed'.
- **Evidence:** `src/workflows/media/reprocess-product-white-bg.ts:240`, `src/workflows/media/reprocess-product-white-bg.ts:327`, `src/modules/media/reprocess-detourage.ts:141`
- **Verified:** A product image whose filename contains -nobg. is permanently excluded from detourage because the gate treats any storage_key with that substring as already reprocessed. buildStorageKey (storage.ts:56-63) keeps hyphens and dots, and upload-media.ts:109-110 strips only the final extension, so watch-nobg.jpg becomes storage_key products/uuid-watch-nobg.jpg. Both the main-only gate (reprocess-product-white-bg.ts:240) and the bulk/scheduled scan (:327), plus the offline script (scripts/reprocess-product-white-bg.ts:308), filter it with notLike/NOT LIKE perce
- **Fix:** Match -nobg only before the final extension (percent-nobg.jpg/.webp/.avif or an end-anchored regex), or use a dedicated already-detoured column. Fix all three sites.

### B4. Disputed — needs a human call

The two skeptics split; treat as open questions, not confirmed defects.

- **Business employee discount suppressed when loyalty config read fails on display surfaces** (`loyalty-credit-giftcard#9`, bug) — resolveMemberBenefit gates `const benefit = loyaltyConfig ? selectMemberBenefit(...) : null`, so when the degrade:true path catches a resolveLoyaltyConfig() failure (loyaltyConfig = null) the BUSINESS employee discount is also dropped — contradicting the stated invariant that the employee benefit is independent of the loyalty program.
  - The quoted mechanism is literally correct: when resolveLoyaltyConfig() throws in degrade mode, loyaltyConfig=null and line 105 makes benefit=null, so the employee benefit is dropped from the resolver output; employeeLevel itself (lines 75-77) is still looked up, and the scenario is reachable because the pages' pre-member reads (getDeliveryConfig/getCheckoutCopy/getCartPageCopy/getActiveCurrency, and getActiveEmployee
- **ERP push_stock / pull_stock toggles gate nothing (presented as functional)** (`inventory-stock#2`, dead-feature) — erp.push_stock and erp.pull_stock are written and displayed but enforce no behaviour: outbound stock webhooks fire regardless of push_stock, and pull_stock only renders a warning banner — the platform never actually defers edits to the ERP.
  - The mechanical half of the claim is CONFIRMED: push_stock gates nothing in the outbound-webhook path (dispatch-webhooks gates only on outboundWebhooksEnabled + endpoint subscription; bulkUpdateStockAction emits product.updated unconditionally), and pull_stock only drives a banner while admin edits are never blocked/deferred. However the finding's actual defect characterization — that these toggles are "presented as f

### B5. Refuted — investigated, not a defect

Reported by the first pass but **cleared** on verification (listed so they are not re-flagged).

- **2FA not enforced on the verify-email auto-sign-in session-mint path** (`auth-rbac-users#1`) — The claimed failure cannot be reproduced. Its pivotal step — a 2FA account that becomes unverified "then triggers a verification email" — has no implementation path. The cited adminSetUserEmailAction/setEmail sends no verification email; /send-verification-email is HTTP-disabled; and nothing in-process calls auth.api.s
- **Webhook body parser only handles JSON bodies, not form-urlencoded callbacks** (`cart-checkout-payment#4`) — The mechanical claim is accurate — request.json() on a form-urlencoded body throws, is caught (:122), ref stays null, and :126-127 returns 400; there is no formData/URLSearchParams fallback. But the claimed FAILURE is not reproducible. The registered dynamicCallbackUrl being a bare path (webhookUrlFor) does not mean th
- **Embedding model is resolved twice independently (fingerprint vs. actual embed)** (`ai-generation#5`) — The double-resolution exists, but the claimed permanent "mixed-model vector" cannot occur. (1) Within a single invocation both model resolutions read `ai.embedding_model` through `getSettingsMap`, which is React `cache()`-memoized per request (queries.ts:19); the admin backfill runs in one "use server" request (embeddi
- **stripUnsafeEmailHtml misses unquoted handlers and obfuscated javascript:** (`mailing-newsletter-blog-aid#7`) — The regex gap is technically real, but the finding is a SECURITY finding whose whole payload is "executes in a permissive admin preview." That permissive context does not exist: the sole in-app render of the override HTML is a fully sandboxed iframe (sandbox="") that disables all scripting, so a surviving unquoted hand
- **Ledger sum(delta) double-counts shipped units in per_location mode** (`inventory-stock#3`) — The finding's two load-bearing premises are both false against the code/docs. (1) "no scope flag" is wrong: location_id distinguishes total-scoped (NULL) from location-scoped (depot) order rows and is serialized on the ERP feed (movements.ts:25). (2) The "documented reconciliation = running sum of delta" premise is wro
- **Dispatch in-flight lock is a per-process boolean — no overlap guard across app instances** (`jobs-cron-webhooks-import-erp#7`) — The finding's mechanism is accurate (the lock is a per-process boolean), but no path to the claimed failure exists. Two preconditions are required and neither holds: (1) a real multi-instance deployment — the code states the actual topology is single-instance (api-settings/service.ts:48; route.ts:24), multi-instance is

## C. Dead code & dead functionality (verified against the whole repo)

Each claim was checked by grepping the entire repo (src + scripts + tests + docs) for every usage. `CONFIRMED` = no live consumer found (safe to remove, barring the noted risk). `PARTIAL` = referenced only by tests/docs or only half-wired (a feature gap, not pure dead code).

### C1. Confirmed dead / removable (36)

| Item | Category | Evidence | Note |
|---|---|---|---|
| SECTION_TITLE and CARD_TITLE are dead exports (zero consumers repo-wide) | dead-code | `src/lib/pages/block-model.ts:87` | SECTION_TITLE and CARD_TITLE have zero consumers repo-wide (only their definition in block-model.ts and the pass-through re-export in home-blocks.ts). |
| banner_duo renderer reads config.image/imageMobile that the parser never produces | dead-code | `src/lib/pages/home-blocks.ts:172` | Confirmed. Every parsed/synthesized/stored banner_duo block has image and imageMobile undefined: the parser's banner_duo case emits only {bannerId, ba |
| BLOCK_WIDTHS value "wide" renders identically to "default" (dead enum value) | dead-feature | `src/lib/pages/block-model.ts:95` | "wide" is a genuinely dead enum value. The parser accepts and persists it, but the two (and only two) components that read presentation.width both bra |
| Legacy Konnect ciphertext columns retained but never read or written | dead-code | `src/modules/payment/schema.ts:22` | The two columns are genuinely dead for all live runtime behavior. They can never be freshly written: the upsert's FIELD_TO_COLUMN has no entry mapping |
| Dead column review_generation_drafts.apply_error (never written or read) | dead-code | `src/modules/catalog/review/schema.ts:139` | The column is genuinely dead for both write and read paths. applyReviewDrafts wraps claim+insert+recompute in a single transaction, so a per-draft ins |
| listSitemapBrands is dead code (sitemap uses listActiveBrands instead) | dead-code | `src/modules/catalog/brand/queries.ts:61` | brandQueries is re-exported via `export * as brandQueries from "./queries"` (brand/index.ts:1), so any invocation would appear as `brandQueries.listSi |
| categoryService.listBySlugs is dead code | dead-code | `src/modules/catalog/category/service.ts:322` | The category method has no callers in src, scripts, tests, docs, or app routes, and there is no dynamic/string dispatch (the unique name would surface |
| collectionService.deleteAll is dead code | dead-code | `src/modules/catalog/collection/service.ts:191` | Every usage path was searched (imports, calls, dynamic `.deleteAll()`, barrel re-exports, scripts, tests). collectionService is used live elsewhere (l |
| upsertProductVariantsAction is an unreachable (dead) server action | dead-code | `src/lib/actions/catalog.ts:1171` | In Next.js App Router a `"use server"` export becomes a client-invocable endpoint (assigned a server-reference/action ID) only when a client component |
| Showcase grid_*/empty_*/cta_band_* settings keys are read but never writable | dead-feature | `src/lib/pages/collection-page-config.ts:208` | The settings keys pages.<slug>.{grid_*,empty_*,cta_band_*} are read into CollectionPageConfig but no admin form, action, or seed script writes them, s |
| `platform` column is vestigial — never settable via the editor yet still rendered | dead-feature | `src/modules/catalog/product/schema.ts:65` | Confirmed as a half-wired vestigial field. The persistence plumbing is fully present (createProductSchema accepts platform at create-product.ts:134; u |
| Dead service method listLiveAutoForProduct (app uses the batched resolver) | dead-code | `src/modules/promotion/service.ts:257` | The method on PromotionService can only be invoked as promotionService.listLiveAutoForProduct(...), and the exhaustive literal-name grep shows the onl |
| Dead service method countLivePromotionsForScopeTarget (delete guard uses the other counter) | dead-code | `src/modules/promotion/service.ts:663` | The finding is accurate. PromotionService.countLivePromotionsForScopeTarget is dead with respect to application code: it is invoked only inside the DB |
| Deprecated promotions.business_id column is write-dead but still read in several paths | dead-code | `src/modules/promotion/schema.ts:113` | Every particular of the finding checks out at the cited lines. The column is write-dead for all post-0042 data (three null-forcing writers, no non-nul |
| spendCredit() is dead code — no production caller | dead-code | `src/lib/credit/apply.ts:108` | spendCredit() is an exported orchestrator for a non-checkout credit debit. The only non-test reference is its own definition. The checkout path delibe |
| Several exported service methods are app-dead (only tested) | dead-code | `src/modules/gift-card/service.ts:34` | The methods are exported with docstrings promising live support/reconciliation use (findByReference "staff lookup", findById "the support tools", sumF |
| GIFT_CARD_ORIGINS / 'physical' origin is a dead reserved export | dead-code | `src/modules/gift-card/schema.ts:28` | The core claim is correct: the 'physical' origin value is never minted and never read in production — it is reserved forward-compat scaffolding kept i |
| ThemeConfig.defaultOgMediaId is computed on every request but never consumed | dead-code | `src/lib/theme/config.ts:43` | The ThemeConfig.defaultOgMediaId FIELD is genuinely dead: it is written in getThemeConfig()'s per-request memo (an extra str(s[...]) lookup) but no ca |
| navigationService.findMenuById and listAllMenuIds have zero consumers | dead-code | `src/modules/cms/navigation/service.ts:20` | Both methods compile and are reachable via the exported navigationService singleton but have zero invocations across the entire repository. Methods ar |
| Trust-badge `preorder` visibility is permanently dead (showPreorder hardcoded false) yet still a stored/CHECK-allowed value | dead-code | `src/lib/storefront/trust-badges.ts:46` | Every factual claim verifies against the actual code. The `preorder` visibility branch in resolveBuyBoxBadges fires only when showPreorder is true; th |
| search_log ip and user_id columns are never populated | dead-feature | `src/app/(shop)/recherche/page.tsx:168` | Every production search_log row is written with user_id=NULL and ip=NULL because the only non-skipLog caller (/recherche/page.tsx) forwards neither va |
| Alias term/expansion edit path is dead (toggle-only UI) | dead-feature | `src/modules/search/service.ts:428` | Repo-wide grep for updateSearchAliasWorkflow/updateAlias/toggleSearchAliasAction and editAlias/renameAlias/search.updateAlias found no caller anywhere |
| document_sequences_kind_idx standalone index appears redundant | dead-code | `src/modules/document/schema.ts:31` | The finding is factually correct. No query anywhere filters document_sequences by kind alone; the sole mutating access is the (kind,period) upsert, wh |
| ai_call_logs is a write-only journal with no reader; the "chat" half is never recorded | dead-feature | `src/modules/ai/schema.ts:84` | Every factual claim in the finding is true against the actual code. The table is appended only by the embedding path (embed.ts:148), purged by retenti |
| email_campaigns.template_key column and create() param are never written | dead-code | `src/modules/mailing/campaigns.service.ts:29` | The param and column are genuinely unwired. No caller ever supplies templateKey (both call sites were read in full), so the `?? null` always resolves  |
| newsletterService.list() (whole-table, unpaginated) has no caller | dead-code | `src/modules/newsletter/service.ts:94` | newsletterService.list() has zero callers anywhere — app code, workflows, event subscribers, scripts, tests, and docs. No barrel-import consumer calls |
| currencies.decimals column is dead (never written, never read) | dead-code | `src/modules/currency/schema.ts:32` | The currencies.decimals column is dead storage exactly as claimed: no create/update/admin path ever assigns it (it only receives the migration default |
| CURRENCY_SYMBOL_POSITIONS runtime array is an effectively-dead export | dead-code | `src/modules/currency/schema.ts:18` | The exported runtime array is read by nobody. Its only use is `(typeof CURRENCY_SYMBOL_POSITIONS)[number]` at schema.ts:19 to derive the type union —  |
| tax.rule.upserted event declares a scope field that is never populated | dead-code | `src/events/types.ts:617` | The `scope?: string / null` field in the tax.rule.upserted payload type is never populated. The only code path that emits the event passes just { rule |
| media.kind enum + column effectively dead (always 'image') | dead-code | `src/modules/media/schema.ts:30` | Every verifiable code path writes/relies on kind='image'. The enum values video/document/other are never produced, the exported mediaKindEnum symbol i |
| uploaded_by written on every upload but never read anywhere (write-only column) | dead-code | `src/modules/media/schema.ts:50` | The column is populated on every media insert but its value is never consumed, displayed, or sent to any client. The only code that "reads" it is gene |
| ALT_TEXT_MAX and MEDIA_TS_RE exported but used only internally / by tests | dead-code | `src/workflows/media/upload-media.ts:59` | A repo-wide ripgrep for each symbol (no path or file-type restriction, covering src/scripts/tests/docs/app routes) confirms both claims exactly. ALT_T |
| login funnel event (and refund) defined + grouped but never emitted | dead-feature | `src/lib/tracking/event-groups.ts:30` | Both `login` and `refund` are fully present in the taxonomy (type union + EVENT_TO_GROUP), are therefore allow-listed by /api/track (ALLOWED_EVENTS =  |
| __GZ_FUNNEL__ in-app subscriber queue has no consumer and grows unbounded | dead-feature | `src/lib/tracking/funnel.ts:146` | The in-app subscriber queue __GZ_FUNNEL__ is write-only: track() enriches each funnel event and pushes it, but no module in the entire repository read |
| CONSENT_CHANGE_EVENT broadcast has no listener | dead-code | `src/lib/consent/state.ts:24` | The CustomEvent is dispatched in writeConsentRecord but nothing in the repo listens for it, so the dispatch and the exported constant are dead. The tw |
| verifyWebhookSignature is dead code (exported, re-exported, used only in a test) | dead-code | `src/modules/webhook-endpoints/service.ts:30` | The webhook subsystem in this repo is OUTBOUND-only. The live drain src/lib/webhooks/dispatch-drain.ts:113 uses the sibling `signWebhookBody` to SIGN  |

### C2. Half-wired / test-only (9) — a feature or cleanup gap

- **Gateway/COD label + description settings keys are read but never writable (dead feature)** (`cart-checkout-payment#2`) — The finding's core fact (no admin writer for these 5 keys) is TRUE, but it is a DELIBERATE, DOCUMENTED deferral, not a dead feature — and several supporting claims are wrong. (1) The read branches are live, not inert: buy-block.tsx and checkout-form.tsx render all five values on every storefront pay
- **segmentCountSql is exported but referenced only by tests** (`customers-business-segments#4`) — The finding is accurate. segmentCountSql has no application caller; the admin segments panel's member-count card is fed by segmentStats().total, which comes from segmentStatsSql (SEGMENT_STATS_COLUMNS includes count(*)::int as total), confirming the count-card role was superseded. segmentCountSql is
- **Dead exported function productsMatchingScope (superseded by productsMatchingPromoScope)** (`promotions#3`) — The finding's two factual claims both hold against the actual code: (a) productsMatchingScope is never called by application/runtime code — the only non-definition, non-comment reference is a test; and (b) the coupon engine uses the multi-target-aware productsMatchingPromoScope (coupon-eligibility.t
- **Customer loyalty-QR mint is live UI with no in-repo consumer** (`loyalty-credit-giftcard#3`) — The finding's factual claims hold against the code, so it is not a false positive — but it describes a HALF-WIRED feature, which is why PARTIAL rather than fully CONFIRMED. The customer-facing mint (issueLoyaltyQrToken + refreshLoyaltyQrAction + LoyaltyQrCard) is genuinely live and shown in Mon Comp
- **createNavMenuSchema's arbitrary lowercase-key create path is unreachable from the UI** (`CMS — banners, nav, footer, trust badges, theme (cms-chrome)#11`) — The finding's narrow factual observations are all TRUE: repo-wide grep confirms there is no generic "new menu" form, every create path pins one of the 5 fixed system keys, and the storefront only ever reads those fixed keys — so an arbitrary-key menu is genuinely un-creatable from the UI and would b
- **carrier_ref is captured and displayed but never used to attribute orders** (`inventory-stock#5`) — The finding's factual core is accurate: nothing reads stock_locations.carrier_ref to attribute a pickup/in-store order to a location (the purpose promised in schema.ts:15-18). I followed the order placement path — place-order.ts/create-from-lines.ts/place-quick-order.ts/manual-order.ts all thread pi
- **Reserved cache tags + their invalidation subscribers are no-ops (no cached reader declares them)** (`Platform: db, cache, config/settings, security, audit, headless API, bootstrap (platform-infra)#2`) — The audit's observation that these tags/builders have no 'use cache' reader (so the subscriber busts are no-ops) is literally true — I enumerated every reader and none declares them. However, this is not an accidental dead feature: it is deliberate, exhaustively documented forward-wiring (tags.ts he
- **tryBustStorefrontCache exported but only referenced inside its own module** (`Platform: db, cache, config/settings, security, audit, headless API, bootstrap (platform-infra)#4`) — The finding's factual core (no non-test production module imports it; only self-referenced in production) is accurate, but the "dead code / effectively private" framing is largely a false positive. (1) The function is NOT dead — it is live production code, invoked on both the synchronous and the aft
- **ERP push/pull toggle settings are persisted but never read — non-functional config** (`jobs-cron-webhooks-import-erp#2`) — The finding's technical claim is accurate: no runtime path reads these toggles to gate behavior. push_stock/push_transfers/push_warranty/pull_warranty are read only to repopulate the ERP form's defaultChecked; pull_stock is read only for a cosmetic 'stock piloted by ERP' banner that does not actuall

### C3. Refuted deadness claims — actually used (2)

- **Reissue's EXPIRED-card refusal branch is unreachable from the UI** — "Dead-code" is the wrong category: the branch is a reachable, tested server-side money guard, not unused code. reissueGiftCardAction is a Next.js server action (a POST endpoint), callable with any cardId regardless of which buttons the clie
- **catalog.review_gen.generated event is emitted but has no subscriber** — The event is NOT dead. On every emit, the bus delivers it to the wildcard subscriber audit-everything.ts, which is the deliberate catch-all for the non-curated "long tail" of events. Because the event is not in the curated allowlist (audit-

## D. Lower-severity observations (first-pass, UNVERIFIED)

These 66 items came from the subsystem readers but were **not** put through adversarial verification (low severity: inconsistencies, style, perf nits, minor oversights). Confidence is the reader's own. Treat as a cleanup backlog to confirm individually before acting.

| Subsystem | Category | Sev/Conf | Observation | Evidence |
|---|---|---|---|---|
| ai-generation | inconsistency | low/high | Bulk generation stores truncated completions; the one-click path refuses them | `src/workflows/catalog/auto-assign/ai.ts:58` |
| ai-generation | inconsistency | low/medium | Same one-click task is more random on Anthropic than on OpenAI (temperature divergence) | `src/lib/ai/client.ts:91` |
| ai-generation | inconsistency | low/high | GameZone copy-paste leftover in auto-assign proposal mapper comment | `src/lib/actions/ai-assign.ts:289` |
| auth-rbac-users | inconsistency | low/high | Manage-class controls rendered to users:view-only delegates (UI-honesty inconsistency) | `src/app/admin/users/page.tsx:73` |
| auth-rbac-users | inconsistency | low/medium | Per-process auth-instance cache is never invalidated across pods | `src/lib/auth/server.ts:793` |
| auth-rbac-users | oversight | low/medium | staff enum role confers no access; invite flow cannot assign RBAC roles | `src/lib/rbac/authorize.ts:44` |
| cart-checkout-payment | bad-practice | low/high | Four hand-maintained copies of the live cart re-price logic | `src/lib/cart/live-lines.ts:69` |
| cart-checkout-payment | inconsistency | low/medium | getCartSummary SUM cast to ::int can overflow where the admin list uses ::bigint | `src/modules/cart/queries.ts:26` |
| cart-checkout-payment | inconsistency | low/high | ONLINE_METHODS / payable-method set duplicated across modules (drift risk) | `src/lib/checkout/quick-buy-config.ts:130` |
| cart-checkout-payment | perf | low/high | placeQuickOrderWorkflow re-runs the full getQuickBuyConfig (unused delivery/agent DB reads) on the hot express path | `src/workflows/order/place-quick-order.ts:117` |
| catalog-products | bad-practice | low/high | Keyed ERP /api/products responses carry storefront drip tags and query schedules for un-gated rows | `src/lib/api/products.ts:814` |
| catalog-products | inconsistency | low/medium | PDP variable 'à partir de' struck price can come from a different variant than the shown price | `src/app/(shop)/[slug]/page.tsx:1206` |
| catalog-products | inconsistency | low/medium | Listing card 'à partir de' uses cheapest variant ignoring stock, diverging from the in-stock PDP price | `src/lib/listing/display-pricing.ts:59` |
| catalog-reviews-showcase | inconsistency | low/medium | Single-review moderation busts only product:<id>, not products:list (stale card ratings) | `src/events/subscribers/invalidate-catalog-cache.ts:69` |
| catalog-reviews-showcase | oversight | low/medium | PDP 'Avis' tab still rendered to shoppers when the reviews feature is disabled | `src/components/product-tabs.tsx:17` |
| catalog-taxonomy | bad-practice | low/medium | Four migration-only media soft-link indexes not re-declared in the Drizzle schema | `src/modules/catalog/brand/schema.ts:95` |
| catalog-taxonomy | inconsistency | low/medium | Public categories API ignores ancestor-chain visibility (child of deactivated parent leaks) | `src/lib/api/categories.ts:513` |
| catalog-taxonomy | inconsistency | low/high | Landing settings namespace diverges (boutique uses storefront.*, marques/collections use pages.*) | `src/lib/actions/catalog.ts:535` |
| catalog-taxonomy | oversight | low/medium | number↔text attribute kind change silently hides existing per-product scalar values | `src/workflows/catalog/manage-attributes.ts:252` |
| CMS — banners, nav, footer, trust badges,  | bad-practice | low/low | buildNavRoots keys nav roots by the admin-overridable name, risking duplicate React keys / featured mismatch | `src/components/site-header.tsx:290` |
| CMS — banners, nav, footer, trust badges,  | inconsistency | low/high | Banner form collects eyebrow/subtitle/ctaLabel/description/secondaryCTA that header_strip (and others) never render | `src/components/admin/banner-form.tsx:356` |
| CMS — banners, nav, footer, trust badges,  | oversight | low/high | createBannerSchema still accepts the dead `checkout` placement → crafted create yields an orphan banner | `src/workflows/cms/banner.ts:35` |
| CMS — banners, nav, footer, trust badges,  | oversight | low/low | A nav_* featured banner set inactive can never be re-activated from the Nav Menu editor | `src/workflows/cms/banner.ts:253` |
| cms-home-pages | inconsistency | low/high | Home vs page brand-grid fallback diverged (lone initial vs wordmark) | `src/components/storefront/home/home-blocks-render.tsx:360` |
| cms-home-pages | inconsistency | low/medium | togglePagePublish / createPage don't revalidate the storefront layout like the sibling page actions | `src/lib/actions/cms.ts:309` |
| cms-home-pages | perf | low/high | /[slug] CMS branch reads the same page row up to three times per request | `src/app/(shop)/[slug]/page.tsx:346` |
| customers-business-segments | bad-practice | low/high | life_event_anniversary default leaf hardcodes stage "mariage" instead of the shared constant | `src/lib/promotions/segment-leaf-defaults.ts:42` |
| customers-business-segments | inconsistency | low/medium | entry_tier leaf JS↔SQL parity diverges on loyalty levels sharing a display_order | `src/lib/promotions/rule-leaves.ts:104` |
| customers-business-segments | oversight | low/medium | delete-customer scrubs a staff/admin account's customer-side data without the privilege guards | `src/workflows/customer/delete-customer.ts:90` |
| customers-business-segments | oversight | low/medium | Customer admin search caps email pre-resolution at 5000 ids, silently excluding further matches | `src/lib/customers/filter.ts:75` |
| customers-business-segments | perf | low/high | Per-segment CSV export (manual) and /pro dashboard do unbounded / N+1 reads | `src/app/api/admin/segments/[id]/export/route.ts:50` |
| delivery-tax-currency | inconsistency | low/high | Deleting a delivery agent leaves orphaned delivery_agent_zone_rates rows | `src/modules/delivery/service.ts:76` |
| delivery-tax-currency | oversight | low/medium | Line added to a TVA order gets zero TVA when store TVA is live-disabled | `src/lib/order/build-line-snapshot.ts:159` |
| inventory-stock | inconsistency | low/low | Transfer variant-grain decision diverges between the picker action and create validation | `src/lib/actions/stock-transfers.ts:101` |
| inventory-stock | oversight | low/medium | reconcileDefaultLevels can leave Σ(levels) greater than the total | `src/modules/stock-location/service.ts:148` |
| inventory-stock | oversight | low/high | Transfer slip « SKU / Réf. » column renders the product slug, not the SKU | `src/app/admin/catalog/stock/transfers/[id]/print/page.tsx:117` |
| inventory-stock | perf | low/medium | Transfer completion busts PDP cache + fires product.updated though the sellable total is invariant | `src/lib/actions/stock-transfers.ts:216` |
| jobs-cron-webhooks-import-erp | inconsistency | low/high | Two different exported `DataJobView` types with the same name and divergent shapes | `src/modules/import/service.ts:18` |
| jobs-cron-webhooks-import-erp | inconsistency | low/low | Outbound-webhook kill-switch fails OPEN on a settings read error, unlike the API master switch which fails closed | `src/modules/api-settings/service.ts:79` |
| loyalty-credit-giftcard | inconsistency | low/high | Stale selectMemberBenefit doc describes a consumer free-shipping perk that cannot exist | `src/lib/loyalty/member-discount.ts:84` |
| loyalty-credit-giftcard | inconsistency | low/medium | Overlapping caps on add_relative referral earning (max_earning vs max_grants) | `src/lib/credit/config.ts:121` |
| loyalty-credit-giftcard | oversight | low/medium | Outstanding gift-card liability is surfaced nowhere | `src/modules/credit/service.ts:168` |
| mailing-newsletter-blog-aid | inconsistency | low/medium | blog/aid admin search does not escape LIKE metacharacters (newsletter does) | `src/modules/blog/service.ts:218` |
| mailing-newsletter-blog-aid | inconsistency | low/low | canSendMarketingTo uses limit(1) with no ordering vs batched any-opt-out gate | `src/lib/email/consent.ts:112` |
| media | inconsistency | low/high | media/page.tsx hand-rolls URL resolution, diverging from the canonical resolvers used by /api/admin/media | `src/app/admin/media/page.tsx:81` |
| media | inconsistency | low/high | « Charger plus » re-fetch assumes a 200-row API cap but /api/admin/media caps limit at 100 | `src/app/admin/media/media-panel.tsx:277` |
| media | perf | low/medium | Médiathèque search scans alt_text unindexed (only filename has the trigram GIN index) | `src/modules/media/service.ts:71` |
| orders | bad-practice | low/high | Newsletter/user analytics queries live in the order module | `src/modules/order/queries.ts:527` |
| orders | inconsistency | low/high | Redundant actorUserId in several order.* event payloads (dead field / copy-paste drift) | `src/workflows/order/set-spam.ts:40` |
| Platform: db, cache, config/settings, secu | bad-practice | low/medium | script-client.ts hardcodes a dev DB fallback URL on port 5434 that can hit the wrong Postgres | `src/lib/db/script-client.ts:16` |
| Platform: db, cache, config/settings, secu | oversight | low/low | Per-IP rate-limit buckets collapse to one bucket behind a second proxy (XFF depth assumption) | `src/lib/client-ip.ts:13` |
| promotions | bad-practice | low/medium | Coupon codes generated with Math.random() on the client (crypto used elsewhere) | `src/app/admin/promotions/promotion-form.tsx:107` |
| promotions | inconsistency | low/medium | Admin 'Utilisations' count disagrees with uses_count after a refund | `src/modules/promotion/service.ts:503` |
| promotions | inconsistency | low/low | Whole-cart coupon and member discount reduce is_discountable=false lines (scoped coupons don't) | `src/workflows/order/place-order.ts:617` |
| promotions | inconsistency | low/low | Cart-scope exclude_discounted_items coupon accepts a fully-on-sale cart with 0 discount instead of dropping | `src/lib/promotions/coupon-eligibility.ts:204` |
| promotions | oversight | low/medium | Scheduled announce before starts_at is silently deferred, never fired at the chosen time | `src/workflows/promotion/manage.ts:346` |
| promotions | oversight | low/medium | Announce stamps announced_at before the blast runs → a failed blast permanently suppresses it | `src/lib/mailing/promotion-announce/run.ts:52` |
| search-seo-feeds-docs | inconsistency | low/medium | Alias update audit event omits the changed expansion value | `src/workflows/search/aliases.ts:87` |
| search-seo-feeds-docs | inconsistency | low/medium | Sitemap ignores the seo.robots_index master kill-switch | `src/app/sitemap.ts:55` |
| search-seo-feeds-docs | inconsistency | low/medium | Feed categoryPath is a single category name, not a breadcrumb path | `src/lib/seo/feeds/products.ts:66` |
| search-seo-feeds-docs | inconsistency | low/medium | GA4 search event + results count include early-access-embargoed products | `src/app/(shop)/recherche/page.tsx:261` |
| search-seo-feeds-docs | oversight | low/medium | Sitemap lists hardcoded Maison/legal routes with no publish check | `src/app/sitemap.ts:189` |
| storefront-shell-tracking | bad-practice | low/medium | ConsentProvider mutates module-level globals during render | `src/components/consent/consent-provider.tsx:102` |
| storefront-shell-tracking | inconsistency | low/high | forceFavoritesPrivateAction comment claims it clears the handle; service keeps it | `src/lib/actions/wishlist.ts:165` |
| storefront-shell-tracking | inconsistency | low/medium | Advanced Consent Mode: client POSTs /api/track pre-consent, server always drops it | `src/lib/tracking/funnel.ts:165` |
| storefront-shell-tracking | oversight | low/medium | Analytics/Cookies admin panels lose typed input on a validation error | `src/app/admin/system/analytics/analytics-settings-panel.tsx:82` |

---

# Phase execution results (2026-10-02)

The findings above were organized into phases, **re-verified against live code at the fix site**, then fixed. Re-verification materially changed several verdicts (noted below) — a number of "confirmed" findings turned out to be intentional design, accepted tradeoffs, or product/feature decisions that should **not** be silently changed. Each applied fix was verified with `pnpm typecheck` + the relevant DB/pure tests. **Final regression gate: full DB suite 274 passed / 5 failed — the 5 are exactly the pre-existing seed-dependent files (unchanged); zero new failures from any fix, and `wiring-matrix` went from red → green.** `pnpm typecheck` clean. Change set: **24 source files + 7 test files** (+256 / −90). No production code paths were changed beyond the fixes below.

> Verification harness note: tests were run against a disposable migrated Postgres (not the dev DB). `tsx` is not on PATH — use `pnpm exec tsx`. Baseline before fixes: 6 DB-suite files failed at HEAD — 5 are **seed/environment** dependent (need the boot/demo seed: `admin-caps`, `home-blocks-media-coverage`, `identity-low`, `loyalty-tier-stats`, `segment-rule-tree-sql`) and 1 was a **real** source-level failure (`wiring-matrix`, now fixed below). A stale `gift-card-lifecycle` test was also failing at HEAD (fixed).

## Fixed (verified)

### Phase 1 — data-loss & money
- **media#1 (HIGH, data-loss)** — `bodyRefMatch()` + `countMediaReferences` now scan `brands.description` / `collections.description` (rich-HTML bodies rendered on the storefront that can embed inline `/cdn` media), closing the orphan-tracking gap that let the reclaim sweep / "0 references" delete hard-delete an in-use image. `src/modules/media/queries.ts`.
- **giftcard#4 (data-loss)** — `giftCardService.voidCard` guard tightened from `status <> 'redeemed'` to `status = 'active'`, so re-voiding an already-void card is a no-op instead of nulling its `void_reason` / `replaced_by_gift_card_id` reissue link; clearer already-void message. `src/modules/gift-card/service.ts`, `src/lib/gift-card/reissue.ts`.

### Phase 2 — security & privacy
- **storefront#1 (security)** — `/parrainage/<token>` referral-invite added to `TAG_FREE_PATHS` + `BEARER_PATH_RULES`, so the invite token no longer leaks to GA4/GTM/Meta (matches `/pro/join/<token>`). `src/lib/tracking/redact-url.ts`.
- **platform#1 (security)** — the Sécurité scorecard now reports `payment-enc` honestly: a key auto-generated into `app_secrets` (same DB as the ciphertext) is a **warn** with an actionable note, only an env-supplied key is a clean **pass**. New `PostureFacts.paymentKeyFromDb` fact + `getSecuritySignals().paymentKeyInDb` provenance read. `src/lib/security/posture.ts`, `src/lib/security/signals.ts`, `src/app/admin/system/security/page.tsx`.

### Phase 3 — correctness
- **cart#1** — quick-remove-by-slug now matches `!variant_id` (simple lines store `variant_id = ""`, never NULL), so the "+ → ✕" toggle actually removes the item. `src/lib/actions/cart.ts`.
- **promotions#1** — an unparseable inline audience-rule blob now **fails closed** (returns an empty group the workflow rejects) instead of coercing to `null` and silently publishing a coupon that was meant to be audience-restricted. `src/lib/actions/promotion.ts`.
- **cms-home-pages#1** — `savePageBlocksWorkflow` refuses to blank a **published** page (zero visible blocks + no system default), so a composer clear can't leave a live 200 "bientôt disponible" placeholder indexed + in the sitemap (mirrors the publish-time guard). `src/workflows/cms/page.ts`.
- **mailing#2 / mailing#3** — the wishlist-campaign email passes `wishlist_items` via `htmlVariables` (was double-escaped into literal `<ul>…` text) and links products at `/<slug>` (was a 404 `/produit/<slug>`). `src/lib/mailing/wishlist-campaign/run.ts`.
- **cms-home-pages#2** — the home `cta_band`/`banner` renders a plain `<div>` when there's no CTA instead of wrapping the whole band in a dead `<Link href="#">`. `src/components/storefront/home/home-blocks-render.tsx`. (The page renderer was already correct.)
- **orders#2** — the late-capture log on a cancelled credit-settled order prints `amountDueCents` (total − credit applied), matching the real verification, not the full total. `src/workflows/order/gateway-payment.ts`.
- **ai-generation#2** — the OpenAI-compatible client sends `max_completion_tokens` and omits `temperature` for o-series reasoning models (o1/o3/o4-mini), so a suggested `o4-mini` no longer 400s. `src/lib/ai/client.ts`.
- **media#3** — `buildStorageKey` defangs a user `-nobg` token before a dot to `-no-bg`, so a file named `watch-nobg.jpg` is no longer wrongly treated as a détourage output by the `%-nobg.%` eligibility filter (mirrors the existing `.original` guard). `src/modules/media/storage.ts`.

### Phase 4 — ops / consistency / guards
- **orders#1** — `createOrderFromLinesWorkflow` stamps `confirmed_at` after placement (mirrors `createManualOrderAction`), so an API/ERP-pushed COD order with no `externalRef` isn't auto-cancelled by the 48 h abandoned sweep. `src/workflows/order/create-from-lines.ts`.
- **inventory#1** — `deleteLocationAction` now refuses a location with non-terminal transfers (mirrors the deactivation guard), so a 0-stock transfer-linked location can't be deleted and strand its transfers. `src/lib/actions/stock-locations.ts`.
- **ai-generation#4** — `startAutoAssignDryRunAction` + `startReviewGenerationAction` gained the shared `ai:bulk:<userId>` per-actor rate limit (10/h, degrade-open) the other two bulk AI flows already had. `src/lib/actions/ai-assign.ts`, `src/lib/actions/review-generation.ts`.
- **cms-chrome#3** — nav/footer dead-link pruning now checks `page`-kind targets against published, non-deleted CMS page slugs (new `pageService.listPublishedSlugs`, noindex-agnostic), so a link to an unpublished/deleted page is dropped; `system` stays exempt. `src/lib/cms/nav-link-liveness.ts`, `src/lib/api/cms.ts`, `src/modules/cms/page/service.ts`.

### Phase 6 — dead code / invariants
- **wiring-matrix (real baseline failure)** — the 6 orphaned legacy `home.hero.*` / `home.rail.*` reads (read-with-default by the home fallback; their admin writer moved to the composer) are documented in `UNWIRED_SETTING_KEYS`, greening the invariant. `src/lib/db/tests/wiring-matrix.test.ts`.
- Removed genuinely-dead, isolated internal methods: `navigationService.findMenuById`, `promotionService.countLivePromotionsForScopeTarget` (the delete guard uses the complete `countLivePromotionsForScope` in `queries.ts`, which already covers `scope_targets`). Redirected its test to the real counter.

## Re-verified as NOT a bug — flagged for a decision (NOT changed)

These were reported by the audit but, on close re-read, are intentional design, accepted tradeoffs, or product/feature decisions. Changing them would alter customer-facing or policy behavior and belongs to the owner:

- **loyalty#8 (money)** — the first-purchase discount re-earn across unsettled COD orders is a **documented accepted v1 tradeoff** (member-discount.ts:46–54; a self-limiting under-charge). The airtight fix (a `first_purchase_discount_used_at` stamp) is a product choice.
- **jobs#1 (security)** — `newsletter.*` carrying an email to a `["*"]` webhook is consistent with `order.*`/`customer.*` (standard commerce webhooks); `SECURITY_DOMAINS` is a *tested* list that excludes only auth/security telemetry. Adding newsletter would strip it from existing integrations.
- **customers#1 (inconsistency)** — the segment engine is account-scoped (JOIN users) while the Clients filter counts account-less profiles. Aligning them (LEFT JOIN) changes **every dynamic segment's audience** for promos + mailing — a segment-scope decision.
- **catalog-reviews#1** — per the documented design, `rating_source="customers"` keeps AI/manual reviews *displayed* but out of the *aggregate*; the count/list visual mismatch is a labeling choice, not a defect.
- **catalog-reviews#2** — the `rating_source` default of `"all"` (AI/manual reviews in JSON-LD) is an intentional, documented default with a one-flip remediation; defaulting to `"customers"` (or decoupling structured data to always customer-only for FTC/Google compliance) is a policy decision. **Recommended** but not changed.
- **inventory#2 (ERP push/pull stock toggles)** — enforcement is explicitly "Phase 2" (unbuilt): the toggles are persisted + displayed but don't gate the outbound webhook or `/api/stock` authority. Either complete Phase 2 enforcement or hide the toggles.
- **cart-checkout-payment#2** — already documented as intentional unwired copy (`UNWIRED_SETTING_KEYS`: gateway/COD labels). Non-issue.

## Cleanup backlog (owner review recommended)

**Dead features — wire vs remove (product decision):** footer/newsletter banner image is collected but never rendered (cms-chrome#1); nav-item nesting renders on the storefront but has no admin create path (cms-chrome#2); `email_suppressions` is read by the consent gate but never populated — wire a provider bounce/complaint webhook or an admin suppression-add, else the gate is inert (mailing#1).

**Dead methods whose docs claim a clean/import-flow use that has no caller — verify the flow isn't missing them before removing** (removing could mask a real gap): `collectionService.deleteAll` + `navigationService.listAllMenuIds` ("segmented clean flow"), `categoryService.listBySlugs` ("bulk import"). Confirm whether the data-clean / import flows should call these.

**Dead DB columns / enums / indexes — one reviewed, irreversible cleanup migration (0177) when ready** (each still needs a final "never read" confirmation; `promotions.business_id` is still READ in several paths so its reads must be removed first): `payment_provider_settings` legacy Konnect ciphertext cols, `review_generation_drafts.apply_error`, `products.platform` (still rendered — remove render first), `search_log.ip`/`user_id`, `document_sequences_kind_idx` (redundant), `ai_call_logs` (write-only, no reader), `email_campaigns.template_key`, `currencies.decimals`, `media.kind` (always `'image'`), `media.uploaded_by` (write-only), trust-badge `preorder` visibility (hardcoded off). Not executed here — dropping columns on a prod-mirroring DB is a deliberate, irreversible decision.

**Low-value / intentional (leave):** over-exported-but-used constants (`ALT_TEXT_MAX`, `MEDIA_TS_RE`, `tryBustStorefrontCache` — their exports feed tests); intentionally-retained APIs (`upsertProductVariantsAction` decoupled write-API, `verifyWebhookSignature`, `__GZ_FUNNEL__` extension point, `GIFT_CARD_ORIGINS`'s reserved `physical`); reserved cache tags with no reader (documented); `productsMatchingScope` (superseded by `productsMatchingPromoScope`, still re-exported).

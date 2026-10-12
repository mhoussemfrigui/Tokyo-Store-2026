# Tokyo Store — Architecture map

**Purpose.** A whole-project map for targeted work: where each concern lives, how a request or a mutation
flows, which admin page touches which tables and storefront surfaces (§5 **Admin section index**), and what
must change together when you modify something (§6 **Change-impact cheat sheet**).
**Snapshot:** 2026-09-23, `HEAD = 866522c` (after the A–Z audit fix program `77b7163 … 866522c`; run
`git log --oneline 6a539e6..866522c` for the per-wave summaries). The order-edit money-integrity and
storefront listing-engine work in progress after that commit is **not** reflected here.
**Note (2026-09-25):** a further A–Z audit-fix pass landed after this snapshot (branch
`fix/az-audit-2026-09-25` (merged to main) + a round-2 pass, migrations 0132–0136, and changed some behaviour described below — notably
category-scoped promotions now CASCADE to subcategories, `/boutique` honours its `noindex` toggle in the
sitemap + JSON-LD, the avoir amount is snapshotted at issuance, and the counts in this file were re-synced.
Specific counts/lines are updated inline; deeper prose may still describe the pre-audit behaviour.
**Canonical spec:** [`docs/modules.md`](modules.md) remains the source of truth for module rules and
conventions. This file describes the code as it is, including where it deviates from the rules. When the two
disagree, fix the code or the spec, then update this map.
Line numbers are avoided on purpose. Grep for the named symbol.

---------------------------------------------------------------------------------------------------------------------------

## 1. System overview & tech stack

Single-store Tunisian luxury-watch e-commerce (French-only UI). One Next.js app serves the storefront, the back-office,
a key-gated ERP/headless HTTP API, cron endpoints and machine surfaces (feeds, sitemap, llms.txt, Markdown twins).
The backend is a re-skinned "Game Zone" codebase (load-bearing `gz_` / `gz.*` identifiers kept on purpose).

| Layer | Technology / version (package.json) | Notes |
|---|---|---|
| Framework | Next.js `^16` App Router (installed 16.2.6), React `^19.2`, RSC + Server Actions | `next build --webpack` (prod), `next dev --turbopack`; `output: standalone`; `experimental.useCache` ON (default in-memory, process-local handler; `cacheComponents` OFF); `serverActions.bodySizeLimit` = `SERVER_ACTION_BODY_LIMIT` = 16 MB (`lib/config/next-runtime.ts`) |
| Edge | `src/proxy.ts` (Next 16 "proxy" = middleware) | cookie-presence gate for `/admin` + `/account`, secret `ADMIN_LOGIN_PATH` rewrite, `.md` / `Accept: text/markdown` → `/md/*` rewrite, stamps `x-tokyo-pathname` (`SITE_PATH_HEADER`, used by the site-mode gate) |
| DB | Postgres 16.14 + pgvector 0.8.0 (`docker/pgvector/Dockerfile`), Drizzle ORM `^0.45`, `pg` Pool | prod pool max 12 (`DB_POOL_MAX`; dev 5), `statement_timeout` + client `query_timeout` 10 s, startup `options` lock_timeout 3 s / idle-in-tx 30 s (+ role defaults, migration 0117); `withLongStatement` (`lib/db/client.ts`) is the only sanctioned way to exceed the budget (an available affordance — currently no production caller); optional PgBouncer 1.23 (transaction mode, `IGNORE_STARTUP_PARAMETERS` includes `options`); migrator prefers `MIGRATION_DATABASE_URL` (direct connection) |
| Auth | Better Auth `^1.4.5` (installed 1.6.11) | email+password, TOTP 2FA, Google/Facebook OAuth, change-email, verification. Credential endpoints are called in-process from server actions (throttles, audit, signup invariants); their raw HTTP paths are disabled (`AUTH_HTTP_DISABLED_PATHS`, `lib/auth/policy.ts`) |
| Validation | Zod `^4` with French messages (`workflows/shared.ts` zod locale) | at the workflow boundary (and some actions) |
| Media | S3 / SeaweedFS (`@aws-sdk/client-s3`), sharp `^0.34` | JPEG primary + WebP + AVIF (+ optional original); `/cdn/[...path]` same-origin relay |
| Styling | Tailwind `^4`, `components/ui` shared kit | storefront `.storefront{}` + admin `.admin{}` token scopes injected by the ROOT layout |
| AI | OpenRouter / DeepSeek / OpenAI / Anthropic (fetch clients in `lib/ai`) | one-click generation, bulk content/product/review generation, auto-assign, embeddings (1536-d) |
| Email | providers `resend \| smtp (nodemailer) \| internal \| console` | chokepoint `dispatchEmail`; provider send timeout (`lib/email/providers/send-timeout.ts`) |
| Payments | ClicToPay (SMT) + Flouci v2 + COD/cash/bank transfer | creds AES-GCM encrypted (`PAYMENT_ENCRYPTION_KEY`) |
| Deploy | Docker (node:22-alpine), Coolify (`docker-compose.coolify.yml`: app + postgres(pgvector, `pg_stat_statements` preloaded) + seaweedfs + optional `pooler` pgbouncer profile) | entrypoint: `db-runner/migrate.cjs` (image-only esbuild of `src/lib/db/migrate.ts`; advisory lock) → `db-runner/init-secrets.cjs` (of `src/lib/db/init-secrets.ts`; env → `app_secrets` → generate) → `node server.js` → `instrumentation.ts` |
| Tests | bespoke `check()` harness under `src/lib/db/tests`, run by `tsx --conditions=react-server` | 219 files: `test:pure` (104, sub-scripts `:1`–`:2`) + `test:db` (115, sub-scripts `:1`–`:3`), see §7.3 |

Codebase shape (`src/`):

| Folder | Role | Size / entry |
|---|---|---|
| `app/admin/**` | back-office: 95 `page.tsx`, 63 nav items in 8 groups | `layout.tsx` gate + `_components/admin-shell.tsx`; `admin/not-found.tsx` (404 inside the shell), `admin/error.tsx` |
| `app/(shop)/**` | storefront (dynamic) | `layout.tsx` = maintenance gate + chrome; `[slug]` resolver: redirect rule → showcase → category → product → brand → CMS page; `[slug]/[sub]` and `[slug]/[sub]/[...rest]` catch-alls |
| `app/(documents)/facture/[id]` | printable receipt (root layout only, owner-gated, no shop gate) | |
| `app/api/**` | 52 route files: external API (55 method-level entries in `lib/api-auth/route-catalog.ts` `ext()`), `/api/admin/*` (session + RBAC), `/api/cron/*` (8, incl. `detourage`), `/api/webhooks/{clictopay,flouci}`, `/api/auth/[...all]`, `/api/store/search`, `/api/track`, `/api/unsubscribe/one-click`, `/api/health` | |
| `app/{cdn,feeds,md,llms.txt,robots.txt,sitemap.ts,promo,manifest.ts}` | machine / infra surfaces | `/promo/[slug]` is a route handler (sets the promo cookie); `manifest.ts` is `force-dynamic` |
| `lib/actions/*.ts` | 70 `"use server"` files (+ `types.ts`, `coerce.ts`), 324 exported async functions. Every export is a public RPC endpoint | return `ActionState` (`lib/actions/types.ts`) |
| `workflows/**` | orchestration: zod → `db.transaction` → post-commit `bus.emit`; registry `workflows/index.ts` (namespaces `auth rbac customer catalog media cms cart order blog demo newsletter audit search promotion payment ai showcase tax delivery`). Some workflows are imported directly instead of through the registry (`delivery/zone.ts`, `search/aliases.ts`, brand/category tax-rate workflows, `order/gateway-payment.ts settleZeroTotalOrderWorkflow`, `customer/set-promo-opt-out.ts`, `customer/unsubscribe.ts`, `newsletter/unsubscribe.ts`, `auth/upsert-oauth-settings.ts`). Also `data/`, `import/`, `helpers.ts`, `shared.ts` | |
| `modules/<domain>/{schema,service,queries}.ts` | 39 top-level domain folders (`catalog/` has 8 sub-domains + `_shared/`, `cms/` has 6) | CRUD + reads |
| `associations/*` | 7 cross-module join tables (bare uuid columns in Drizzle; the 6 `product_*` ones still carry CASCADE FKs in SQL, `customer_user_links` has none) + `catalog.service.ts` (set = replace) + `customer-user.service.ts` | |
| `events/{bus,types,severity}.ts`, `events/subscribers/*` (37 files) | in-process pub/sub, 226 events / 52 domains | |
| `lib/**` | cross-cutting (rbac, auth, cache, checkout, promotions, inventory, order, mailing, seo, redirects, search facades, payments, api-auth, jobs, retention, telemetry, security, site-mode, settings, tracking, consent…) | |
| `components/{ui,admin,storefront,…}` | admin and storefront share ONLY `components/ui` (dialog, select-field, star-rating) | |

Canonical rules (`docs/modules.md`): (1) one folder per domain; (2) no cross-module FKs; (3) services do CRUD, workflows
orchestrate, pages/actions call workflows for mutations; (4) events decouple side effects; (5) zod at the boundary.
**Known deviations** (by design or debt; do not "fix" silently):
- Rule 2: the live schema has cross-module FKs: `orders→delivery_agents/pickup_locations` (SET NULL), `promotion_redemptions→orders`
  (CASCADE) `/users` (SET NULL), `showcase_pins/wishlist_items→products`,
  `stock_levels→products/product_variants`,
  `tax_rules→product_attribute_values`, `product_media.media_id→media` (CASCADE, the only hard media FK). 84 FKs in total. 81 exist
  only in SQL migrations, and 3 are declared in Drizzle (`accounts`/`sessions`/`two_factors → users`).
- Rule 3: these actions call services directly (no workflow): currency CRUD, segments, redirects, mailing (templates/flows/logs/campaigns/global toggles), API keys + access toggles,
  webhook endpoints, stock-location CRUD, `setVariantStockDefaultAction` (raw `app_secrets`), `toggleOrderLinePickedAction`,
  wishlist ops, data-job/import runners. Most of them emit their own events (`currency.*`, `segment.*`,
  `redirect.*`, `mailing.*`, `api_key.*`, `api.access_settings_updated`, `webhook_endpoint.*`, `stock_location.*`,
  `setting.upserted`). Exceptions with **no event** are listed in §4.3.

---------------------------------------------------------------------------------------------------------------------------

## 2. Layering & request lifecycle

### 2.1 Read path (RSC)
| Hop | Concrete helper(s) |
|---|---|
| Edge | `src/proxy.ts`: admin without a session cookie is redirected to `/admin-login` (or gets a 404 when a secret login path is configured); `/account` cookie gate → `/login`; md rewrite; `x-tokyo-pathname`. `/api/auth/*` excluded from the matcher. |
| Root layout | `src/app/layout.tsx`: `getThemeConfig()` + `getAdminThemeConfig()` → `<style>.storefront{…}</style>` + `.admin{…}` (hex/font allow-listed), metadata via `getSeoConfig()` (metadataBase = `seo.site_url`, robots kill-switch), favicon (`theme.favicon_media_id` → `/tokyo-logo.png`). |
| Shop layout | `src/app/(shop)/layout.tsx` (dynamic, reads headers/cookies). `getSiteModeConfig()` fails OPEN. `viewerCanBypassSiteGate()` fails CLOSED (session + any admin grant). Gate-exempt paths (`lib/site-mode/gate-exempt.ts`: `/login(/2fa)`, `/forgot-password`, `/reset-password`, `/verify-email`, `/se-desabonner`) render in a bare shell with `SiteGateNavGuard`. Everyone else gets `<MaintenanceScene>`. Otherwise the layout runs the parallel chrome reads (categories/brands `'use cache'`, menus, `getSettingsMap`, banners, cart, checkout copy, theme, trust badges, currency, user, nav featured banners, `nav.*` labels) → `SiteHeader`/`SiteFooter` + consent/wishlist/money providers, tracking scripts, `PageLocationSync`. |
| Admin layout | `src/app/admin/layout.tsx`: `getSession()` → `resolveAdminShellAccess(userId)` (`lib/rbac/authorize.ts`) → 404 when the user has no grants → logo (`admin.theme.logo_media_id` → `site.logo_media_id` → `/tokyo-logo.png`) → `<AdminShell grantedKeys>` (sidebar visibility = `<id>:view` or the item's `visibleWhen`, `lib/rbac/nav-access.ts`). **Not re-run for Server Action POSTs.** |
| Page guard | `lib/auth/session.ts`: `requirePermission(module, action)` / `requirePermissionAny([...])` / `requireAdminArea()` (any grant; allowed only on the dashboard and the Système index) / `requireSession()` (redirect `/login`). On deny it calls `emitPermissionDenied` (`rbac.permission_denied`, only if the actor holds ≥1 grant) and then `notFound()`. The 404 renders `admin/not-found.tsx` INSIDE the shell (the layout's own 404 for non-staff still goes to the root boundary). Super-admin gates: `lib/auth/super-admin.ts` `requireSuperAdmin` / `checkSuperAdmin` / `isSuperAdmin` (`*` grant). |
| Authorization engine | `resolveUserPermissions(userId)` (React `cache()`, one DB hit/request): disabled ⇒ ∅; else the per-user OVERLAY (`user_permissions`, migr 0191) applied over the union of `role_permissions` via `user_roles` — `applyPermissionOverlay` = `union ∪ allow − deny`. Access is ROLE-ONLY: `*` comes solely from a role grant (the legacy `users.role` enum + its `admin→'*'` bridge were dropped, migr 0192/0193); the coarse account TYPE is DERIVED (`resolveAccountType`). `permissionSetAllows(perms, module, action)` honours `*` and `<module>:*`. Pages compute `can*` flags with it and render write controls read-only without the grant. |
| Reads | `modules/<d>/queries.ts` or storefront facades `lib/api/*.ts` (`products.ts` `mapProductRows` / `toApiProduct`, `categories.ts`, `cms.ts`, `content.ts`…). Per-viewer layers applied per request: live promo enrichment (`buildLivePromotionDiscountMap`), published/active filters. |
| Settings | `getSettingsMap()` (`modules/cms/setting/queries.ts`, one `SELECT *`, React `cache()` per request) → typed resolvers (`getCheckoutCopy`, `getSeoConfig`, `resolveSearchConfig`, `parseTrackingConfig`, `getTaxConfig`, `resolveLowStockConfig`, …). Storefront readers fall back to defaults on a read error. **Admin pages that feed a settings save read strictly**: a failed read lands on `admin/error.tsx` instead of rendering defaults that a save would persist. They pass only their own prefixes to the client with `pickSettings` (`lib/settings/pick-settings.ts`). Enforced by `settings-fail-closed.test.ts`. |
| Cache | 6 `'use cache'` readers (`cacheLife("hours")`): `getProductWithRowBySlug` (PDP DTO, `lib/api/products.ts`; tags `products:list, products, brands, categories, product:<id>, product:slug:<slug>`), `listCategoriesCached`/`getCategoryBySlug` (`lib/api/categories.ts`; `categories`, `products:list`), `listActiveBrandsCached`/`getBrandBySlug` (`brands`), `listPublishedPosts` (`blog:posts`, `blog:categories`). Other tagged caches: the `/api/track` consent gate (`unstable_cache`, `site:settings`) and the search alias loader (`ttlCached`, `search:aliases`). Audit overview/top stats use a 5-min `unstable_cache`. Grids, CMS, search, cart and checkout are uncached/dynamic (grids apply per-viewer embargo). In-process TTL caches: query embeddings + aliases (`ttlCached`), payment config 30 s, AI config 30 s, social/OAuth config 30 s, mail config 30 s, email flows 30 s, media settings/CDN base 30 s, api-settings 15 s, audit/perf runtime config 15 s, shared-stock default 15 s, webhook endpoints 5 s. **All per-process** (multi-replica lag). |

### 2.2 Mutation path (admin/storefront Server Action), the canonical chain
```
client form (useActionState | useTransition | useRefreshAction [src/hooks]) — entity editors wrap submit in useNoResetSubmit
  → "use server" *Action (lib/actions/<file>.ts)
      1. requirePermission(module, create|update|delete|manage)   // throws notFound() on deny — NOT an ActionState
         (route-invariants: it must be the FIRST awaited call of every export)
      2. parse FormData (manual; lib/actions/coerce.ts only used by catalog.ts + lib/catalog/editor-stock-fields.ts); money: dinarsToMinor (TND → millimes),
         shared admin money parser lib/checkout/money-input.ts; % → bps (bpsFromPercent / taxBpsField);
         blank numeric settings = default (lib/settings/form-number.ts)
      3. workflows.<ns>.<op>(input, { actorUserId: session.user.id })
  → workflow(name, fn) wrapper (workflows/shared.ts)
      zod safeParse → fail("validation", …, flattenZodError)       // top-level keys only, feeds fieldErrors
      db.transaction(async tx => service calls with tx; FOR UPDATE locks; ledgers)
         — never call the pool (`db`) inside the tx callback (second connection while holding locks; tx-pool-reentrancy test)
      unique-violation / contention / foreseeable-input errors → WorkflowFail (UNIQUE_VIOLATION_MESSAGES map)
      post-commit: await bus.emit(event, payload, { actorUserId, actorIp })   // never inside a tx
  → modules/<d>/service.ts (DbOrTx param) → Drizzle → pg Pool → Postgres
  → bus.emit (events/bus.ts) awaits Promise.allSettled(named handlers ∪ "*" handlers)   // failures swallowed, LATENCY propagates
      "*": structured-logger, metrics-counter, audit-everything (long tail), dispatch-webhooks (outbound queue)
      curated: audit-trail (HINTS, rich summaries)
      domain: invalidate-{catalog,attribute,cms,media,blog,promotion}-cache → bustCacheTag(tag) / revalidatePath
              send-* / notify-* → dispatchEmail;  issue-bl-on-ship;  reembed-product;
              sync-marketing-optin / sync-newsletter-to-profile / sync-user-name-from-profile;  cleanup-media-storage
  → back in the action: revalidatePath(adminPath) [+ revalidatePath("/", "layout") for storefront-visible settings]
  → WorkflowResult → ActionState {ok,message,id} | {ok:false,error,message,fieldErrors}
  → client: useTabErrorFocus/TabbedFormError (tabbed forms), router.refresh()
```
Notes that bite during modifications:
- `revalidatePath("/", "layout")` expires **every** `'use cache'` entry site-wide (implicit tag `_N_T_/layout` on every request).
  Cart actions no longer do this: they call `refresh()` (`lib/actions/cart.ts refreshCartViews`). Settings/CMS/promotion writes still do.
- `bustCacheTag` (`lib/cache/revalidate.ts`) = `clearTtlCache(tag)` then `revalidateTag(tag,{expire:0})` in try/catch. It is a
  no-op outside a request work store (detached `void runX()` job runners). Bulk paths therefore use `lib/cache/bust-storefront.ts`
  (`STOREFRONT_BULK_TAGS`, `tryBustStorefrontCache`), and the job pollers re-bust from their own request when they first see a
  finished job (`bustStorefrontForFinishedJobs` / `lib/cache/bust-finished-jobs.ts`).
- React 19 form actions reset the form after every submit, including on `{ok:false}`. Entity editors keep the operator's input
  through `useNoResetSubmit` (`components/admin/_components/form-tabs.tsx`; `form-no-reset` test). A new editor must use it too.
- Settings panels re-submit all of their keys. `upsertSetting` skips identical rows (no write, no `setting.upserted`), so only real
  changes are audited. `FormTab` panels stay mounted (`hidden`), so hidden tabs still post.

### 2.3 Other entry lifecycles
| Entry | Chain |
|---|---|
| External API | `app/api/<res>/route.ts` → `enforceExternalApi(req, routeId)` (`lib/api-auth/enforce.ts`: catalog lookup → kill-switch `api.enabled` (fail-closed, 503) → public read if the route is toggled public AND no key is presented (IP 60/min per route) → otherwise `requireApiKey(scope)` (`require-api-key.ts`: sha256 lookup, expiry, scope, 120/min/key, **request-time re-check of the creator's current RBAC**)). A key sent to a public route gets the keyed view. Writes use `requireApiActor` (key `created_by`) and run the SAME workflows as admin (actor = key owner) → `workflowResponse` (`workflowErrorStatus` maps fail codes to 4xx/409). Incremental sync uses µs-exact keyset cursors (`lib/api/keyset.ts`). |
| Cron | Coolify task `POST /api/cron/<x>` + `Bearer CRON_SECRET` → `guardCron` (`lib/cron/guard.ts`: per-IP 10/60 s → optional `CRON_ALLOWED_IPS` → 503 if the secret is unset → constant-time compare) → `runScheduledJob(key,"cron")` (`lib/jobs/run-job.ts`: kill-switch `jobs.<key>.enabled`, fail-open, cron trigger only) → `jobRunLogService.runAndLog` → `JOB_WORK[key]` → `job_run_log` (keeps 100 real runs per key; no-op runs don't evict history). Dashboard "run now" = same executor, trigger `manual`, bypasses the kill-switch. |
| Payment webhooks | `/api/webhooks/{clictopay,flouci}` → `handleGatewayWebhook` (`lib/payments/webhook-handler.ts`: `webhooks.enabled` kill-switch 503, IP 300/min, lookup by stored `payment_reference`+provider) → `confirmPaymentWorkflow` (re-verify with the gateway, exact amount vs current `total_cents`, `webhook_events` claim) → `transitionOrderStatusWorkflow(paid)`. Gateway "pending" (open session/3DS) is not treated as unpaid on cancel (`assertPendingOnlineOrderNotCaptured`, `workflows/order/gateway-payment.ts`). |
| Better Auth HTTP | `/api/auth/[...all]` rewrites `X-Forwarded-For` to the trusted last hop and serves only what must be HTTP (session, sign-out, social sign-in/callback, verify-email, reset link, 2FA enable/verify/disable). DB hooks + before/after middleware in `lib/auth/server.ts`: ban gate on session create, OAuth autolink gate, social signup → profile + link + `user.created`, user-update audit (email change/verify), 2FA audit. |
| Boot | `instrumentation.ts`: `ensureDefaultAdmin` → `ensureSystemContentPages` → `registerAllSubscribers()` (globalThis guard) → review-gen scheduler (internal timer; also prunes `ai_job_logs`) → runtime sampler (perf ring buffer, alerts, DB heartbeat). SIGTERM drains the scheduler and the sampler, then `closePool`. |

---------------------------------------------------------------------------------------------------------------------------

## 3. Module inventory

Legend: **S** = service/queries entry points; **W** = workflows (`workflows.<ns>.*` unless a file is named); **A** = admin pages; **C** = storefront / API / other consumers.
All `*_cents` = integer millimes. "soft" = soft link (no FK). 126 Drizzle tables + raw `app_secrets`, `rate_limit_buckets`.

| Module (`src/modules/…`) | Tables | S | W | A (admin) | C (consumers) |
|---|---|---|---|---|---|
| `catalog/product` | `products` (+DB-only `search_vector`, `embedding vector(1536)`, `embedding_input_hash`), `product_variants`, `product_variant_values` | `productService` (insert/update/softDelete/`replaceVariants`/admin + stock listings), `productQueries` (published lists, low-stock, sitemap) | `catalog.createProduct/updateProduct/deleteProduct/duplicateProduct/upsertProductVariants`, product-gen (`workflows/catalog/product-gen/*`) | products (list/new/[id]), stock, dashboard low-stock | PDP `(shop)/[slug]` (`'use cache'` DTO), grids, search, feeds, sitemap, `/md`, `/api/products*`, `/api/stock`, cart/place-order/edit-items/restock/returns, wishlist emails, ERP webhooks `product.*` |
| `catalog/product-gen` | `product_generation_jobs/_drafts` | service | `workflows/catalog/product-gen` | products (Génération IA) | — |
| `catalog/category` | `categories` (self-FK parent SET NULL; `search_vector`; `value_props` jsonb incl. optional per-card `iconMediaId`) | `categoryService` (`softDeleteWithChildPromotion`: children and their products move to the parent; `reorderSiblings`: per-parent `display_order` renumber, FOR UPDATE), queries (`getCategorySubtreeChildren` nested active subtree) | `catalog.createCategory/updateCategory/deleteCategory` (delete refused while live promotions target it), `reorderCategories`, `setCategoryActive` (inline (de)activate, cascades to the subtree), `saveBoutiqueLanding` — all emit/​gate on `categories.*`; the admin panel adds a "Page Boutique" sub-tab (boutique-landing-settings) | categories (list/drill/reorder/toggle + Page Boutique tab) | `/[slug]`, `/[slug]/[sub]`, `/boutique` landing chooser (`storefront.boutique_landing.*` + `buildNavRoots` `boutiqueLandingEnabled`), mega menu, TVA/warranty cascade (`lib/catalog/category-chain.ts`), sitemap, `/api/categories` (round-trips every writable field incl. `valueProps`), value-prop icons resolved via `resolveValuePropIcons` |
| `catalog/brand` | `brands` (flat — no parent; `display_order`, `is_discountable`, `value_props` jsonb incl. optional per-card `iconMediaId`, editorial block, SEO meta/canonical/noindex, logo/hero/og/icon media, `tax_rate_bps`) | `brandService` (`reorderSiblings`: flat `display_order` renumber, FOR UPDATE; `listAll`/`list` ordered by display_order), `brandQueries` (`'use cache'`; `listSitemapBrands`) | `catalog.createBrand/updateBrand/deleteBrand` (delete refused while live promotions target it), `reorderBrands`, `setBrandActive` (inline (de)activate), `saveMarquesLanding` — emit/gate on `brands.*`; the admin panel adds a "Page Marques" sub-tab (marques-landing-settings) | brands (list/reorder/toggle + Génération IA + Auto-affecter + Page Marques tab) | `/[slug]` brand view (CollectionPage+Brand+FAQ JSON-LD, canonical-threaded, OG og→hero→logo), `/marques` landing (`pages.marques.*`), PDP, tax cascade + discount opt-out tier (`is_discountable`), sitemap (empty brands dropped), `/api/brands` (round-trips every writable field), value-prop icons via `resolveValuePropIcons` |
| `catalog/attribute` | `product_attributes`, `product_attribute_values`, `product_attribute_assignments`, `product_attribute_scalars`, `category_attribute_filters` | `attributeService` | `manage-attributes.ts` (attribute/value CRUD, `setCategoryFilters`, bulk assign, value order, attribute categories) | attributes, product form, category form | facets (`lib/catalog/attribute-filter.ts`), PDP specs, JSON-LD `additionalProperty`, variant axes, tax rules, `/api/attributes` |
| `catalog/review` | `product_reviews`, `review_generation_jobs/_drafts`, `review_schedule` | review service/queries (`recomputeProduct`), config | `catalog.review.*` (`workflows/catalog/review.ts`), `review-gen/*` (scheduler) | reviews | PDP reviews + JSON-LD aggregateRating, `/api/reviews`, review-request mails |
| `catalog/content-gen` | `catalog_content_gen_jobs/_drafts` | service | `workflows/catalog/content-gen/*` | categories/brands bulk panels | — |
| `ai`, `ai-assign`, `ai-jobs` | `ai_provider_settings`, `ai_feature_prompts`, `ai_call_logs`; `ai_assign_jobs/_proposals`; `ai_job_logs` | provider/prompt/call-log services | `ai.upsertProviderSettings/upsertFeaturePrompts`, `workflows/catalog/auto-assign/*` | system/ai; categories/brands/attributes (auto-assign control) | every AI button (`generateAiContentAction`), semantic search embeddings |
| `cms/setting` | `site_settings` | `settingService`, `getSettingsMap` | `cms.upsertSetting` | every settings panel | the whole app |
| `cms/banner` | `banners` (placement enum incl. legacy `nav_*`) | `bannerService` (`listLive`) | `cms.createBanner/updateBanner/deleteBanner`; `setNavFeatured` workflow is DORMANT (no admin/seed caller — legacy `nav_*` only), kept only as a tested guard | banners, footer (banner form) | home hero, header strip, in-grid banners, footer/newsletter row, `/api/content` (the header mega-menu now reads `nav_items.config`, not `nav_*` banners) |
| `cms/navigation` | `nav_menus`, `nav_items` (incl. `config` JSONB — the composable mega-menu dropdown per root, migr 0180) | service, `getMenu`; system menu keys in `lib/cms/nav-menus.ts` (`main`, `FOOTER_COLUMNS`) | `cms.createNavMenu/updateNavMenu/createNavItem/updateNavItem/deleteNavItem` (footer/maison-explore); `saveHeaderNavAction` (replace-all the `main` roots + config) | nav-menu (composable builder), footer | header via `getComposedNavRoots` (`lib/api/nav-composer.ts`) → data-driven `components/site-header.tsx`; the 3 roots are materialized by `ensureHeaderNavRoots` boot seed; footer columns |
| `cms/page` | `pages` (unique slug incl. tombstones; `blocks` JSON composer layout — migr 0175), legacy read-only `page_sections` + `hero_/text_/cta_/stats_/timeline_sections` (+ items) for rollover | `pageService`, `getPageForRender`/`getEditBlocks` + `resolvePageBlocks` (`lib/pages/page-blocks-data`) | `cms.createPage/updatePage/savePageBlocks/togglePagePublish/deletePage` | pages (block composer) | `/[slug]` CMS branch, legal/Maison pages (`LegalPageRenderer`), `/help`, sitemap, `/md`, boot bootstrap |
| `cms/trust_badge`, `cms/faq` | `trust_badges`; `faqs`, `faq_categories` | services | `cms.*TrustBadge`; `cms.upsert{Product,Category,Brand}Faqs` | trust-badges; product/category/brand forms | product/cart/checkout reassurance strip via shared `TrustStrip` (`resolveBuyBoxBadges` + `storefront.trust_badges.*` appearance/placement); entity FAQs |
| `showcase` | `showcase_pins` | service | `showcase.setPins` | cms/showcase | `/nouveautes`, `/top-ventes`, `/promotions` |
| `media` | `media`, `media_settings` (singleton) | `mediaService`, `mediaQueries` (`resolveUrlMap`, `listOrphans`, `countMediaReferences`), `cdn-base.ts`, `cdn-allowlist.ts`, `url-resolver.ts`, `processor.ts` (sharp), `image-safety.ts`, `validation.ts` (`MEDIA_UPLOAD_SCOPES`), `storage.ts` | `media.upload/importFromUrl/delete/update/updateSettings`, `workflows/media/reprocess-product-white-bg.ts` | media, media/settings, `MediaPicker` in admin forms | every image, `/cdn`, feeds, emails, order line snapshots (URL strings) |
| `import` | `import_jobs` (op import/clean/reprocess) | `importJobService` (`createIfIdle` single-flight) | `workflows/import/run-product-import.ts`, `workflows/data/*`, `workflows/demo/*` | system/import, system/import-demo, cms/settings (clean), media/settings (reprocess) | bulk catalog writes (no per-entity events) |
| `order` | `orders`, `order_items`, `order_status_history`, `order_refunds`, `shipments`, `shipment_items`, `order_returns`, `order_return_items` | `orderService` (status-in-tx, keyset admin list, stats, `setItemPicked`), queries (`revenueOrderSql`, analytics series, top sellers), `export.ts`, `returns-reasons.ts` | `order.place/placeQuick/createFromLines/transitionStatus/confirm/editItems/createShipment/refund/setPaymentReference/setInvoiceTax/setExternalRef/linkGuestOrder/initiatePayment/confirmPayment/reconcilePendingPayments/sweepAbandonedOrders/createReturn/receiveReturn/rejectReturn` | orders*, caisse, returns, warranty, dashboard, analytics | `/checkout`, `/order/[id]`, `/order/verify/[id]`, `/account/orders/[id]`, `/facture/[id]`, emails, `/api/orders*`, webhooks `order.*` |
| `document` | `document_sequences` | `documentService.nextNumber` (gapless per kind × fiscal year, Africa/Tunis) | via `actions/documents.ts`, create-shipment, `lib/order/issue-delivery-note.ts` | orders/[id] | invoice / avoir / BL pages |
| `appointments` | `appointment_locations`, `appointment_reasons` (`max_products`, 0190), `appointments` (`products` jsonb, 0190) (0189) | `appointmentService` (location/reason CRUD, bookings, `countActiveForSlot`/`slotCountsForDate` + `userHoldsSlot`/`countFutureActiveForLocation` capacity guards, admin list/count), `appointmentQueries` (`getAvailability`, `listPublicLocations`/`Reasons`), `lib/appointments/{availability,config}.ts` | `appointment.book/cancel/updateOwn/setStatus/delete` + `appointment.{location,reason}.{create,update,delete}` (capacity-safe via `pg_advisory_xact_lock`) | rendez-vous (agenda), rendez-vous/moderation, rendez-vous/reglages | `/rendez-vous` wizard, `/account?tab=rendezvous`, booking/confirm emails, webhooks `appointment.*` |
| `payment` | `payment_provider_settings` | config resolver (`lib/payments/config.ts`, env > DB), `settings-plan.ts`, `gateway-rules.ts` | `payment.upsertProviderSettings` | system/payments | gateways, checkout methods |
| `cart`, `cart-event` | `carts`, `cart_items`; `cart_events` | `cartService` (atomic upsert, merge, `lockForCheckout`), `lib/cart/live-lines.ts` (live repricing), cart-event service | `cart.add/setQuantity/remove` | cart (read-only) | header count, `/panier`, `/checkout`, place-order, analytics "most added" |
| `currency` | `currencies` (one-active partial unique) | `currencyService` (direct from actions) | — (actions emit `currency.*`) | system/currency | `MoneyProvider` labels, JSON-LD, feeds, `orders.currency` snapshot |
| `delivery` | `delivery_agents`, `pickup_locations`, `delivery_zones`, `delivery_agent_zone_rates` | `deliveryService` | `delivery.*Agent/*Location`, `workflows/delivery/zone.ts` (`delivery.zone.*`) | system/delivery | `lib/checkout/delivery.ts` `resolveDelivery` (authoritative; `channel: storefront \| operator`), checkout options, manual/ERP orders |
| `tax` | `tax_rules` | `taxQueries` (`taxRuleBpsForProducts`, `brandTaxBpsForProducts`) | `tax.upsertRule/deleteRule`; brand/category bulk rates via `setBrandTaxRatesWorkflow` / `setCategoryTaxRatesWorkflow` | system/tax | `build-line-snapshot`, panier/checkout previews, invoices |
| `promotion` | `promotions`, `promotion_redemptions`, `promotion_targets` (WHO — audience), `promotion_scope_targets` (WHAT — multi-target product set: any mix of products/categories/brands; scope=`targeted`, migr 0169/0170) | `promotionService`, queries (`resolveLivePromotionRowsForProducts`, `getActiveDiscountForProduct`, `productsMatchingPromoScope`, `effectiveScopeTargets`) | `promotion.create/update/delete/toggleActive/duplicate/evaluate` (`workflows/promotion/manage.ts`, `redeem.ts`) | promotions, product form panel | card/PDP/feed prices, `/panier`, `/checkout`, `/promo/[slug]`, place-order, announcement emails |
| `customer` | `customer_profiles`, `addresses`, `customer_segments`, `customer_segment_members` | `customerService`, `customer-user.service` (keyset search), segment service | `customer.*` (profile, admin profile, notes, delete (offboarding fan-out), addresses, upsertFromApi); `customer/set-promo-opt-out.ts`, `customer/unsubscribe.ts` | customers, customers/[id], guests, segments | `/account`, checkout, audiences, `/api/customers*` |
| `wishlist` | `wishlists`, `wishlist_items` | service, `lib/wishlist/config.ts` | — (actions + service) | customers/favorites | `/favoris`, `/u/[slug]`, price-drop/back-in-stock emails |
| `newsletter` | `newsletter_subscriptions` | service/queries | `newsletter.subscribe/reactivate`, `newsletter/unsubscribe.ts` (admin), `customer/unsubscribe.ts` (token) | newsletter | footer signup, audiences, `/se-desabonner`, `/api/unsubscribe/one-click` |
| `mailing` | `email_template_overrides`, `email_flows`, `email_campaigns`, `email_logs`, `mailing_sends`, `email_suppressions` | `dispatch.ts`, `flows.registry/resolver`, `templates.ts`, log/campaign/sends services | none (actions → services) | marketing/mailing | every email |
| `auth`, `oauth`, `rbac` | `users`, `sessions`, `accounts`, `verifications`, `two_factors`; `oauth_provider_settings`; `roles`, `role_permissions`, `user_roles`, `user_permissions` (per-user overlay) | `authService`, `rbacService` | `auth.*`, `rbac.*`, `workflows/auth/upsert-oauth-settings.ts` | users, users/[id], users/roles, users/settings, customers/[id] | every guard; storefront auth pages |
| `api-key`, `api-settings`, `webhook-endpoints`, `webhook` | `api_keys`; (app_secrets `api.*`/`webhooks.*`); `webhook_endpoints`, `webhook_deliveries`; `webhook_events` (inbound payment claim ledger) | key/settings/endpoint services, `lib/webhooks/dispatch-drain.ts` | — (actions → services, own events) | system/api | external API, outbound webhooks, payment callbacks |
| `search` | `search_log`, `search_aliases` (+ products `search_vector`/`embedding`) | `searchService` (FTS + trigram + aliases + vector), embedding service | `search.purgeLog`, `workflows/search/aliases.ts` (`search_alias.*`) | system/search | `/recherche`, `/api/store/search` (no storefront caller), reembed subscriber |
| `redirects` | `redirects` | service/queries; `lib/redirects/{resolve,guard,normalize,auto-slug-redirect}.ts` | — (actions → service + `redirect.*`); slug renames create redirects automatically | system/redirects | `resolveRedirect` in dynamic storefront pages + redirect-aware static routes |
| `stock-location`, `stock-movement` | `stock_locations`, `stock_levels`; `stock_movements` (append-only ledger, reasons `order\|cancellation\|refund\|return\|api_delta\|api_set\|admin`) | location service (`_applyLevelTx`, `evacuateLocation`, `reconcileDefaultLevels`), movement service | — (actions → service + `stock_location.*`) | stock (Emplacements) | `/api/stock/movements`, ERP |
| `audit`, `jobs`, `instance` | `audit_log`; `job_run_log`; `app_instance_heartbeats` | audit/job/heartbeat services | `audit.purge` | system/audit, system/jobs, system/performance | security center, users/[id] activity |
| `blog` | `blog_categories`, `blog_tags`, `blog_posts`, `blog_post_tags` | services/queries (`listPublishedPosts` `'use cache'`) | `blog.*` | blog/* | `/blog*`, `/api/blog`, sitemap, search |
| associations | `customer_user_links`, `product_brands`, `product_categories`, `product_complementary`, `product_media`, `product_related` | `associations/catalog.service.ts` (`set` = replace), `customer-user.service.ts` | used inside catalog/customer workflows | — | — |
| raw SQL | `app_secrets` (key PK), `rate_limit_buckets` | `lib/db/init-secrets.ts`, `lib/inventory/variant-stock.ts`, api-settings service, `lib/rate-limit.ts` | — | — | guarded by `lib/db/scripts/guard-push.ts` |

---------------------------------------------------------------------------------------------------------------------------

## 4. Cross-cutting systems

### 4.1 RBAC
- **Registry** `src/lib/rbac/registry.ts`: 59 modules × actions from `view|create|update|delete|manage` (166 concrete keys) + `*` + `<module>:*`.
  Module `id` MUST equal the admin nav id, and its `group` should match the nav group. Keys exist only in code. The DB stores grants
  (`role_permissions.permission`, no CHECK; validated by `isValidPermissionKey`). Removed keys are purged by a migration (latest: 0206 — the removed-subsystem grants `collections`/`loyalty`/`businesses`/`credit`; also 0129 `stock:manage`, 0123),
  and the role editor tolerates stale ones.
- **Nav ↔ guard parity** (`lib/rbac/nav-access.ts`): an item is visible with `<id>:view`, or with ANY grant of its `visibleWhen`
  constant, and the page guards with `requirePermissionAny` on that SAME constant. `ORDER_NEW_VIEW_GRANTS` = `orders_new:view ∨ orders:manage`
  (Nouvelle commande). Nav ids that reuse another module:
  Segments→`promotions`, Nav Menu + Footer→`navigation`. Tests: `admin-nav-access`, `route-invariants`.
- **Dashboard**: `/admin` uses `requireAdminArea()` (landing page for every staff role). What it shows is gated by
  `lib/rbac/dashboard-access.ts`: `dashboard:view` is the master switch, and each block also needs its module's view grant
  (revenue → `analytics`, orders → `orders`, new customers → `customers`, low stock → `stock ∨ products`). Hidden blocks run no query.
- (There is no reserved-unenforced RBAC key: `stock:manage` was purged in migration 0129.)
- **Escalation guards** `lib/rbac/guards.ts`: `assertActorOutranksTarget` (uses the target's LATENT role-grants ∪ allow-overrides so an
  overlay-elevated account can't be seized), `assertActorMayGrantRole`, `assertActorMayGrantPermissionKeys`, and the last-admin floors
  (`countEffectiveWildcardAdmins` / `countWildcardAdminsExcludingRole` — both exclude deny-override "phantom" `*` holders via
  `WITHOUT_DENY_OVERRIDE`, `assertDisableKeepsAnAdmin`, `assertRoleChangeKeepsAnAdmin`, `assertRoleWildcardRemovalKeepsAnAdmin`). Access is
  role-only (the enum + `change-role`/`demoteAdminAtomic` were retired): the grant paths (assign-roles, per-user overlay, role CRUD) are
  gated by `users:roles`, and removing a `*`-carrying role runs `assertRoleChangeKeepsAnAdmin`.
- **Owner-only (`*`) powers** (a module grant is not enough): custom tracking JS + GTM (`lib/tracking/script-keys.ts`), mail transport +
  account-security templates (`lib/email/mail-settings.ts`, `critical` in `modules/mailing/templates.ts`), payment gateway
  credentials + sandbox toggle (`lib/payments/settings-plan.ts`), `seo.site_url` (it drives payment/email/QR/invite origins),
  off-site redirect destinations (`lib/actions/redirects.ts`), moving an env-keyed AI provider's base URL, demo purge / every data clean
  (any segment, `data-jobs.ts`) / demo API clear (`lib/auth/super-admin.ts`). API-key scopes are bounded by the creator's RBAC at mint time and re-checked at request time
  (`lib/api-auth/scopes.ts` `SCOPE_RBAC`, `require-api-key.ts`).
- **Render-time cross-module data**: a page may call another module's server action only behind a `can*` pre-check (for example
  `listAutoAssignJobsAction` only with `system_ai:view`, `listDataJobsAction` only with `system_jobs:view`). An unguarded call 404s the
  whole page for scoped roles. `page-guards.test.ts` enforces this, and also enforces `/new` pages → `:create`.
- Tests: `rbac-escalation`, `rbac-last-admin`, `privilege-escalation`, `route-invariants` (API catalog ⇔ disk; nav ids ⊆ registry;
  nav ⇔ page-guard parity; every admin page gated (AST, `requireAdminArea` only on an allow-list); **every export** of a `"use server"`
  file opens with a guard as its first awaited call; owner-only step-ups stay wired), `page-guards`, `admin-nav-access`.

### 4.2 Settings KV and other config stores
| Store | Contents | Read | Write |
|---|---|---|---|
| `site_settings` (KV, `settings_key_unique`) | dotted keys: `site.* social.* business.* theme.* admin.theme.* home.* storefront.* pages.<slug>.* nav.* checkout.* cart.* price.decimals warranty.* invoice.* delivery.* tax.* stock.* inventory.* catalog.product_code_* reviews.* search.* seo.* tracking.* consent.* auth.* mail.* newsletter.* audit.* debug.* perf.* redirects.enabled notfound.* site.mode… jobs.<key>.enabled demo.purge_in_progress ai.embedding_*` | `getSettingsMap()` + typed resolvers; admin panels via `pickSettings` | `workflows.cms.upsertSetting(input, {actorUserId})` (`workflows/cms/setting.ts`, `CmsActorCtx`; skips no-op writes; `validateSiteSetting` for `seo.site_url`/site keys; sensitive values redacted in audit via `lib/cms/sensitive-settings.ts`). Other writers: `jobs.*.enabled`, `demo.purge_in_progress`, bootstrap/seeds, demo `cleanSettings` (scoped by `lib/demo/settings-clean-plan.ts`, keeps operator-customised keys) |
| `app_secrets` (raw) | `BETTER_AUTH_SECRET`, `PAYMENT_ENCRYPTION_KEY`, `ADMIN_BOOTSTRAP_TOKEN`/`ADMIN_BOOTSTRAP_CLOSED`, `DEFAULT_ADMIN_*`, `api.enabled`, `api.public_routes`, `webhooks.enabled`, `webhooks.outbound_enabled`, `catalog.variant_stock_shared_default` | init-secrets, api-settings service (15 s), variant-stock (15 s) | same |
| Config tables | `media_settings`, `payment_provider_settings`, `oauth_provider_settings`, `ai_provider_settings`, `ai_feature_prompts`, `email_flows`, `email_template_overrides`, `review_schedule`, `currencies` | own services (in-process TTLs) | own actions/workflows |
| env | DB/S3/secrets/providers; `CSP_EXTRA_HOSTS`, `MEDIA_CDN_URL`, `S3_PUBLIC_URL` are **build-time** for CSP + `images.remotePatterns` | `lib/env.ts` lazy Zod proxy + raw `process.env` reads | Coolify env (must be listed in compose `environment:`) |

Invariants: there is no generic key editor, so every key needs a dedicated writer. `wiring-matrix.test.ts` fails when a key is read
but never written, except the deliberately unwired copy keys in its `UNWIRED_SETTING_KEYS` (`cart.coupon.*`, `cart.empty.*`,
`cart.summary.*`, `checkout.form.*`, gateway/COD radio labels). The `*_media_id` suffix is what protects a media id from orphan purge.
Headless exposure is decided by the `lib/api/content.ts` allow-list + deny filter (never widen it to `mail.`/`payment.`). Kill-switches
for marketing and public favourites fail CLOSED on a settings read error. Consent revision can't be lowered (`lib/consent/revision.ts`).

### 4.3 Events, audit, outbound webhooks
- `src/events/types.ts` declares 214 events / 49 domains. `lib/api-auth/event-catalog.ts` is GENERATED (`node scripts/gen-event-catalog.mjs`,
  part of `pnpm gen:api-catalog`) and enforced by `event-catalog.test.ts`. Severity: `events/severity.ts`.
- `bus.emit` (`events/bus.ts`) awaits `Promise.allSettled`, so slow subscribers delay the emitting request (the order receipt email on
  `order.created` is sent inline; provider sends are time-bounded). Heavy fan-out is detached (`void`), like the promotion announcement.
  Detach heavy I/O in new subscribers.
- Audit: `audit-trail.ts` (curated `HINTS`, ≈50 events, honours `audit.enabled` except audit/debug setting changes) + `audit-everything.ts`
  (long tail; `persist_low_signal`; `redactForStorage`; target via `TARGET_ID_KEYS` in `audit-target.ts`) → `audit_log`. The security center
  reads warn events. CSV exports emit `data.exported`.
- Outbound: `dispatch-webhooks.ts` (`bus.onAny`, gated by `webhooks.outbound_enabled`, active endpoints cached 5 s; a `["*"]` subscription
  excludes `SECURITY_DOMAINS` = `auth rbac api_key user data`) → `webhook_deliveries(queued)` → `/api/cron/webhooks` → `drainWebhookQueue`
  (`lib/webhooks/dispatch-drain.ts`: stale-pending recovery 20 min, claim 200 with SKIP LOCKED, 8-way pool, `ssrfSafeRequest` (DNS-pinned,
  capped read), HMAC signature, backoff 60/300/900/3600 s; respects the kill-switch without dropping the queue). WEBHOOKS.md documents payloads.
- Mutations with **no event** (so no audit row and no webhook): `toggleOrderLinePickedAction`, email-log pin/delete/requeue,
  favourites force-private. `nav.menu.deleted` has no emitter (no menu-delete UI).

### 4.4 Cache tags (`lib/cache/tags.ts`)
| Tag | Busted by | Reader? |
|---|---|---|
| `products:list`, `product:<id>`, `product:slug:<slug>`, `products` | `invalidate-catalog-cache` (product.*, catalog.review.*, import/demo completion), `invalidate-attribute-cache` (`products`), `invalidate-media-cache` (`products:list`; incl. `media.deleted`), `emitProductStockCacheBust` (`lib/catalog/product-cache-bust.ts`: sales/restock/edit/white-bg/stock-location levels) | PDP DTO; `products:list` also on the category readers (every sale line evicts every PDP + the mega-menu tree) |
| `categories`, `brands` | catalog/attribute/media subscribers | yes |
| `blog:posts`, `blog:categories` | `invalidate-blog-cache` (a tag update/delete also busts `blog:posts`), `invalidate-media-cache` (`blog:posts`) | `listPublishedPosts` |
| `site:settings` | `invalidate-cms-cache` (`setting.upserted`) | `/api/track` consent gate (`unstable_cache`) |
| `search:aliases` | alias writes in `searchService` (`modules/search/service.ts`, TTL layer) | `loadActiveAliases` (`ttlCached`) |
| `attributes`, `blog:tags`, `blog:post:slug:*`, `blog:category:*`, `banners*`, `faqs*`, `nav*`, `pages`/`page:slug:*` | various subscribers | **reserved, no reader**: CMS freshness relies on dynamic rendering + `revalidatePath("/", "layout")` |

Promotions have no tag: `invalidate-promotion-cache` revalidates the root layout. Rule: add a tag only together with a real reader, list it in
`tags.ts` and on the perf page (`CACHED_READERS` in `admin/system/performance/page.tsx`). `cache-tag-readers.test.ts` guards the vocabulary.
Anything baked into `mapProductRows` (warranty default, shared-stock default, brand/category names, media URLs, attribute labels) needs a bust path on write.

### 4.5 Jobs, cron, retention
| Job key (`lib/jobs/registry.ts`) | Route | Work |
|---|---|---|
| `retention_purge` | `/api/cron/retention` | `runRetentionPurge` (`lib/retention/run.ts`). Targets come from `RETENTION_TARGETS`, defaults from `RETENTION_WINDOWS` (`lib/retention/windows.ts`, days): search_log (live window `search.purge_months`), webhook_events 90, webhook_deliveries 90, audit_log (live window `audit.retention_months`), `qb-` ephemeral carts 2, guest carts 60 (last activity), guest wishlists 180, job_run_log 90, email_logs 180 (pinned kept), mailing_sends 540, cart_events 180, instance heartbeats 90, ai_call_logs 14, expired sessions/verifications. Setting-driven windows fail closed (skipped) when settings are unreadable. `ai_job_logs` is pruned by the review scheduler. |
| `mailing_queue` | `/api/cron/mailing` | `drainEmailQueue` (`lib/mailing/drain.ts`; single-flight lock, throttle `mail.throttle_per_min`, daily marketing cap `mail.daily_limit`/`mail.daily_reset_time` [defers marketing past the cap to the next reset; transactional never capped], consent re-check, retries) |
| `birthday_email` | `/api/cron/birthday` | birthday coupon mails (`mail.birthday_code`, per-year dedup, Feb-29 fold) |
| `review_request` | `/api/cron/review-request` | review requests (`mail.review_delay_days`) |
| `payment_reconcile` | `/api/cron/payments` | `reconcilePendingPaymentsWorkflow` |
| `abandoned_orders` | `/api/cron/abandoned-orders` | `sweepAbandonedOrdersWorkflow` (48 h; gateway pre-flight; never cancels operator-confirmed, ERP-pushed or offline-settled counter sales; covers named pickup points) |
| `webhook_dispatch` | `/api/cron/webhooks` | `drainWebhookQueue` |
| `review_generation` | internal timer (instrumentation) | AI review schedule (`review_schedule`) + janitors |

Adding a job = `ScheduledJobKey` + `SCHEDULED_JOBS` + `JOB_WORK` (`lib/jobs/run-job.ts`) + `app/api/cron/<x>/route.ts` (`guardCron`) +
`route-catalog.ts` + docs (`docs/deployment-coolify.md`, API.md, README cron list, `docs/site-map.md`). `wiring-matrix` checks
registry ↔ `JOB_WORK`. Adding a retention target = `RETENTION_TARGETS` + `RETENTION_WINDOWS` (the executors, DB page, storage
`LOG_TABLES`, registry copy and confirm copy derive from it; `retention-inventory` test).

### 4.6 Email
`dispatchEmail` (`modules/mailing/dispatch.ts`): template (DB override ?? `templates.ts`) → per-template `is_enabled` gate (`critical`
account-security templates can never be disabled) → marketing kill-switch `mail.marketing_enabled` + `lib/mailing/automation-gate.ts`
(gates run before any `claimOnce`) → consent backstop `canSendMarketingTo` (`lib/email/consent.ts`) → brand vars (`mailing/brand.ts`) →
inline `sendEmail` + `email_logs` row, or bulk enqueue (`queued`) for the drain. 17 flows (`flows.registry.ts`, DB override `email_flows`,
`isFlowEnabled` 30 s cache) × 22 templates; idempotency `mailing_sends` `claimOnce(flow, key)`. Token templates are redacted in logs
(`REDACTED_KEYS`). Unsubscribe = HMAC token (`lib/crypto/sign.ts`) → `/se-desabonner` POST confirm, plus RFC 8058 List-Unsubscribe
one-click (`lib/email/list-unsubscribe.ts`, `/api/unsubscribe/one-click`). Better Auth links use `BETTER_AUTH_URL`. All other links use
`seo.site_url` via `resolvePublicOrigin` (`lib/url/public-origin.ts`). Env `EMAIL_PROVIDER` applies until an admin deliberately picks
another provider.
Triggers: `user.created`→welcome; `order.created`→receipt; `order.confirmed`; `order.status_changed`→paid/preparing/shipped/delivered/cancelled
(`FLOW_BY_STATUS`); `newsletter.subscribed`→welcome coupon; `promotion.announce_requested` (detached,
live promos only); `product.price_changed`/`product.restocked` (wishlist); `product.stock_low/depleted` (staff);
crons birthday/review; demo purge code; perf alerts.

### 4.7 Media / CDN
Upload (page Server Action, picker `/api/admin/media/upload`, URL import `/api/admin/media/import-url` (SSRF-hardened
`lib/media/fetch-remote-image.ts`, shared `isBlockedIp`), feed import, demo, scripts) → `uploadMediaWorkflow` → `processImage` (sharp: decode
with pixel limits, rotate, GIF detection, max size from `media_settings.max_width_px/max_height_px` (default 2400 px), EXIF strip (originals included), product-scope white-bg removal, JPEG primary + WebP/AVIF) →
`putObject` per variant → `media` row → `media.uploaded`. URL resolution `url-resolver.ts` + CDN base precedence `media_settings.cdn_base_url`
(accepted only if its host is in the baked allow-list, `cdn-allowlist.ts`) → `MEDIA_CDN_URL` → same-origin `/cdn` (anonymous relay, traversal
guard, immutable cache; kept originals are staff-only). Delete is NOT refused while the media is in use: the Médiathèque only warns (single
delete shows `mediaUsageCountAction`; bulk delete lists `listMediaInUseAction` hits and needs an explicit confirm). Then soft delete + S3
purge via `cleanup-media-storage` (objects still shown by order-line snapshots are kept, `listOrderReferencedStorageKeys`) + storefront bust.
Orphan/usage detection (`listOrphans`, `countMediaReferences`, `listReferencedMediaIds`) must list every media-id column + `%_media_id` settings. Upload scopes: canonical `MEDIA_UPLOAD_SCOPES` (`modules/media/validation.ts`), still spelled literally in
several UI/route files.

### 4.8 Search
`/recherche` (the only logging surface; rate-limited) → `resolveSearchConfig` → alias expansion → optional semantic (pgvector KNN ∪ keyword
candidates) → search readers (tx-local `set_config` trigram threshold, PgBouncer-safe) → hit enrichment → published + embargo + promo listing →
`CategoryPageClient`. Embeddings: `reembed-product` subscriber on product/brand/category/attribute changes and `import.products_completed`
(hash-gated), admin backfill. `/api/store/search` is site-mode + embargo gated and has no storefront caller.

### 4.9 SEO & machine surfaces
`getSeoConfig` (`lib/seo/config.ts`, React-cached) → root metadata, `buildPageMetadata`, per-route `generateMetadata`, JSON-LD
(`lib/seo/jsonld.ts`), `sitemap.ts`, `robots.txt`, `llms.txt`, `/feeds/[file]` (Google Merchant RSS + ACP JSON), `/md/[...path]` (Markdown
twins, canonical `lib/seo/markdown/canonical.ts`). URL validation in `lib/seo/url-guards.ts`. `seo.site_url` also drives `resolvePublicOrigin`
→ email links, payment return/callback URLs, order QR (hence owner-only). Redirects: rules fire where `resolveRedirect` runs
(dynamic storefront pages, `REDIRECT_AWARE_STATIC_ROUTES`, the `[slug]/[sub]/[...rest]` catch-all, `/promo/[slug]`). `lib/pages/reserved-routes.ts`
(`RESERVED_ROUTES`, `APP_ROUTE_SHAPES`) lists the slugs entities can't take and the paths where a rule never fires. Slug renames create
redirects (`lib/redirects/auto-slug-redirect.ts`).

### 4.10 Money, tax, currency
- Money = integer **millimes** in `*_cents` (1 TND = 1000). Admin forms enter TND → `dinarsToMinor` / `lib/checkout/money-input.ts`. Display
  (`lib/price.ts`): `formatMoney` (rounded to `price.decimals`, default 0; cards/PDP/panier) vs `formatMoneyExact` (checkout, orders, emails,
  invoices) vs `formatMoneyMachine` (JSON-LD/feeds).
- Price composition (place-order, authoritative): line unit = auto-promo-resolved price (live) → subtotal → coupon (`evaluateCouponEligibility`,
  one engine for apply/cart/quick/place, evaluated on LIVE prices `lib/cart/live-lines.ts`) → clamp ≤ subtotal → free shipping (coupon) → TVA → total.
  Zero-total online orders settle without a gateway. Preview copies live in `/panier/page.tsx`, `/checkout/page.tsx` + checkout form, the express
  fee preview (`lib/checkout/express-delivery-fees.ts`), plus `recompute-totals.ts` / `edit-items.ts` and the renderers.
- Tax (`lib/tax`): `tax.mode` (`disabled|ttc|ht`), `tax.default_rate_bps`, `tax.label`, `tax.on_shipping`. Cascade, most specific wins: product
  bps → attribute-value rule → brand → category chain (child → root, first non-null; `lib/catalog/category-chain.ts`) → global. Snapshot on
  `order_items.tax_rate_bps/tax_cents`. The per-order override `orders.tax_manual_cents` goes through the `set-invoice-tax` workflow
  (locked, audited, refused once a facture is issued). Known deferred at this snapshot: the HT taxable base excludes order-level discounts.
- Currency: relabel only (`currencies`, one active; display precision comes from `price.decimals`); `orders.currency` snapshot; gateways use TND
  (ClicToPay 788).

### 4.11 Site mode, consent, tracking, rate limiting
- `site.mode` `live|maintenance|coming_soon` (+ copy, `launch_at`, countdown), written from the Redirections page (`system_redirects:manage`).
  Gated: `(shop)` layout, `/md`, `/api/store/search`, `/feeds/*`, `sitemap.xml`, `llms.txt`, `robots.txt`. Staff bypass fails closed,
  auth-continuation paths are exempt.
- Consent `lib/consent/*` (cookie `tokyo.consent`, revision re-prompt) ↔ tracking `lib/tracking/parse-config.ts` → `TrackingScripts`
  (GTM/GA4/Meta), `CustomTrackingHtml` (owner-only content, consent-gated); client funnel `lib/tracking/funnel.ts` → dataLayer + `/api/track`
  (consent-revision aware). Bearer URLs (order UUIDs/tokens) are redacted from page URLs sent to third-party tags (`lib/tracking/redact-url.ts`).
- Rate limiting: Postgres fixed window (`lib/rate-limit.ts`, `rate_limit_buckets`). Client IP = LAST `X-Forwarded-For` hop (`lib/client-ip.ts`).
  Buckets include signin/signup/2FA/reset/password + email change, coupon (15/min IP, 10/min user), order placement (`lib/checkout/place-order-guards.ts`:
  refused attempts count per IP only, phone/email buckets increment after a real order), pay-return 10/min/order, public API 60/min per route+IP,
  key 120/min, `/api/track` 60/min, wishlist 60/min, newsletter, media upload/import, search, AI generation, cron 10/60 s, payment webhooks.

---------------------------------------------------------------------------------------------------------------------------

## 5. ADMIN SECTION INDEX

Columns: **Files** (page dir under `src/app/admin/` + main components) · **Guard** (page) · **Writes** (action perms) · **Actions** (`src/lib/actions/…`) · **W/S** (workflows or direct services) · **Tables** · **Storefront/API surfaces affected**.
Shared chrome: `admin/layout.tsx`, `_components/admin-shell.tsx` (`NAV_GROUPS`), `admin/not-found.tsx`, `admin/error.tsx`, `lib/rbac/nav-access.ts`,
`components/admin/_components/form-tabs.tsx` (FormTabs / FormTabStrip / useTabErrorFocus / TabbedFormError / useNoResetSubmit),
`components/admin/_components/setting-fields.tsx`, `components/ui/select-field.tsx`,
`components/admin/{page-header,confirm-delete-modal,icon-button,media-picker,rich-body-field,kpi-strip}.tsx`, `hooks/use-refresh-action.ts`.
Every page below renders its write controls read-only when the viewer lacks the write grant.

### 5.1 Tableau de bord
| Page | Files | Guard | Writes | Actions | W/S | Tables | Surfaces |
|---|---|---|---|---|---|---|---|
| Tableau de bord `/admin` | `page.tsx` | `requireAdminArea()` + per-block `lib/rbac/dashboard-access.ts` (`dashboard:view` master switch) | — | — (links `/admin/orders/export`, new product) | `getDailyOrdersSeries` (`ANNUAL_SERIES_DAYS`), `orderService.stats/list`, `getStatusDistribution`, customer series, `productQueries.listLowStockProducts` + `countStockProducts` with the configured threshold (`resolveLowStockConfig`) | orders, customer_profiles, products | none (read-only) |
| Statistiques `/admin/analytics` | `analytics/page.tsx` | `analytics:view` | — | — | order analytics SQL (`modules/order/queries.ts`, revenue = `revenueOrderSql`: paid, net of refunds, excl. cancelled/refunded), `lib/analytics/{trend,revenue-buckets}`, cart-event "most added" | orders, order_items, cart_events, customer_profiles | `getTopSellingProducts` also feeds the home best-sellers and `/top-ventes` |
| (non-nav) Système index `/admin/system` | `system/page.tsx` | `requireAdminArea()` | — | — | static tiles | — | — |

### 5.2 Catalogue
| Page | Files | Guard | Writes | Actions | W/S | Tables | Surfaces |
|---|---|---|---|---|---|---|---|
| Produits `/admin/catalog/products` (+`/new`, `/[id]`) | `catalog/products/{page,products-panel,products-workspace}.tsx` (catalog settings live in the workspace), `components/admin/product-form.tsx` (~3.8k lines, `TABS` + `FIELD_TAB`), `product-variants-editor.tsx`, `product-promotions-panel.tsx`, `product-scan-code.tsx`, `catalog/product-generation-control.tsx` | list/[id] `products:view`, new `products:create`; promo panel flags from `promotions:*` | `products:create/update/delete/manage`, `attributes:update` (bulk assign), `products:update` (catalog settings, FAQ, related) | `catalog.ts` (create/update/upsertProductVariants/duplicate/setProductArchived/delete/createBrandInline), `product-generation.ts`, `related-products.ts`, `catalog-settings.ts`, `cms.ts upsertProductFaqsAction`, `attribute.ts`, `ai-generate.ts`, `promotion.ts` (panel) | `catalog.*Product*`, `upsertProductVariants`, product-gen, `cms.upsertProductFaqs`. Editor stock fields go through `lib/catalog/editor-stock-fields.ts` (changed-only + `expectedStockQty` CAS). Delete (one tx, `deleteProductWorkflow`) retires live variants (SKU/GTIN freed), drops stock levels + attribute assignments. | products, product_variants(+values), product_* assoc, product_attribute_*, faqs, stock_movements, product_generation_*, ai_job_logs, site_settings `catalog.product_code_*` | PDP (`'use cache'`), grids, cards, search, feeds, sitemap, `/md`, JSON-LD, `/api/products*`, cart/checkout, wishlist emails, ERP webhooks |
| Stock `/admin/catalog/stock` (`/admin/catalog/locations` → `?tab=emplacements`) | `catalog/stock/{page,stock-panel,stock-tabs,stock-alert-settings,inventory-locations-card}.tsx`, `catalog/locations/locations-panel.tsx` | `stock:view` (read-only panel without `stock:update`) | `stock:update` | `catalog.ts bulkUpdateStockAction` / `setVariantStockDefaultAction` (app_secrets + `setting.upserted`), `stock-settings.ts`, `stock-locations.ts` (inventory settings, levels, location CRUD) | `lib/inventory/adjust.ts` (`applyStockSet`/`applyStockDelta`, lock + ledger), `lib/inventory/stock-alerts.ts`, `stockLocationService` | products/product_variants stock cols, stock_movements, stock_locations, stock_levels, site_settings `stock.*`/`inventory.*`, app_secrets | availability everywhere (`lib/inventory/in-stock-rule.ts`), `/api/stock`, back-in-stock + low-stock emails, dashboard low-stock |
| Catégories (+new,[id]) | `catalog/categories/**`, `components/admin/category-form.tsx` | `categories:view` (new `:create`); auto-assign widget only with `system_ai:view` | `categories:*`, `attributes:create` (inline filter attr) | `catalog.ts` category actions, `attribute.ts`, `cms.ts upsertCategoryFaqsAction`, `content-generation.ts`, `ai-assign.ts` | `create-category.ts` (cycle guard, child promotion on delete, delete refused while live promos target it), `setCategoryFilters`, auto-assign | categories, category_attribute_filters, faqs, product_categories | `/[slug]`, `/[slug]/[sub]`, mega menu, facets, TVA/warranty chain, `is_discountable`, sitemap, `/api/categories` |
| Marques (+new,[id]) | `catalog/brands/**`, `components/admin/brand-form.tsx` | `brands:view` (new `:create`); auto-assign only with `system_ai:view` | `brands:*` | `catalog.ts` brand actions, `cms.ts upsertBrandFaqsAction`, content-gen, ai-assign | `create-brand.ts` | brands, product_brands, faqs | `/[slug]` brand view, `/marques`, PDP, nav strip, tax cascade (brand rate edited only in Taxes), `/api/brands` |
| Attributs (+new,[id]) | `catalog/attributes/**` | `attributes:view` (new `:create`); auto-assign only with `system_ai:view` | `attributes:*` | `attribute.ts` | `manage-attributes.ts` (delete guards: variants/facets/tax rules) | product_attributes, product_attribute_values, product_attribute_assignments, product_attribute_scalars, category_attribute_filters, tax_rules | facets, PDP specs, JSON-LD, variant axes, tax rules, `/api/attributes` |
| Avis `/admin/catalog/reviews` | `catalog/reviews/{page,reviews-panel}.tsx`, `components/admin/catalog/review-{generation-control,schedule-card}.tsx` | `reviews:view` | `reviews:create/update/delete/manage` (schedule auto-publish needs `reviews:manage`) | `reviews.ts`, `review-generation.ts` | `workflows/catalog/review.ts`, `review-gen/*` | product_reviews, review_generation_*, review_schedule, products.rating/reviews_count | PDP reviews, JSON-LD aggregateRating, `/api/reviews`, review-request mails |
| Médiathèque `/admin/media` (+ `/admin/media/settings`, sub-tab) | `media/{page,media-panel,media-subtabs}.tsx`, `media/settings/{media-settings-form,product-white-bg-reprocess}.tsx` | `media:view`; settings `system_media:view` | `media:create/update/delete`; `system_media:update` | `catalog.ts` media actions (upload/import/delete/bulkDelete/update/usage/in-use/updateMediaSettings), `data-jobs.ts` reprocess; API `/api/admin/media{,/upload,/import-url}` | `media.*` workflows, `cleanup-media-storage`, `invalidate-media-cache`, reprocess runner | media, media_settings, import_jobs | every image (storefront, emails, feeds, OG), `/cdn`, admin forms via MediaPicker (explains a missing Médiathèque grant) |

### 5.3 Commandes
| Page | Files | Guard | Writes | Actions | W/S | Tables | Surfaces |
|---|---|---|---|---|---|---|---|
| Nouvelle commande `/admin/orders/new` | `orders/new/{page,manual-order-form}.tsx` | `requirePermissionAny(ORDER_NEW_VIEW_GRANTS)` | `orders_new:create ∨ orders:manage` | `manual-order.ts` (`searchProductsForOrderAction`/`resolveProductByCodeAction`/`createManualOrderAction`) | ephemeral `manual_*` cart → `order.place` (actor = customer, operator recorded, delivery `channel: "operator"`) → cash/bank ⇒ `transitionStatus(paid)` | orders*, carts, stock_movements, promotion_redemptions, addresses | order pages, emails, stock |
| Commandes `/admin/orders`, `/[id]`, `/[id]/invoice` (`?doc=avoir`), `/[id]/delivery-note` (`?shipment=`), `/admin/orders/export` (route, `orders:view`, `data.exported`) | `orders/{page,orders-panel}.tsx`, `orders/[id]/{order-detail-tabs,order-status-controls,order-line-editor,shipments-panel,documents-panel,payment-reference-form,invoice-tax-form,partial-refund-form,returns-panel,verification-panel,guest-order-link}.tsx` | `orders:view` (`canManage` = manage, `canUpdate` = manage ∨ update, returns = `returns:manage ∨ orders:manage`) | `orders:manage` (status, bulk status (no cancel), confirm, edit, ship, pick, refund, payment ref, link guest, documents), `orders:manage ∨ update` (invoice TVA), `returns:manage ∨ orders:manage` | `order.ts`, `documents.ts`, `returns.ts` | `order.transitionStatus/confirm/editItems/createShipment/refund/setPaymentReference/setInvoiceTax/linkGuestOrder`, returns workflows, `documentService.nextNumber`, `restockOrderLines`, `reconcileOrderPromos`, `lib/order/fulfilment-state.ts` (`goodsLeftWarehouse`), `lib/order/issue-delivery-note.ts`; list = µs keyset with server-side status filters/KPIs | orders, order_items, order_status_history, order_refunds, shipments, shipment_items, order_returns(+items), document_sequences, stock_movements, promotion_redemptions | `/order/[id]`, `/account/orders/[id]`, `/facture/[id]`, `/order/verify/[id]`, status emails, `/api/orders*`, webhooks `order.*`, CSV export |
| Paniers `/admin/cart` (+[id]) | `cart/**` | `cart:view` | — | — | cart service summary (filters before its limit, activity-based) | carts, cart_items | — |
| Retours `/admin/orders/returns` | `orders/returns/page.tsx` | `returns:view` | processing happens on `/admin/orders/[id]` | — | returns dashboard | order_returns | — |
| Garanties `/admin/orders/warranty` | `orders/warranty/page.tsx` | `warranty:view` | — | — | `lib/warranty computeWarrantyStatus` (phone-format lookup, cancelled/refunded, coverage start) | orders, order_items | — |
| Promotions & codes `/admin/promotions` (+new,[id]) | `promotions/{page,promotions-panel,promotion-form}.tsx` + `scope-choices.ts` | `promotions:view` (new `:create`) | `promotions:create/update/delete` | `promotion.ts` (create/update/delete/toggle/clone) | `workflows/promotion/manage.ts` (`refineCombo`, `resolveTargets`, `duplicate`) | promotions, promotion_targets, promotion_redemptions | auto-promo prices on cards/PDP/feeds/JSON-LD, `/panier`, `/checkout`, `/promo/[slug]`, coupon cookies `gz.coupon`/`gz.promo`, announcement emails; root-layout revalidate |
| Paiement & encaissement `/admin/system/payments` | `system/payments/{page,payment-settings-panel}.tsx` | `system_payments:view` | `system_payments:update`; credentials + sandbox toggle owner-only | `payment-settings.ts` (`planPaymentSettingsSave`, all-or-nothing) | `payment.upsertProviderSettings` (encrypt) + `cms.upsertSetting` (`checkout.payment.<p>_enabled`, `checkout.quick.cod_*`), payment config cache reset | payment_provider_settings, site_settings | checkout/express payment methods, gateways (creds + test mode), payment webhooks |
| Achat express `/admin/system/express` | `system/express/*` | `system_express:view` | `system_express:update` | `express-settings.ts` | `cms.upsertSetting` (`checkout.quick.*`) | site_settings | PDP quick-buy form AND the full checkout field set; the quick-buy kill-switch is enforced in the workflow |
| Livraison `/admin/system/delivery` | `system/delivery/{page,delivery-panel}.tsx` | `system_delivery:view` | `system_delivery:create/update/delete` | `delivery.ts` | methods/fees via `cms.upsertSetting` (shared money parser); agents/locations via `delivery.*`; zones/rates via `workflows/delivery/zone.ts` (`delivery.zone.*`) | delivery_agents, pickup_locations, delivery_zones, delivery_agent_zone_rates, site_settings `delivery.*` + `checkout.delivery.default_fee_cents/free_threshold_cents` (dual writer with Réglages commande) | `resolveDelivery` (place-order, manual/ERP), checkout options, panier preview, PDP JSON-LD shipping |
| Taxes `/admin/system/tax` | `system/tax/{page,tax-tabs,tax-settings-panel,entity-tax-editor,tax-rules-panel}.tsx` | `system_tax:view` | `system_tax:update` | `tax-settings.ts`, `tax.ts` (brand/category bulk rates → workflows + `tax.entity_rate_updated`; rules) | `tax.upsertRule/deleteRule`, `setBrandTaxRatesWorkflow`, `setCategoryTaxRatesWorkflow` | site_settings `tax.*`, brands/categories `tax_rate_bps`, tax_rules | panier/checkout tax, place-order line snapshot, invoices/receipts, edit-items |
| Devises `/admin/system/currency` | `system/currency/{page,currency-panel}.tsx` | `system_currency:view` | `system_currency:create/update/delete` | `currency.ts` | `currencyService` direct + `currency.*` events | currencies | MoneyProvider symbol, JSON-LD `priceCurrency`, feeds, llms/md, `orders.currency` snapshot |
| Réglages commande `/admin/system/checkout` | `system/checkout/checkout-settings-panel.tsx` | `checkout:view` | `checkout:update` | `checkout-settings.ts` (`CHECKOUT_FIELDS`, `DINAR_INPUT_KEYS`) | `cms.upsertSetting` | site_settings `checkout.*`, `price.decimals`, `warranty.default_months/label`, `invoice.number_prefix/credit_prefix`, `delivery.note_prefix` | copy/fees/min order/require account (web, express, manual, ERP), order-number prefix, doc numbering, `formatMoney` decimals, PDP JSON-LD delivery times |

### 5.4 Rendez-vous
| Page | Files | Guard | Writes | Actions | W/S | Tables | Surfaces |
|---|---|---|---|---|---|---|---|
| Rendez-vous `/admin/rendez-vous` | `rendez-vous/{page,rendez-vous-panel,dto}.tsx` | `appointments:view` | — (read-only agenda) | — | `appointmentService.listForAdmin` (all statuses, `deleted_at IS NULL`, ORDER BY created_at DESC), `countForAdmin`, `countByStatus` | appointments, appointment_locations, appointment_reasons | `/rendez-vous` wizard, `/account?tab=rendezvous`, booking/confirm emails |
| Modération `/admin/rendez-vous/moderation` | `rendez-vous/moderation/page.tsx` (reuses `rendez-vous-panel`) | `appointments:view` (act = `appointments:manage`) | `appointments:manage` | `setAppointmentStatusAction`, `deleteAppointmentAction` (`lib/actions/appointments-admin.ts`) | `listForAdmin({status:"pending"})`, `countForAdmin("pending")`; status transition via `appointment.setStatus`/`delete` (reactivation re-checks slot capacity under the advisory lock) | appointments | pending queue, confirm email on accept |
| Réglages `/admin/rendez-vous/reglages` | `rendez-vous/reglages/page.tsx` | `appointments:view` (write = `appointments:update`) | `appointments:update` | `create/update/deleteAppointmentLocationAction`, `create/update/deleteReasonAction`, `saveAppointmentsSettingsAction` (`lib/actions/appointments-admin.ts`) | location + reason CRUD (`appointment.{location,reason}.*`; a slot-length change is blocked while upcoming bookings exist), `cms.upsertSettingsBatch` (`appointments.*`) | appointment_locations, appointment_reasons, site_settings `appointments.*` | availability + slot capacity feeding the `/rendez-vous` wizard |

All three items share nav id `appointments` (registry group « Rendez-vous »). The storefront `/rendez-vous` wizard reuses the `/account` DateField calendar and `/api/store/search` for the montre step.

### 5.5 Clients
| Page | Files | Guard | Writes | Actions | W/S | Tables | Surfaces |
|---|---|---|---|---|---|---|---|
| Clients `/admin/customers` (+[id] = customer 360) | `customers/{page,customers-list,invite-client-form}.tsx`, `customers/[id]/{customer-detail-panel,account-controls,promo-optout-control}.tsx` | `customers:view`; UI flags `users:manage` (account ops, roles, 2FA), `customers:update`, `customers:manage`, `users:create` (invite) | `customers:update/delete/manage`, `users:manage/create` | `customers.ts`, `admin.ts` (notes/profile/default address/promo opt-out/delete/invite/changeUserRole), `auth.ts` (disable/enable/forceLogout/verify/reset), `two-factor.ts`, `rbac.ts`; API `/api/admin/customers/export` | `customer.adminUpdateProfile/updateNotes/deleteCustomer` (offboarding: consent, favourites, segments), `auth.*` | customer_profiles, addresses, customer_user_links, users, sessions, two_factors, api_keys (revoke) | `/account`, audiences, `/api/customers*` |
| Invités `/admin/customers/guests` | `customers/guests/*` | `invites:view` | — | API `/api/admin/customers/guests/export` | guest grouping from orders | orders | — |
| Favoris `/admin/customers/favorites` | `customers/favorites/{page,favorites-browser,favorites-public-admin}.tsx`; `lib/wishlist/favorites-filter{,-shared}.ts` | `favorites:view` | `favorites:manage`, `favorites:export` | `wishlist.ts searchFavoritesAction/favoritesStatsAction (view), saveFavoritesPublicEnabledAction/forceFavoritesPrivateAction/liftFavoritesLockAction (manage)`; API `/api/admin/customers/favorites/export` (favorites:export) | `cms.upsertSetting` / wishlist service | wishlists, wishlist_items, products (in_stock/stock_qty), product_categories, site_settings `social.favorites_public_enabled` | `/favoris`, `/u/[slug]` |
| Segments clients `/admin/marketing/segments` | `marketing/segments/{page,segments-panel}.tsx` | `promotions:view` (nav id `promotions`) | `promotions:create/update/delete` | `segments.ts` | `segmentService` direct + `segment.*` | customer_segments, customer_segment_members | promo targeting (`resolveBuyerContext`), campaign/announcement audiences |
| Newsletter `/admin/newsletter` | `newsletter/{page,newsletter-panel}.tsx` | `newsletter:view` | `newsletter:manage` | `newsletter.ts` (reactivate, unsubscribe); API `/api/admin/newsletter/export` | `newsletter.reactivate`, `workflows/newsletter/unsubscribe.ts` | newsletter_subscriptions | audiences, welcome coupon, profile opt-in sync |
| Réglages (Utilisateurs) `/admin/users/settings` | `users/settings/{page,auth-settings-panel,session-policy-panel}.tsx` (`/admin/system/auth` → 308 redirect here) | `users:view` OR `system_auth:view` (`USER_SETTINGS_VIEW_GRANTS`) | session panel `users:policy`; auth/social panel `system_auth:update` | `auth-settings.ts` (`AUTH_FIELDS`, OAuth creds write-only), `session-policy.ts` | `cms.upsertSetting` + `workflows/auth/upsert-oauth-settings.ts` (`auth.oauth_settings_updated`) → auth instance reset | site_settings `auth.*`, oauth_provider_settings | login/register/forgot/reset/verify copy, social login, email verification requirement, session lifetime |

### 5.6 Contenu & Design
| Page | Files | Guard | Writes | Actions | W/S | Tables | Surfaces |
|---|---|---|---|---|---|---|---|
| Page d'accueil `/admin/cms/home` | `cms/home/{page,home-composer,listing-settings-panel}.tsx` | `home:view` | `home:update` | `home.ts saveHomeBlocksAction` (+ `saveHomeSettingsAction` for the listing keys) | `cms.upsertSetting` | site_settings `home.blocks` (the composer layout) + `storefront.*` (listing help CTA / display mode); the legacy `home.*` keys are the dormant synthesis seed | instance BLOCK composer (`lib/pages/{home-blocks,home-blocks-data}.ts` → `HomeBlocksRenderer`); fresh-install fallback synthesised from `home-page-config`/`home-config-defaults` |
| Pages `/admin/cms/pages` (+[id]) | `cms/pages/{page,pages-panel}.tsx`, `cms/pages/[id]/{page,page-meta-form,sections-panel}.tsx` | `pages:view` | `pages:create/update/delete` | `cms.ts` page + section actions (`buildSectionData`) | `cms.createPage/updatePage/togglePagePublish/deletePage/*Section` | pages, page_sections, typed section tables + items | `/[slug]` CMS pages, legal/Maison static routes (`LegalPageRenderer`), `/help`, sitemap, `/md`, boot `ensureSystemContentPages` |
| Bannières `/admin/cms/banners` (+[id]) | `cms/banners/{page,banners-panel}.tsx` + `target-options.ts`, `components/admin/banner-form.tsx` | `banners:view` | `banners:create/update/delete` | `cms.ts` banner actions | `cms.createBanner/updateBanner/deleteBanner` | banners | home hero, header strip, in-grid banners (target/cadence), footer row (newsletter signup renders only when a `footer` banner exists), `/api/content` |
| Catalogues (showcase) `/admin/cms/showcase` | `cms/showcase/{page,showcase-settings-panel}.tsx` | `showcase:view` | `showcase:update` | `showcase-settings.ts` | `cms.upsertSetting` (`pages.<slug>.*`) + `showcase.setPins` | site_settings, showcase_pins | `/nouveautes`, `/top-ventes`, `/promotions` |
| Badges de confiance | `cms/trust-badges/{page,trust-badges-panel}.tsx` | `trust_badges:view` | `trust_badges:*` | `cms.ts` trust-badge actions + `saveTrustBadgeSettingsAction` (`storefront.trust_badges.*`) | `cms.*TrustBadge` | trust_badges + `storefront.trust_badges.*` | product/cart/checkout reassurance strip via shared `TrustStrip` (`resolveBuyBoxBadges`) |
| Nav Menu `/admin/cms/nav-menu` | `cms/nav-menu/{page,nav-builder}.tsx` | `navigation:view` | `navigation:update` | `nav-builder.ts` `saveHeaderNavAction` (replace-all) | `nav.menu.updated` | nav_menus, nav_items (+ `config`) | composable header mega-menu via `getComposedNavRoots` → `site-header.tsx`; per-root dropdown blocks (categories/brands/products/image/links), columns, mobile visibility. (`nav.*` labels + `nav_*` featured banners are legacy, superseded by the composer) |
| Footer `/admin/cms/footer` | `cms/footer/{page,footer-panel,footer-content-form}.tsx` + `MenuCard` + locked `BannerForm` | `navigation:view` | content/appearance → **`settings_site:update`** (`saveFooterAction`, `lib/actions/footer.ts`); columns → `navigation:update`; newsletter banner → `banners:create/update` | `saveFooterAction` (footer subset of `site.*`/`social.*` + `storefront.footer.*`) + `cms.ts` nav/banner actions | nav/banner workflows | `site.*`/`social.*`/`storefront.footer.*` settings, nav_menus/nav_items (`FOOTER_COLUMNS`), banners (`footer`) | the whole footer via `SiteFooter` — brand/contact/socials (settings), appearance (`getFooterAppearance`: tone/newsletter style/social style/show-toggles, `lib/cms/footer-appearance.ts`), columns, newsletter; mobile collapses contact + columns into pills; Kawn attribution non-removable |
| Thème & design `/admin/cms/theme` | `cms/theme/{page,theme-panel,color-field}.tsx` | `settings_theme:view` | `settings_theme:update` | `theme.ts` (hex-validated; `theme.*` + `admin.theme.*`) | `cms.upsertSetting` | site_settings | ROOT layout CSS for storefront AND admin (`lib/theme/{config,admin-config}.ts`), favicon, OG default, email brand colours |
| Identité & contact `/admin/cms/settings` | `cms/settings/{page,settings-panel}.tsx` + `components/admin/_components/contact-list-field.tsx` | `settings_site:view` | `settings_site:update` | `site.ts` (validates all fields first; multi-value phones/emails/addresses via `lib/cms/contact-list{,-save}.ts` → `site.contact_phones/_emails/addresses` JSON arrays + synced single primaries, per-entry « Footer » flag) | `cms.upsertSettingsBatch` (atomic) | site_settings `site.* social.* business.*` | header/footer/help/legal, invoices & receipts (seller identity read LIVE), JSON-LD, llms.txt, email brand |

### 5.7 Blog
| Page | Files | Guard | Writes | Actions | W/S | Tables | Surfaces |
|---|---|---|---|---|---|---|---|
| Articles blog (+new,[id]) | `blog/posts/**`, `components/admin/blog-post-form.tsx` | `blog_posts:view` (new `:create`) | `blog_posts:*` | `blog.ts` | `blog.*Post*` | blog_posts, blog_post_tags | `/blog`, `/blog/[slug]`, `listPublishedPosts` cache, `/api/blog`, sitemap, search |
| Catégories blog / Tags blog | `blog/categories/**`, `blog/tags` | `blog_cats:view`, `blog_tags:view` | `blog_cats:*`, `blog_tags:*` | `blog.ts` | blog category/tag workflows | blog_categories, blog_tags | `/blog/[slug]` (flat category; legacy `/blog/category/[slug]` 308→), `/blog/tag/[slug]` |

### 5.8 Système
| Page | Files | Guard | Writes | Actions | W/S | Tables | Surfaces |
|---|---|---|---|---|---|---|---|
| Utilisateurs `/admin/users` (+[id], `/roles`) | `users/{page,users-table,create-user-form,invite-user-form,set-password-modal,user-roles-editor}.tsx`, `users/[id]/page.tsx`, `users/roles/{page,roles-manager,session-policy-panel}.tsx` | `users:view` (`manage` flags) | `users:create/manage` | `admin.ts` (inviteUser, changeUserRole), `rbac.ts` (roles CRUD, setUserRoles, createUser, setUserPassword), `auth.ts` account ops, `two-factor.ts`, `session-policy.ts` | `auth.*`, `rbac.*` (escalation guards + last-admin floors) | users, sessions, accounts, two_factors, roles, role_permissions, user_roles, api_keys, site_settings `auth.session.*` | every guard; users/[id] redirects to the customer 360 when a live profile link exists (archived profiles stay on the user page) |
| IA & Automation `/admin/system/ai` | `system/ai/{page,ai-settings-panel}.tsx` | `system_ai:view` (`update` flag) | `system_ai:update` (providers, prompts), `system_ai:manage` (auto-assign) | `ai-settings.ts`, `ai-assign.ts`, `ai-job-logs.ts` | `ai.upsertProviderSettings` (base-URL block-list; env-keyed base URL owner-only), `ai.upsertFeaturePrompts` | ai_provider_settings, ai_feature_prompts, ai_call_logs, ai_job_logs, ai_assign_*, site_settings `ai.embedding_*` | all AI buttons (`lib/ai/tasks.ts`), semantic search |
| Mailing `/admin/marketing/mailing` (`/admin/system/mail` → redirect) | `marketing/mailing/{page,mailing-tabs,workflows-tab,campaigns-tab,logs-tab}.tsx` + `logs-params.ts`, `system/mail/mailing-panel.tsx` | `system_mail:view` | `system_mail:update` (non-security templates, flows, From/Reply-To, globals), `:manage` (reset, test, logs), `:create` (campaigns); transport + security templates owner-only | `mailing.ts` | services direct (no mailing workflows); provider keys via `cms.upsertSetting` | email_template_overrides, email_flows, email_logs, email_campaigns, mailing_sends, site_settings `mail.*`, `newsletter.welcome_code` | every email (transactional + marketing), campaign sends |
| Tâches planifiées `/admin/system/jobs` | `system/jobs/{page,jobs-panel}.tsx` | `system_jobs:view` | `system_jobs:manage` | `jobs.ts` (setJobEnabled, runJobNow) | `runScheduledJob(key,"manual")` | job_run_log, site_settings `jobs.*.enabled`, review_schedule | all crons (§4.5) |
| SEO & schéma `/admin/system/seo` | `system/seo/seo-settings-panel.tsx` (ONE form over 7 hidden tabs) | `system_seo:view` (read-only without `update`) | `system_seo:update`; `seo.site_url` owner-only | `seo.ts` (`TEXT_FIELDS`/`BOOL_FIELDS`) | `cms.upsertSetting` | site_settings `seo.*` | metadata, JSON-LD, sitemap, robots, llms.txt, feeds, `/md`, **`resolvePublicOrigin` (email links, payment returns, QR, invite URLs)** |
| Redirections & 404 `/admin/system/redirects` (tabs list/settings/notfound/maintenance) | `system/redirects/{page,redirects-manager,settings-forms}.tsx` | `system_redirects:view` (read-only without `manage`) | `system_redirects:manage`; off-site destinations owner-only | `redirects.ts`, `site-mode.ts` | redirect service + `redirect.*` events (`lib/redirects/guard.ts`: own hosts, loop check); `cms.upsertSetting` | redirects, site_settings `redirects.enabled`, `notfound.*`, `site.mode…` | `resolveRedirect` surfaces (§4.9), 404 scenes, maintenance gate |
| Cookies & RGPD `/admin/system/cookies` | `system/cookies/{page,cookie-settings-panel}.tsx` | `system_cookies:view` | `system_cookies:update` | `cookies.ts` (revision can't be lowered) | `cms.upsertSetting` | site_settings `consent.*` | consent banner, tracking gating, `/api/track` |
| Suivi & Analytics `/admin/system/analytics` | `system/analytics/{page,analytics-settings-panel}.tsx` | `system_analytics:view` | `system_analytics:update`; GTM + custom head/body owner-only | `analytics.ts` (tracking id format validation) | `cms.upsertSetting` | site_settings `tracking.*` | `(shop)/layout.tsx` TrackingScripts / CustomTrackingHtml / Consent Mode |
| Recherche `/admin/system/search` (Stats/Réglages/Alias/Sémantique/Purge) | `system/search/*` | `system_search:view` (`manage` flag) | `system_search:manage` | `search-settings.ts`, `search-aliases.ts`, `search-maintenance.ts`, `embeddings.ts` | `cms.upsertSetting`, alias workflows (`search_alias.*`), `search.purgeLog`, embedding backfill | search_log, search_aliases, products.embedding, site_settings `search.*` | `/recherche`, header min length, `/api/store/search` |
| Journal d'audit `/admin/system/audit` (+ `/export` route) | `system/audit/*` | `system_audit:view` (`manage` flag) | `system_audit:manage` | `audit-log.ts`, `audit-settings.ts`, `admin.ts purgeOldAuditEntriesAction` | `audit.purge`, runtime config reset; stats cached 5 min | audit_log, site_settings `audit.*`/`debug.*` | security center signals, users/[id] activity |
| Import catalogue `/admin/system/import` | `system/import/{page,import-panel}.tsx` | `system_import:view` | `system_import:manage` | `import.ts`; API `/api/admin/import/template` | detached `runProductImport` (services, no `product.created`; `import.products_completed` → reembed + storefront bust; poller re-bust) | import_jobs, products + links, brands, media | whole catalog |
| Importer la démo `/admin/system/import-demo` | `system/import-demo/{page,import-demo-panel,purge-relaunch-card}.tsx` | `system_demo:view` (job list only with `system_jobs:view`) | `system_jobs:manage` (data jobs; every clean also needs `*`), `system_demo:manage` (API import), purge + API clear = `system_demo:manage` + `*` | `data-jobs.ts`, `demo-purge.ts`; API `POST /api/admin/system/demo[?op=clear]` | `workflows/demo/*`, `workflows/data/{run-data-job,segments}.ts` (single-flight; re-import keeps admin-edited editorial/FAQ) | nearly everything (seed/clean segments; purge deletes ALL orders) | whole storefront |

### 5.9 Infrastructure
| Page | Files | Guard | Writes | Actions | W/S | Tables | Surfaces |
|---|---|---|---|---|---|---|---|
| API & Webhooks `/admin/system/api` (13 tabs) | `system/api/{page,api-webhooks-panel,api-catalog-tabs}.tsx` | `system_api:view` | `system_api:create/update/delete` | `api-settings.ts` (toggles audited before→after via `lib/api-auth/access-settings-diff.ts`, keys), `webhooks.ts` (endpoints, redeliver) | api-key / api-settings / webhook-endpoint services | api_keys, webhook_endpoints, webhook_deliveries, app_secrets `api.*`/`webhooks.*` | external API (kill-switch, public routes), inbound payment webhook kill-switch (both gateways), outbound webhooks |
| Base de données | `system/database/page.tsx` | `system_database:view` | — | — | read-only pg diagnostics, migrations applied vs journal, retention inventory | pg catalogs, `drizzle.__drizzle_migrations` | — |
| Ressources | `system/resources/page.tsx` | `system_resources:view` | — | — | S3 head, provider readiness, DB ping | — | — |
| Performance | `system/performance/*`; `GET /api/admin/metrics` | `system_performance:view` (`manage` flag) | `system_performance:manage` | `perf-settings.ts` | `cms.upsertSetting` (`perf.*`) + runtime cache reset | app_instance_heartbeats, site_settings `perf.*` | sampler/alerts/uptime (process-local) |
| Sécurité | `system/security/{page,security-center}.tsx` | `system_security:view` | — | — | `lib/security/{posture,signals,headers}.ts` (CSP re-evaluated at request time; served CSP is build-time) | audit_log | — |

Redirect stubs (no guard, pure `redirect()`): `/admin/catalog/locations`, `/admin/system/catalog`, `/admin/system/mail`.

---------------------------------------------------------------------------------------------------------------------------

## 6. CHANGE-IMPACT CHEAT SHEET

### 6.0 Global checklist (applies to every admin modification)
| If you… | Also change | Verify with |
|---|---|---|
| add/rename/delete an exported `*Action` | make the RBAC guard its FIRST awaited call (or list it in `PUBLIC_ACTIONS` if shopper-facing); `pnpm gen:api-catalog` (regenerates `lib/api-auth/internal-api-catalog.ts` + `event-catalog.ts`; the permission column is derived from the guard calls); a NEW action file also needs a `FILE_MAP` entry in `scripts/gen-internal-api-catalog.mjs`. Put non-action helpers in a plain module (every export of a `"use server"` file is an endpoint) | `internal-api-catalog`, `route-invariants` |
| add an event | `events/types.ts`, `events/severity.ts` (if security/money), `audit-trail.ts` HINTS (curated), `audit-target.ts` `TARGET_ID_KEYS`, `SECURITY_DOMAINS` decision in `dispatch-webhooks.ts`, a cache subscriber if data is baked into a `'use cache'` reader, `pnpm gen:api-catalog`, WEBHOOKS.md | `event-catalog`, `audit-severity`, `audit-target`, `webhook-wildcard` |
| add a nav item / admin page | `NAV_GROUPS` id ∈ `PERMISSION_MODULES` (same `group`/`label`); page `requirePermission(<id>,'view')` or, if the guard differs, a `visibleWhen` constant in `lib/rbac/nav-access.ts` used by BOTH nav and page (`requirePermissionAny`); `/new` pages → `:create`; `isUuid` on `[id]`; `can*` flags + read-only rendering; cross-module data only behind a `can*` pre-check; `docs/site-map.md` | `route-invariants`, `page-guards`, `admin-nav-access` |
| add a permission key/module | `registry.ts`, nav id, migration back-fill if splitting an existing grant (see 0109), cleanup migration when removing a key (see 0123), `docs/security.md` | `rbac-escalation`, `privilege-escalation`, `route-invariants` |
| add/rename a settings key | action field list AND panel `name=` (literal match), reader + default (identical in panel and resolver), page `pickSettings` prefix list, strict read on the admin page (no `.catch(() => ({}))`), `revalidatePath("/", "layout")` when storefront-visible, `DINAR_INPUT_KEYS`/money parser if money, `form-number` for numeric blanks, `*_media_id` suffix for media, `lib/api/content.ts` allow-list if headless, `lib/cms/sensitive-settings.ts` if secret-ish, demo `settings-clean-plan`, `validateSiteSetting` if validation needed | `wiring-matrix` (read ⇒ write, actor), `settings-fail-closed`, `settings-actor`, panel parse tests (`search-config`, `seo-settings`, `perf-config`, `tracking-*`, `theme-config`, `site-mode-config`) |
| add a column/table | module `schema.ts` + barrel `lib/db/schema.ts`, hand-written `migrations/0131_*.sql`, journal entry with `when` strictly > 1790800000000, FK/CHECK in SQL only, CHECK for every `$type<Union>` (extend together or runtime 23514), `docs/database.md` + counts in README/DEVELOPMENT/REQUIREMENTS/modules.md | `migration-journal`, `test:db` on a throwaway DB |
| add a test file | wire into exactly one chain, appended to the LAST numbered sub-script (`test:pure:N` / `test:db:N`); start a new sub-script near 6000 chars (Windows 8191-char cmd limit) | `test-chain-integrity` |
| add an env var | `lib/env.ts` (or documented raw read), `.env.example` + `.env.coolify.example`, compose `environment:`; build-time vars (CSP/images) also Dockerfile `ARG` + compose `build.args`; security page checklist; `docs/deployment-coolify.md` | `security-posture` |
| add an external route | `route-catalog.ts` (id, scope, `canBePublic:false` for PII), `enforceExternalApi(id)`, `workflowErrorStatus` for new fail codes, keyset cursor for list endpoints, API.md + `src/app/api/README.md`, ERP guide tab copy | `route-invariants`, `headless-api`, `erp-api`, `external-api-contract` |
| add a CSV/data export | `requirePermission(<module>,'view')` + emit `data.exported` (excluded from `*` webhooks) | `identity-audit`, `webhook-wildcard` |
| add a cron job / retention target | §4.5 recipes | `job-outcome`, `wiring-matrix`, `retention-inventory`, `route-invariants` |
| write inside `db.transaction` | pass `tx` to every read (no pool read while holding locks) | `tx-pool-reentrancy` |

### 6.1 Per section
| Section | Must change together | Tests | Generators / docs |
|---|---|---|---|
| **Dashboard / Statistiques** | `getDailyOrdersSeries`, `revenueOrderSql`, `aovCents`, `computeDelta` shared by both pages (and the Commandes KPIs); block gating in `dashboard-access.ts`; low-stock threshold = `resolveLowStockConfig` (`lib/inventory/low-stock.ts`) + `stockStateSql` predicates (`lib/inventory/stock-state.ts`) shared with the stock page | `dashboard-kpis`, `analytics-trend`, `revenue-buckets`, `low-stock`, `route-invariants` | — |
| **Produits (form)** | field `name` ⇄ BOTH mappers in `actions/catalog.ts` (create + update) ⇄ `createProductSchema` + update map + create insert (`create-product.ts`) ⇄ `duplicate-product.ts` insert ⇄ `FIELD_TAB` ⇄ `mapProductRows` + `src/types/catalog.ts` + `toApiProduct` + feeds + JSON-LD; embedded text ⇒ `EMBEDDING_TEXT_FIELDS` + `buildEmbeddingInput`; stock fields go through `editor-stock-fields.ts` (changed-only + CAS); editor must keep input on failure (`useNoResetSubmit`) | `catalog-admin`, `duplicate-product-parity`, `product-stock-editor`, `replace-variants`, `demote-variable-stock-reset`, `reembed-fields`, `promo-card-charge-parity`, `product-discount`, `attribute-validation`, `form-no-reset` | `pnpm gen:api-catalog`, API.md |
| **Produits (price/promo parity)** | PDP `renderProductView`, `buildLivePromotionDiscountMap`, `resolveLivePromotionRowsForProducts`, `listLiveAutoForProduct`, feeds, cart `resolvePromotionalUnitPriceCents` (`lib/cart/pricing.ts`), `lib/cart/live-lines.ts`, place-order re-price, `lib/promotions/live-product-price.ts`, `/md` product twin, API single-product price | `promo-card-charge-parity`, `product-discount`, `public-gating`, `checkout-correctness` | — |
| **Stock / Emplacements** | availability rule (`lib/inventory/in-stock-rule.ts`, `lib/api/products.ts`, search `p.in_stock`, place-order pre-check, add-to-cart), `applyStockSet`/`applyStockDelta` (lock + ledger: one `stock_movements` row per change), stock-crossing alerts (`lib/inventory/stock-alerts.ts`), `product.updated` (+ `product.restocked` on unavailable→available), `emitProductStockCacheBust`; shared-stock mode touches place-order/restock/returns/edit-items/build-line-snapshot/add-to-cart/api-stock; per_location = totals only (deferred); ledger reason list duplicated in `stock-movement/schema.ts` + `api/stock/movements/route.ts` | `low-stock`, `stock-location`, `stock-location-transfer`, `inventory-config`, `inventory-writers`, `inventory-ledger-completeness`, `variant-stock`, `order-events`, `order-edit-ship`, `refund-restock-remainder` | API.md stock contract |
| **Catégories / Marques** | `FIELD_TAB` + zod + `provided`/patch lists; `/[slug]`, `/[slug]/[sub]` and `[...rest]`; `toApiCategory`/brand DTO; sitemap; content-gen `entity-adapter.ts`; category chain (`lib/catalog/category-chain.ts`) for TVA/warranty; `RESERVED_ROUTES` (`lib/pages/reserved-routes.ts`) for any new static route; slug rename ⇒ auto redirect; delete fan-out (promo guard, children/products to parent, picker/count exclusions) | `taxonomy`, `catalog-deletion-fanout`, `reserved-routes`, `slug`, `slug-rename-redirects`, `tax`, `content-generation`, `chip-icons`, `pdp-category` | API.md, `pnpm gen:api-catalog` |
| **Attributs** | `validateAttributeRefs` (`lib/api/attribute-validation.ts`; inactive non-deleted attributes accepted), variant axes, tax rules, facets (`getCategoryAttributeFilters`), AI assign, `invalidate-attribute-cache` | `attribute-filter`, `attribute-validation` | docs/modules.md attribute policies |
| **Avis** | `createReviewWorkflow` policy + PDP `alreadyReviewed`; `recomputeProduct`; AI apply must bust product tags; `reviews.enabled` gates PDP JSON-LD, review-request and the public `/api/reviews` view | `reviews-showcase`, `taxonomy` (partial) | — |
| **Médiathèque** | body-size: Server Action limit (`next-runtime.ts`) ↔ `limits.ts` ↔ settings clamp ↔ zod; `MEDIA_UPLOAD_SCOPES` + its literal copies; variant key shape (`variantKey`, `variantUploadKeys`, `variantStorageKeys`, `-nobg`, dedupe script); new media-id column ⇒ `listOrphans` + `countMediaReferences` + `listReferencedMediaIds` (in-use delete warning) + clean segments + docs/media.md; CDN allow-list (`cdn-allowlist.ts`) + build-time CSP/remotePatterns | `media-storage-keys`, `storage`, `reprocess-detourage`, `white-bg`, `media-resolver`, `media-orphans-count`, `media-safety`, `media-safety-db`, `cdn-allowlist`, `ssrf-fetch`, `ssrf-ip-classifier` | docs/media.md |
| **Commandes (status/lifecycle)** | `lib/order/status.ts` graph ⇒ transition guard, status controls, `adminStatusLabel`, `SHIPPABLE` (`lib/order/badges.ts`), `PRE_SHIP`, returnable statuses, send-order-status `FLOW_BY_STATUS`, issue-bl-on-ship, sweep, analytics status list, API PATCH + API.md, customer trail; restock/refund/return share the "did goods leave?" rule (`fulfilment-state.ts goodsLeftWarehouse`, `restockOrderLines`, `alreadyRestockedByRefund`, returns block, page `returnsBlocked`); fully refunded orders can't be edited/shipped/advanced; cancel pre-flight `assertPendingOnlineOrderNotCaptured` on EVERY cancel entry (admin single, customer (online pending only), sweep, API); bulk status never cancels | `order-status`, `order-edit-ship`, `order-lifecycle-guards`, `order-events`, `orders-admin`, `refund-restock-remainder`, `return-refund-advisory`, `manual-order`, `order-api`, `erp-api`, `confirm-payment-decision`, `phase1-review-order` | API.md, WEBHOOKS.md, docs/security.md |
| **Commandes (money/documents)** | totals: place-order ↔ `recompute-totals.ts` ↔ `edit-items.ts` ↔ `set-invoice-tax.ts` ↔ renderers (admin detail, invoice/avoir, `/facture`, `/order/[id]`, `/account/orders/[id]`, receipt email, CSV `modules/order/export.ts`, `serializeOrder`), `lib/order/document-money.ts` (TVA row parity); documents gapless + immutable numbering (`document_sequences`, delivery-note series shared by shipments + order BL; no second BL when parcels exist); invoice pages render LIVE order + LIVE seller identity; dates via store-zone formatters (`lib/time/store-tz.ts`) | `document-number`, `fiscal-period`, `store-date-format`, `recompute-totals`, `tax`, `invoice-tax`, `warranty` | — |
| **Nouvelle commande** | `placeOrderWorkflow` contract (actor = customer ⇒ address auto-save; operator recorded), `resolveDelivery` `channel: "operator"` (skips storefront toggles, still validates point/agent), ephemeral cart disposal, cash/bank → `transitionStatus(paid)`; grants via `ORDER_NEW_VIEW_GRANTS` / `ORDER_CREATE_GRANTS` | `manual-order`, `order-placement-guards`, `delivery-zone`, `admin-nav-access` | — |
| **Promotions / Segments** | `readPromotionForm` ↔ `baseSchema`/`refineCombo` ↔ DB CHECKs (trigger_surface, discount_bounds, cart_band) ↔ duplicate copy list ↔ `[id]` initial map ↔ list row ↔ `scope-choices.ts`; eligibility ONLY in `coupon-eligibility.ts` (+ `redeem.ts` messages, `COUPON_HARD_FAIL_REASONS`), mirrored set-wise in `lib/mailing/audience.ts`; segment rule vocabulary (`segment-rules.ts`) used by `segments.ts` + `audience.ts`; redemption/reversal (`reconcile-order-promos.ts`); category/brand delete guard reads live promo targets; **category-scope matching CASCADES to subcategories** — `expandCategoryIdsWithAncestors` (`promotion/queries.ts`) is applied at ALL 3 match points (`getActiveDiscountForProduct` / `resolveLivePromotionRowsForProducts` / `productsMatchingScope`), so a parent-category promo discounts descendant products; the non-discountable opt-out stays on DIRECT links; `shipping_waived_cents` records the free-ship cost on a redemption (nets on reversal) | `coupon-eligibility`, `scoped-coupon`, `coupon-race`, `coupon-free-shipping-cap`, `promotion-targeting`, `promo-security`, `promotions-admin`, `mailing-promotion-audience`, `reconcile-order-promos`, `auto-name` | WEBHOOKS.md, `pnpm gen:api-catalog` |
| **Paiements / Express / Checkout / Livraison / Taxes / Devises** | new gateway: `ONLINE_METHODS`, `payment_method` pg enum migration, provider client + `verify-mapping.ts`, webhook route + route-catalog, `resolvePaymentMethod`, `QuickBuyConfig.payment`, both checkout forms, labels, `isUpfrontPaidMethod`, `payment_provider_settings` columns, `lib/payments/{gateway-rules,settings-plan}.ts`; `CHECKOUT_FIELDS` writes every key (missing input ⇒ blanked); fee/threshold dual-written by checkout AND delivery actions through `lib/checkout/money-input.ts`; express field toggles also drive the FULL checkout form; express fee preview `express-delivery-fees.ts`; pricing change ⇒ inline previews + place-order + recompute + renderers; currency is relabel-only | `quick-buy-payment`, `payment-gateway-completeness`, `payment-verify-mapping`, `confirm-payment-decision`, `payments-hardening`, `checkout-correctness`, `delivery-currency-admin`, `cod-label-sanitize`, `checkout-parse`, `delivery-fee`, `delivery-zone`, `tax`, `recompute-totals`, `currency-normalize`, `purchase-limits` | WEBHOOKS.md, docs/security.md, docs/FORK.md |
| **Clients / Utilisateurs / Auth** | profile edits via `adminUpdateProfileWorkflow` (name + marketing sync, ERP webhooks); delete-customer offboarding fan-out (consent, favourites, segments; self-action guard); archived profile = link row survives (`customer_user_links`), 360/users[id] redirect semantics; enum role vs RBAC roles (change both floors together); new user control ⇒ workflow guard (`assertActorOutranksTarget`) + event + `revalidatePath`; `AUTH_FIELDS` ↔ panel names ↔ `lib/auth/pages-config.ts` defaults ↔ `components/auth/pages-fallback.ts`; OAuth creds ⇒ auth instance reset (single-process); session bounds `lib/auth/{policy,session-policy}.ts` | `rbac-escalation`, `rbac-last-admin`, `privilege-escalation`, `auth-hardening`, `auth-policy`, `oauth-autolink`, `name-sync`, `identity-audit`, `identity-privacy`, `identity-low`, `account-lifecycle`, `user-detail-archived-profile`, `keyset-cursor`, `phase1-review-auth` | docs/security.md, `pnpm gen:api-catalog` |
| **Newsletter / Mailing** | new flow = registry entry + template + sender calling `isFlowEnabled` + `claimOnce` (gates before the claim); template keys closed union + `REDACTED_KEYS` + category parity; `critical` templates owner-only; `mail.marketing_enabled` semantics identical in dispatch, drain, campaign action, page; provider precedence `lib/email/config.ts` ↔ hub initial values ↔ resources page; campaign audience kinds are CHECK-constrained (migration) | `mailing-*` (admin, audience, campaign-send, dispatch-logging, drain, flows, flows-consent, newsletter-sync, promotion-audience, security, unsubscribe), `email-send-timeout`, `email-recipients`, `wiring-matrix` | docs/deployment-coolify.md env table |
| **CMS (home/pages/banners/nav/footer/theme/identité)** | home: `lib/pages/home-blocks.ts` (model) + `home-blocks-data.ts` (read/resolve/synthesise) + `components/storefront/home/home-blocks-render.tsx` (renderer) + `(shop)/page.tsx` + `actions/home.ts` + demo seeds; legacy synthesis fallback = `lib/pages/{home-page-config,home-config-defaults}.ts`; banner placement = pg enum migration + zod + `BannerForm` + panel tabs + `lib/api/cms.ts` + cache subscriber + `/api/content`; nav = composable mega-menu: `nav-composer-model.ts` (columns + typed blocks) + `nav-defaults.ts` + `ensureHeaderNavRoots` boot seed + `getComposedNavRoots` (`lib/api/nav-composer.ts`) → data-driven `site-header.tsx`, saved by `saveHeaderNavAction` (replace-all) + `lib/cms/nav-menus.ts` system keys + `nav-link-liveness.ts` (the old `buildNavRoots` / `nav-labels.ts` / `nav_*` featured banners are retired); pages use the block composer (`savePageBlocksAction` → page_blocks), seeded at bootstrap via `insertSections` (the old admin section write-path `buildSectionData`/`SectionRenderer` is retired); theme `THEME_DEFAULTS` ↔ `globals.css` (incl. the `.storefront{}` `--radius-*-v` scale), `THEME_FONT_STACKS` ↔ panel options, radius clamp | `cms-admin`, `cms-correctness`, `storefront-chrome`, `theme-config`, `system-pages`, `trust-badge-resolve`, `banner-targeting`, `headless-api`, `content-public`, `editorial-sanitize`, `sanitize-img`, `site-mode-config` | docs/cms-content-model.md |
| **Blog** | create/update tri-state conventions (blank meta → NULL); DTOs `lib/api/blog.ts` + API.md; JSON-LD; slug rename ⇒ redirect (event carries OLD slug); public pagination | `blog`, `content-public`, `slug-rename-redirects` | API.md |
| **SEO / Redirections / Cookies / Tracking / Recherche** | SEO: ONE form over hidden tabs (every field must stay mounted), `TEXT_FIELDS`/`BOOL_FIELDS` + `SeoConfig` + all consumers + `url-guards.ts`; `seo.site_url` owner-only and money-relevant; redirects fire only where `resolveRedirect` runs (`REDIRECT_AWARE_STATIC_ROUTES`, `APP_ROUTE_SHAPES`), off-site = owner-only, loop check in `lib/redirects/guard.ts`; maintenance tab shares `system_redirects:manage`; tracking keys ↔ `parse-config.ts` ↔ `/api/track` gate ↔ content allow/deny ↔ CSP hosts (build-time) ↔ URL redaction; search knobs = `SearchConfig` + `SEARCH_DEFAULTS` + `resolveSearchConfig` + action map + form (semantic keys in a separate form); embedding model change ⇒ full backfill | `seo-settings`, `seo-title`, `seo-url-guards`, `same-as`, `llms-robots`, `feed-*`, `markdown-render`, `redirects`, `reserved-routes`, `slug-rename-redirects`, `tracking-*`, `redact-tracked-url`, `consent-effective`, `search-config`, `search-quality`, `search-aliases`, `search-alias-expand`, `semantic-embed-input`, `embedding-models`, `vector-literal`, `vector-bulk-write`, `search-visibility` | docs/modules.md search table |
| **API & Webhooks** | `route-catalog.ts`, scopes (`API_RESOURCES`, `SCOPE_RBAC`, writable resources), key creation bound + request-time creator re-check, toggles field names (literal), `webhooks.enabled` affects BOTH gateways' callbacks; external refs via `order.setExternalRef` (audited, 409 on conflict) and `customer.upsertFromApi` (409 on a conflicting ref); endpoint model changes ⇒ migration + service + actions + panel + drain + WEBHOOKS.md | `route-invariants`, `headless-api`, `erp-api`, `external-api-contract`, `order-api`, `ssrf-fetch`, `webhook-wildcard`, `privilege-escalation` | API.md, WEBHOOKS.md |
| **Jobs / Audit / Perf / Retention / Import / Demo** | §4.5 recipes; audit settings single clamp `resolveAuditConfig`; perf clamps `resolvePerformanceConfig`; data-job segments `DATA_SEGMENTS` ↔ `segment-meta.ts` ↔ run-data-job orders ↔ `SEGMENT_LABEL` ↔ panel copy; bulk paths must bust via `bust-storefront.ts` from a request context (pollers re-bust) | `job-outcome`, `job-run-log-prune`, `audit-*`, `perf-config`, `uptime`, `instance-heartbeat-window`, `storage`, `retention-inventory`, `data-clean-scoping`, `data-jobs-cache`, `import-parse`, `import-feed-parse`, `import-category-map` | docs/deployment-coolify.md, API.md |

---------------------------------------------------------------------------------------------------------------------------

## 7. Dev / runtime notes

### 7.1 Docker & services (observed 2026-09-23)
| Container | Image | Port | Role |
|---|---|---|---|
| `tokyo-postgres` | `tokyo-pgvector:16.14-alpine` | 5434→5432 | dev DB (real data; read-only for audits) |
| `tokyo-seaweedfs` | `chrislusf/seaweedfs:4.47` | 8333 (S3), 8888 (filer) | object storage |
| `tokyo-audit-db` | `tokyo-pgvector:16.14-alpine` | 5440→5432 | throwaway DB used for `test:db` runs |

`docker-compose.dev.yml` also defines `pgbouncer` (`pooler` profile). `docker-compose.coolify.yml` defines `app`, `postgres`
(pgvector build, `shared_preload_libraries=pg_stat_statements`), `seaweedfs`, optional `pgbouncer` (`pooler` profile). Both PgBouncer
configs ignore the startup `options` packet (and the timeout params). The migrator's session advisory lock must run on a DIRECT connection
(`MIGRATION_DATABASE_URL`), not through the pooler.
Env gotcha: `.env.local` may point at another Postgres. Verify `DATABASE_URL` before `db:migrate` / `test:db`, and run DB work against a
throwaway DB with inline `DATABASE_URL` + `BETTER_AUTH_SECRET`.

### 7.2 Migrations
- Hand-authored SQL in `src/lib/db/migrations/`; journal `meta/_journal.json` = **141 entries (0000–0140)**. Meta snapshots are frozen, and
  `db:generate` / `db:push` refuse to run (guard scripts).
- Recent: `0133_redemption_shipping_waived` (free-shipping cost on a promo redemption),
  `0134_index_and_check_hygiene` (boutique-image + partial stock-transfer indexes, drop redundant customer_user_links indexes, stable $type CHECKs),
  `0135_status_kind_checks` (webhook_deliveries.status / document_sequences.kind / pickup_locations.kind CHECKs, drop dead two_factors_secret_idx),
  `0136_review_listing_index` (PDP approved-review covering index (product_id, status, created_at DESC)),
  `0137_category_parent_display_order_idx` (composite categories (parent_id, display_order) index; drop the non-selective display_order + redundant parent-only index),
  `0138_brand_parity` (brands.display_order + is_discountable + the brands_tax_rate_bps_range CHECK),
  `0139_collection_parity` (collections.external_ref + partial-unique index; DROP the non-selective standalone collections_display_order_idx — collections are flat, mirrors brands),
  `0140_loyalty_cercle_famille` (loyalty rebuild "Le Cercle de Famille": coin_levels→loyalty_levels rename + spend/count columns, DROP coin_transactions, customer_profiles wallet→cumulative_spend_cents/paid_order_count/loyalty_level_id, orders coins→loyalty_accrued_at/loyalty_spend_cents, NEW loyalty_bons/loyalty_referrals/loyalty_life_stage_claims, coins→loyalty settings + RBAC rename, spend/count backfill from paid orders),
  `0141_customer_credit_wallet` (store-credit WALLET "Crédit": DROP the never-wired loyalty_bons, ADD customer_profiles.credit_balance_cents + append-only customer_credit_entries ledger + orders.credit_applied_cents; credit SETTLES an order rather than discounting it),
  `0142_credit_entries_erp_feed_idx` (global ERP-feed keyset index credit_entries_created_id_idx on customer_credit_entries (created_at, id)),
  `0204_remove_subsystems`–`0207_tighten_removed_value_checks` (SUBSYSTEM REMOVAL: drop merchandising Collections, Drip/early-access/tier-release, stored-value gift cards, Fidélité/loyalty, Entreprises/B2B and Store credit — their tables/columns/`site_settings`/RBAC grants; narrow `promotion_targets.target_type` to customer|segment and `catalog_content_gen_jobs.entity_type` to category|brand; KEEP `business.legal_name`/`business.tax_id`, the credit-note/avoir doc columns, the showcase collection pages and the retail gift-card products).
- **Next migration = 0208**, with `when` strictly > 1795408300000 (drizzle silently skips a smaller or equal `when` on existing DBs). The
  migrator wraps files in one transaction, so no `CREATE INDEX CONCURRENTLY`. FK/CHECK only in SQL. A `$type<Union>` CHECK drift causes
  runtime 23514. CHECKs are added SELECTIVELY to the hot-path lifecycle/status/kind columns (0134/0135), NOT universally — many enum-typed
  `$type<Union>` text columns still rely on TS + app enforcement only, and `import_jobs.segment` is deliberately left open (0100).
  `migration-journal.test.ts` guards the idx/tag/file bijection and monotonic `when`.
- Boot: `db-runner/migrate.cjs` (advisory lock 72707468, connect retry, one txn) → `db-runner/init-secrets.cjs` (`eval` exports) → `server.js`.

### 7.3 Test harness
- 219 `*.test.ts` files in `src/lib/db/tests`, all wired: `test:pure` = `test:pure:1` (82) + `test:pure:2` (22); `test:db` = `test:db:1` (56) +
  `test:db:2` (56) + `test:db:3` (3); `test` = `test:db && test:pure`. `test-chain-integrity.test.ts` requires each file in exactly one chain,
  aggregates sub-scripts and enforces the command-length limit.
- Runner: `tsx --conditions=react-server` (tsx CJS mode: no top-level await in tests). `test:db` uses `--env-file-if-exists=.env.local`, so
  override `DATABASE_URL` inline to target a throwaway DB. Test fixtures use `zztest-*` slugs/keys, and nothing stops a run against a
  non-throwaway DB (it would write them into the dev DB).
- Invariant tests worth running after ANY admin change: `route-invariants`, `page-guards`, `admin-nav-access`, `internal-api-catalog`,
  `event-catalog`, `wiring-matrix`, `settings-fail-closed`, `cache-tag-readers`, `test-chain-integrity`, `migration-journal` (all DB-free,
  although `route-invariants` and `wiring-matrix` are wired into the `test:db` chain), plus `privilege-escalation` (needs a DB).
- Verification toolchain: `pnpm typecheck`, `pnpm lint` (passes; eslint ignores `.claude/` and `.tmp`), `pnpm build` (webpack; layout-reachable
  `'use cache'` DB reads must guard `isBuildPhase()` (`lib/cache/build-phase.ts`) because the Docker build has no DB).

### 7.4 Build/runtime facts that affect admin work
- CSP + `images.remotePatterns` are frozen at BUILD. The Security tab shows a request-time CSP that can differ. Changing `S3_PUBLIC_URL` /
  `MEDIA_CDN_URL` / `CSP_EXTRA_HOSTS` requires a rebuild, and a runtime `cdn_base_url` must stay within the baked host allow-list.
- `'use cache'` uses the default in-memory handler (process-local), so multi-replica deployments see independent caches.
  `revalidateTag` / `revalidatePath` only affect the replica that handled the request.
- Dates: DB + Node run in UTC. Order numbers, fiscal year, store-local parsing and printed documents use Africa/Tunis (`lib/time/store-tz.ts`,
  `lib/fiscal-period.ts`).
- Frozen historical docs (do not edit as specs): `AUDIT-REPORT.md`, `ANALYSIS.md`, `PLAN.md`. Living docs: `docs/modules.md` (canonical),
  `docs/database.md`, `docs/security.md`, `docs/media.md`, `docs/cms-content-model.md`, `docs/site-map.md`, `docs/deployment-coolify.md`,
  `docs/deploy-runbook.md`, `docs/FORK.md`, `API.md`, `WEBHOOKS.md`, `DEVELOPMENT.md`, `README.md`, `REQUIREMENTS.md`, `src/app/api/README.md`.

---------------------------------------------------------------------------------------------------------------------------

## Appendix A — Architecture hazards to keep in mind during targeted admin edits
1. **RBAC denial inside an action throws `notFound()`**. It does not return an `ActionState`, so client code awaiting an action must catch.
2. **Cross-module reads at render** must sit behind a `can*` pre-check, otherwise the whole page 404s for scoped roles (§4.1).
3. **Settings panels write every key on save.** Admin settings pages therefore read strictly (fail closed to the error boundary). Never
   reintroduce `getSettingsMap().catch(() => ({}))` on a page that feeds a save form.
4. **`bus.emit` is synchronous from the caller's point of view** (it awaits all subscribers). Keep new subscribers fast or detached.
5. **Cache invalidation is layout-wide** for settings/CMS/promotion writes: `revalidatePath("/", "layout")` expires all `'use cache'` entries.
   Several tags are reserved with no reader.
6. **Soft deletes cascade only where coded**: category/brand deletes are refused while live promos target them, and product deletes retire
   live variants, drop stock levels + attribute assignments. Other link tables (tax rules, nav links, …) keep pointing at
   the tombstone.
7. **Every export of a `"use server"` file is a public endpoint** and must open with its guard. Put helpers in plain modules (pattern:
   `place-order-guards.ts`, `super-admin.ts`, `lib/wishlist/config.ts`).
8. **Money is millimes, and admin inputs are TND.** `formatMoney` rounds to `price.decimals` (default 0), so never compare displayed and
   charged prices.
9. **Process-local caches/TTLs** (payment 30 s, AI 30 s, OAuth 30 s, mail 30 s, flows 30 s, media 30 s, api-settings 15 s, shared-stock 15 s,
   perf/audit 15 s, endpoints 5 s, auth instance): a save is not instantly visible on other replicas.
10. **Nav id reuse** (Segments/Nav Menu/Footer share another module's grant; Nouvelle commande uses `visibleWhen`) couples
    visibility grants. The footer page also needs `banners:*` for its banner form.
11. **No pool reads inside a transaction** (`db` vs `tx`): the cancel/refund paths were fixed for this, and new tx code must pass `tx` through.
12. **Owner-only (`*`) step-ups** sit on top of module grants for money/phishing-relevant settings (§4.1). A delegate's form renders them
    disabled, and a crafted post is refused and logged.

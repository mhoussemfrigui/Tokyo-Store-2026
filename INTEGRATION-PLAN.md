# Tokyo-Store — Storefront Swap Plan (in-repo, phase-by-phase)

> **What you want (confirmed):** delete the current storefront inside this repo
> (`Tokyo-Store-2026`) and replace it with the new UI (`Tokyo-Store-UI`), wired to the **existing**
> backend. **No architecture changes, no new REST layer, no separate app, keep the admin, keep this
> Next app as-is.** The new storefront plugs into the backend's **existing** in-process data reads
> and Server Actions.
>
> Companion: [FRONTEND-REPLACEMENT-ANALYSIS.md](FRONTEND-REPLACEMENT-ANALYSIS.md) (backend reference).
> _Rev 2 — 2026-10-08. (Supersedes rev 1, which wrongly assumed a separate app over HTTP.)_

---

## The approach in one paragraph

Both apps are Next.js 16 / React 19. Because the new storefront will live **inside this repo**, its
pages become part of the same Next app as the backend — so they reach the backend the **same way the
current storefront already does**: Server Components importing `@/lib/api/*` / module `queries.ts`
directly (reads), and client components calling the existing `@/lib/actions/*` Server Actions
(cart, checkout, auth, wishlist…). **Nothing in `src/modules`, `src/workflows`, `src/lib/api`,
`src/lib/actions`, `src/app/api`, or the DB changes.** We swap the *presentation* (routes under
`src/app/(shop)` + storefront components + design tokens) and connect it to the plumbing that's
already there.

## Two realities the swap must handle (not optional)

1. **Coverage gap — 7 new routes vs 47 current.** The new UI provides: home, `[slug]`
   (category/product), `panier`, `checkout`, `account`, `favoris`, `reels`. The current storefront
   also has **~40 more**: login/register/2FA/forgot/reset/verify-email, blog (+author/category/tag),
   `fidelite`/`mes-credits` (loyalty), `pro` (B2B), `order/[id]` + `order/verify` (confirmation /
   tracking), `recherche` (search), `boutique`/`marques`/`collections` listings, and ~15 legal/CMS
   pages. A straight paste would delete all of them. **Recommended default:** keep the backend's
   existing routes for everything the new UI doesn't provide, swap only the overlapping ones, then
   restyle/port the rest progressively. (This is the least-disruptive path and keeps the site fully
   functional throughout.) → see the one decision in §Decision.
2. **Mock data → real data.** The new UI renders bundled JSON (`src/data/*.json`, placeholder
   electronics) through its `CatalogSource` seam. In-repo we replace that seam's source with an
   **in-process adapter** that calls the backend's existing `@/lib/api/*` and maps the DB product/
   category shape → the UI's `Product`/`Category` DTO. No new endpoints — it reuses the backend's
   existing read layer. (The UI's design already anticipates this swap: one file, `src/lib/data`.)

## File collisions to reconcile (both repos define these)

`app/globals.css`, `app/layout.tsx`, `app/(shop)/layout.tsx`, `app/(shop)/not-found.tsx`,
`app/(shop)/(shell)/{layout,error,page}.tsx`, `app/(shop)/(shell)/{account,checkout,favoris,panier,[slug]}/page.tsx`,
`components/seo/json-ld.tsx`, `lib/api/{products,categories}.ts`, `lib/price.ts`, `lib/utils.ts`,
`types/catalog.ts`. **Rule:** backend keeps the files that carry real wiring (`lib/api/*` →
DB, `lib/price.ts`, auth/session, the root layout's providers); the UI brings the **design** (its
`globals.css` tokens, `components/storefront/*`, shell chrome, `types/catalog.ts` DTO).

---

## Phases

Each phase ends **buildable** (`pnpm typecheck` + `pnpm build` green) and is a safe stopping point.
Work happens on a branch; the old storefront is only deleted once the new one renders real data.

### Phase 0 — Prep (non-destructive)
- Create a branch; snapshot the current `(shop)` route inventory.
- Merge the UI's missing deps into `package.json` (`embla-carousel-react`; the `next/font` Figtree/
  Outfit fonts) and its font setup. Reconcile `tsconfig`/eslint/prettier only where needed.
- Bring the UI's design tokens into `globals.css` (namespaced/merged so admin + storefront themes
  coexist; the admin theme injection stays untouched).
- Decide the collision rule per file (above). No routes deleted yet.

### Phase 1 — Land the new storefront's presentation
- Copy in the UI's `src/components/storefront/*`, `components/seo`, shell chrome
  (header/footer/mobile-nav), and UI primitives.
- Replace the **7 overlapping** routes (`(shell)/page`, `[slug]`, `panier`, `checkout`, `account`,
  `favoris`) with the UI's versions, and add `reels` + the `p/[id]` redirect. Keep all other
  backend storefront routes in place (Reality #1).
- Reconcile the three layouts: the **backend's** root + shell layout keep the global providers
  (MoneyProvider, ConsentProvider, auth session, tracking) and wrap the **new** chrome.
- At end of Phase 1 the new design renders (still on a temporary mock/adapter), site builds.

### Phase 2 — Repoint catalog reads to the real backend (in-process)
- Replace the UI's `CatalogSource` static source with a **platform source** that calls the backend's
  existing `@/lib/api/products` / `@/lib/api/categories` / module queries directly, mapping DB →
  the UI DTO (`title←name`, `price←minorToDinars(priceCents)`, `image←resolved /cdn URL`,
  `category←slug`, `product_type←breadcrumb`, `availability←inStock`, `count`, …).
- **Enrich the UI DTO where the PDP needs it** (variants, gallery, description, specs, reviews,
  live promotions) — the current flat DTO is minimal; add the fields the real PDP shows, reading
  the backend's storefront-shaped product read (not the thin ERP read).
- Wire `listRelated` / `listAlsoViewed` / `listNewArrivals` / `listByIds` to the backend's existing
  association readers / listing engine.
- Delete `src/data/*.json` mock + the static source. Home, category, PDP now show real catalog.

### Phase 3 — Wire the transactional UI to the backend's existing Server Actions
Replace the UI's `localStorage` stores with the backend's existing actions (same repo, direct import
— **no new endpoints**):
- **Cart** → `addToCartAction` / `setCartItemQuantityAction` / `removeCartItemAction` /
  `mergeGuestCartAction` + live cart pricing + the `gz.cart_token` cookie flow.
- **Favorites** → `toggleWishlistAction` / `getWishlistSlugsAction` (guest cookie + merge on login).
- **Checkout** → `placeOrderFromCartAction` / `placeQuickOrderAction`, delivery/tax/coupon/credit,
  the payment redirect + `/order/[id]?pay=return` confirmation (reuse the existing flow).
- **Account/auth** → the existing `customer.ts`/`auth.ts` actions + better-auth; reuse (or restyle)
  the backend's login/register/2FA/reset pages, or point the new account view at them.

### Phase 4 — Chrome, theme, SEO, metadata, tracking, media
- Finalize theme: the new UI's design tokens drive the storefront look; keep the DB-driven theme
  hooks only if desired (otherwise the UI tokens win — a presentation choice, not architecture).
- Reinstate JSON-LD + `generateMetadata` for the new pages (reuse the backend's `lib/seo` builders).
- Keep the **Kawn footer attribution** (contractual) and the existing `/category`→`/:slug`,
  `/product`→`/:slug` redirects. Media via `/cdn` + re-enable image optimization.
- Tracking/consent: keep the backend's existing providers wrapping the new chrome.

### Phase 5 — Feature-parity pass & cleanup (per the §Decision)
- For the ~40 non-overlapping routes: restyle to the new design, or leave on the current design, or
  drop — per your decision. Remove dead old-storefront components once nothing imports them.
- Final `pnpm typecheck` + `pnpm lint` + `pnpm build`; smoke-test the key flows.

---

## Decision I need to finalize the plan

**What happens to the ~40 current storefront features the new UI doesn't include** (auth pages,
blog, loyalty, B2B, order tracking, search, listings, legal/CMS pages)?

- **(Recommended) Keep them running, restyle progressively** — swap only the 7 routes the new UI
  provides now; the rest keep working on the current design and get the new look over later phases.
  The site stays 100% functional at every step.
- **Port them into the new design now** — larger Phase 5; nothing ships until they're rebuilt.
- **Drop them** — only if you truly want a catalog-only storefront (loses login, orders, blog, etc.).

---

## What does NOT change (your "no architecture changes" guarantee)

`src/modules/*`, `src/workflows/*`, `src/events/*`, `src/associations/*`, `src/lib/api/*`,
`src/lib/actions/*`, `src/app/api/*`, `src/app/admin/*`, `src/app/cdn|feeds|md|sitemap|robots`,
`src/instrumentation.ts`, the DB, auth, payments, cron. The backend is reused exactly as-is; we only
replace the storefront presentation and connect it to the existing plumbing.

Once you approve this plan (and pick the §Decision option), I'll execute phase by phase
autonomously, keeping the branch buildable and reporting at each phase boundary.

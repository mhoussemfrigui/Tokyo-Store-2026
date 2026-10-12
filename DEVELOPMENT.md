# Development guide

How to work on Tokyo Store without breaking the conventions that keep it
maintainable. Read the **[golden rules in the README](README.md#development-guide)**
first — this file is the long form: setup, the per-layer workflow, the
database workflow, the gotchas that have actually bitten us, and the pre-merge
checklist.

---

## 1. Prerequisites

- **Node.js 22+**
- **pnpm 9** (`corepack enable && corepack prepare pnpm@9.15.0 --activate`) —
  the **only** package manager. `pnpm-lock.yaml` is the lockfile (the
  Dockerfile installs with `--frozen-lockfile`); `package-lock.json` is
  gitignored, because an npm lockfile would resolve deps without the
  `pnpm.overrides` security floors (dompurify, undici, …). Never `npm install`.
- **Docker Desktop** (Postgres + SeaweedFS for the local stack)

## 2. First-time setup

```bash
pnpm install

# Postgres on :5434 (the tokyo-pgvector image, built from docker/pgvector on
# first run), SeaweedFS S3 gateway on :8333 (+ filer browser on :8888)
pnpm db:up

# Apply the schema (squashed baseline 0000 + the 0001..0138 migration chain)
pnpm db:migrate

# Optional: seed a starter catalogue (root categories + subcategories + brands)
pnpm db:seed:catalog

# Env defaults already point at the local stack
cp .env.example .env.local

pnpm dev
```

| URL                           | What                                                    |
| ----------------------------- | ------------------------------------------------------- |
| `http://localhost:3000`       | Storefront                                              |
| `http://localhost:3000/admin` | Admin (needs an RBAC grant — see §3)                    |
| `http://localhost:8888`       | SeaweedFS filer file browser (no login in dev)          |
| `pnpm db:studio`              | Drizzle Studio at https://local.drizzle.studio          |

## 3. Getting an admin account

On **every server boot** `instrumentation.ts` runs `ensureDefaultAdmin()`
([`src/lib/bootstrap/default-admin.ts`](src/lib/bootstrap/default-admin.ts)).
On a fresh database it creates **`admin@tokyostore.tn`** with a random password
and prints it **once** to the server log:

```
✨  DEFAULT ADMIN ACCOUNT CREATED
   email     : admin@tokyostore.tn
   password  : <random — copy it now>
```

So locally: run `pnpm dev`, copy the password from the console, sign in at
`/admin-login` (the staff portal; the same account also works at `/login` — it's
one account per email, and `/admin` is gated by RBAC), change it at `/account`.
The password is **never stored** — if you
miss it, use `/forgot-password` or delete the rows and restart:

```sql
DELETE FROM users WHERE email = 'admin@tokyostore.tn';
DELETE FROM app_secrets WHERE key LIKE 'DEFAULT_ADMIN_%';
```

**Fallback — no admin exists yet** (e.g. `DISABLE_DEFAULT_ADMIN=true` on a
fresh DB): set `ADMIN_BOOTSTRAP_TOKEN` (≥ 8 chars) in `.env.local`, register at
`/register`, then:

```bash
curl -X POST http://localhost:3000/api/admin/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"token":"<ADMIN_BOOTSTRAP_TOKEN>","email":"you@example.com"}'
```

The route is **one-shot**: it 404s while any active admin exists (enum `admin`
or an RBAC `*` holder), and it is burned for good as soon as an admin exists —
on the default-admin creation, on the first successful promotion, or on any
boot that finds an admin. Burning deletes the persisted token and records
`app_secrets.ADMIN_BOOTSTRAP_CLOSED`
([`default-admin.ts`](src/lib/bootstrap/default-admin.ts)), so there is nothing
to unset afterwards. On a DB where the default admin was created the route is
already closed; promote further staff from `/admin/users`. To re-open it after a
genuine lockout: `DELETE FROM app_secrets WHERE key='ADMIN_BOOTSTRAP_CLOSED';`
then restart. `DISABLE_DEFAULT_ADMIN=true` opts out of the auto-admin entirely.

## 4. Scripts

| Command                | Purpose                                                         |
| ---------------------- | -------------------------------------------------------------- |
| `pnpm dev`             | Dev server (Turbopack)                                         |
| `pnpm build`           | Production build — **webpack** (`next build --webpack`)        |
| `pnpm start`           | Run the built standalone server                                |
| `pnpm typecheck`       | `tsc --noEmit` — **the only local type gate** (`pnpm build` skips TS) |
| `pnpm lint`            | ESLint (flat config) — passes: exits 0 with no errors (warnings only). Keep it that way |
| `pnpm format`          | Prettier                                                       |
| `pnpm test:pure`       | DB-free tests (`test:pure:1` then `test:pure:2`) — see §6b     |
| `pnpm test:db`         | DB tests (`test:db:1` → `test:db:3`) — **run against a throwaway DB** (§6b) |
| `pnpm test`            | `test:db` then `test:pure`                                     |
| `pnpm gen:api-catalog` | Regenerate `src/lib/api-auth/internal-api-catalog.ts` + `event-catalog.ts` (their tests fail until you do after adding/renaming an exported server action or an event) |
| `pnpm db:up` / `:down` | Start / stop the Postgres + SeaweedFS compose stack                |
| `pnpm db:logs`         | Tail the local Postgres container logs                         |
| `pnpm db:generate`     | **Guarded — refuses** (snapshots frozen; hand-author migrations). `db:generate:force` overrides |
| `pnpm db:migrate`      | Apply pending migrations (drizzle ledger, idempotent)          |
| `pnpm db:push`         | **Guarded — refuses** (would offer to DROP the raw-SQL `app_secrets` / `rate_limit_buckets`). `db:push:force` = dev-only escape hatch |
| `pnpm db:init-secrets` | Initialise the `app_secrets` encryption material               |
| `pnpm db:studio`       | Drizzle Studio (web SQL inspector)                             |
| `pnpm db:seed:catalog` | Idempotent seed: categories + brands                           |
| `pnpm db:bench:catalog`| `EXPLAIN ANALYZE` benchmark of hot catalog queries             |

> The build uses **webpack**, not Turbopack (`next.config.ts` notes the
> OOM-avoidance reason). `typescript.ignoreBuildErrors` is `true`, so a type
> error will **not** fail `pnpm build` — `pnpm typecheck` is the real local gate.
> Run it before every handoff. (The Docker image runs `tsc --noEmit` as its own
> step after the bundle, so a type error *does* fail a Coolify deploy.)
>
> **Local build heap.** A local `pnpm build` can outgrow Node's default V8 heap
> (~4 GB on a 64-bit dev box). Observed 2026-09-23 (Windows, Next 16.2.6):
> `FATAL ERROR: Reached heap limit … JavaScript heap out of memory` about 80 s
> into "Creating an optimized production build" at the ~4 GB default; the same
> build compiled in ~2 min with a 6 GB ceiling:
> `NODE_OPTIONS=--max-old-space-size=6144 pnpm build` (PowerShell:
> `$env:NODE_OPTIONS="--max-old-space-size=6144"; pnpm build`). The
> Dockerfile's `NODE_BUILD_MEMORY=2048` default is commented "VERIFIED
> sufficient"; that claim predates this observation and has not been re-checked
> — see [docs/deployment-coolify.md](docs/deployment-coolify.md) (build memory).

---

## 5. Architecture map

Tokyo Store is a **modular monolith** — **39 domain modules** under
`src/modules/*` (catalog, order, payment, delivery, tax, loyalty, cms, media,
promotion, wishlist, ai, ai-assign, jobs, rbac, business, …).
The canonical
module specification + PR conformance checklist live in
[docs/modules.md](docs/modules.md); this is the working summary.

```
src/
  modules/<name>/         schema.ts · service.ts · queries.ts · index.ts
  associations/           cross-module join tables (product↔category, etc.)
  workflows/<domain>/     multi-step mutations (wrap in db.transaction)
  events/                 in-process event bus (types.ts + subscribers/)
  lib/
    actions/<domain>.ts   "use server" server actions (forms → workflows)
    db/                   client.ts · columns.ts · schema.ts (barrel) · migrate.ts · migrations/
    price.ts              money SSOT (millimes)
    tax/                  shared.ts (pure, client-safe) + index.ts (server)
    checkout/             delivery · shipping · copy · quick-buy-config
    payments/             gateway.ts + providers/{clictopay,flouci}.ts
    cache/tags.ts         cache-tag SSOT
  components/
    ui/select-field.tsx   the ONE dropdown component
    admin/ · storefront/
  app/
    (shop)/               storefront routes (server components + client islands)
    admin/                admin panel
    api/                  route handlers (webhooks, cron, bootstrap)
  instrumentation.ts      boot bootstrap (admin, system content pages, subscribers, schedulers, pool drain)
```

**Layering rule:** `service.ts` is single-module (never import another
module's service). Cross-module orchestration happens in a **workflow**. Pages
read through `queries.ts`; pages never write — mutations go through a workflow
called from a server action.

### Adding a feature — the order to work in

1. **Schema** — edit `modules/<x>/schema.ts`, **and** re-export it from the
   [`src/lib/db/schema.ts`](src/lib/db/schema.ts) barrel (see §6 — a missed
   export silently hides the table from drizzle-kit).
2. **Hand-author** the migration SQL + a `meta/_journal.json` entry
   (`pnpm db:generate` is guarded — see §6), then `pnpm db:migrate`.
3. **Service** — CRUD in `modules/<x>/service.ts`.
4. **Queries** — shaped/aggregate reads in `modules/<x>/queries.ts`.
5. **Workflow** — orchestration in `workflows/<x>/<action>.ts`, wrapped in
   `db.transaction()`; emit a typed event **after** commit.
6. **Event** — register it in `src/events/types.ts`; payloads carry IDs only.
7. **Server action** — `src/lib/actions/<domain>.ts`:
   `requirePermission(module, action)` (RBAC, 404 on deny) /
   `requireSession()` first, return `ActionState`, `revalidatePath()` /
   `revalidateTag()` the affected routes. A new exported action also needs
   `pnpm gen:api-catalog`.
8. **Admin UI** — `app/admin/<feature>/page.tsx` (server, `requirePermission`
   first) + a `*-panel.tsx` client island; image fields use `<MediaPicker>`.
   `useActionState` forms pass `onSubmit={useNoResetSubmit(formAction, state)}`
   next to `action={formAction}`
   ([`form-tabs.tsx`](src/components/admin/_components/form-tabs.tsx)) — React 19
   otherwise resets every `<form action={fn}>` after its action, even on
   `{ ok: false }`, wiping what the operator typed. The sidebar is `NAV_GROUPS`
   in [`admin-shell.tsx`](src/app/admin/_components/admin-shell.tsx); each item
   is shown only to holders of its module grant.
9. **Storefront UI** — server component reads via `queries.*`, client islands
   only for interactivity.

---

## 6. Database workflow (the part to get right)

The migration history begins with a **squashed baseline**:
[`src/lib/db/migrations/0000_squash_baseline.sql`](src/lib/db/migrations/0000_squash_baseline.sql),
followed by the live numbered chain **`0001`..`0138`** (139 `.sql` files incl.
the `0000` baseline, `meta/_journal.json` entries idx 0–138; the next migration
is **`0139`**). The most recent entries are `0134` (index + $type CHECK hygiene),
`0135` (status/kind CHECKs + drop a dead index), `0136` (PDP review covering
index), `0137` (categories composite (parent_id, display_order) index), `0138`
(brand parity — brands.display_order + is_discountable + the tax-rate CHECK).
Older notable entries: `0121` (drops the serial-number subsystem), `0122`
(low-stock dashboard index), `0123` (purges `role_permissions` rows whose key
left the RBAC registry), `0124` (creates `pg_stat_statements` — only where the
server preloads it, e.g. the Coolify compose; a no-op NOTICE on dev/test DBs)
and `0125` (drops two redundant prefix indexes + backfills the release of
legacy soft-deleted products' variants).
The squash folded the *pre-`0000`* history into the baseline; the
chain continues from there. The baseline carries everything drizzle
can't model: the extensions (`pgcrypto`, `pg_trgm`, `btree_gin`, `unaccent`;
`vector` comes later from `0112` and needs the pgvector image),
the `uuid_generate_v7()` function, the `fr_unaccent` text-search config, the
raw-SQL tables (`app_secrets`, `rate_limit_buckets`), the generated
`search_vector` tsvector columns, every FK + CHECK (all **VALID**), and the
functional / partial / BRIN / trigram indexes.

### To change the schema

1. Edit the module's `schema.ts`.
2. **Re-export the module from [`src/lib/db/schema.ts`](src/lib/db/schema.ts).**
   drizzle-kit only reads that barrel — a table that isn't re-exported is
   invisible to it (this is exactly how the `tax` table went
   unmanaged before the squash).
3. **Hand-write the migration SQL.** `pnpm db:generate` is **guarded/disabled**:
   the drizzle meta-snapshot chain is frozen at `0007`, so generate would diff
   against stale state and emit a destructive migration. Instead create
   `src/lib/db/migrations/NNNN_name.sql` (statements separated by
   `--> statement-breakpoint`; prefer idempotent `IF [NOT] EXISTS` / guarded
   `DO $$ … $$`) and add a matching entry to `migrations/meta/_journal.json`
   (`idx`, `version: "7"`, `when`, `tag` = filename without `.sql`,
   `breakpoints: true`). **`when` must be strictly greater than the previous
   entry's `when`** — the drizzle migrator only runs an entry whose `when` is
   newer than the last applied row, so an equal or smaller value is *silently
   skipped* on every already-migrated DB (prod, your dev DB) while a fresh DB
   applies it. The hand-picked values run ahead of the wall clock (the last,
   `0130`, is `1790800000000`), so `Date.now()` can be too small — use the
   previous `when` + `100000000`. Guarded by
   `src/lib/db/tests/migration-journal.test.ts` (pure: file ↔ entry parity,
   contiguous `idx`, strictly increasing `when`).
4. **Add FKs and CHECK constraints in the migration SQL.** Convention:
   `schema.ts` does not use `.references()`; foreign keys live in migration
   SQL. (The one legacy exception is the Better Auth tables in
   `modules/auth/schema.ts` — `sessions` / `accounts` / `two_factors` →
   `users` — don't copy it.)
5. `pnpm db:migrate`.
6. Keep the Drizzle schema (the barrel) matching what the SQL creates — it stays
   the source of truth. (Escape hatch, only after rebuilding the snapshot chain:
   `pnpm db:generate:force`.)

In short: use the next index (`0139_...`), add a matching entry to
`meta/_journal.json`
(`{ idx, version: "7", when: <previous when + 100000000>, tag, breakpoints: true }`),
and separate statements with `--> statement-breakpoint`.

The migrator (`src/lib/db/migrate.ts`, also bundled as the container's
`db-runner/migrate.cjs`) holds a **session** advisory lock and session-level
timeouts for the whole run, so it must reach Postgres **directly**: it uses
`MIGRATION_DATABASE_URL` when set, else `DATABASE_URL`. With the dev pooler
profile (`DATABASE_URL` on PgBouncer `:6432`), set
`MIGRATION_DATABASE_URL=postgresql://tokyo:tokyo_dev_pwd@localhost:5434/tokyo`
(the direct `:5434` URL; `init-secrets` uses it too).

### Rules for migrating a database that already has data

The greenfield baseline uses plain enforced constraints. Once there's real
data, a migration that adds constraints/indexes to a live table must be
non-blocking:

- `ADD CONSTRAINT ... NOT VALID` for FKs/CHECKs (enforces new rows, skips the
  legacy scan, can't fail the deploy), preceded by `DROP CONSTRAINT IF EXISTS`.
- `CREATE INDEX IF NOT EXISTS` (and `CONCURRENTLY` only outside a transaction).
- **Dedup first, then add a unique index.**
- Purges: batched `DELETE ... WHERE id IN (SELECT ... LIMIT n)` loops — never a
  single `DELETE ... RETURNING` over a year of rows.

### Non-negotiables

- **Never edit an applied migration** — add a new one.
- **`*_cents` columns hold integer millimes** (legacy name). Never rename them,
  never assume ×100. See §7.
- **Every PK is uuid v7** via `id()` in
  [`src/lib/db/columns.ts`](src/lib/db/columns.ts). Don't hand-roll a default.
- `app_secrets` and `rate_limit_buckets` are **raw-SQL tables** accessed via
  `db.execute(sql\`...\`)` — deliberately not in the drizzle graph. Leave them
  there.
- `search_vector` columns + the `fr_unaccent` config live **only** in the
  baseline SQL (drizzle can't express generated tsvector columns).

### 6b. Tests

Every test is a standalone `tsx` script in `src/lib/db/tests/*.test.ts`
(prints ✓/✗, exits non-zero on failure — no test framework). Two chains:

- **`test:pure`** — DB-free (`tsx --conditions=react-server …`); currently 104
  files in `test:pure:1` + `test:pure:2`.
- **`test:db`** — needs a live, fully migrated DB (`tsx
  --conditions=react-server --env-file-if-exists=.env.local …`); currently 115
  files in `test:db:1` + `test:db:2` + `test:db:3`.

The chains are **split into numbered sub-scripts** because Windows runs package
scripts through `cmd.exe`, which rejects a command line over ~8191 characters
("The command line is too long"). **Append a new test to the LAST sub-script of
its chain** (`test:pure:2` / `test:db:3` today); when that script nears 6000
characters, start the next one (`test:db:4`) and add it to the parent
(`"test:db": "pnpm run test:db:1 && … && pnpm run test:db:4"`).
`test-chain-integrity.test.ts` (in `test:pure`) fails on a file wired into no
chain, a reference to a missing file, a file in both chains or listed twice, a
script over 7500 characters, or a sub-script its parent never runs.

**Run `test:db` against a throwaway database**, never your dev data: many DB
tests write fixtures, and several register the event subscribers
(`registerAllSubscribers`), so mail-sending flows go through whatever provider
`.env.local` configures — hence `EMAIL_PROVIDER=console` below. Recipe (the
pgvector image is built by `pnpm db:up`; migrations `0112`+ need it):

```bash
docker run -d --name tokyo-test-db -e POSTGRES_USER=tokyo \
  -e POSTGRES_PASSWORD=tokyo_dev_pwd -e POSTGRES_DB=tokyo \
  -p 5439:5432 tokyo-pgvector:16.14-alpine
export DATABASE_URL=postgresql://tokyo:tokyo_dev_pwd@localhost:5439/tokyo
export EMAIL_PROVIDER=console      # never send real mail from tests
pnpm db:migrate                    # fresh 0000 → 0138
pnpm test:db                       # or: pnpm test (db + pure)
docker rm -f tokyo-test-db
```

Exported/inline variables win over `.env.local` (Node's `--env-file` never
overrides a variable that is already set), so `.env.local` still supplies
`BETTER_AUTH_SECRET` (≥ 32 chars) and the `S3_*` values. If your `.env.local`
sets `MIGRATION_DATABASE_URL`, override or unset it too — the migrator prefers
it over `DATABASE_URL`. Single file:
`pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local src/lib/db/tests/<name>.test.ts`.

On Windows, a test that uses `sharp` must not `process.exit()` right away (libuv
`UV_HANDLE_CLOSING` abort, exit 127): call `sharp.cache(false)` and exit on a
short timer, as `media-safety-db.test.ts` does.

---

## 7. Money — integer millimes

1 TND = **1000 millimes**. There is no floating point and no "cents".

- [`src/lib/price.ts`](src/lib/price.ts) is the **single** source of scale +
  formatting (`MINOR_PER_DINAR = 1000`, `formatMoney`, `formatCents`,
  `minorToDinars`, `dinarsToMinor`, …). Never format money anywhere else.
- DB columns named `*_cents` **store millimes** — the name is legacy. Read them
  as "integer minor units".
- Admin price **inputs** take dinars and convert at the edge via
  `dinarsToMinor`. Display precision is the `price.decimals` setting
  ([`src/lib/price-format.ts`](src/lib/price-format.ts) + the `useMoney` client
  hook).
- Payment gateways use millimes natively, so `toGatewayMinor` /
  `fromGatewayMinor` are identity functions — don't "helpfully" rescale them.

---

## 8. The server/client boundary (this broke a deploy — read it)

Modules that touch the DB, secrets, or `react`'s `cache` start with
`import "server-only"`. A `"use client"` component that imports such a module
**fails the production build** (`webpack` errors: *"You're importing a module
that depends on server-only"*) — even though `pnpm dev` and `pnpm typecheck`
let it through.

The fix pattern, used by the tax engine: split the module into a **pure half**
that any component can import and a **server half** that re-exports it:

- [`src/lib/tax/shared.ts`](src/lib/tax/shared.ts) — types, constants, pure
  math/formatting. **No** `server-only`. Client forms import from here.
- [`src/lib/tax/index.ts`](src/lib/tax/index.ts) — `import "server-only"`,
  `export * from "./shared"`, plus the DB-backed `getTaxConfig()`. Server code
  imports from `@/lib/tax`.

Rule of thumb: if a client component needs a helper, the helper must live in a
file with no `server-only` import. `import type { … }` from a server module is
fine (types are erased) — runtime imports are not.

---

## 9. Commerce subsystems — where to touch what

Everything routes through one resolver/SSOT per concern. Don't re-implement;
extend these.

| Concern        | Source of truth                                                     | Admin                       |
| -------------- | ------------------------------------------------------------------- | --------------------------- |
| Order total    | [`workflows/order/place-order.ts`](src/workflows/order/place-order.ts) — `max(0, subtotal − discount + shipping + taxAdd[ht only])` (`discount` = coupon + member/niveau discount, clamped ≤ subtotal) | —                           |
| Payments       | [`lib/payments/gateway.ts`](src/lib/payments/gateway.ts) + `providers/*` (ClicToPay / Flouci / COD) | `/admin/system/payments`    |
| Delivery       | [`lib/checkout/delivery.ts`](src/lib/checkout/delivery.ts) `resolveDelivery` (home / drive-by / in-store; agents + pickup locations) | `/admin/system/delivery`    |
| Tax (TVA)      | [`lib/tax`](src/lib/tax) — product → rule → brand → category → global cascade; `disabled`/`ttc`/`ht` modes | `/admin/system/tax` + per-product/category |
| Loyalty        | **tiers-only « Le Cercle de Famille »** — `loyalty_levels` niveaux resolved from `customer_profiles.cumulative_spend_cents` + `.paid_order_count` (`levelForSpend`), denormalized onto `.loyalty_level_id`; accrual in [`lib/loyalty/accrue-spend.ts`](src/lib/loyalty/accrue-spend.ts); `loyalty_bons` engagement vouchers; per-level `early_access_delay_days` staggers new-product visibility (storefront-browse only — see `lib/loyalty/early-access.ts`). No points ledger/redemption | `/admin/marketing/loyalty`  |
| Promotions     | [`modules/promotion`](src/modules/promotion) (product/category/brand/coupon/URL) + redemptions | promotions admin            |
| AI & automation | [`lib/ai`](src/lib/ai) (provider config + task/prompt catalog) + [`modules/ai`](src/modules/ai) (key/prompt overrides), [`modules/ai-assign`](src/modules/ai-assign) (auto-categorize / brand / attribute), [`modules/jobs`](src/modules/jobs) (run log) — content gen, related-product + synthetic-review generation, internal scheduler | `/admin/system/ai` + `/admin/system/jobs` |

Guest orders are first-class: the admin orders list has an **Invité** filter +
badge, and `linkGuestOrderWorkflow` attaches a guest order to a customer with
an atomic `WHERE user_id IS NULL` guard.

---

## 10. CMS & content rules

- **No hardcoded storefront copy.** Labels/headings are CMS settings
  ([`modules/cms/setting`](src/modules/cms/setting)) and render
  hide-when-unset. Typing French copy into a component is a bug.
- **One dropdown component:** [`components/ui/select-field.tsx`](src/components/ui/select-field.tsx)
  (`SelectField` client listbox + `NativeSelect` for no-JS GET forms).
- **All images go through the médiathèque** (`<MediaPicker>`); the CDN base is
  `media_settings.cdn_base_url` → `MEDIA_CDN_URL` env → same-origin `/cdn`.
- Internal links use the link-target module
  ([`lib/links`](src/lib/links)); the page builder
  (`pages` → `page_sections` → subtype tables) is fully relational with CASCADE
  FKs. See [docs/cms-content-model.md](docs/cms-content-model.md).

---

## 11. Runtime constraints & gotchas

- **PgBouncer transaction pooling in prod** — no session-level Postgres in app
  code: no `LISTEN/NOTIFY`, no session `SET`, no session advisory locks
  (transaction-scoped `pg_advisory_xact_lock`, as used by the mail drain and the
  import single-flight, is fine). Cross-module signalling goes through the
  in-process event bus ([`src/events`](src/events)). Per-connection timeouts
  ride on the libpq startup packet (`statement_timeout` + `-c` options, which
  the pooler ignores), backed by role-level `lock_timeout` /
  `idle_in_transaction_session_timeout` defaults (migration `0117`) and the
  client-side `query_timeout`. (`migrate.ts`'s session advisory lock is fine —
  it runs on the direct `MIGRATION_DATABASE_URL`, see §6.)
- **No pool reads inside a transaction.** Inside a `db.transaction(async (tx)
  => …)` callback, pass `tx` down; a nested `db.*` call waits for a *second*
  pool connection while the tx holds one plus its row locks, which deadlocks
  the pool at pool-max concurrency (guarded by `tx-pool-reentrancy.test.ts`).
- **Long statements:** the pool caps every query at `DB_STATEMENT_TIMEOUT_MS`
  (10 s) server- *and* client-side, so a bare `SET LOCAL statement_timeout` is
  still cut by the client `query_timeout`. Legitimately long jobs use
  `withLongStatement(ms, fn)` from [`src/lib/db/client.ts`](src/lib/db/client.ts).
- **Store time zone:** server components and subscribers run in the container's
  UTC. Printed/fiscal dates (facture, avoir, BL, reçu) and SAV dates go through
  `formatStoreDate` / `formatStoreDateTime`
  ([`src/lib/time/store-tz.ts`](src/lib/time/store-tz.ts), Africa/Tunis) —
  never a bare `toLocaleDateString`.
- **Soft deletes:** `deleted_at IS NULL` = live. Queries must filter it; the
  partial indexes assume it.
- **Cache:** invalidate via the tags in [`lib/cache/tags.ts`](src/lib/cache/tags.ts)
  (`revalidateTag`), not ad-hoc strings.
- **Admin APIs return 404, not 403**, on unauthorised — don't leak existence.
- **Dynamic `[id]` routes** validate with `isUuid()` (`@/lib/utils/uuid`)
  before any query that casts to `uuid`.
- **Retention:** `POST /api/cron/retention` (Bearer `CRON_SECRET`) batch-purges
  the 15 targets of the `RETENTION_TARGETS` inventory
  ([`src/lib/retention/windows.ts`](src/lib/retention/windows.ts) — the purge,
  the admin cards and the job description all derive from it; a new purge
  target is added there, `retention-inventory.test.ts` checks the wiring). The
  `search_log` / `audit_log` windows come from settings (`search.purge_months`,
  `audit.retention_months`) and those two purges are **skipped** when the
  settings read fails (fail closed). Wire it as a daily Coolify scheduled task;
  the full cron list (7 routes, incl. `/api/cron/webhooks`) is in
  [docs/deployment-coolify.md §12](docs/deployment-coolify.md).

---

## 12. Pre-merge checklist

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm lint` exits 0 (no errors).
- [ ] `pnpm test:pure` green; `pnpm test:db` green on a throwaway DB (§6b). New
      test files appended to the LAST sub-script of their chain.
- [ ] `pnpm gen:api-catalog` re-run if you added/renamed an exported server
      action or an event.
- [ ] `pnpm build` succeeds (catches server-only-in-client — see §8; raise the
      heap if it OOMs locally — see §4).
- [ ] Migration SQL + `meta/_journal.json` entry added by hand (`db:generate` is guarded — don't run it), with a `when` strictly greater than the previous entry's; schema barrel matches.
- [ ] New schema module re-exported from the `schema.ts` barrel.
- [ ] FKs/CHECKs added in migration SQL, not `.references()`.
- [ ] No cross-module service import in `service.ts`.
- [ ] Mutations go through a workflow; pages don't write.
- [ ] New events typed in `EventMap`; payloads carry IDs only.
- [ ] Admin pages + actions call `requirePermission(module, action)`; admin APIs 404 on unauthorised.
- [ ] Money via `@/lib/price`; no inline `*100` / `/100`.
- [ ] No hardcoded storefront copy; image fields use `<MediaPicker>`.
- [ ] Docs updated if a new module/rule was introduced.

The deep version is the conformance checklist in
[docs/modules.md](docs/modules.md).

---

## 13. Debugging

- **Email not arriving?** With `EMAIL_PROVIDER=console` the body prints to the
  dev log — look for `─── ✉  EMAIL` markers. A provider an admin explicitly
  picked in Système → Mailing (`/admin/marketing/mailing`) → Réglages overrides `EMAIL_PROVIDER`
  (re-selecting the env value reverts to it).
- **Migration won't apply / DB wedged?**
  `docker compose -f docker-compose.dev.yml down -v && pnpm db:up && pnpm db:migrate`
  for a clean slate (there's no important local data).
- **Type errors after a schema change?** Types are inferred directly from your
  `schema.ts` edits — make sure the module is re-exported from the `schema.ts`
  barrel and restart the TS server. (`db:generate` is guarded; it doesn't emit
  types.)
- **Build cache weirdness?** `rm -rf .next` and rebuild. After deleting a
  route, a stale `.next/types/**` file can make `pnpm typecheck` fail with
  TS2307 — run `pnpm exec next typegen` (or delete the stale dir).
- **`pnpm start` refuses to boot locally?** With `NODE_ENV=production` the env
  guard ([`src/lib/env.ts`](src/lib/env.ts)) rejects a localhost
  `DATABASE_URL`, a localhost or non-`https` `BETTER_AUTH_URL` /
  `NEXT_PUBLIC_SITE_URL`, the dev SeaweedFS keys and a weak `BETTER_AUTH_SECRET`
  (prod: ≥ 40 chars, ≥ 16 distinct); a localhost/private `S3_PUBLIC_URL` only
  logs a warning. Intended — don't bypass it; use `pnpm dev` locally.
- **Upload fails?** The `tokyo` bucket auto-creates on the first upload; browse
  the SeaweedFS filer at `http://localhost:8888` to confirm objects landed.

## 14. Local ports

| Service          | Host | Container | Why                   |
| ---------------- | ---- | --------- | --------------------- |
| Next.js          | 3000 | —         | App                   |
| Postgres         | 5434 | 5432      | avoid 5432 collision  |
| PgBouncer        | 6432 | 5432      | `--profile pooler` (keep `MIGRATION_DATABASE_URL` on 5434) |
| SeaweedFS S3     | 8333 | 8333      | S3 API (`S3_ENDPOINT`) |
| SeaweedFS filer  | 8888 | 8888      | file browser          |

For deployment see [docs/deployment-coolify.md](docs/deployment-coolify.md)
and [docs/deploy-runbook.md](docs/deploy-runbook.md).

---

Built by **[Kawn Digital Studio](https://kawn.me)** for Tokyo Store. See [CREDITS.md](CREDITS.md).

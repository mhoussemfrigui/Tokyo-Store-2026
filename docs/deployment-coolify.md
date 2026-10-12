# Deployment — Coolify

Tokyo Store deploys two ways on Coolify. Pick one.

## Path A — One Docker Compose file (recommended for first deploy)

Single resource, single paste. Everything (app + Postgres + SeaweedFS object
storage) comes up together. No manual resource wiring.

1. Coolify → New Resource → **Docker Compose**.
2. Paste the contents of [`docker-compose.coolify.yml`](../docker-compose.coolify.yml).
3. Coolify parses it and shows the env vars as form fields. Fill in:
   - `PUBLIC_URL` — `https://setup.tokyostore.tn` (the public URL of your
     app)
   - `EMAIL_PROVIDER` + provider creds (`resend` / `smtp` / `internal` /
     `console`)
   - `CRON_SECRET` (≥ 16 chars) — then wire the scheduled tasks of §12–§12f
   - That's it. The Postgres password, the SeaweedFS S3 keys
     (`SERVICE_USER_SEAWEEDFS` / `SERVICE_PASSWORD_SEAWEEDFS`), the Better Auth
     secret, and the bootstrap token all auto-generate (`MIGRATION_DATABASE_URL`
     is fixed by the compose to the direct `postgres:5432`).
   - `SEAWEEDFS_PUBLIC_URL` is OPTIONAL — media is served through the app's own
     same-origin `/cdn` proxy by default, so the object store needs no public
     domain. Only set it (+ the matching Build Arg, step 5) if you deliberately
     serve media from a dedicated storage domain.
4. In the resource settings, add the app domain:
   - `setup.tokyostore.tn` → service `app` on port 3000.
   - (Optional) a media domain → service `seaweedfs` on port 8333, only if you
     set `SEAWEEDFS_PUBLIC_URL` above.
5. In **Build Arguments**, add `NEXT_PUBLIC_SITE_URL=https://setup.tokyostore.tn`
   (must match `PUBLIC_URL` — Next.js bakes it at build time). If you set
   `SEAWEEDFS_PUBLIC_URL`, add `S3_PUBLIC_URL=<that>/tokyo` here too.
6. Click **Deploy**.

What happens on first boot:
- Postgres comes up → app waits for it.
- SeaweedFS comes up healthy (its entrypoint renders the S3 identities config
  from the generated keys). The `tokyo` bucket auto-creates on the first upload.
- App entrypoint runs migrations → auto-generates secrets → auto-creates
  the default admin → prints credentials to the container log.

Open the app container log, find the boxed credentials, sign in at
`https://setup.tokyostore.tn/admin-login` (the staff portal, or your secret
`ADMIN_LOGIN_PATH`; the same account also works at `/login` — `/admin` is
RBAC-gated either way), change the email/password under `/account`. Done.

The SeaweedFS storage (uploads + variants) lives in the `seaweedfs_data` named
volume on **your** VPS — there's no AWS, no SaaS, nothing external. The
`S3_*` env names are just because SeaweedFS speaks the S3 protocol.

### Why Path A is simpler

- One resource → one Deploy button → one place to roll back from.
- Coolify auto-generates and persists passwords for any `${SERVICE_PASSWORD_*}`
  reference in the compose. You never run `openssl rand`.
- The whole stack can also be run locally with one command
  (`docker compose -f docker-compose.coolify.yml --env-file .env up`) so
  what you test is what deploys.

### When to prefer Path B (separate resources)

- You want independent backup schedules / monitoring / scaling for the DB.
- You want to upgrade Postgres versions through Coolify's database UI.
- You want PgBouncer in front of Postgres (Path A has it under a profile,
  but a dedicated resource gives finer control).

## Path B — Separate resources (more control)

This is the original three-resource workflow: a Postgres database, a
SeaweedFS storage, and an Application — each provisioned individually. Use
this once you're past MVP and want fine-grained ops controls.

## Prerequisites (both paths)

- A Coolify instance reachable on the public internet
- A domain pointed at it (e.g. `tokyostore.tn`)
- SSH access to the Coolify host (for first-time bootstrap)

## Pre-flight: what's been verified locally

Before the runbook below, the full stack was exercised in Docker against
the same `Dockerfile` Coolify will use. Last verification (May 2026,
after the bug sweep) — all 14 batches green.

### Functional matrix

| Surface | Count | Result |
| --- | --- | --- |
| Storefront public pages (home, about, help, login, register, forgot-pwd, reset-pwd, verify-email, blog, 5 legal, sitemap, robots) | 16 | 200 ✓ |
| Storefront category pages (luxury, sport, classic, smartwatches, accessories, marques) | 6 | 200 ✓ |
| Non-existent slug `/category/...`, `/product/...` | 2 | 404 ✓ |
| `/account` anonymous | 1 | 307 → /login ✓ |
| Public APIs (health, categories, products, products?category=…, search FTS, search +fuzzy, search +suggest) | 7 | 200 ✓ |
| Auth APIs (get-session, ok, sign-up, sign-in, sign-out, request-password-reset, reset-password, verify-email) | 8 | all behaviours correct ✓ |
| Admin pages **anonymous** (39 routes incl. dynamic IDs) | 39 | 307 ✓ |
| Admin pages **authed** (dashboard, users, catalog ×3, cms ×5, blog ×2, media ×2, orders, all edit pages by id) | 19 | 200 ✓ |
| Admin pages with malformed UUID (`/products/new`, `/categories/abc`, …) | 6 | 404 ✓ (was 500 pre-fix) |
| Admin APIs anonymous (`GET /api/admin/media`, `POST /api/admin/media/upload`, `POST /api/admin/bootstrap`) | 3 | 404 ✓ no leak |
| Admin APIs authed (list, by ids, upload, bootstrap variants) | 8 | all correct ✓ |
| Bootstrap variants (ok, wrong token, short token, malformed email, missing user) | 5 | 200/404/400/400/404 ✓ |
| Media upload (valid PNG, wrong MIME, oversized 12MB) | 3 | 200/400/400 ✓ (was 500 on oversize) |
| Media settings toggle: AVIF + keep_original | 1 | 3 variants in SeaweedFS ✓ |
| Product CRUD round-trip (create, publish toggle, soft-delete reflected on storefront) | 3 | ✓ |
| Webhooks (Flouci GET/POST + ClicToPay GET/POST, both API-verified) | — | confirm via gateway API; no HMAC |

### Security matrix

| Check | Result |
| --- | --- |
| HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy on every page | ✓ all present |
| Session cookies: `__Secure-` prefix + `HttpOnly` + `SameSite=Lax` + 7-day rotation | ✓ |
| Anti-enumeration: duplicate signup returns plausible success, single DB row (and, since 2026-09, creates nothing at all: no profile, customer link or welcome email to the real owner) | ✓ |
| Anti-enumeration: bad password / unknown user — both return generic 401 | ✓ |
| Bad token bootstrap returns 404 (not 401/403 — no leak that the endpoint exists) | ✓ |
| Admin gate: 39/39 admin paths anonymous → 307 | ✓ |
| Admin APIs anonymous: 3/3 → 404 (no leak) | ✓ |
| SQLi probes (`' OR 1=1 --`, `UNION SELECT`, `; DROP TABLE`, `<script>`) on `/api/store/search` | 4/4 → 200 `[]` ✓ |
| Long input: 5000-char search query | 200 ✓ no DoS |
| Unicode + emoji search | 200 ✓ (emoji even matched a product) |
| Path traversal probes on the object-store public URL (`/../etc/passwd` variants) | 400/403 ✓ |
| Bad UUID in admin pages (`/admin/.../<not-a-uuid>`) | 404 ✓ |
| Bad UUID in admin API (`?ids=bad,$valid,bad`) | 200 returning only valid ✓ |
| Invalid date cursor on admin media | 200 (silent fallback) ✓ |
| Malformed JSON / empty body / null token on bootstrap | 400 ✓ |
| Webhook bad signature with secret configured | 401 ✓ |

### Performance (warm, prod image)

| Endpoint | p50 | p99 |
| --- | --- | --- |
| `/api/health` | 6 ms | 7 ms |
| `/` (home, cached) | 6 ms | 8 ms |
| `/api/categories` | 9 ms | 10 ms |
| `/api/store/search` (FTS) | 9 ms | 10 ms |
| `/api/store/search` (fuzzy) | 9 ms | 10 ms |
| `/api/products?category=luxury` | 10 ms | 17 ms |
| `/blog` | 15 ms | 19 ms |
| `/api/products` (all, 50 mapped) | 80 ms | 88 ms (N+1) |
| `/category/[slug]` | 90 ms | 103 ms (N+1) |
| 50 concurrent `/api/store/search` | wall 1.33 s, 0 errors | p99 35 ms |

EXPLAIN ANALYZE on the two hottest queries:
- listing (`products_published_recent_idx`) → 0.142 ms
- FTS (`products_search_gin`) → 0.167 ms

Container idle resources: app 172 MB / 0.02% CPU, postgres 78 MB / 0.01%, SeaweedFS 96 MB / 0.03%.

### Bugs found + fixed during the sweep

| # | Surface | Before | After | Fix |
| --- | --- | --- | --- | --- |
| 1 | `next.config.ts` baking `NEXT_PUBLIC_SITE_URL` | sitemap showed `localhost:3000` regardless of runtime env | unchanged — Coolify users must set `NEXT_PUBLIC_SITE_URL` as a **build arg** (see §3 below); the bake is a Next.js convention | docs-only |
| 2 | `/api/products?category=<slug>` with malformed `product_categories.product_id` row | 500 | 200 (bad rows silently dropped) | `isUuid` filter in `productCategoryLinks.listProductIdsInCategory` |
| 5 | `/admin/.../new` (URL pattern doesn't exist by design) | 500 | 404 | UUID guard at top of every `[id]/page.tsx` via shared `isUuid` |
| 6 | `POST /api/admin/media/upload` with >10 MB body | 500 (Next.js `formData()` throws) | 413 friendly | try/catch around `request.formData()` + bump `experimental.proxyClientMaxBodySize=16mb`. The `/admin/media` dropzone and the catalogue import now upload through Server Actions, capped by `experimental.serverActions.bodySizeLimit` = the same `16mb` (`SERVER_ACTION_BODY_LIMIT`, `src/lib/config/next-runtime.ts`) |
| 7 | `GET /api/admin/media?ids=not-a-uuid` | 500 | 200 (bad UUIDs dropped) | `.filter(isUuid)` in the route |
| 8 | Console email "link:" extracted HTML doctype URL | `http://www.w3.org/...` | real verify URL | regex now matches `<a href="http..."` and skips known non-app domains |
| 9 | `GET /api/admin/media?cursor=not-a-date` | 500 | 200 (cursor silently ignored) | validate `Date.getTime()` in `mediaService.list` |

### Known gaps still pending (not bugs — documented stubs)

- `/admin/cms/pages/new`, `/admin/cms/faq/new`, `/admin/cms/settings/new`, `/admin/blog/categories/new` — no individual `/new` routes (creation is **inline on the list page** via the `<Plus> Nouveau …` button). These return 404, which is correct. (The user detail page has since shipped at `/admin/users/<id>`.)
- ~~`/cart`, `/checkout`, `/search` storefront pages~~ — since shipped: the cart lives at `/panier`, checkout at `/checkout`, and the dedicated search page at `/recherche`.
- N+1 on `/category/[slug]` and `/api/products` — `mapProductRow` does ~6 sub-queries per row. Already tracked as a spawned task. Not blocking; PgBouncer + `'use cache'` directives mitigate in prod.

## 1. Provision Postgres

In Coolify:

1. New Resource → Database → PostgreSQL 16.
2. Name: `tokyo-postgres`.
3. Note the credentials and the internal hostname Coolify exposes
   (typically `tokyo-postgres-<id>`).
4. Connection string for the app:
   `postgresql://<user>:<pwd>@tokyo-postgres-<id>:5432/<db>`

> **⚠️ The image must ship pgvector.** Migration `0112_product_embedding` runs
> `CREATE EXTENSION vector`; the stock `postgres:16-alpine` image does not have
> it, so the boot migrator aborts there and the app never starts. Run the DB on
> an image with pgvector — the repo's
> [`docker/pgvector/Dockerfile`](../docker/pgvector/Dockerfile)
> (`postgres:16.14-alpine` + pgvector 0.8.0, a drop-in over an existing Alpine
> data volume: same collation, no reindex) is what Path A builds. Swap the DB
> image **before** the app deploy that carries `0112`. For slow-query
> statistics, also start it with `shared_preload_libraries=pg_stat_statements`
> (see [Database health checklist](#database-health-checklist)).

## 2. Provision SeaweedFS

Unlike MinIO, SeaweedFS is **not** a first-class Coolify "Storage" resource
type — it ships as a service **inside the compose stack** (Path A already
includes it). If you are doing the split-resource Path B, deploy it as its own
small Docker Compose resource using the `seaweedfs` service from
[`docker-compose.coolify.yml`](../docker-compose.coolify.yml):

1. New Resource → **Docker Compose** → paste just the `seaweedfs` service (+ the
   `seaweedfs_data` volume). Name it `tokyo-seaweedfs`.
2. Set `SERVICE_USER_SEAWEEDFS` / `SERVICE_PASSWORD_SEAWEEDFS` (Coolify
   auto-generates `SERVICE_PASSWORD_*`) and `S3_BUCKET=tokyo`. The service's
   entrypoint renders the S3 identities config from these — an authenticated
   "app" writer identity + an "anonymous" read-only identity on the bucket.
3. No console, no manual bucket step: the `tokyo` bucket **auto-creates on the
   first upload**, and anonymous read (for the app's `/cdn` proxy) is granted by
   the rendered config — not a runtime policy.
4. The S3 API is on port `8333`. A public domain is only needed if you serve
   media from a dedicated storage host (`SEAWEEDFS_PUBLIC_URL` + the matching
   `S3_PUBLIC_URL` build arg); otherwise the app's same-origin `/cdn` proxy
   reaches it internally at `http://tokyo-seaweedfs:8333`.

### Persistence across redeploys (critical)

SeaweedFS stores everything (master + volume + filer metadata + objects) under
`/data`, backed by the **named volume `seaweedfs_data`**, which survives
container restarts AND redeploys.

- Verify the mount in Coolify → the resource → Volumes tab: `/data` maps to a
  named volume (e.g. `seaweedfs_data` / `seaweedfs-data-<id>`).
- After a fresh deploy, upload a test image in the admin médiathèque and confirm
  previously-uploaded files still render — this is the smoke test.

If you ever need to migrate the store to a new host:

```bash
# On the source host
docker run --rm -v <seaweedfs-volume>:/source -v $(pwd):/backup alpine \
  tar czf /backup/seaweedfs-snapshot.tgz -C /source .

# Restore on the new host (after creating the storage resource)
docker run --rm -v <new-volume>:/target -v $(pwd):/backup alpine \
  tar xzf /backup/seaweedfs-snapshot.tgz -C /target
```

The same approach works for Postgres — Coolify's "Backup" tab dumps to
S3-compatible storage on a schedule.

## 3. Deploy the app

1. New Resource → Application → Dockerfile.
2. Source: this Git repo, branch `main`.
3. Build pack: **Dockerfile** (the repo's `Dockerfile`).
4. Port: `3000`.
5. Health check path: `/api/health` (auto-detected if you use the
   provided Dockerfile).
6. Domain: **`setup.tokyostore.tn`** for the initial launch — Coolify
   provisions Let's Encrypt automatically. Switch to `tokyostore.tn` at
   cutover time (see §11 below).
7. **Build Arguments:** add
   `NEXT_PUBLIC_SITE_URL=https://setup.tokyostore.tn`. Next.js inlines
   every `NEXT_PUBLIC_*` value into the JS bundle at *build* time — a
   runtime env var of the same name is ignored by client code. This is
   why we expose it as a build arg in the Dockerfile (`ARG
   NEXT_PUBLIC_SITE_URL`). If you forget it, the sitemap and OG tags
   will all say `localhost:3000`. At cutover (§11) rebuild with the new
   value. Also add `S3_PUBLIC_URL` (same value as the env var — baked into
   `images.remotePatterns` + the CSP; without it every uploaded image 400s)
   and, if used, `MEDIA_CDN_URL` / `CSP_EXTRA_HOSTS` (compiled the same way;
   changing them requires a rebuild) and `NODE_BUILD_MEMORY`
   ([Build memory](#build-memory-node_build_memory)).

### Environment variables (initial launch — setup subdomain)

Copy from [.env.example](../.env.example), customise. The initial launch
points everything at `setup.tokyostore.tn` so you can verify the deploy
without exposing the brand domain. The cutover to `tokyostore.tn` is in
§11.

```env
NODE_ENV=production
NEXT_PUBLIC_SITE_URL=https://setup.tokyostore.tn

DATABASE_URL=postgresql://<user>:<pwd>@tokyo-postgres-<id>:5432/<db>?sslmode=require
BETTER_AUTH_URL=https://setup.tokyostore.tn

EMAIL_PROVIDER=resend
EMAIL_FROM="Tokyo Store <noreply@setup.tokyostore.tn>"
EMAIL_REPLY_TO=support@tokyostore.tn
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

S3_ENDPOINT=http://tokyo-seaweedfs:8333
S3_REGION=us-east-1
S3_BUCKET=tokyo
S3_ACCESS_KEY=<seaweedfs access key = SERVICE_USER_SEAWEEDFS>
S3_SECRET_KEY=<seaweedfs secret key = SERVICE_PASSWORD_SEAWEEDFS>
S3_FORCE_PATH_STYLE=true
# Only if serving media from a dedicated storage domain (else omit — the app's
# same-origin /cdn proxy needs no public host):
# S3_PUBLIC_URL=https://s3.tokyostore.tn/tokyo
```

Click **Deploy**. That's it — no `openssl` ceremony.

> **Postgres TLS (`sslmode`).** `DB_SSL_CA` (PEM literal or file path) is
> applied to every connection (app pool, migrator, `init-secrets`) via
> `src/lib/db/ssl.ts`. `sslmode=require` **with** `DB_SSL_CA` = verified
> TLS; `sslmode=require` **without** it = encrypted but **not** verified (a
> warning is logged in production); `sslmode=verify-ca` / `verify-full` need a
> readable `DB_SSL_CA` or the app refuses to boot. Only add `?sslmode=require`
> on the internal `tokyo-postgres-<id>` hostname if SSL is actually enabled on
> that Coolify database — otherwise drop it (private network, plain TCP).

> **Auto-bootstrapped secrets.** Note the absence of
> `BETTER_AUTH_SECRET`, `PAYMENT_ENCRYPTION_KEY`, and `ADMIN_BOOTSTRAP_TOKEN`
> from the env block.
> The container's entrypoint runs `db-runner/init-secrets.cjs` on every
> boot — on the *first* boot it generates fresh values and persists them
> to the `app_secrets` Postgres table (created by the squashed baseline
> migration); on subsequent boots it reads them back from the same table. The
> `ADMIN_BOOTSTRAP_TOKEN` value is printed to stderr so you can grab it
> from the Coolify container log for the bootstrap curl — but only while no
> admin exists: the token is burned as soon as one does (§6c). Setting a
> var explicitly in the env tab always wins — that's how you rotate a
> compromised secret or move to your own KMS later. If `init-secrets` fails,
> the entrypoint aborts the boot (container restart) instead of starting the
> server without its secrets.

> **Why `EMAIL_FROM=noreply@setup.tokyostore.tn` during setup?** It keeps
> verification / password-reset emails from contaminating the brand
> domain's deliverability reputation. SPF/DKIM/DMARC records for
> `setup.tokyostore.tn` are isolated from those on `tokyostore.tn`. At
> cutover you swap to `noreply@tokyostore.tn`.

> **Optional runtime tuning (env, all have safe defaults — leave unset unless
> tuning):**
> - `NODE_RUNTIME_MEMORY` (build arg) **or** `NODE_OPTIONS=--max-old-space-size=<MB>`
>   (runtime env) — give the live server a V8 heap ceiling so a leak/spike GCs +
>   exits cleanly instead of being kernel-OOM-killed. Set it BELOW the
>   container's memory limit (e.g. `1536` on a ~2 GB app container); a value
>   above the limit is a no-op. Unset = no ceiling (current behaviour). Distinct
>   from `NODE_BUILD_MEMORY` (builder stage only).
> - `DB_POOL_MAX` / `DB_STATEMENT_TIMEOUT_MS` / `DB_IDLE_TIMEOUT_MS` /
>   `DB_CONNECTION_TIMEOUT_MS` / `DB_KEEPALIVE` — pg pool tuning (shown read-only
>   on Infrastructure → Base de données). Defaults: 12 / 10000 / 15000 / 3000 / on.
>   All are passed through by `docker-compose.coolify.yml`.
> - `DB_APPLICATION_NAME` — `application_name` in `pg_stat_activity`.
> - `CRON_ALLOWED_IPS` — optional comma-separated allow-list for `/api/cron/*`,
>   checked before the `CRON_SECRET` compare (403 `ip_not_allowed`), so a leaked
>   secret alone can't trigger the jobs. Blank = allow all.

### Build memory (`NODE_BUILD_MEMORY`)

The builder stage sets `NODE_OPTIONS=--max-old-space-size=${NODE_BUILD_MEMORY}`
(Dockerfile build arg, **default `2048`** MB) for `next build --webpack` and the
separate `tsc --noEmit` step. Two different failures, two opposite fixes:

- `Next.js build worker exited with code: null and signal: SIGKILL` / a bare
  `exit 255` right after "Creating an optimized production build" = the
  **kernel** OOM-killed the build (the ceiling is above the RAM actually free
  during a deploy, which also hosts Postgres, SeaweedFS and the old container) →
  **lower** `NODE_BUILD_MEMORY` (or add swap / RAM).
- `FATAL ERROR: Reached heap limit … JavaScript heap out of memory` = the
  build genuinely needs more heap than the ceiling → **raise**
  `NODE_BUILD_MEMORY` (the box must have that much free).

The Dockerfile comment calls 2048 "VERIFIED sufficient for THIS app". Treat
that as unconfirmed: on 2026-09-23 a local `next build --webpack` (Windows,
Next 16.2.6) hit the second failure at Node's ~4 GB default heap and only
compiled with `--max-old-space-size=6144`. That was a local build, not the
Docker/Linux one, and it was not re-run in Docker — but budget for a build
that may need more than 2 GB: on a Path B (Dockerfile) resource set
`NODE_BUILD_MEMORY` as a Coolify Build Argument sized to the free RAM during a
deploy. (On Path A the compose's `build.args` does not list it, so the
Dockerfile default applies unless you add it there.)

## 3.5 Provision PgBouncer (recommended once you scale past 1 app instance)

PgBouncer multiplexes the app's connections onto a small server pool so we
can run 4 Next.js instances without exhausting Postgres `max_connections`.
See [database.md §2](database.md#2-topology) for the topology.

1. Coolify → New Resource → Service → **edoburu/pgbouncer:v1.23.1-p3**
   (PgBouncer 1.23.1; edoburu publishes `v<version>-p<n>` tags — a bare
   `1.23.1` tag does not exist).
2. Environment:
   ```env
   DB_HOST=tokyo-postgres-<id>
   DB_PORT=5432
   DB_USER=tokyo
   DB_PASSWORD=<paste from step 1>
   DB_NAME=tokyo
   POOL_MODE=transaction
   MAX_CLIENT_CONN=200
   DEFAULT_POOL_SIZE=25
   MIN_POOL_SIZE=5
   RESERVE_POOL_SIZE=5
   RESERVE_POOL_TIMEOUT=3
   SERVER_LIFETIME=3600
   SERVER_IDLE_TIMEOUT=600
   QUERY_TIMEOUT=30
   QUERY_WAIT_TIMEOUT=30
   AUTH_TYPE=scram-sha-256
   ADMIN_USERS=tokyo
   IGNORE_STARTUP_PARAMETERS=extra_float_digits,application_name,statement_timeout,lock_timeout,idle_in_transaction_session_timeout,options
   ```
   The full `IGNORE_STARTUP_PARAMETERS` list is **required**: the app sends
   `statement_timeout` as a startup parameter and `lock_timeout` /
   `idle_in_transaction_session_timeout` inside `options`, and PgBouncer
   rejects every connection carrying an unlisted one ("unsupported startup
   parameter: statement_timeout"). Under the pooler those timeouts come from
   the role-level defaults (migration `0117`) + the client-side
   `query_timeout` instead.
3. Expose port `5432` on the internal Coolify network — no public port.
4. After deploy, change **only** `DATABASE_URL` in the app to point at the
   pooler:
   `postgresql://tokyo:<pwd>@tokyo-pgbouncer-<id>:5432/tokyo?sslmode=disable`
   (TLS terminates between PgBouncer and Postgres on Coolify's private
   network — no need for client-side SSL). Set
   `MIGRATION_DATABASE_URL` to the **direct** Postgres URL
   (`postgresql://tokyo:<pwd>@tokyo-postgres-<id>:5432/tokyo`): the boot
   migrator (and `init-secrets`) use it when set, and the migrator's session
   advisory lock + per-session timeouts don't survive transaction pooling.
   (Path A's compose already pins `MIGRATION_DATABASE_URL` to `postgres:5432`.)
5. Redeploy the app and watch `pg_stat_activity` — you should now see
   ~25 `client backend` rows max for the `tokyo` user instead of
   per-process pools each opening 10.

## 4. Apply migrations

Normally there's nothing to do: the container entrypoint runs
`node db-runner/migrate.cjs` on **every** boot. It's idempotent — Drizzle
keeps its ledger in `drizzle.__drizzle_migrations` and skips applied SQL —
and a Postgres advisory lock serialises concurrent runners during rolling
redeploys. It connects via `MIGRATION_DATABASE_URL` when set, else
`DATABASE_URL` — always a **direct** Postgres connection, never PgBouncer
(§3.5). To run it manually, exec into the container or use Coolify's
"Run command" feature:

```bash
# Inside the running container
node db-runner/migrate.cjs
```

The migration set is a **single squashed baseline** —
[`src/lib/db/migrations/0000_squash_baseline.sql`](../src/lib/db/migrations/0000_squash_baseline.sql).
One file creates the bulk of the database (the incremental migrations layered on
top — `0001`–`0130` — add the rest):

- Extensions `pgcrypto`, `pg_trgm`, `btree_gin`, `unaccent` (later
  migrations add `vector` — `0112`, needs the pgvector image, see §1 — and
  `pg_stat_statements` — `0124`, created only when the server preloads it and
  the role is superuser, as in the Path A compose; otherwise a harmless NOTICE)
- `uuid_generate_v7()` (time-ordered UUID PKs) and the `fr_unaccent`
  text-search configuration
- 72 tables + 17 enums in the baseline (later migrations add more — e.g.
  `import_jobs`, RBAC `roles`/`role_permissions`/`user_roles`, and
  `businesses`/`business_members`), including the raw-SQL `app_secrets` and
  `rate_limit_buckets` tables (deliberately outside the Drizzle schema graph)
- 5 `GENERATED ALWAYS` `search_vector` tsvector columns (products,
  categories, brands, pages, blog_posts)
- Every FK + CHECK constraint, plus the functional / partial / BRIN /
  trigram-GIN indexes

> **⚠️ One-time breaking change — pre-squash databases.** The PRE-`0000`
> migration history was squashed into this baseline; only that pre-baseline
> history is gone from git. The numbered chain CONTINUES on disk as
> `0000_squash_baseline.sql` plus `0001`–`0130` (131 `meta/_journal.json`
> entries, idx 0–130; the next migration is `0131`). A database that already ran the *pre-squash* chain
> carries a `drizzle.__drizzle_migrations` ledger that conflicts with the
> rebased baseline journal — there is **no incremental upgrade path** from
> that old history.
> Before deploying the squashed code against such a database, drop and
> recreate it: on Path A delete the `postgres_data` volume (Coolify →
> resource → Volumes), on Path B `DROP DATABASE` + `CREATE DATABASE` from
> the postgres terminal. The next boot applies the baseline to the empty
> database and re-runs the first-boot bootstrap (secrets + default admin).
> Fresh deploys are unaffected — they simply run the baseline. Future
> schema changes ship as normal incremental migrations on top of `0000`.

Verify it ran:

```bash
docker exec tokyo-postgres psql -U tokyo -d tokyo -c \
  "SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm','btree_gin','pgcrypto','unaccent','vector','pg_stat_statements');"
# expects 5 rows (+ pg_stat_statements = 6 when the server preloads it)
```

## 5. Seed the catalogue (optional)

Run from your **local checkout** pointed at the Coolify-managed Postgres
(open a temporary tunnel if Coolify keeps the DB on a private network):

```bash
# In the project root on your machine
DATABASE_URL='postgresql://tokyo:<pwd>@<host>:5432/tokyo?sslmode=require' \
  pnpm db:seed:catalog
```

This drops 6 root categories + ~30 subcategories + 7 starter brands so
the admin can immediately add products. Idempotent — re-running is safe.

For a one-shot benchmark sanity check on the prod data shape:

```bash
DATABASE_URL='postgresql://...' pnpm db:bench:catalog 10000
```

## 6. Sign in as the default admin

The container creates a default admin account the first time it boots
against an empty DB. There's no `curl` ceremony — sign in, change the
password, you're done.

### 6a. Grab the auto-generated password

Open the Coolify app container log (Coolify → app → Logs) and look for:

```
════════════════════════════════════════════════════════════════════
  ✨  DEFAULT ADMIN ACCOUNT CREATED
════════════════════════════════════════════════════════════════════
  email     : houssem@kawn.me
  password  : g3DQQ6QyvAwo-sKU-A5tCbrk

  → sign in at  /admin-login  (the staff portal; or your secret
    ADMIN_LOGIN_PATH if set. The same account also works at the
    public /login — /admin itself is gated by RBAC.)
  → change email/password at  /account

  This banner is the ONLY copy of the password — it is NOT
  written to the database.
```

The password is printed **once** and is deliberately **never persisted**
(plaintext credentials don't belong in the same table as
`BETTER_AUTH_SECRET`). If the log has scrolled off:

- **Recover:** request a reset at `/forgot-password` for
  `houssem@kawn.me` (requires a working email provider), or
- **Re-mint:** delete the account + bootstrap flag and restart the
  container — `ensureDefaultAdmin()` re-fires and prints a fresh banner:

  ```sql
  DELETE FROM users WHERE email = 'houssem@kawn.me';
  DELETE FROM app_secrets
  WHERE key IN ('DEFAULT_ADMIN_BOOTSTRAPPED', 'DEFAULT_ADMIN_EMAIL');
  ```

### 6b. Sign in + change email/password

1. Open `https://setup.tokyostore.tn/login`, sign in with the values from
   6a.
2. Go to `/account`, change the email to your real address and pick a
   password you'll remember.

The account row is yours from here on — change role, email, and password
freely from the admin UI. Future admins are added via `/admin/users`, not
via this flow.

### 6d. (Recommended) Load the demo content

A fresh deploy shows a working storefront but empty product grids. To load
a starter catalogue (category tree, brands, hero banners, FAQs, typed
settings, and the products imported from the demo feed; exact per-type counts
are shown live on the panel):

1. Sign in to `/admin`.
2. Navigate to **Système → Importer la démo** (in the sidebar) or go
   straight to `/admin/system/import-demo`.
3. Click **Tout importer** (or one segment). The import runs as a background data job
   (live progress on the page) — it needs the « Tâches planifiées »
   `system_jobs:manage` grant on top of the page's `system_demo` grant.

Re-running is safe: rows are matched by stable slug/key, blank fields are
filled but admin-edited editorial, SEO text and category FAQs are never
overwritten, and a category an admin moved is never re-parented.

**There is no demo-only undo.** Cleanup lives in **Contenu & Design →
Identité & contact** (`/admin/cms/settings`, « Réglages site ») → **« Nettoyage
des données — zone sensible »**: super-admin (`*`) only,
irreversible, and it empties the **whole** chosen segment — not just the demo
rows.

Curl alternative for headless setups / CI:

```bash
# import — system_demo:manage; 409 {"error":{"code":"busy"}} while an
# import/clean job or a purge is running
curl -X POST https://setup.tokyostore.tn/api/admin/system/demo \
  -H "Origin: https://setup.tokyostore.tn" \
  -b "<your signed-in session cookie>"

# ⚠ WHOLE-STORE clear (not demo-scoped) — super-admin '*' only
curl -X POST 'https://setup.tokyostore.tn/api/admin/system/demo?op=clear' \
  -H "Origin: https://setup.tokyostore.tn" \
  -b "<your signed-in session cookie>"
```

The route calls `requirePermission("system_demo", "manage")` first
(anonymous / unauthorised callers get 404, same privacy pattern as the rest
of `/api/admin/*`) and is same-origin guarded: a POST carrying neither
`Origin` nor `Referer` is rejected, hence the `-H 'Origin: …'`. `?op=clear`
is **not** demo-scoped: it hard-deletes every product (with its
reviews/wishlists/variants/stock), attribute, banner, brand, FAQ and menu,
archives every customer profile, deletes the Le Foyer/Le Clan/La Lignée +
Partner tiers (unless a product drip schedule still uses them) and resets only
the demo settings nobody edited; categories and orders survive. It
additionally requires the super-admin `*` wildcard
(403 otherwise) and answers 409 while an import/clean job or a purge runs.

### 6c. The back-door bootstrap path closes itself

The deploy ALSO generates an `ADMIN_BOOTSTRAP_TOKEN` as a fallback in
case the auto-admin step ever fails (e.g. the email collided with an
existing user). **Nothing to do to close it:** the token is burned
automatically as soon as any admin exists — when the default admin is
created, on the first successful `POST /api/admin/bootstrap`, or on any boot
that finds an active admin (enum `admin` or RBAC `*` holder), including
installs with `DISABLE_DEFAULT_ADMIN=true`. The app deletes the persisted
`ADMIN_BOOTSTRAP_TOKEN` row and records `ADMIN_BOOTSTRAP_CLOSED` in
`app_secrets`, so the route returns 404 for good and `init-secrets` stops
exporting or regenerating the token.

To deliberately re-open it after a true lockout, run
`DELETE FROM app_secrets WHERE key='ADMIN_BOOTSTRAP_CLOSED';` and restart: a
fresh token is generated and printed once (the route still 404s while any
active admin exists). An `ADMIN_BOOTSTRAP_TOKEN` key that is present but
**empty** in the container env also disables the route — on Path A it must be
passed through the compose file to take effect.

### Opting out of the default admin

Set `DISABLE_DEFAULT_ADMIN=true` in Coolify env. On every boot, the
instrumentation hook skips the auto-creation and you're back to the
manual flow: register a customer account at `/register`, then promote
via the `ADMIN_BOOTSTRAP_TOKEN` curl.

<details>
<summary>Manual bootstrap (only used if `DISABLE_DEFAULT_ADMIN=true` OR auto-admin failed)</summary>

```bash
# 1. Get the bootstrap token from the container log:
#    [init-secrets] ADMIN_BOOTSTRAP_TOKEN: generated + persisted
#    [init-secrets]   value: <hex>
#
#    Or:  SELECT value FROM app_secrets WHERE key='ADMIN_BOOTSTRAP_TOKEN';

# 2. Register a normal account at https://setup.tokyostore.tn/register
# 3. Confirm the verification email (or set EMAIL_PROVIDER=console temporarily).
# 4. Promote:
curl -X POST https://setup.tokyostore.tn/api/admin/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"token":"<TOKEN>","email":"you@tokyostore.tn"}'
```

A successful promotion burns the back door automatically (6c) — the token is
single-use.
</details>

<details>
<summary>Niche: rotate the bootstrap token before it is used</summary>

While **no admin exists yet** (the only time the route is live), you can
invalidate the value you copied (e.g. it leaked into a ticket) with:

```sql
DELETE FROM app_secrets WHERE key = 'ADMIN_BOOTSTRAP_TOKEN';
```

then restart the container. The entrypoint generates a fresh value and
logs it. Once an admin exists this is moot — the door is closed (6c).
</details>

## 7. Smoke test

| Check                                                              | Expected             |
| ------------------------------------------------------------------ | -------------------- |
| `GET https://setup.tokyostore.tn/api/health`                        | 200 `{ status: ok }` (liveness — the container HEALTHCHECK) |
| `GET https://setup.tokyostore.tn/api/health?ready=1`                | 200 with `checks: { env: true, db: true }`; 503 `not-ready` otherwise |
| `GET https://setup.tokyostore.tn/`                                  | 200, storefront      |
| `GET https://setup.tokyostore.tn/admin` (signed in as admin)        | 200, dashboard       |
| `POST https://setup.tokyostore.tn/api/admin/bootstrap` (any token)  | 404 (door closed once an admin exists) |
| Image upload via `/admin/media`                                    | Saved + visible      |
| Inspect Postgres: `SELECT count(*) FROM audit_log;`                | > 0                  |

Repeat the full smoke test from
[the verification matrix](#pre-flight-whats-been-verified-locally) at the
top of this document — every row should be green before you proceed to
the cutover.

## Subsequent deploys

Every push to `main` triggers a Coolify rebuild. Migrations are applied
automatically — the container entrypoint runs `node db-runner/migrate.cjs`
on every start. Drizzle migrations are idempotent — re-running on a
fully-migrated DB is a no-op.

For zero-downtime DB schema changes:

1. First deploy: introduce additive change (new nullable column / new
   table).
2. Backfill data.
3. Second deploy: rename / drop only after no app instance reads the old
   column.

Migrations are hand-authored (`pnpm db:generate` is guarded) — review each
one before merging, and check its `meta/_journal.json` `when` is strictly
greater than the previous entry's: an equal/smaller value is silently skipped
on an already-migrated production DB (`migration-journal.test.ts` guards it).

## 11. Cutover — moving from `setup.tokyostore.tn` to `tokyostore.tn`

The setup subdomain is the staging launch. When you're confident the
storefront, admin, media pipeline, search, and email all work, swap to
the brand domain. This is **one** Coolify app — the cutover is a domain
+ env-var change, not a re-provision.

### Sequence (15-minute downtime window, optional)

1. **Add the brand domain to the existing app resource.**
   Coolify → app → Domains → add `tokyostore.tn` (and optionally
   `www.tokyostore.tn` with a redirect to apex). Coolify will issue a new
   Let's Encrypt cert.

2. **Point DNS.** At your registrar, set the A/AAAA for `tokyostore.tn` to
   the same IP as `setup.tokyostore.tn`. Keep TTL low (300s) until you're
   confident, then bump to 3600s.

3. **Add SPF/DKIM/DMARC records** on `tokyostore.tn` if you haven't
   already. They're independent of the records on `setup.tokyostore.tn`.
   Confirm with `dig TXT tokyostore.tn` and `dig TXT _dmarc.tokyostore.tn`
   that Resend / your SMTP provider's records resolve.

4. **Swap env vars + rebuild** in Coolify:

   | Where | Var | Before | After |
   | --- | --- | --- | --- |
   | Environment | `BETTER_AUTH_URL` | `https://setup.tokyostore.tn` | `https://tokyostore.tn` |
   | Environment | `EMAIL_FROM` | `Tokyo Store <noreply@setup.tokyostore.tn>` | `Tokyo Store <noreply@tokyostore.tn>` |
   | **Build Arguments** | `NEXT_PUBLIC_SITE_URL` | `https://setup.tokyostore.tn` | `https://tokyostore.tn` |

   The other env vars (`DATABASE_URL`, `S3_*`, `RESEND_API_KEY`) **stay
   the same** — you're keeping the same database, same SeaweedFS bucket,
   and same Resend account. Sessions issued on `setup.tokyostore.tn`
   will not roundtrip to `tokyostore.tn` (cookies are domain-scoped), so
   existing admins will need to sign in once on the new domain. That's
   the expected behaviour, not a bug.

   > **Why `NEXT_PUBLIC_SITE_URL` is a Build Argument, not just env:**
   > Next.js inlines `NEXT_PUBLIC_*` values at build time. Changing it
   > at runtime would leave the sitemap, OG meta tags, and email
   > template links pointing at the setup domain even after cutover.

5. **Redeploy** the app — Coolify rebuilds from the new build arg and
   rolls the container with the new env.

6. **Re-run the smoke test** against the brand domain:

   ```bash
   H=https://tokyostore.tn
   curl -fs $H/api/health
   curl -fsI $H/ | grep -i strict-transport
   curl -fs "$H/api/store/search?q=ps5"
   # Sign in via /admin-login (staff portal; same account also works at /login), verify admin dashboard loads.
   ```

7. **Optional:** keep `setup.tokyostore.tn` as a permanent staging
   pre-prod by spinning up a SEPARATE Coolify app pointed at a separate
   Postgres + SeaweedFS. The current setup app then becomes prod under its
   new domain and you have full env isolation going forward.

   **Or** — simpler for an MVP — drop the `setup.tokyostore.tn` domain
   from the app resource once `tokyostore.tn` serves a successful smoke
   test. Coolify cleans up the unused cert automatically.

### What NOT to do during cutover

- **Don't change** `BETTER_AUTH_SECRET`. That invalidates every session
  and forces a global re-login.
- **Don't change** the database role or `S3_BUCKET`. There's no upside
  and the rename touches every uploaded file's stored URL prefix.
- **Don't run** another migration unless you've added one — migrations
  are idempotent but unnecessary churn is unnecessary churn.
- **Nothing to do** for `ADMIN_BOOTSTRAP_TOKEN`: it was burned when the
  first admin was created on `setup.tokyostore.tn`, and the brand domain
  shares the same database (and its `ADMIN_BOOTSTRAP_CLOSED` marker).

### Rollback

If the cutover smoke test fails:

1. Flip the three env vars back to `setup.tokyostore.tn`.
2. Redeploy.
3. DNS for `tokyostore.tn` can stay pointed at the same IP — the app
   will just refuse the request on that vhost until the next env swap.

The database and uploaded media are untouched throughout — there's
nothing to restore.

## Backups

Coolify Postgres includes scheduled backups. Verify:

1. Database → Backups tab → schedule a daily dump.
2. Forward dumps to off-host storage (S3 / R2 / SCP target).
3. Test a restore monthly — backups you never restore aren't backups.

## Monitoring

- Coolify exposes container CPU/RAM/disk graphs.
- App-level: the structured-logger subscriber
  (`src/events/subscribers/structured-logger.ts`) writes one JSON line per event
  to stdout — point your log collector at the container's stdout (no extra
  logging dependency).
- Sentry / OpenTelemetry hooks: drop into `error.tsx` and
  `src/events/subscribers/` (TODO Phase 5).

### Database health checklist

Run these monthly (or pipe into pgwatch/Prometheus if you want continuous).

**`pg_stat_statements`.** Path A's compose starts Postgres with
`shared_preload_libraries=pg_stat_statements`, `pg_stat_statements.track=all`
and `log_min_duration_statement=500ms`, and migration `0124` creates the
extension on the next boot (it runs as `POSTGRES_USER`, a superuser), so the
admin « Requêtes lentes » card (Infrastructure → Base de données) and query 1 below
work out of the box. `0124` runs only once and only creates the extension when
the library is preloaded at that moment — on Path B, if you add the preload
**later**, restart Postgres and run
`CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` yourself (superuser).

```sql
-- 1. Slow queries (requires shared_preload_libraries = 'pg_stat_statements')
SELECT mean_exec_time::int AS avg_ms, calls,
       substring(query, 1, 80) AS preview
FROM pg_stat_statements
ORDER BY total_exec_time DESC LIMIT 20;

-- 2. Unused indexes — drop after 30+ days at 0 scans
SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_stat_user_indexes
WHERE schemaname = 'public' AND idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;

-- 3. Table sizes
SELECT relname, pg_size_pretty(pg_total_relation_size(oid))
FROM pg_class
WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
ORDER BY pg_total_relation_size(oid) DESC LIMIT 10;

-- 4. Bloat estimate (top offenders only)
SELECT relname,
       n_live_tup, n_dead_tup,
       round(n_dead_tup::numeric / nullif(n_live_tup, 0), 3) AS dead_ratio
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY dead_ratio DESC NULLS LAST;
```

See [database.md §7](database.md#7-observability) for the full observability
playbook.

## Rollback

Coolify keeps the last N image versions. To roll back:

1. Coolify → Deployments → pick the prior good build → **Redeploy**.
2. If the rollback involves a destructive migration, restore from the
   matching backup BEFORE redeploying the old code.

## 12. Data-retention purge (scheduled job)

Fifteen purge targets — the `RETENTION_TARGETS` inventory in
`src/lib/retention/windows.ts`, which the purge, the Database tab's
« Rétention » card, the API page's retention card and the job description all
derive from — cover the unbounded / PII-bearing tables (GDPR concern). The app
exposes a secret-gated endpoint that hard-deletes rows past their retention
window — batched, no `RETURNING`, so it stays WAL- and
`statement_timeout`-safe even on multi-million-row tables. Purges run **2 at a
time** (so a backlog never takes the whole app pool), the high-volume tables
last.

| Target (table) | Retention | Notes |
| --- | --- | --- |
| `search_log` | `search.purge_months` × 30 (default 90 days) | search queries + IP; window set in Recherche → Purge |
| `webhook_events` | 90 days | payment idempotency ledger; only needs to outlive a gateway retry window |
| `webhook_deliveries` | 90 days | outbound ERP webhook delivery log (payload snapshots) |
| `audit_log` | `audit.retention_months` × 30 (default 360 days) | actor/target trail + IP; window set in Journal d'audit → Réglages |
| ephemeral `carts` (`qb-…`) | 2 days | abandoned quick-buy carts |
| guest `carts` (no user, not `qb-…`) | 60 days of no activity | cart row + lines; the guest cookie lives 30 days |
| guest `wishlists` (token, no user) | 180 days of no activity | matches the guest cookie's max-age |
| `job_run_log` | 90 days | reaps run history of removed/renamed jobs (per-job pruning is separate, §12c) |
| `email_logs` | 180 days | send audit log (recipient + rendered body); **pinned rows excluded** |
| `mailing_sends` | 540 days | automation idempotency ledger; outlives any dedup window |
| `cart_events` | 180 days | add-to-cart analytics events |
| `app_instance_heartbeats` | 90 days | app boot heartbeats; live instance protected by refreshed `last_seen_at` |
| `ai_call_logs` | 14 days | one row per AI provider call (chat + embeddings) |
| expired `sessions` | at expiry (`expires_at < now()`) | Better Auth sessions |
| expired `verifications` | at expiry (`expires_at < now()`) | Better Auth verification tokens |

**Fail closed:** if the settings read fails, the `search_log` and `audit_log`
purges are **skipped** (`errors.searchLog` / `errors.auditLog` =
`settings_unavailable`, run recorded as failed) — they never run with a
shorter default window.

### 12a. Set the secret

In Coolify → app → Environment, add `CRON_SECRET` with a long random value:

```bash
openssl rand -hex 32
```

The route returns **503** while `CRON_SECRET` is unset (purge disabled, never
runs unguarded) and **401** on an `Authorization` header mismatch (every
`/api/cron/*` route shares this guard, plus a per-IP 10/min rate limit → 429
and the optional `CRON_ALLOWED_IPS` allow-list → 403). Redeploy after setting
it.

### 12b. Wire the scheduled job

Coolify → app → **Scheduled Tasks** → add a task:

- **Frequency (cron):** `0 3 * * *` (daily at 03:00 — off-peak).
- **Command:**

  ```bash
  curl -fsS -X POST https://tokyostore.tn/api/cron/retention \
    -H "Authorization: Bearer $CRON_SECRET"
  ```

  `$CRON_SECRET` resolves from the app's environment inside the task container.
  `-f` makes `curl` exit non-zero on a 4xx/5xx so a failed purge shows up as a
  failed task run in Coolify's task history.

A successful run returns:

```json
{
  "ok": true,
  "status": "ok",
  "deleted": {
    "searchLog": 1203, "webhookEvents": 47, "webhookDeliveries": 930,
    "auditLog": 8891, "ephemeralCarts": 12, "guestCarts": 64,
    "guestWishlists": 9, "jobRunLog": 340, "emailLogs": 5102,
    "mailingSends": 88, "cartEvents": 410, "instanceHeartbeats": 21,
    "aiCallLogs": 1520, "expiredSessions": 77, "expiredVerifications": 15
  },
  "errors": {}
}
```

The run summary in « Tâches planifiées » is `<label> <count>, …` over all 15
targets. Per-target failures are isolated — one target erroring (surfaced in
`errors`) does not abort the others; the response is then `ok:false` with
HTTP 500 so the task is flagged for follow-up while the healthy tables still
got purged.

> **Alternative (external scheduler).** Any cron host (GitHub Actions, a VPS
> crontab, Uptime-Kuma) can hit the same endpoint with the same `curl` — the
> secret is the only gate. Keep it out of logs/URLs (it's a header, not a query
> param, by design).

### 12·bis. Recommended — ONE dispatch heartbeat runs every job

Instead of wiring a separate Coolify task per job (§12c–§12g below), point **one**
Scheduled Task at the dispatch heartbeat. It reads each job's in-app cadence
(`SCHEDULED_JOBS[].dispatch`) and runs only the ones **due** this tick — collapsing the
nine per-job crons into a single task.

- **Frequency (cron):** `*/2 * * * *` (every 2 min — the finest interval any job needs).
- **Command:**

  ```bash
  curl -fsS -X POST https://tokyostore.tn/api/cron/dispatch \
    -H "Authorization: Bearer $CRON_SECRET"
  ```

The heartbeat returns fast (it runs the due jobs in a background sweep, each bounded to
90 s) and an in-process lock skips a tick while the previous sweep is still going, so
ticks never overlap. Each job keeps its own kill-switch + `job_run_log` row and is
managed identically in **Système → Tâches planifiées** — which now also shows the
computed **« Prochaine »** (next fire). Current cadences (Africa/Tunis, +01:00): mailing
& outbound webhooks every 2 min, payments every 12 min, abandoned orders hourly;
retention 03:00, birthday 00:10, life-event anniversary 00:15, review requests 09:30,
détourage 04:00.

> **Pick ONE model.** Use this single dispatch task **or** the per-job tasks of
> §12b/§12c–§12g — not both. The heartbeat already schedules `retention_purge` at 03:00,
> so the §12b retention task can be dropped when you adopt it. The per-job routes stay
> reachable for a manual `curl` / external scheduler and for « Exécuter maintenant ».

### 12c. Mailing scheduled jobs (same `CRON_SECRET`)

The mailing system adds three scheduled tasks (same Bearer-secret pattern). Add
them in Coolify → **Scheduled Tasks** alongside the retention job:

| Job | Frequency (cron) | Endpoint |
| --- | --- | --- |
| **Mail queue drain** (campaigns + bulk automations, throttled + retry) | `*/2 * * * *` (every 2 min) | `POST /api/cron/mailing` |
| **Birthday emails** (today's birthdays → gift code) | `10 0 * * *` (00:10 Africa/Tunis) | `POST /api/cron/birthday` |
| **Life-event anniversary emails** (mariage/naissance/fiançailles anniversary within the configured days-before window → gift code) | `15 0 * * *` (00:15 Africa/Tunis) | `POST /api/cron/life-event-anniversary` |
| **Review requests** (orders delivered ~N days ago) | `30 9 * * *` (daily) | `POST /api/cron/review-request` |

```bash
curl -fsS -X POST https://tokyostore.tn/api/cron/mailing -H "Authorization: Bearer $CRON_SECRET"
```

Each returns `503` while `CRON_SECRET` is unset and records a row in `job_run_log`
(surfaced in the admin "Tâches planifiées" dashboard). The queue drain is the
important one — without it, campaigns + bulk automation emails stay `queued` and
never send. It is single-flight: an overlapping run (a slow tick, or « Exécuter
maintenant » during a tick) is skipped under a transaction-scoped advisory lock.
The batch is sized from `mail.throttle_per_min` for the `*/2` cadence with 10 s of
headroom, so a slower cadence lowers the effective throughput at low throttles.
Provider config + per-automation toggles live in the admin Mailing hub
(`/admin/marketing/mailing`).

> **Dashboard control (all external crons).** Every job in §12–§12f can be
> **paused** from `/admin/system/jobs` — a per-job kill-switch
> (`jobs.<key>.enabled`) the cron route respects (it records a `skipped`
> « Ignoré » run and returns 200 without doing work, so Coolify keeps firing
> harmlessly). It can also be **run on demand** (« Exécuter maintenant »), which
> bypasses the pause, takes the exact same logged path as the cron and works **without**
> `CRON_SECRET` (only the external scheduler needs it). A run that THROWS is
> recorded as `failed` (never an invisible 500). Each job's history keeps the
> latest 100 real runs + the latest 20 no-op (« Ignoré ») runs + always the
> latest failure, shown on the card as « Dernier échec ».

### 12d. Payment reconciliation (same `CRON_SECRET`) — REQUIRED for online payments

| Job | Frequency (cron) | Endpoint |
| --- | --- | --- |
| **Payment reconcile** (settle online orders stuck `pending`) | `*/12 * * * *` (every 12 min) | `POST /api/cron/payments` |

```bash
curl -fsS -X POST https://tokyostore.tn/api/cron/payments -H "Authorization: Bearer $CRON_SECRET"
```

⚠️ **Wire this if you accept online payments (ClicToPay / Flouci).**
ClicToPay and Flouci both confirm via a server-to-server webhook
(`/api/webhooks/clictopay`, `/api/webhooks/flouci`), but a webhook can be missed or
disabled, so a customer who closes the return tab leaves a genuinely-paid order
stuck `pending` until this job re-verifies it against the gateway and settles it. It also rescues an order stranded by a
crash between the webhook idempotency claim and the status transition (it releases
the orphaned claim before re-confirming). Idempotent — safe to run often. Tune the
staleness window with `PAYMENT_RECONCILE_STALE_MINUTES` (default 20).

### 12e. Abandoned-order sweep (same `CRON_SECRET`) — RECOMMENDED (releases reserved stock)

| Job | Frequency (cron) | Endpoint |
| --- | --- | --- |
| **Abandoned orders** (cancel stale `pending` + restock) | `7 * * * *` (hourly) | `POST /api/cron/abandoned-orders` |

```bash
curl -fsS -X POST https://tokyostore.tn/api/cron/abandoned-orders -H "Authorization: Bearer $CRON_SECRET"
```

Tokyo Store reserves stock at order **creation**, so an order left `pending` forever
silently holds inventory. The payment-reconcile job (12d) only frees ONLINE orders
with a gateway reference inside its 24h window; this sweep is the generic backstop
that cancels every **unconfirmed** order stuck `pending` past the abandon window
(default 48h, `ABANDONED_ORDER_HOURS`) — unconfirmed COD orders, online orders that
never reached a gateway reference, and anything aged out of reconcile — restoring
the reserved stock + reversing loyalty/promotions via the normal cancellation path.
**Exempt:** operator-confirmed orders (`confirmed_at`), ERP-pushed orders
(`external_ref`), and point-less counter sales settled offline (e.g. a caisse
« Non payé »); pickup orders naming a point (drive / retrait en magasin) are swept
like home COD orders. An online order that carries a gateway reference is
re-verified first and skipped unless the gateway definitively reports it unpaid
(never blind-cancelled). The 48h default sits comfortably beyond any live gateway
session, so it never races 12d. Idempotent. Toggle/run-now from **Système →
Tâches planifiées**.

### 12f. Outbound ERP webhooks (same `CRON_SECRET`) — REQUIRED if you register webhook endpoints

| Job | Frequency (cron) | Endpoint |
| --- | --- | --- |
| **Outbound webhooks** (deliver queued events to ERP endpoints) | `*/2 * * * *` (every 2 min) | `POST /api/cron/webhooks` |

```bash
curl -fsS -X POST https://tokyostore.tn/api/cron/webhooks -H "Authorization: Bearer $CRON_SECRET"
```

Events subscribed by the endpoints registered in **Infrastructure → API & Webhooks → « Webhooks
sortants (ERP) »** (`/admin/system/api?tab=webhooks-out`) are queued in
`webhook_deliveries`; this job POSTs them as signed
(HMAC) JSON through the SSRF-hardened fetch, with bounded concurrency, retry +
back-off, and a hard per-delivery timeout. **Without it, queued webhooks never
leave the store.** The API settings' outbound-webhooks switch pauses the drain
(runs are recorded as skipped). The delivery log is trimmed after 90 days by the
retention purge (§12). Toggle/run-now from **Système → Tâches planifiées**
(job `webhook_dispatch`).

### §12g — Product détourage back-fill (OPTIONAL)

| Job | Frequency (cron) | Endpoint |
| --- | --- | --- |
| **Product détourage** (remove uniform backdrop from existing product images) | `0 4 * * *` (daily 04:00) | `POST /api/cron/detourage` |

```bash
curl -fsS -X POST https://tokyostore.tn/api/cron/detourage -H "Authorization: Bearer $CRON_SECRET"
```

Back-fills the détourage (uniform-backdrop → transparent) on **existing** product
images that haven't been processed — for catalogues imported before the feature
was enabled, or images that slipped through. It runs the SAME reprocess as the
manual button in **Médiathèque → Réglages**, and is **a no-op unless the
« Détourage automatique du fond uni » media setting is ON** (so a scheduled run
never removes a backdrop you turned the feature off for). Idempotent — images
already on a `-nobg` key are skipped — so a daily cadence only touches product
images added since the last run; historical order thumbnails are preserved.
Optional (skip it if you détoure at upload and never bulk-import). Toggle/run-now
from **Système → Tâches planifiées** (job `product_detourage`).

## Cost reference (rough order of magnitude)

A modest Coolify VPS hosting Tokyo Store + Postgres + SeaweedFS comfortably
runs on a **4 vCPU / 8 GB RAM / 80 GB SSD** node — roughly $20-30/mo
on Hetzner, OVH, or DigitalOcean. Add R2 ($0.015/GB/month) once the
media library outgrows the local SeaweedFS volume.

---

## Pre-flight deployment checklist

Tick everything before pressing **Deploy** on Coolify.

### Code
- [ ] All (hand-authored) migrations committed — `NNNN_*.sql` + matching
      `meta/_journal.json` entries; the Drizzle schema barrel matches. (`pnpm
      db:generate` is guarded/disabled — see docs/database.md §9.1.)
- [ ] `pnpm typecheck` clean (no `any`, no missing exports).
- [ ] `pnpm lint` passes (exit 0 — no errors; warnings only).
- [ ] `pnpm test:pure` green, and `pnpm test:db` green against a throwaway
      migrated DB (see [DEVELOPMENT.md §6b](../DEVELOPMENT.md#6b-tests)).
- [ ] `pnpm build` succeeds locally with prod env vars supplied (it may need
      `NODE_OPTIONS=--max-old-space-size=6144` — see
      [Build memory](#build-memory-node_build_memory)).
- [ ] Local Docker build passes: `docker build -t tokyo-app .`
- [ ] Local Docker smoke test passes (storefront, /api/health, search APIs).
- [ ] `pnpm db:bench:catalog 10000` reports all hot-paths < 10 ms (see
  [database.md §12](database.md#12-benchmark-results)).

### Secrets & env
- [ ] `BETTER_AUTH_SECRET` (if set explicitly) is **≥ 40 chars with ≥ 16
      distinct characters** and unique per env — production boot refuses a
      weaker one. Generate: `openssl rand -base64 32` (44 chars).
- [ ] `ADMIN_BOOTSTRAP_TOKEN` needs no action — it is burned automatically
      once the first admin exists (§6c).
- [ ] `DATABASE_URL` includes `?sslmode=require` when pointing at Coolify-
      managed Postgres on the public proxy (+ `DB_SSL_CA` to verify the cert).
- [ ] `MIGRATION_DATABASE_URL` is the **direct** Postgres URL whenever
      `DATABASE_URL` goes through PgBouncer (§3.5).
- [ ] `CRON_SECRET` set (≥ 16 chars) and EITHER the single dispatch heartbeat wired (§12·bis — one Coolify task at `POST /api/cron/dispatch`, `*/2 * * * *`, recommended) OR the per-job routes of §12–§12g. Not both.
- [ ] `EMAIL_PROVIDER` matches the secret pack you provisioned
      (`resend` ⇒ `RESEND_API_KEY`, `smtp` ⇒ `SMTP_HOST/USER/PASSWORD`).
- [ ] `S3_*` credentials match the SeaweedFS keys (anonymous read on the bucket, writes require the key),
      authenticated write).

### Infrastructure
- [ ] Postgres extensions installable in your Coolify Postgres flavour:
      `pg_trgm`, `btree_gin`, `pgcrypto`, `unaccent` (all four ship in the
      stock postgres:16-alpine image) **and `vector`** — which does NOT: run
      the DB on the pgvector image (§1) before the app deploy.
- [ ] (Recommended) Postgres started with
      `shared_preload_libraries=pg_stat_statements` (Path A does this).
- [ ] DNS records: A/AAAA pointed at the Coolify host; CNAME for the object store if
      using a vanity subdomain.
- [ ] Coolify TLS auto-issuance (Let's Encrypt) working for both domains.
- [ ] PgBouncer service deployed (when scaling past 1 app instance — see §3.5).
- [ ] Backups scheduled and forwarded off-host.

### Post-deploy verification
- [ ] `GET /api/health` → 200 and `GET /api/health?ready=1` → 200.
- [ ] `GET /api/store/search?q=test` → 200 (validates DB extensions loaded).
- [ ] First admin signed in; `POST /api/admin/bootstrap` now → 404.
- [ ] `SELECT extname FROM pg_extension;` includes the five we depend on
      (`pgcrypto`, `pg_trgm`, `btree_gin`, `unaccent`, `vector`).
- [ ] `SELECT count(*) FROM products WHERE deleted_at IS NULL;` is sane.
- [ ] First storefront page load < 2s; warm reload < 500ms.
- [ ] First image upload visible at `S3_PUBLIC_URL/<key>`.

---

## Complete environment reference

Mark **R**equired or **O**ptional. Defaults apply at runtime if absent.
The schema lives in [`src/lib/env.ts`](../src/lib/env.ts) — blank values
from the Coolify dashboard are treated as *unset* (empty-string
preprocessing), and production boot refuses placeholder secrets.

| Var                          | R/O | Default               | Notes                                                                  |
| ---------------------------- | --- | --------------------- | ---------------------------------------------------------------------- |
| `NODE_ENV`                   | R   | `development`         | Set to `production` in Coolify.                                        |
| `NEXT_PUBLIC_SITE_URL`       | R   | `http://localhost:3000` | Used for canonical links & email templates. **Build Argument** — inlined at `next build` (see §3). |
| `DATABASE_URL`               | R   | _none_                | `postgresql://user:pwd@host:5432/db` (+ `?sslmode=require` only if the server has SSL — see §3). Localhost hosts are rejected in prod. May point at PgBouncer (§3.5). |
| `MIGRATION_DATABASE_URL`     | O   | _unset_ ⇒ `DATABASE_URL` | **Direct** Postgres URL for the boot migrator + `init-secrets` (session advisory lock + per-session timeouts don't survive transaction pooling). Required whenever `DATABASE_URL` goes through PgBouncer; the Path A compose pins it to `postgres:5432`. |
| `DB_SSL_CA`                  | O   | _unset_               | CA bundle (PEM literal or file path). `sslmode=require` + CA = **verified** TLS; `require` without it = encrypted but NOT verified (prod warning); `verify-ca` / `verify-full` refuse to boot without a readable CA. |
| `DB_POOL_MAX`                | O   | 12 prod / 5 dev       | Per-process client pool ceiling.                                       |
| `DB_STATEMENT_TIMEOUT_MS`    | O   | 10000                 | Query kill switch, enforced server-side (startup param) AND client-side (`query_timeout`). A bare `SET LOCAL statement_timeout` can't lengthen a query — long jobs use `withLongStatement(ms, fn)` (`src/lib/db/client.ts`). |
| `DB_IDLE_TIMEOUT_MS`         | O   | 15000                 | Idle pool client reaped after this.                                    |
| `DB_CONNECTION_TIMEOUT_MS`   | O   | 3000                  | Pool-acquire / connect timeout.                                        |
| `DB_KEEPALIVE`               | O   | on                    | TCP keepalive on pool sockets; `false` disables it.                    |
| `DB_APPLICATION_NAME`        | O   | `tokyostore-app` | Tag in `pg_stat_activity` (the Path A compose passes `tokyo-app`).     |
| `BETTER_AUTH_SECRET`         | R   | _auto_                | Auto-generated (44 chars) + persisted in `app_secrets` by the entrypoint; env overrides. An explicit prod value must be **≥ 40 chars with ≥ 16 distinct characters** and not a placeholder, or boot is refused. |
| `BETTER_AUTH_URL`            | R   | `http://localhost:3000` | Must match the public URL for the cookie domain — **and it is the origin better-auth builds the OAuth `redirect_uri` from** (`<BETTER_AUTH_URL>/api/auth/callback/<provider>`). Whitelist that exact origin in the Google/Facebook console. Keep it equal to `NEXT_PUBLIC_SITE_URL` unless you deliberately split hostnames; if they differ, the callback URL shown in /admin/system/auth uses `BETTER_AUTH_URL` (the correct one) and the panel warns. |
| `BETTER_AUTH_TRUSTED_ORIGINS`| O   | _unset_               | CSV of extra trusted origins — only when serving from multiple hostnames. |
| `ADMIN_BOOTSTRAP_TOKEN`      | O   | _auto_                | ≥ 8 chars. Enables `POST /api/admin/bootstrap` (fallback first-admin path) **only while no admin exists**. Burned automatically once an admin exists (`app_secrets.ADMIN_BOOTSTRAP_CLOSED`, §6c) — nothing to unset. A key present but empty in the env also disables it. |
| `DISABLE_DEFAULT_ADMIN`      | O   | _unset_               | `true` skips the first-boot auto-creation of `houssem@kawn.me` (see §6). |
| `ADMIN_LOGIN_PATH`           | O   | `/admin-login`        | Secret staff-login path (e.g. `/staff-x7k2`). `proxy.ts` serves the staff sign-in ONLY there, 404s the `/admin-login` default, and 404s (not redirects) an unauthenticated `/admin` so the slug never leaks. Clean absolute path or it's ignored. **Passed through by `docker-compose.coolify.yml` → appears as a Coolify env field.** |
| `CRON_SECRET`                | O   | _unset_               | ≥ 16 chars. Bearer token for ALL `/api/cron/*` routes — the single dispatch heartbeat (`/api/cron/dispatch`, §12·bis) and the per-job routes (retention purge, mailing queue drain, outbound webhooks, birthday, life-event-anniversary, review-request, payments-reconcile, abandoned-orders). Unset ⇒ routes return 503 (jobs disabled; « Exécuter maintenant » in the dashboard still works). See §12·bis / §12–§12f. |
| `CRON_ALLOWED_IPS`           | O   | _unset_ (allow all)   | Comma-separated client-IP allow-list for `/api/cron/*`, checked before the secret compare (403 `ip_not_allowed`), so a leaked `CRON_SECRET` alone can't trigger the jobs. |
| `ABANDONED_ORDER_HOURS`      | O   | 48                    | Abandon window of `POST /api/cron/abandoned-orders` (§12e): unconfirmed `pending` orders older than this are cancelled + restocked (confirmed, ERP-pushed and offline counter sales exempt). Keep it beyond `PAYMENT_RECONCILE_MAX_AGE_HOURS`. |
| `PAYMENT_RECONCILE_STALE_MINUTES` | O   | 20               | Optional tuning for `POST /api/cron/payments` (§12d): how long an online order may sit `pending` before the reconcile sweep re-probes the gateway and settles/cancels it. |
| `PAYMENT_RECONCILE_MAX_AGE_HOURS` | O   | 24               | Optional tuning for `POST /api/cron/payments` (§12d): upper age bound the reconcile sweep considers; orders older than this fall through to the abandoned-orders sweep (`ABANDONED_ORDER_HOURS`, §12e). |
| `PAYMENT_ENCRYPTION_KEY`     | O   | _auto_                | AES-256-GCM key for payment creds at rest. Auto-generated + persisted in `app_secrets`; env overrides. Don't change once secrets are stored. |
| `CLICTOPAY_USERNAME`         | O   | _unset_               | ClicToPay merchant login. Creds are normally set in `/admin/system/payments` (encrypted in DB); any env value **force-overrides** the admin value. |
| `CLICTOPAY_PASSWORD`         | O   | _unset_               | ClicToPay merchant password.                                           |
| `CLICTOPAY_TEST_MODE`        | O   | _unset_               | `true` ⇒ test.clictopay.com.                                           |
| `FLOUCI_APP_TOKEN`           | O   | _unset_               | Flouci app token (env force-overrides admin value).                    |
| `FLOUCI_APP_SECRET`          | O   | _unset_               | Flouci app secret.                                                     |
| `FLOUCI_TEST_MODE`           | O   | _unset_               | Stored but **inert** — Flouci v2 has no sandbox host; test vs live is decided by which app credentials you enter. The admin panel hides Flouci's sandbox toggle for this reason. |
| `GOOGLE_CLIENT_ID`           | O   | _unset_               | Google OAuth client id. Normally set in `/admin/system/auth` (encrypted in DB); env value **force-overrides**. A provider is active only when BOTH id + secret resolve AND the `auth.social.google_enabled` toggle is on. In the Google console whitelist the redirect URI `<BETTER_AUTH_URL>/api/auth/callback/google` **exactly** (protocol/host/port/path) or sign-in fails with `redirect_uri_mismatch`. |
| `GOOGLE_CLIENT_SECRET`       | O   | _unset_               | Google OAuth client secret (same override semantics). |
| `FACEBOOK_CLIENT_ID`         | O   | _unset_               | Facebook OAuth app id (same override semantics). Redirect URI to whitelist: `<BETTER_AUTH_URL>/api/auth/callback/facebook`. Facebook does **not** guarantee an email (phone-only accounts / withdrawn consent) — a no-email sign-in fails gracefully with `error=email_not_found` + a French message and creates no account. |
| `FACEBOOK_CLIENT_SECRET`     | O   | _unset_               | Facebook OAuth app secret (same override semantics). |
| `OPENROUTER_API_KEY`         | O   | _unset_               | AI/automation provider key. Normally set in `/admin/system/ai` (encrypted in `ai_provider_settings`); env value **force-overrides**. |
| `DEEPSEEK_API_KEY`           | O   | _unset_               | DeepSeek key (same override semantics). |
| `OPENAI_API_KEY`             | O   | _unset_               | OpenAI key (same override semantics). |
| `ANTHROPIC_API_KEY`          | O   | _unset_               | Anthropic / Claude key (same override semantics). |
| `EMAIL_PROVIDER`             | O   | `console`             | `resend` \| `smtp` \| `internal` (local sendmail) \| `console` (logs only). `EMAIL_PROVIDER` / `EMAIL_FROM` / `EMAIL_REPLY_TO` apply until an admin deliberately picks a different value in Système → Mailing (`/admin/marketing/mailing`) → Réglages (that choice overrides the env; re-selecting the env value reverts to it). The transport (provider / SMTP / sendmail / secrets) is editable by the super-admin (`*`) only. |
| `EMAIL_FROM`                 | O   | `Tokyo Store <noreply@tokyostore.tn>` | Display sender. Override to `noreply@setup.tokyostore.tn` for the setup launch (see §11). |
| `EMAIL_REPLY_TO`             | O   | _unset_               | Reply-To header.                                                        |
| `RESEND_API_KEY`             | C*  | _unset_               | Required if `EMAIL_PROVIDER=resend` (unless set in the admin Mailing tab). `re_xxxxx`. |
| `SMTP_HOST`                  | C*  | _unset_               | Required if `EMAIL_PROVIDER=smtp` (unless set in the admin Mailing tab). |
| `SMTP_PORT`                  | O   | 587                   | Standard submission port.                                              |
| `SMTP_USER`                  | C*  | _unset_               | Required if `EMAIL_PROVIDER=smtp`.                                     |
| `SMTP_PASSWORD`              | C*  | _unset_               | Required if `EMAIL_PROVIDER=smtp`.                                     |
| `SMTP_SECURE`                | O   | false                 | `true` for implicit TLS on 465.                                        |
| `SENDMAIL_PATH`              | O   | _unset_               | Local sendmail binary for `EMAIL_PROVIDER=internal` (overrides the admin `mail.sendmail_path`; blank ⇒ platform default). |
| `S3_ENDPOINT`                | O   | `http://localhost:8333` | SeaweedFS S3 gateway URL (internal, app→store; prod `http://seaweedfs:8333`). |
| `S3_REGION`                  | O   | `us-east-1`           | Cosmetic for SeaweedFS; matters for real AWS.                          |
| `S3_BUCKET`                  | O   | `tokyo`            | Auto-created on first upload.                                          |
| `S3_ACCESS_KEY`              | O   | `seaweedfs`           | Set a real key in prod (`SERVICE_USER_SEAWEEDFS`; dev placeholder rejected at boot). |
| `S3_SECRET_KEY`              | O   | `seaweedfs_dev_secret`| Set a real secret in prod (`SERVICE_PASSWORD_SEAWEEDFS`; dev placeholder rejected at boot). |
| `S3_FORCE_PATH_STYLE`        | O   | false                 | Set to `true` for SeaweedFS.                                          |
| `S3_PUBLIC_URL`              | O   | `http://localhost:8333/tokyo` | Browser-facing base URL for uploaded media (only when serving from a dedicated storage domain — else the same-origin `/cdn` proxy is used). **Also a Build Argument** — baked into `images.remotePatterns` + CSP at build time. |
| `MEDIA_CDN_URL`              | O   | _unset_               | CDN base **fallback** for public media URLs. Precedence: `media_settings.cdn_base_url` (admin-editable DB field, primary) → `MEDIA_CDN_URL` (comma-separated; first entry used) → same-origin `/cdn` proxy. **Also a Build Argument** (like `S3_PUBLIC_URL`): baked into `images.remotePatterns` + the CSP at build time, so changing it requires a rebuild; a CDN base (DB or env) outside the build's allow-list is ignored at runtime (falls back to `/cdn`) and Médiathèque → Réglages (`/admin/media/settings`) warns about it. |
| `CSP_EXTRA_HOSTS`            | O   | _unset_               | Comma-separated extra hosts added to the CSP `script-src`/`connect-src`/`img-src`. For custom tracking tags (Suivi & Analytics → Code personnalisé) whose vendor isn't already allow-listed (GTM/GA4/Meta + TikTok/Hotjar/Clarity/LinkedIn are built-in). A host not listed is silently CSP-blocked. **Build Argument** — compiled into the served CSP, so changing it requires a rebuild; the compose passes it both as a build arg and as a runtime env (so the admin Sécurité tab shows the served policy). |
| `REVIEW_SCHEDULER_TICK_MS`   | O   | 1800000               | AI review-draft scheduler tick interval (ms). Blank ⇒ 30 min. Read directly from `process.env`. |
| `NEXT_PUBLIC_BUILD_SHA`      | O   | _unset_               | **Build Argument** — optional commit SHA surfaced on the admin Performance page for build provenance. Set as a Coolify Build Arg; unset ⇒ shown as "absent". |
| `NODE_BUILD_MEMORY`          | O   | 2048                  | **Build Argument** (builder stage only) — V8 heap ceiling (MB) for `next build` + `tsc`. See [Build memory](#build-memory-node_build_memory). |
| `NODE_RUNTIME_MEMORY`        | O   | _unset_               | **Build Argument** — optional runtime V8 heap ceiling (MB) for the live server; an explicit runtime `NODE_OPTIONS` wins. Keep it below the container memory limit. |

*C = Conditionally required (see notes).

> **Compose deployments:** when you deploy via `docker-compose.coolify.yml`
> (the Docker-Compose-resource path), Coolify only shows — and only injects —
> env vars that the compose file references as `${VAR}`. The app service's
> `environment:` block passes through the operator-settable vars above:
> `ADMIN_LOGIN_PATH`, `DISABLE_DEFAULT_ADMIN`, `BETTER_AUTH_TRUSTED_ORIGINS`,
> `CRON_SECRET`, `CRON_ALLOWED_IPS`, `ABANDONED_ORDER_HOURS`,
> `PAYMENT_RECONCILE_STALE_MINUTES` / `PAYMENT_RECONCILE_MAX_AGE_HOURS`, the
> `DB_*` tunables (`DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`,
> `DB_IDLE_TIMEOUT_MS`, `DB_CONNECTION_TIMEOUT_MS`, `DB_KEEPALIVE`,
> `DB_APPLICATION_NAME`, `DB_SSL_CA`), `MIGRATION_DATABASE_URL` (fixed to
> `postgres:5432`), the email vars incl. `SENDMAIL_PATH`, `MEDIA_CDN_URL` and
> `CSP_EXTRA_HOSTS` (also as build args), the optional social-login overrides
> `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `FACEBOOK_CLIENT_ID` /
> `FACEBOOK_CLIENT_SECRET` (a non-blank value force-overrides and locks the
> admin field), and `REVIEW_SCHEDULER_TICK_MS`. Payment (`CLICTOPAY_*` /
> `FLOUCI_*`) and AI provider credentials are **not** compose-passed by design —
> set them in the admin panel (encrypted in the DB) instead. `ADMIN_BOOTSTRAP_TOKEN`
> and `NODE_BUILD_MEMORY` are not in the compose either.

### Sample `.env` — initial launch (setup subdomain)

```env
NODE_ENV=production
NEXT_PUBLIC_SITE_URL=https://setup.tokyostore.tn

# Drop ?sslmode=require unless SSL is enabled on this Coolify DB (see §3).
DATABASE_URL=postgresql://tokyo:CHANGE@tokyo-postgres-abc:5432/tokyo?sslmode=require
# Only needed once DATABASE_URL points at PgBouncer (§3.5) — the DIRECT URL:
# MIGRATION_DATABASE_URL=postgresql://tokyo:CHANGE@tokyo-postgres-abc:5432/tokyo
DB_POOL_MAX=10
DB_STATEMENT_TIMEOUT_MS=10000
DB_APPLICATION_NAME=tokyo-setup

# Optional — omit to let the entrypoint generate + persist one. If set:
# ≥ 40 chars, ≥ 16 distinct characters (`openssl rand -base64 32`).
BETTER_AUTH_SECRET=GENERATE_VIA_openssl_rand_base64_32
BETTER_AUTH_URL=https://setup.tokyostore.tn

# ADMIN_BOOTSTRAP_TOKEN — leave unset: auto-generated while no admin exists and
# burned automatically once one does (§6c).

# Bearer for all 7 /api/cron/* routes (§12–§12f). Min 16 chars; unset ⇒ 503.
CRON_SECRET=GENERATE_VIA_openssl_rand_hex_32
# Optional: only these client IPs may call /api/cron/* (comma-separated).
# CRON_ALLOWED_IPS=

EMAIL_PROVIDER=resend
EMAIL_FROM="Tokyo Store <noreply@setup.tokyostore.tn>"
EMAIL_REPLY_TO=support@tokyostore.tn
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

S3_ENDPOINT=http://seaweedfs:8333
S3_REGION=us-east-1
S3_BUCKET=tokyo
S3_ACCESS_KEY=CHANGE_ME
S3_SECRET_KEY=CHANGE_ME
S3_FORCE_PATH_STYLE=true
# Only when serving media from a dedicated storage domain (else omit — the
# same-origin /cdn proxy is used):
# S3_PUBLIC_URL=https://s3.tokyostore.tn/tokyo
```

### Sample `.env` — after cutover to brand domain

Only three vars change:

```diff
- NEXT_PUBLIC_SITE_URL=https://setup.tokyostore.tn
+ NEXT_PUBLIC_SITE_URL=https://tokyostore.tn
- BETTER_AUTH_URL=https://setup.tokyostore.tn
+ BETTER_AUTH_URL=https://tokyostore.tn
- EMAIL_FROM="Tokyo Store <noreply@setup.tokyostore.tn>"
+ EMAIL_FROM="Tokyo Store <noreply@tokyostore.tn>"
```

Everything else (DB, secrets, S3 store, Resend key) stays
identical — see §11 for the full cutover procedure.

---

Built by **[Kawn Digital Studio](https://kawn.me)** for Tokyo Store. See [CREDITS.md](../CREDITS.md).

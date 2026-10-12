# Coolify deployment runbook

10-step path from "I have Coolify and a domain" to "site live on https://shop.example.com". Treat this as the canonical start-to-finish reference. For the long-form architecture see `docs/deployment-coolify.md`; for security posture see `docs/security.md`.

---

## 0. Prerequisites

- Coolify instance reachable on a public IP.
- DNS records ready (A record pointing at the Coolify host):
  - `shop.example.com` — public storefront
  - (optional) `s3.example.com` — ONLY if you serve media from a dedicated
    storage domain; by default media is served through the app's same-origin
    `/cdn` proxy and the object store needs no public DNS record
  - (optional) `s3-admin.example.com` — SeaweedFS filer file browser (port 8888)
- Resend or SMTP creds if you want real email; otherwise the `console` provider works for setup and logs verification links to stdout.

## 1. Create the resource

Coolify → Servers → your-server → Projects → **New Resource → Docker Compose Empty**.

## 2. Paste the compose

Open `docker-compose.coolify.yml` from this repo, copy the entire contents, paste into the Docker Compose Configuration textarea, **Save**.

## 3. Configure environment

Coolify auto-detects every `${...}` placeholder in the compose and renders form fields for them.

| Variable | Value | Notes |
|---|---|---|
| `PUBLIC_URL` | `https://shop.example.com` | The public URL users hit. |
| `SEAWEEDFS_PUBLIC_URL` | `https://s3.example.com` | OPTIONAL — browser-reachable object-store host (no bucket suffix). Only needed when serving media from a dedicated storage domain; omit to use the same-origin `/cdn` proxy. |
| `EMAIL_PROVIDER` | `resend`, `smtp`, `internal` (local sendmail) or `console` | `console` works for setup but lands in container logs. `EMAIL_PROVIDER` / `EMAIL_FROM` / `EMAIL_REPLY_TO` apply until an admin deliberately picks another value in Système → Mailing (`/admin/marketing/mailing`) → Réglages (that choice overrides the env; re-selecting the env value reverts to it). |
| `RESEND_API_KEY` | `re_xxx...` | Only if `EMAIL_PROVIDER=resend`. |
| `EMAIL_FROM` | `Tokyo Store <noreply@example.com>` | Display name + verified sender. |
| `EMAIL_REPLY_TO` | `support@example.com` | Where customer replies land. |
| `BETTER_AUTH_TRUSTED_ORIGINS` | (leave blank) | Only set if you serve from multiple hostnames. |

**Leave alone:** anything starting with `SERVICE_` (`SERVICE_PASSWORD_POSTGRES`, `SERVICE_PASSWORD_SEAWEEDFS`, `SERVICE_USER_SEAWEEDFS`) — Coolify auto-generates these and persists them across redeploys.

## 4. Configure build arguments

Coolify → resource → **Build Arguments** tab. These get inlined into the Next.js JS bundle at `next build` time — runtime env changes will not update them.

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | `https://shop.example.com` |
| `S3_PUBLIC_URL` | `https://s3.example.com/tokyo` (only if `SEAWEEDFS_PUBLIC_URL` is set) |
| `MEDIA_CDN_URL` | (optional) CDN host(s), same value as the env var |
| `CSP_EXTRA_HOSTS` | (optional) extra CSP hosts for custom tags, same value as the env var |

All must match the corresponding env values exactly (the compose feeds the build args from the same variables). Forgetting `S3_PUBLIC_URL` here will cause every uploaded image to return HTTP 400 with "hostname not configured under images in your next.config.ts". `MEDIA_CDN_URL` and `CSP_EXTRA_HOSTS` are compiled into `images.remotePatterns` and the served CSP, so changing either **requires a rebuild**; a CDN base the build didn't see is ignored at runtime (media falls back to `/cdn`).

## 5. Assign domains

Coolify → resource → **Domains** tab:

| Service | Domain | Port |
|---|---|---|
| `app` | `shop.example.com` | `3000` |
| `seaweedfs` | `s3.example.com` (optional — dedicated media domain) | `8333` |
| `seaweedfs` | `s3-admin.example.com` (optional — filer browser) | `8888` |

Coolify auto-issues Let's Encrypt for each. TLS is terminated at the Coolify proxy — backend services speak plain HTTP on the docker network.

## 6. Deploy

Click **Deploy**. Watch the build log. First boot takes ~2–4 minutes, in this order:

1. **Image build** — webpack prod build (`next build --webpack`) + `tsc --noEmit` type-check (a type error fails the deploy), then esbuild bundles the standalone DB runners. The build's V8 heap ceiling is the `NODE_BUILD_MEMORY` build arg (default 2048 MB); if the build dies, see [deployment-coolify.md "Build memory"](deployment-coolify.md#build-memory-node_build_memory).
2. **Migrations** — the entrypoint runs `node /app/db-runner/migrate.cjs` (bundled from [`src/lib/db/migrate.ts`](../src/lib/db/migrate.ts)) under a Postgres **session advisory lock** (key `72707468`), so concurrent/rolling boots don't race. It connects via `MIGRATION_DATABASE_URL` when set (the compose pins it to the direct `postgres:5432`), else `DATABASE_URL` — it must never go through PgBouncer. Migrations are now a **single squashed baseline** — `0000_squash_baseline.sql` creates the extensions (pgcrypto, pg_trgm, btree_gin, unaccent), the `uuid_generate_v7()` function, the `fr_unaccent` text-search config, all tables/enums/indexes, and the raw-SQL `app_secrets` + `rate_limit_buckets` tables. A **fresh** database applies it cleanly in one pass; see §6a if you are redeploying onto a DB that predates the squash. Hand-authored **incremental** migrations layered on top of the baseline (currently through `0130_media_white_bg_main_only` — 131 journalled entries: the `0000` baseline + the `0001`–`0130` chain; `0124` creates `pg_stat_statements`, which the compose's Postgres preloads; `0127` adds the inter-location stock-transfers subsystem) are applied in journal order by the same locked runner — idempotent (`IF NOT EXISTS` / `WHERE NOT EXISTS`), so re-running is safe. **⚠️ pgvector ordering:** `0112_product_embedding` runs `CREATE EXTENSION vector`, which only succeeds on a Postgres image that ships pgvector (`docker/pgvector/Dockerfile`). Redeploy the DB resource on the pgvector image **BEFORE** the app deploy that carries 0112, or the boot migrator aborts on that statement and the app won't start. The image swap is data-safe (same Alpine base, no reindex). Notable recent ones: `0033`/`0034` add RBAC + promote existing admins to `super_admin`; `0035` is a **no-op** (its column drops were deferred per the 3-deploy rule in §10); `0036_business_accounts` adds the B2B tables + `promotions.business_id`, **inert until `auth.business.enabled` is turned on**; `0037` adds trigram search indexes for the admin Clients list; `0038` finally performs the deferred `0035` column drops (`customer_profiles.date_of_birth`, `coin_levels.badge_color`, `promotions.description`) now that no instance reads them, plus drops a redundant orders phone-index left by `0032`; `0039` adds the missing `order_returns` / `order_return_items` foreign keys and drops the last dead column (`import_jobs.kind`) — best applied stop-start (see the migration's deploy note).
3. **Secret bootstrap** — `node /app/db-runner/init-secrets.cjs` (from [`src/lib/db/init-secrets.ts`](../src/lib/db/init-secrets.ts)) generates and persists three secrets to `app_secrets` unless already set in env (env always wins): `BETTER_AUTH_SECRET`, `PAYMENT_ENCRYPTION_KEY`, and `ADMIN_BOOTSTRAP_TOKEN`. Only `ADMIN_BOOTSTRAP_TOKEN` is echoed to the logs — and only while the bootstrap door is still open: once an admin exists the token is burned (see §10) and never regenerated. With the default admin enabled, that happens moments later on the same first boot (step 4), so the printed token is already dead. If `init-secrets` fails, the entrypoint **aborts the boot** (the container restarts) rather than starting the server without its secrets.
4. **Default-admin creation** — `instrumentation.ts` → `ensureDefaultAdmin()` seeds `houssem@kawn.me` on first boot (step 7) and assigns it the **`super_admin` RBAC role** (seeded by migration 0033, applied in step 2). On an existing-DB upgrade, migration 0034 backfills that role to every current `role='admin'` user — no manual step.
5. **Next.js JIT** — compile-on-first-request.

If the healthcheck flips to "unhealthy" within the first 2 minutes, that's the `start_period` (120s) — wait for it.

### 6a. ⚠️ One-time reset for databases that predate the squash (BREAKING)

The **original pre-squash** migration history was collapsed into the `0000_squash_baseline.sql` baseline above; the live chain now begins at that baseline and continues incrementally (`0001`–`0130`). A database deployed **before** the squash — whose `drizzle.__drizzle_migrations` ledger still holds the *original* pre-baseline entries — has **no incremental upgrade path** onto the rewritten ledger: it makes drizzle re-run `0000_squash_baseline.sql`, whose `CREATE TABLE` / `CREATE TYPE` statements collide with the objects the old chain already created.

This **only** affects an existing database that was deployed before the squash. A brand-new Coolify resource (fresh `postgres_data` volume) is unaffected — skip to step 7.

If you are redeploying onto a pre-squash database, you **must wipe and recreate** it (this destroys all data — back up first if you need it):

**Option A — drop the volume (simplest).** In Coolify, stop the resource, delete the `postgres_data` volume, then redeploy. The baseline applies clean against the empty DB.

**Option B — reset the schema in place** (keeps the volume; run in Coolify → postgres → Terminal):

```sql
DROP SCHEMA public CASCADE;
DROP SCHEMA IF EXISTS drizzle CASCADE;   -- removes the stale __drizzle_migrations ledger
CREATE SCHEMA public;
```

Then redeploy. On the next boot `migrate.cjs` recreates everything from the baseline and writes a fresh ledger (the `0000` baseline followed by the `0001`–`0130` chain). (`init-secrets` will regenerate `BETTER_AUTH_SECRET` etc. into the new `app_secrets`, so every existing session is invalidated and the default admin is re-seeded — capture the new password in step 7.)

## 7. Grab the admin password

Coolify → resource → **Logs** (`app` service). Find the boxed banner:

```
════════════════════════════════════════════════════════════════════
  ✨  DEFAULT ADMIN ACCOUNT CREATED
════════════════════════════════════════════════════════════════════
  email     : houssem@kawn.me
  password  : <random-24-char-string>

  → sign in at  /admin-login  (the STAFF portal)
  → change email/password at  /account
```

> **Sign in at the staff portal `/admin-login`** (or your secret
> `ADMIN_LOGIN_PATH` if configured). It's one account per email — the same
> credentials also work at the public `/login`, but the staff portal is the
> dedicated (optionally secret) admin entry. Whichever door is used, the `/admin`
> panel itself is gated by RBAC (`resolveAdminShellAccess`) — non-admins are
> 404'd there.

**The password is shown ONCE and is NOT written to the database** (storing it next to `BETTER_AUTH_SECRET` would turn any DB-read leak into instant admin). If the log already scrolled or you missed it, reset via `https://shop.example.com/forgot-password` (the seeded admin email is `houssem@kawn.me`).

To opt out of the auto-seeded admin entirely (e.g. you prefer the `ADMIN_BOOTSTRAP_TOKEN` flow), set `DISABLE_DEFAULT_ADMIN=true` in the app env.

> **Tip — seed the admin at YOUR real address.** Set `DEFAULT_ADMIN_EMAIL=you@your-domain.com` in the app env **before the first boot** and the bootstrap admin is created at that address instead of `houssem@kawn.me`. This matters because the self-serve email change (step 8.2) now sends its confirmation link to your **current** mailbox (an anti-takeover protection), so the seeded address must be one you can actually receive mail at. A blank/invalid value falls back to `houssem@kawn.me`.

## 8. Sign in + change credentials

1. Visit `https://shop.example.com/admin-login` (the **staff** portal, or your secret `ADMIN_LOGIN_PATH`; the same account also works at `/login` — `/admin` is RBAC-gated either way), sign in with the email + password from step 7.
2. Go to `/account` — change your password, and (if you didn't seed `DEFAULT_ADMIN_EMAIL`) your email. **The email-change confirmation link is sent to your CURRENT address**, so you must be able to receive mail at the seeded address to complete it. If the seeded `houssem@kawn.me` isn't a mailbox you control, don't use self-serve change — instead invite yourself at your real address as a super-admin via `/admin/users` (that invitation link IS delivered to the new address), then disable the seeded account.
3. (Optional) Promote a second admin via `/admin/users`.

## 9. (Optional) Import demo content

`/admin/system/import-demo` → the segmented import panel (« Tout importer » or one segment at a time; runs as a background data job, so it needs the « Tâches planifiées » `system_jobs:manage` grant on top of `system_demo`). Seeds the category tree, brands, banners, FAQs, typed settings (plus, with « Tout importer », the logo, home editorial blocks, loyalty tiers and the B2B « Partner » levels) and the catalogue imported from the product feed, with images uploaded to the object store and re-encoded to webp/avif per the current media settings (exact per-type counts are shown live on the panel). The import is idempotent — a re-run re-uses existing rows by stable slug/key, only **fills blank fields** (it never overwrites admin editorial, SEO text or category FAQs) and never re-parents a category an admin moved. There is **no demo-only undo**: cleanup lives in Contenu & Design → Identité & contact (`/admin/cms/settings`, « Réglages site ») → « Nettoyage des données — zone sensible » (super-admin `*` only, irreversible, and it wipes the **whole** segment, not just demo rows).

## 10. Verify + close back-doors

```bash
# Health endpoint (liveness — what the container HEALTHCHECK calls)
curl -fs https://shop.example.com/api/health
# → {"status":"ok",...}

# Readiness (env valid + SELECT 1) — for external monitoring
curl -fs "https://shop.example.com/api/health?ready=1"
# → {"status":"ok",...,"checks":{"env":true,"db":true}}   (503 "not-ready" otherwise)

# Bootstrap back-door is closed once an admin exists
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://shop.example.com/api/admin/bootstrap \
  -H "Content-Type: application/json" -d '{"token":"not-the-token","email":"probe@example.com"}'
# → 404

# HSTS header (only sent on HTTPS)
curl -fsI https://shop.example.com/ | grep -iE "strict|content-security"
# → Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
# → Content-Security-Policy: default-src 'self'; ...

# Search endpoint with rate limit
for i in {1..70}; do curl -s -o /dev/null -w "%{http_code} " "https://shop.example.com/api/store/search?q=ps"; done
# → first ~60 are 200, then 429s

# Object-store bucket — anonymous LIST must be blocked (SeaweedFS anonymous identity is read-only)
curl -s -o /dev/null -w "%{http_code}\n" "https://s3.example.com/tokyo/?list-type=2"
# → 403 (not 200!)
```

**The bootstrap back-door closes itself** — nothing to do. The token is burned automatically as soon as any admin exists: when the default admin is created, on the first successful `POST /api/admin/bootstrap`, or on any boot that finds an active admin (including installs with `DISABLE_DEFAULT_ADMIN=true`). The app deletes the persisted `ADMIN_BOOTSTRAP_TOKEN` row and records `ADMIN_BOOTSTRAP_CLOSED` in `app_secrets`, so the route returns 404 for good and `init-secrets` stops exporting or regenerating the token. To deliberately re-open it after a true lockout: `DELETE FROM app_secrets WHERE key='ADMIN_BOOTSTRAP_CLOSED';` then restart — a fresh token is generated and printed once. (An `ADMIN_BOOTSTRAP_TOKEN` key present but empty in the container env also disables the route; it must be passed through the compose file to take effect.)

**Wire the daily data-retention purge.** Fifteen purge targets — the `RETENTION_TARGETS` inventory in `src/lib/retention/windows.ts` (see the table in [deployment-coolify.md §12](deployment-coolify.md)): `search_log`, `webhook_events`, `webhook_deliveries`, `audit_log`, ephemeral quick-buy `carts` (`qb-…`), stale guest `carts` and guest `wishlists` (by last activity), `job_run_log`, `email_logs` (pinned rows excluded), `mailing_sends`, `cart_events`, `app_instance_heartbeats`, `ai_call_logs`, and expired Better Auth `sessions` / `verifications`. The `search_log` / `audit_log` windows come from settings (`search.purge_months` / `audit.retention_months` × 30); if that settings read fails, those two purges are **skipped** (never run with a shorter default). [`POST /api/cron/retention`](../src/app/api/cron/retention/route.ts) batch-purges them past their window, gated by a constant-time `CRON_SECRET` Bearer check (returns **503** while the secret is unset so it never runs unguarded, **401** on mismatch; optional `CRON_ALLOWED_IPS` allow-list → **403**).

1. Coolify → resource → **Environment** → add `CRON_SECRET` (min 16 chars; `openssl rand -hex 32`) → Save → Redeploy.
2. Coolify → resource → **Scheduled Tasks** → add a task, frequency `0 3 * * *` (daily 03:00), command:

   ```bash
   curl -fsS -X POST https://shop.example.com/api/cron/retention \
     -H "Authorization: Bearer $CRON_SECRET"
   ```

   `-f` makes a 4xx/5xx exit non-zero so a failed purge shows as a failed run in Coolify's task history. A healthy run returns `{"ok":true,"status":"ok","deleted":{...},"errors":{}}`. See [deployment-coolify.md §12](deployment-coolify.md) for details.

**Wire the other scheduled tasks** (same `CRON_SECRET`, same `curl -fsS -X POST … -H "Authorization: Bearer $CRON_SECRET"` shape). Eight cron routes in total — the full table with cadences is [deployment-coolify.md §12–§12f](deployment-coolify.md):

| Route | Cadence | Why |
|---|---|---|
| `/api/cron/retention` | `0 3 * * *` | Retention purge (above). |
| `/api/cron/payments` | `*/12 * * * *` | **Required for online payments** — settles/cancels orders stuck `pending`. |
| `/api/cron/abandoned-orders` | `7 * * * *` | Releases stock held by unconfirmed `pending` orders. |
| `/api/cron/mailing` | `*/2 * * * *` | Mail queue drain — campaigns + bulk automations never send without it. |
| `/api/cron/webhooks` | `*/2 * * * *` | Outbound ERP webhook deliveries — queued webhooks never leave without it. |
| `/api/cron/birthday` | `10 0 * * *` | Birthday emails. |
| `/api/cron/review-request` | `30 9 * * *` | Review-request emails. |
| `/api/cron/detourage` | `0 4 * * *` | Product-image détourage back-fill. **No-op unless** the "Détourage automatique" media setting is on; idempotent (skips images already `-nobg`), so a daily run only touches new product images. Optional. |

Each job can also be paused or run on demand (« Exécuter maintenant », no `CRON_SECRET` needed) from **Système → Tâches planifiées**.

**Schedule daily Postgres backups:**

```
Coolify → resource → Backups → enable daily snapshots of postgres_data
```

SeaweedFS volumes are NOT auto-backed up by Coolify; if you care about your uploaded images, mirror the bucket to an offsite S3 with `rclone sync` on a cron.

---

## Production rename checklist (set via env — do NOT edit code defaults)

A handful of infrastructure identifiers still carry the original fork's
`tokyo` naming **as their built-in code defaults**. These defaults are
intentional **local-dev** values (they match `docker-compose.dev.yml`, the
local SeaweedFS bucket, and the dev Postgres role) — **do not change them in code**,
or you will break every developer's local stack. Instead, the production
operator MUST override each of them with real Tokyo Store values in the
Coolify environment (and Build Arguments where noted). Env always wins over the
code default.

| Identifier | Code default (dev — leave as-is) | Set in production to | Where to set |
|---|---|---|---|
| `S3_BUCKET` | `tokyo` | your production bucket name (e.g. `tokyo-watch-store`) | Environment. Auto-creates on first upload. |
| `S3_PUBLIC_URL` | `http://localhost:8333/tokyo` | `https://s3.<your-domain>/<bucket>` (only if serving from a dedicated storage domain) | **Environment AND Build Arguments** — baked into `images.remotePatterns` + CSP at build time, so it must match in both. |
| `S3_ENDPOINT` | local SeaweedFS (`http://localhost:8333`) | `http://seaweedfs:8333` (internal) | Environment. |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | `seaweedfs` / `seaweedfs_dev_secret` | real generated keys (`SERVICE_USER_SEAWEEDFS` / `SERVICE_PASSWORD_SEAWEEDFS`) | Environment. The compose feeds the SAME two to the `seaweedfs` service, so the app (writer) and the store agree. |
| `DATABASE_URL` (+ `MIGRATION_DATABASE_URL`) | `postgresql://tokyo:tokyo_dev_pwd@…/tokyo` | real role / password / DB name (e.g. `tokyo` / strong pwd / `tokyostore`) | Environment. The compose path auto-generates the Postgres password and derives both URLs from it (`MIGRATION_DATABASE_URL` = the direct `postgres:5432`). |
| `DB_USER` / `DB_NAME` / `DB_HOST` (PgBouncer path) | `tokyo` | match your production Postgres role + DB | Environment. |
| Object-store / CSP base | derived from `S3_PUBLIC_URL` (dev `localhost:8333/tokyo` fallback in `src/lib/security/headers.ts`) | covered automatically once `S3_PUBLIC_URL` is set correctly above | n/a — driven by `S3_PUBLIC_URL`. |
| `NEXT_PUBLIC_SITE_URL` / `PUBLIC_URL` / `BETTER_AUTH_URL` | local URLs | `https://<your-domain>` (e.g. `https://tokyostore.tn`) | Environment + Build Arguments (`NEXT_PUBLIC_SITE_URL`). |
| `EMAIL_FROM` / `EMAIL_REPLY_TO` | dev sender | `Tokyo Store <noreply@<your-domain>>` / `support@<your-domain>` | Environment. |

> **Why not just fix the code defaults?** They are consumed by the local Docker
> stack (`docker-compose.dev.yml`), the dev SeaweedFS service, and the dev
> Postgres role/seed scripts. Renaming them in `src/lib/env.ts` /
> `src/lib/security/headers.ts` would diverge from those fixtures and break
> `pnpm db:up` + local media for every developer. Production correctness comes
> from **setting env**, not editing the fallbacks.

---

## Operational tips

### Rotating `BETTER_AUTH_SECRET`

```sql
-- Coolify → postgres terminal:
DELETE FROM app_secrets WHERE key = 'BETTER_AUTH_SECRET';
```

Then redeploy. The container will generate a fresh secret. **This invalidates every active session** — users will need to sign in again.

### Forcing a fresh admin password reset

The `app_secrets` table does NOT store the admin password (P0 hardening — see `docs/security.md`). Use `/forgot-password` with `houssem@kawn.me`.

### Re-creating the default admin from scratch

```sql
DELETE FROM users WHERE email = 'houssem@kawn.me';
DELETE FROM app_secrets
  WHERE key IN ('DEFAULT_ADMIN_BOOTSTRAPPED','DEFAULT_ADMIN_EMAIL');
```

Restart the container — `ensureDefaultAdmin()` will re-fire and print the new password to logs.

### Enabling Google/Facebook login (OAuth)

Social login is OFF until credentials are set; no code change is needed.

1. **Set the credentials.** In **Admin → Clients → Connexion & comptes → Connexion sociale**, paste each provider's Client ID + Client secret (encrypted at rest) and flip its toggle on. (Alternatively set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` / `FACEBOOK_CLIENT_ID`/`FACEBOOK_CLIENT_SECRET` env vars — a set env var **force-overrides** and locks the field.) A provider goes live only when BOTH credentials resolve **and** its toggle is on.
2. **Whitelist the redirect URI in the provider console — this is the #1 cause of `redirect_uri_mismatch`.** better-auth builds the callback from `BETTER_AUTH_URL`, so register **exactly**:
   - Google Cloud console → Credentials → Authorized redirect URIs: `<BETTER_AUTH_URL>/api/auth/callback/google`
   - Facebook app → Facebook Login → Valid OAuth Redirect URIs: `<BETTER_AUTH_URL>/api/auth/callback/facebook`

   Protocol, host, port and path must match character-for-character. The admin panel prints the exact URL to paste (built from `BETTER_AUTH_URL`).
3. **Keep `BETTER_AUTH_URL` == `NEXT_PUBLIC_SITE_URL`** unless you deliberately serve auth from a separate hostname. They are separate env vars; the OAuth `redirect_uri` follows `BETTER_AUTH_URL`, and the panel warns when the two origins differ.
4. **Google is auto-linkable, Facebook is not.** A Google sign-in whose verified email matches an existing password account links automatically (`users.oauth_autolink`, default ON since migration 0157) — EXCEPT an account with 2FA enabled, which always requires a full password + TOTP sign-in. Facebook never auto-links (its email isn't provably owner-verified). Facebook also does **not** guarantee an email; a no-email sign-in fails gracefully with a French message and creates no account.
5. **Verify on a real deploy.** The OAuth callback path can't be exercised locally — do one live Google and one live Facebook sign-in on staging before relying on it.

### Enabling PgBouncer (multi-instance scale-out)

Activate the `pooler` Compose profile in Coolify (the `pgbouncer` service — `edoburu/pgbouncer:v1.23.1-p3` — runs in transaction-pool mode), then in env point **only** `DATABASE_URL` at the pooler:

```
DATABASE_URL=postgresql://<user>:<password>@pgbouncer:5432/<db>
# leave as the compose sets it — the DIRECT connection:
MIGRATION_DATABASE_URL=postgresql://<user>:<password>@postgres:5432/<db>
```

The app issues only unnamed parameterized queries (no Drizzle `.prepare()` anywhere) and holds no `LISTEN/NOTIFY` and no long-lived session advisory locks at **request** time, so transaction pooling is safe for normal traffic. The compose's `MAX_PREPARED_STATEMENTS=256` is harmless headroom for the day prepared-statement caching is added.

Two caveats the pooler config must honour:

1. **Startup parameters.** The app's `pg` Pool sends `statement_timeout` as a standalone PostgreSQL StartupMessage parameter and `lock_timeout` / `idle_in_transaction_session_timeout` as `-c` keys inside the `options` parameter (`src/lib/db/client.ts`). PgBouncer rejects any connection carrying a startup param it doesn't know, so `IGNORE_STARTUP_PARAMETERS` **must** be `extra_float_digits,application_name,statement_timeout,lock_timeout,idle_in_transaction_session_timeout,options` — as in both compose files. "Ignored" means PgBouncer does **not** apply them server-side; under the pooler the timeouts come from the role-level `lock_timeout` / `idle_in_transaction_session_timeout` defaults set by migration `0117` (applied server-side per backend, so they survive the pooler) and from the client-side `query_timeout` (statement cap, default 10 s).

2. **Migrations need a DIRECT connection.** `src/lib/db/migrate.ts` holds a **session-level** advisory lock and per-session timeouts across the whole migration run — these require a stable 1:1 session↔backend binding that transaction pooling does not provide. The migrator (and `init-secrets`) use `MIGRATION_DATABASE_URL` when set, else `DATABASE_URL`; the Coolify compose pins `MIGRATION_DATABASE_URL` to `postgres:5432`, so switching `DATABASE_URL` to the pooler is safe. On a custom setup, set `MIGRATION_DATABASE_URL` to the direct Postgres URL yourself — never `pgbouncer:5432`.

### Adding a custom error/log destination

App logs all go to stdout. Coolify → resource → **Logs** tab is the live view. For long-term aggregation, configure Coolify's "Custom Log Driver" pointing at Loki / Grafana / Datadog.

---

Built by **[Kawn Digital Studio](https://kawn.me)** for Tokyo Store. See [CREDITS.md](../CREDITS.md).

# Requirements

Everything you need to install, deploy, and operate Tokyo Store.

## Architectural conventions (non-negotiable)

The codebase follows a **Medusa.js-inspired modular monolith** pattern. The
canonical specification lives in [docs/modules.md](docs/modules.md); every
contribution is reviewed against the conformance checklist in §9 of that
document. The lineage is deliberate — we curated the Medusa Agent Skills
corpus and adapted it where Next.js's primitives diverge from Medusa's. Read
[docs/modules.md §3](docs/modules.md#3-medusa--tokyo-watch-store-mapping) for the
side-by-side translation table.

The five rules every new module must satisfy:

1. **One folder per domain** — `src/modules/<name>/{schema,service,queries,index}.ts`.
2. **No cross-module foreign keys in Drizzle code** — joins live in `src/associations/`.
3. **Services do CRUD; workflows orchestrate** — pages never call services.
4. **Events decouple side effects** — workflows emit, subscribers react
   (in-process bus: [src/events/bus.ts](src/events/bus.ts)).
5. **Validate at the boundary** — Zod next to the route / action.

Codebase-wide conventions layered on since:

6. **Money is integer millimes** (1 TND = 1000 millimes). The single source
   of truth is [src/lib/price.ts](src/lib/price.ts) (`MINOR_PER_DINAR`, the
   `formatMoney*` family, `minorToDinars` / `dinarsToMinor`). Columns named
   `*_cents` are **legacy names that hold millimes** — never rename them,
   never assume a ×100 scale. Admin price inputs take dinars; display
   precision comes from the `price.decimals` setting
   ([src/lib/price-format.ts](src/lib/price-format.ts) + the `useMoney` hook
   in [src/components/money-provider.tsx](src/components/money-provider.tsx)).
7. **uuid v7 primary keys everywhere**, via the shared `id()` helper in
   [src/lib/db/columns.ts](src/lib/db/columns.ts) (`uuid_generate_v7()`,
   defined in the migration baseline). No `gen_random_uuid()`, no serials.
8. **Soft deletes for content** via the `softDelete()` helper (`deleted_at`);
   hard deletes only for PII (right-to-erasure) and ephemeral rows
   (sessions, rate-limit buckets).
9. **Squashed migration baseline + a live numbered chain.** The pre-0000
   history was squashed into
   [0000_squash_baseline.sql](src/lib/db/migrations/0000_squash_baseline.sql),
   and the chain then continues `0001..0138` (139 `.sql` files incl. the baseline = 139 journal
   entries; next is `0139`). To change the DB: edit the module `schema.ts`,
   make sure it is re-exported from the
   [src/lib/db/schema.ts](src/lib/db/schema.ts) barrel (drizzle-kit only sees
   the barrel), then **hand-write the migration SQL + a journal entry** and
   `pnpm db:migrate`. (`pnpm db:generate` is guarded/disabled — the meta-snapshots
   are frozen at `0007`, so it would emit a destructive diff; escape hatch
   `pnpm db:generate:force`.) Never edit an applied migration.
10. **FKs and CHECKs are added in migration SQL**, not via `.references()`
    in `schema.ts` (sole exception: Better Auth's own tables in
    [src/modules/auth/schema.ts](src/modules/auth/schema.ts)). On a live
    database add constraints `NOT VALID` first, and dedup before creating
    unique indexes.
11. **PgBouncer transaction pooling is a design constraint** — no
    `LISTEN/NOTIFY`, no session-level `SET`. Side effects ride the
    in-process event bus; rate limiting is a Postgres-backed token bucket
    (`rate_limit_buckets`).
12. **No hardcoded storefront copy.** All French storefront text is
    settings-driven ([src/modules/cms/setting](src/modules/cms/setting));
    sections hide when their setting is unset.
13. **Images flow through the médiathèque only** — the media module
    ([src/modules/media](src/modules/media): SeaweedFS + sharp webp/avif
    pipeline, SSRF-safe URL import). No raw external image URLs in content.
14. **One select component** —
    [src/components/ui/select-field.tsx](src/components/ui/select-field.tsx)
    (`SelectField` client listbox + `NativeSelect` for no-JS GET forms).
    No ad-hoc dropdowns.
15. **`pnpm typecheck` must stay green.** The production build skips type
    errors, so `tsc --noEmit` is the gate — run it before every merge.

If your change can't honour these, escalate before merging — they exist
because each one has been broken before and the cost of unwinding is steep.

## Runtime requirements

| Component   | Version       | Notes                                                  |
| ----------- | ------------- | ------------------------------------------------------ |
| Node.js     | **22 LTS**    | Docker image pins `node:22-alpine`; scripts rely on `--env-file-if-exists` |
| pnpm        | **9.x**       | Pinned via `packageManager` in package.json            |
| PostgreSQL  | **16**        | Baseline enables `pgcrypto`, `pg_trgm`, `btree_gin`, `unaccent` + defines `uuid_generate_v7()`; prod sits behind PgBouncer (transaction pooling) |
| Docker      | 24+           | For local dev and Coolify deploy                       |
| SeaweedFS   | 4.47          | Or any S3-compatible store (Cloudflare R2, AWS S3...)  |
| sharp       | bundled       | Linux/macOS prebuilt — Alpine uses musl variant        |

## External services

| Service         | Required?     | Used for                                                |
| --------------- | ------------- | ------------------------------------------------------- |
| Resend          | optional      | Transactional email (verify, reset, receipts)           |
| SMTP server     | optional      | Alternative to Resend — any provider                    |
| ClicToPay       | optional      | Tunisia payment gateway (Monétique Tunisie / SMT)        |
| Flouci          | optional      | Tunisia payment gateway                                  |

You can ship without ANY of these — set `EMAIL_PROVIDER=console` to log
emails to stdout in dev, and leave the payment gateway credentials unset
(each provider reports "non configuré" and the storefront offers only COD —
cash on delivery). Gateway credentials can also be entered in the admin
panel (`/admin/system/payments`), stored encrypted in the
`payment_provider_settings` table; env vars force-override the DB values.

## Environment variables

The schema lives in [src/lib/env.ts](src/lib/env.ts) — validated lazily, and
the app refuses to start in production if a required var is missing or still
a dev placeholder. Reference:

### Required

| Variable                | Example                                                          | Purpose                                 |
| ----------------------- | ---------------------------------------------------------------- | --------------------------------------- |
| `DATABASE_URL`          | `postgresql://tokyo:pwd@host:5432/tokyo`                         | Drizzle pg pool                         |
| `BETTER_AUTH_SECRET`    | 32+ random chars — auto-generated on first boot if unset         | Session token signing                   |
| `BETTER_AUTH_URL`       | `https://tokyostore.tn`                                    | Better Auth canonical base URL          |
| `NEXT_PUBLIC_SITE_URL`  | `https://tokyostore.tn`                                    | OG tags, sitemap, email links           |
| `S3_*` set              | see below                                                        | SeaweedFS / R2 / S3 client                  |

### Optional

| Variable                  | Default        | Purpose                                            |
| ------------------------- | -------------- | -------------------------------------------------- |
| `NODE_ENV`                | `development`  | Standard Node mode flag                            |
| `DB_SSL_CA`               | —              | CA bundle (PEM or path) for verified Postgres TLS  |
| `EMAIL_PROVIDER`          | `console`      | `resend` / `smtp` / `console` / `internal`         |
| `EMAIL_FROM`              | "Tokyo Store…" | Sender header                                |
| `EMAIL_REPLY_TO`          | —              | Reply-To header                                    |
| `RESEND_API_KEY`          | —              | If `EMAIL_PROVIDER=resend` (or set in admin Mailing tab) |
| `SMTP_HOST/PORT/USER/...` | —              | If `EMAIL_PROVIDER=smtp` (or set in admin Mailing tab) |
| `ADMIN_BOOTSTRAP_TOKEN`   | —              | Enables `POST /api/admin/bootstrap` (min 8 chars)  |
| `DISABLE_DEFAULT_ADMIN`   | `false`        | Skips the auto-created `admin@tokyostore.tn` on first boot |
| `CRON_SECRET`             | —              | Bearer token for `POST /api/cron/retention` (min 16 chars; unset ⇒ 503, purge disabled) |
| `PAYMENT_ENCRYPTION_KEY`  | —              | Encrypts admin-entered gateway creds at rest (auto-generated if unset) |
| `CLICTOPAY_USERNAME` / `_PASSWORD` / `_TEST_MODE`   | — | ClicToPay (SMT) credentials (override admin)  |
| `FLOUCI_APP_TOKEN` / `_APP_SECRET` / `_TEST_MODE`   | — | Flouci credentials (override admin)           |
| `MEDIA_CDN_URL`           | —              | CDN base fallback — the primary is the `cdn_base_url` field in admin media settings (see [docs/media.md](docs/media.md)) |

### Storage (S3 / SeaweedFS)

```env
S3_ENDPOINT=http://localhost:8333        # SeaweedFS S3 gateway (dev compose)
S3_REGION=us-east-1                      # arbitrary for SeaweedFS
S3_BUCKET=tokyo
S3_ACCESS_KEY=seaweedfs
S3_SECRET_KEY=seaweedfs_dev_secret
S3_FORCE_PATH_STYLE=true                 # required by SeaweedFS
S3_PUBLIC_URL=http://localhost:8333/tokyo
```

For Cloudflare R2: leave `S3_FORCE_PATH_STYLE=false`, set
`S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`, and put your
custom domain in `S3_PUBLIC_URL`.

## Dependencies

A few key picks (see [package.json](package.json) for the full list):

| Layer        | Pick                                       | Why                                                            |
| ------------ | ------------------------------------------ | --------------------------------------------------------------- |
| Framework    | Next.js 16 + React 19                      | Server Components + Server Actions; Turbopack dev, **webpack prod build** |
| DB           | PostgreSQL 16                              | Relational integrity — no JSON content blobs                   |
| ORM          | drizzle-orm 0.45                           | SQL-as-TS, no codegen, fast migrations                          |
| Auth         | better-auth 1.4                            | Email+pwd, hooks for disabled-account enforcement               |
| Validation   | zod 4                                      | Forms ↔ Server Actions ↔ API routes share schemas              |
| Storage      | @aws-sdk/client-s3                          | Works against SeaweedFS, R2, S3 unchanged                           |
| Images       | sharp 0.34                                 | WebP/AVIF variants + EXIF strip + resize at upload              |
| Email        | resend / nodemailer                        | Provider-agnostic interface in `lib/email/`                     |
| Tables       | @tanstack/react-table 8                    | Headless data grid for admin                                    |
| Logger       | event-bus structured-logger subscriber     | One JSON line per event via `console.log` → stdout to the log shipper |
| Sanitisation | isomorphic-dompurify                       | XSS prevention on TipTap-produced HTML                          |

## What you'll need before going live

1. A **Coolify** instance (any 4 vCPU / 8 GB VPS — Hetzner, OVH, DigitalOcean)
2. A **domain** with DNS pointed at Coolify — Coolify auto-issues Let's Encrypt
3. A **Resend account** OR any **SMTP** server with good deliverability
4. A **payment account** (ClicToPay / Flouci) — only when you wire payments

**That's the full external dependency list.** Postgres + SeaweedFS ship as
containers inside the Coolify-managed Docker stack — no external SaaS
required. Secrets (`BETTER_AUTH_SECRET`, `PAYMENT_ENCRYPTION_KEY`,
`ADMIN_BOOTSTRAP_TOKEN`) auto-generate on first boot and persist in the
`app_secrets` table — no `openssl` ceremony. A default admin
(`admin@tokyostore.tn`) is created on first boot with a random password
printed once to the deploy logs.

After deploy, wire the daily data-retention purge (a Coolify scheduled task
hitting `POST /api/cron/retention` with `CRON_SECRET`) — see
[docs/deployment-coolify.md §12](docs/deployment-coolify.md).

### Two deploy paths

- **One-file compose** (recommended for first deploy) — paste
  [`docker-compose.coolify.yml`](docker-compose.coolify.yml) into Coolify
  as a single Docker Compose resource. Everything (app + Postgres + SeaweedFS
  + bucket init) comes up together.
- **Three separate Coolify resources** (more ops control) — provision
  Postgres, SeaweedFS, and the Application resource individually. Better for
  fine-grained backup schedules and DB version upgrades.

Step-by-step for both paths: [docs/deployment-coolify.md](docs/deployment-coolify.md).

---

Built by **[Kawn Digital Studio](https://kawn.me)** for Tokyo Store. See [CREDITS.md](CREDITS.md).

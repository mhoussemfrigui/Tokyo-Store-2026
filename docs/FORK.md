# Forking / rebranding this codebase

This app is built to be **forked into a new store with zero code edits** — every
storefront string, colour, logo, and contact detail is a DB setting or an env
var, with neutral code only as a last-resort fallback. This guide is the
checklist for standing up a fresh, rebranded instance.

> Nothing below requires touching `src/`. If you find yourself editing a
> component to change a label/colour/logo, stop — it's almost certainly a CMS
> setting (see §2).

---

## 1. What's generic vs. store-specific

**Generic (reuse as-is):** the entire engine — catalog, cart, checkout, orders,
payments (ClicToPay/Flouci/COD), tax, delivery, promotions, mailing,
CMS/theme, RBAC, media pipeline, search, the external/ERP API. None of it hardcodes store-specific branding behaviour.

**Store-specific (set per fork):** brand identity + contact details, theme
colours/fonts/logo, SEO defaults, the catalog itself, payment/email credentials,
and which optional features you switch on. All of these are settings or env.

**Last-resort code fallbacks** (only used when the matching setting is unset):
`DEFAULT_SITE_NAME` ([src/lib/seo/config.ts](../src/lib/seo/config.ts)),
`FALLBACK_NAME`/tagline/address/contact ([src/modules/mailing/brand.ts](../src/modules/mailing/brand.ts)),
and the bootstrap admin email (§4). They exist so an unconfigured instance still
renders; set the real values and they're never read.

---

## 2. Rebrand via admin settings (no deploy)

All of these live in the admin UI and are stored in `site_settings` (DB). Set
them once after first boot:

| Area | Where (admin) | Keys |
| --- | --- | --- |
| Identity + contact | Contenu & Design → Identité & contact (`/admin/cms/settings`) | `site.name`, `site.tagline`, `site.description`; multi-value lists `site.contact_phones` / `site.contact_emails` / `site.addresses` (JSON `{v,f}`) each with a synced primary `site.contact_phone` / `site.contact_email` / `site.address`; `site.whatsapp`, `site.hours`, `site.map_embed_url` |
| Socials | Contenu & Design → Identité & contact (+ Footer) | `social.instagram` / `facebook` / `x` / `youtube` / `tiktok` / `linkedin` |
| Legal (invoices) | Contenu & Design → Identité & contact | `business.legal_name`, `business.tax_id` |
| Theme | Contenu & Design → Thème & design | `theme.primary_color`, `theme.primary_foreground`, `theme.accent_color`, `theme.accent_foreground`, `theme.foreground_color`, `theme.border_radius_base`, `theme.font_family`, `theme.dark_mode`, `theme.favicon_media_id`, `theme.default_og_media_id` |
| Logo | Contenu & Design → Identité & contact | `site.logo_media_id` (médiathèque) |
| SEO | Système → SEO & schéma | `seo.site_url`, `seo.title_template`, `seo.default_title`, `seo.default_description`, `seo.og_image_media_id`, `seo.twitter_handle`, social profile URLs. `seo.site_url` (the origin of payment return URLs, email links, invites and order QR codes) can only be changed by the super-admin (`*`) and must be a bare `https://domain` origin — no path, query or fragment |
| Storefront copy | Contenu & Design → Page d'accueil / Catalogues / Pages | the home is an operator-composed instance block layout (`home.blocks`, edited in `home-composer.tsx`); the legacy `home.*` keys are the dormant fresh-install synthesis seed. Collection pages, system pages — all hide-when-unset |
| Listing display mode | Contenu & Design → Page d'accueil (onglet « Pages listing ») | `storefront.listing_display_mode` — how the product grid paginates on every listing surface (category/brand): `load_more` (default), `infinite`, or `pagination`. The top "thumbs" strip auto-adapts per page type (category tree / brands) — no setting needed. |
| Mega-menu featured images | Contenu & Design → Nav Menu (« Panneaux vedettes du menu » cards) | `nav_boutique` / `nav_marques` / `nav_maison` placements — one médiathèque image + eyebrow / title / link per top-level nav dropdown; unset ⇒ no featured panel |
| Email branding | Système → Mailing (`/admin/marketing/mailing`) → Réglages | `mail.from` + brand identity is pulled from `site.*` |

The catalog (products/categories/brands), banners, navigation, FAQ, and blog
content are all admin-managed too — seed your own or import via
`/admin/system/import` (Google-Merchant XML / CSV).

---

## 3. Environment variables

Secrets and infra config live in env (Coolify → app → Environment). See
[.env.example](../.env.example) for the full list; the fork-critical ones:

**Required**
- `DATABASE_URL` — Postgres (PgBouncer transaction pooling in prod). The DB
  image must ship **pgvector** (migration `0112` runs `CREATE EXTENSION
  vector`) — see [deployment-coolify.md §1](deployment-coolify.md).
- `MIGRATION_DATABASE_URL` — the **direct** Postgres URL, required whenever
  `DATABASE_URL` points at PgBouncer (the boot migrator's session advisory lock
  can't go through the pooler). The Coolify compose sets it to `postgres:5432`.
- `NEXT_PUBLIC_SITE_URL` — your canonical https URL (drives payment return URLs, email links, OG). **Build Argument** (inlined at `next build`).
- `BETTER_AUTH_SECRET` — auth signing key. **Set explicitly** (see §5).
- `PAYMENT_ENCRYPTION_KEY` — AES-256 key for stored gateway/OAuth/AI creds. **Set explicitly + back up** (see §5).
- S3/SeaweedFS: `S3_*` — `S3_PUBLIC_URL` is **also a Build Argument** (baked into
  `images.remotePatterns` + the CSP), as are the optional `MEDIA_CDN_URL` and
  `CSP_EXTRA_HOSTS`: changing any of them requires a rebuild.

**Strongly recommended**
- `CRON_SECRET` — bearer for every `/api/cron/*` job. Until set, the 7 cron routes return 503 and **never run**: retention, mailing drain, **outbound ERP webhooks** (`/api/cron/webhooks` — queued webhooks never leave without it), birthday, review-request, abandoned-orders, and **payment reconcile**. Wire them per [deployment-coolify.md §12–§12f](deployment-coolify.md). Optional `CRON_ALLOWED_IPS` restricts the callers by IP.
- `EMAIL_FROM` + provider creds (`RESEND_API_KEY` or `SMTP_*`) — or set provider/from in the Mailing admin (`mail.*`, which overrides the env once an admin picks a value there). See §6.
- `DISABLE_DEFAULT_ADMIN` (+ the auto-generated `ADMIN_BOOTSTRAP_TOKEN`) — first-admin setup (§4).

**Per-feature (set only what you use)**
- Payments: `CLICTOPAY_USERNAME`/`CLICTOPAY_PASSWORD`, `FLOUCI_APP_TOKEN`/`FLOUCI_APP_SECRET` (+ `*_TEST_MODE`). Or set them encrypted in `/admin/system/payments`. **Env wins over the DB.** Not passed by the Coolify compose — use the admin panel there, or add them to the compose. See §7.
- OAuth: `GOOGLE_*` / `FACEBOOK_*` (or admin `/admin/system/auth`). Passed through by the Coolify compose; a non-blank value force-overrides and locks the admin field.
- AI: `OPENROUTER_API_KEY` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` (or admin `/admin/system/ai`). Not compose-passed.

On the Docker-Compose path Coolify only injects variables the compose file
references — see the passthrough list in
[deployment-coolify.md « Complete environment reference »](deployment-coolify.md#complete-environment-reference).

---

## 4. First admin

On first boot, if no admin exists, the app seeds one (`houssem@kawn.me`, random
password printed ONCE to the boot logs) — see
[default-admin.ts](../src/lib/bootstrap/default-admin.ts). For a fork:

- **Recommended:** set `DISABLE_DEFAULT_ADMIN=true` and create your first admin via
  the one-shot `POST /api/admin/bootstrap` (gated by `ADMIN_BOOTSTRAP_TOKEN`,
  printed once to the boot log by `init-secrets`) with your own email; or
- let it seed, then immediately change the email/password in the admin panel (or
  `/forgot-password`) and rotate.

Either way there is nothing to close afterwards: the bootstrap token is burned
automatically as soon as any admin exists (default-admin creation, first
successful promotion, or any boot that finds an admin). The persisted token is
deleted and `ADMIN_BOOTSTRAP_CLOSED` recorded in `app_secrets`, so the route
404s for good and `init-secrets` stops regenerating it. To re-open it after a
true lockout: `DELETE FROM app_secrets WHERE key='ADMIN_BOOTSTRAP_CLOSED';` and
restart (a fresh token is printed once).

The `houssem@kawn.me` literal is the only hardcoded admin-email default in code
(override per deploy with `DEFAULT_ADMIN_EMAIL`); it never reaches a customer and
is disable-able as above.

---

## 5. Secret hygiene (the GZ-5 hardening)

`BETTER_AUTH_SECRET`, `PAYMENT_ENCRYPTION_KEY`, and `ADMIN_BOOTSTRAP_TOKEN` are
**auto-generated and persisted to `app_secrets` on first boot if unset**
([init-secrets.ts](../src/lib/db/init-secrets.ts); the bootstrap token only
until the first admin exists — then it is burned, §4) — convenient for a quick start,
but a footgun in prod: if the database/volume is reset without a backup, an
auto-generated `PAYMENT_ENCRYPTION_KEY` is **lost**, and every stored gateway /
OAuth / AI credential (encrypted with it) becomes **unrecoverable**, and all
sessions are invalidated.

**Do this for any real deployment:**
1. Generate `PAYMENT_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` yourself
   (`openssl rand -base64 32`) and set them as **explicit, non-ephemeral** env
   vars in Coolify (env always wins over the auto-generated DB value). In
   production an explicit `BETTER_AUTH_SECRET` must be ≥ 40 chars with ≥ 16
   distinct characters (the 44-char `openssl` output passes), or boot is
   refused.
2. Back them up in a vault / password manager. Document a rotation ceremony.
3. Pair this with a verified **Postgres backup + restore drill** before go-live.

---

## 6. Email deliverability (GZ-19)

Provider + from-address are configurable (admin `mail.*` or `EMAIL_FROM` + SMTP/
Resend env). For inbox placement on a fresh sending domain:
- Publish **SPF**, **DKIM**, and **DMARC** DNS records for your domain (per your ESP's instructions).
- **Warm up** the sending domain/IP gradually — this is best delegated to the ESP
  (Resend / a reputable SMTP relay), not done in app code. The mailing queue drain
  already throttles (`mail.throttle_per_min`) if you need a per-window cap.

---

## 7. Payment go-live checklist (GZ-4)

**Flouci** is fully confirmed against the live docs + the official Flouci
WooCommerce plugin v2.0.1 (v2 API: `Authorization: Bearer <token>:<secret>`,
`/api/v2/generate_payment` + `/api/v2/verify_payment/{id}`, settle on
`success===true && result.status==="SUCCESS"`) and has a real-time webhook
(`/api/webhooks/flouci`). **ClicToPay** is implemented against the official
Basic 1.0 manual + merchant recette (`register.do` → `getOrderStatusExtended.do`,
settle on `errorCode===0 && orderStatus===2`) and also has a real-time webhook
(`/api/webhooks/clictopay`). Konnect was removed as a gateway.
Before accepting real payments:
1. Run a **real sandbox transaction** end-to-end for each enabled method and
   confirm the verify-response field names map correctly (a wrong mapping makes a
   paid order silently stay `pending`). (Both Flouci and ClicToPay are confirmed
   against their official references.)
2. Wire the **payment-reconcile cron** ([deployment-coolify.md §12d](deployment-coolify.md))
   — a safety net for paid orders left `pending` (e.g. a closed return tab before
   the webhook lands, or a crash-stranded order). Both gateways now have a
   real-time webhook (`/api/webhooks/flouci`, `/api/webhooks/clictopay`), but the
   cron still backstops them.
3. Add monitoring/alerting on the `webhook.payment.amount_mismatch` event.

---

## 8. Optional features (off by default)

| Feature | Switch |
| --- | --- |
| Public shareable favourites (`/u/<slug>`) | `social.favorites_public_enabled` |
| Free shipping | `delivery.free_shipping_enabled` + threshold |
| Tax (TVA) | `tax.mode` = disabled / ttc / ht |
| Social login | `auth.social.google_enabled` / `facebook_enabled` (+ creds) |
| AI content generation | configure a provider in `/admin/system/ai` |

All ship inert/neutral, so a minimal fork is just: set the brand settings (§2),
the required env (§3), your first admin (§4), and your catalog.

---

Built by **[Kawn Digital Studio](https://kawn.me)** for Tokyo Store. See [CREDITS.md](../CREDITS.md).


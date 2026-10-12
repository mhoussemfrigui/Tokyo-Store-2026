# Media hub

Tokyo Store's media subsystem is the single source of truth for every image
the CMS edits, the storefront renders, or third-party email templates link
to. It's intentionally **central** — modules reference a media row via a
soft-link `text` column (`*_media_id`) wherever they can. The one exception is
rich-text bodies (blog / aid / product / category / page): the TipTap editor
splices the media's `/cdn/<key>` URL inline as an `<img>`, so those references
carry no media id. Orphan detection + the destructive reclaim sweep therefore
ALSO match media by their storage-key base inside those body columns (see
[Orphan detection](#orphan-detection-db-rows)), so an inline-used image is never
mistaken for an orphan and purged.

The module lives at [`src/modules/media`](../src/modules/media); the SSRF-hardened
URL importer sits one level out in [`src/lib/media/fetch-remote-image.ts`](../src/lib/media/fetch-remote-image.ts),
and the same-origin object proxy is the route handler
[`src/app/cdn/[...path]/route.ts`](../src/app/cdn/[...path]/route.ts).

## Why central

| Failure mode without central media         | How the hub prevents it                                  |
| ------------------------------------------ | -------------------------------------------------------- |
| Broken image when admin renames a file     | Storage key carries a random UUID prefix (`buildStorageKey`); the stored object URL never changes when the display filename is edited |
| "We want AVIF off now, WebP only"          | Variants are regenerated at upload time, toggled by a setting (`generate_webp`/`generate_avif`) |
| Same image lives in 4 places, 4× storage   | One row, many references — image is uploaded once        |
| CDN migration mid-quarter                  | `url_override` per row, plus a `cdn_base_url` global default |
| Accessibility audit fails                  | One alt-text column, one edit form, every page picks it up |

## Architecture

```
admin form ──> <MediaPicker> ──> POST /api/admin/media/upload      (file)
                              └─> POST /api/admin/media/import-url (URL)
Médiathèque dropzone ──> uploadMediaAction (Server Action)         (file)
                                            │
                                            ▼
                                   ┌──────────────────┐
                                   │ uploadMediaWorkflow │
                                   │  (workflows/media)  │
                                   └──────────────────┘
                                            │
                  ┌──────────── reads ──────┤
                  ▼                         ▼
        ┌─────────────────┐      ┌───────────────────────────┐
        │ media_settings  │      │ processImage (sharp)      │
        │ singleton       │      │ → jpeg, webp, avif, orig  │
        └─────────────────┘      └───────────────────────────┘
                                            │
                                            ▼
                                  ┌─────────────────────┐
                                  │ SeaweedFS S3 PUT × N  │
                                  └─────────────────────┘
                                            │
                                            ▼
                                  ┌─────────────────────┐
                                  │ media row INSERT    │
                                  │ (url, webp_url,     │
                                  │  avif_url, …)       │
                                  └─────────────────────┘
                                            │
                                            ▼
                                  consumer rows reference
                                  the row.id (text column)
```

The URL importer ([`fetch-remote-image.ts`](../src/lib/media/fetch-remote-image.ts))
downloads the remote bytes, then hands them to the **exact same**
`uploadMediaWorkflow` a file upload uses — so an imported image gets the
identical EXIF/resize/variant treatment and lands as one normal `media` row.

**Body-size ceilings.** Next truncates any request body above
`experimental.proxyClientMaxBodySize` (the JSON routes then answer 413). The
Médiathèque dropzone (`uploadMediaAction`) is a Server Action, so it is also
capped by `experimental.serverActions.bodySizeLimit` (Next's 1 MB default would
413 it; the catalogue import Server Action shares the knob). Both come from [`src/lib/config/next-runtime.ts`](../src/lib/config/next-runtime.ts):
`SERVER_ACTION_BODY_LIMIT` is aliased to `PROXY_CLIENT_MAX_BODY` (`"16mb"`), and
`MAX_UPLOAD_MB_CEILING` (16) in [`limits.ts`](../src/modules/media/limits.ts)
pins `max_upload_mb` to the same value.

### Tables

- `media` — one row per uploaded source. Defined in
  [`src/modules/media/schema.ts`](../src/modules/media/schema.ts). Columns:

  | Column                | Purpose                                           |
  | --------------------- | ------------------------------------------------- |
  | `id`                  | UUID v7                                           |
  | `kind`                | `image` \| `video` \| `document` \| `other` (default `image`) |
  | `storage_key`         | Bucket key of the **primary** variant (the JPEG fallback) |
  | `url`                 | Public URL of the primary variant — the JPEG fallback |
  | `mime_type`           | MIME of the primary variant                       |
  | `webp_url` / `webp_size_bytes`     | WebP variant URL + size (NULL when disabled) |
  | `avif_url` / `avif_size_bytes`     | AVIF variant URL + size (NULL when disabled) |
  | `original_url` / `original_size_bytes` / `original_mime_type` | Kept source (NULL unless `keep_original`): a metadata-free, max-fidelity re-encode when `strip_exif` is on (JPEG → JPEG q100 4:4:4, WebP → lossless WebP, anything else → lossless PNG); the verbatim upload when `strip_exif` is off, or for a GIF. Served to staff only (see [`/cdn`](#cdn-base-resolution)) |
  | `url_override`        | When set, replaces every URL with this exact value (CDN migration)  |
  | `width` / `height`    | Dimensions of the primary variant                 |
  | `size_bytes`          | Primary variant size                              |
  | `filename`            | Upload base name + the **primary variant's** extension (e.g. a re-encoded PNG/import lands as `.jpg`) so the Médiathèque label + filename trigram search match the bytes actually served |
  | `alt_text`            | Accessibility text                                |
  | `uploaded_by`         | Soft link to `users.id` (no FK — accounts are disabled, not deleted) |
  | `deleted_at`          | Soft-delete                                       |

  FKs are intentionally absent (cross-module soft links). Indexes:
  - `media_live_idx` — partial **composite** index `(created_at DESC, id DESC)
    WHERE deleted_at IS NULL` (migration `0029_media_live_index.sql`). Every
    query that orders or counts by `created_at` already filters
    `deleted_at IS NULL`, so this one index backs (a) the keyset pagination
    ordering (`ORDER BY created_at DESC, id DESC` is fully index-ordered, no
    in-group sort at same-timestamp seams) **and** (b) an index-only live
    `count()` for the Médiathèque (no full seq scan). 0029 **dropped** the
    former full single-column `media_created_at_idx` (`created_at`) — redundant
    once no query touches `created_at` over deleted rows.
  - `media_filename_trgm` — partial GIN trigram index on
    `filename WHERE deleted_at IS NULL` (migration `0028_media_indexes.sql`),
    backing the `ilike(filename, '%q%')` MediaPicker / Médiathèque search.

  The former `media_uploader_idx` (`uploaded_by`) and `media_kind_idx` (`kind`)
  were write-only — no query filtered on them — and 0028 dropped them.

- `media_settings` — **singleton config row** (id pinned to
  `00000000-0000-0000-0000-000000000001`, a `media_settings_singleton` CHECK in
  the baseline migration rejects any other id). Defined in
  [`settings.schema.ts`](../src/modules/media/settings.schema.ts), read/written
  through `mediaSettingsService` with a 30 s in-process cache. All knobs editable
  from `/admin/media/settings` (RBAC `system_media:view` / `:update`; the library
  itself is `media:view|create|update|delete`, and a view-only role sees it
  read-only).

  | Column              | Default | What it controls                              |
  | ------------------- | ------- | --------------------------------------------- |
  | `generate_webp`     | `true`  | Emit a `.webp` variant per upload (GIFs excepted — see Pipeline) |
  | `generate_avif`     | `true`  | Emit a `.avif` variant per upload, the storefront's preferred display source (GIFs excepted) |
  | `keep_original`     | `false` | Keep the source alongside the variants (re-encode headroom). With `strip_exif` on it is stored as an EXIF-stripped re-encode, not the raw bytes. GIF animation survives regardless — a GIF's raw bytes become the primary when no JPEG is generated |
  | `max_width_px`      | `2400`  | Width axis cap (`0` = no cap on this axis). Independent of the height cap — both feed `sharp.resize({ width, height, fit: "inside", withoutEnlargement: true })` |
  | `max_height_px`     | `2400`  | Height axis cap (`0` = no cap on this axis). Resize is skipped only when neither axis is exceeded; it is **not** a single longest-edge cap |
  | `webp_quality`      | `82`    | sharp WebP encoder quality (clamped 30–100)   |
  | `avif_quality`      | `60`    | sharp AVIF encoder quality (clamped 30–100)   |
  | `jpeg_quality`      | `85`    | sharp JPEG (fallback) encoder quality (clamped 30–100) |
  | `strip_exif`        | `true`  | Remove camera metadata (privacy). The webp/avif/jpeg variants never carry metadata either way; this toggle decides whether the kept original is stripped |
  | `product_white_bg`  | `false` | When on, **PRODUCT-scope** uploads have their **uniform studio backdrop removed to transparent** (détourage). The column name is historical: the algorithm generalised from white-only to **any flat sweep — white, black, grey, or a flat colour**. It samples the border's median colour and flood-fills the connected backdrop from the photo's borders → alpha 0, so a packshot's studio sweep is cut out while interior regions matching the backdrop (e.g. a white dial on a white sweep) are preserved. **Textured / gradient / multi-coloured** backgrounds (border not uniform) are returned unchanged. The cut edge is **anti-aliased with a colour-distance graded alpha** (an edge pixel that is still a backdrop-ish blend fades out; a clearly-subject pixel stays opaque), so there's no flat feather band or backdrop-tinted halo. The WebP/AVIF variants keep the transparent cut-out; the JPEG fallback is flattened onto white. For performance `removeUniformBackground` returns the **raw RGBA** pixels and the callers encode the variants straight from them (no intermediate PNG round-trip). Other media scopes are untouched. Added in migration `0086`; generalised to any backdrop in [`white-bg.ts`](../src/modules/media/white-bg.ts). Existing media can be back-filled — see **Re-processing existing product media** below. |
  | `product_white_bg_main_only` | `false` | Sub-option of `product_white_bg` (no-op unless it's on). When ON, **upload-time détourage is skipped** and only a product's **MAIN image** (its first gallery image, lowest `product_media.display_order`) is détoured — at product **save**, via the `detourage-main-image` subscriber (idempotent reprocess). Secondary/gallery shots keep their backdrop. Migration `0130`. |
  | `max_upload_mb`     | `8`     | Pre-process upload ceiling (clamped 1–16, ceiling = `MAX_UPLOAD_MB_CEILING`; default from `modules/media/limits.ts`). 16 MB is also the Next body limit of both the JSON routes and the dropzone Server Action (see *Body-size ceilings* above) |
  | `default_alt_text`  | `NULL`  | Applied when admin leaves the alt-text field empty |
  | `cdn_base_url`      | `NULL`  | Active global CDN base — when set, public `/cdn/<key>` URLs are served as `<base>/<key>`; falls back to the `MEDIA_CDN_URL` env when empty. Ignored at runtime when it is outside this build's host allow-list (see [`cdn-base.ts`](../src/modules/media/cdn-base.ts) and *Operational coupling* below) |

  The baseline migration does **not** seed this row — `mediaSettingsService.get()`
  materialises it on first read via `INSERT … ON CONFLICT DO NOTHING` with the
  schema defaults, so a wiped/missing row never crashes the upload pipeline.

### Pipeline (per upload)

The workflow is [`workflows/media/upload-media.ts`](../src/workflows/media/upload-media.ts);
the sharp logic is [`modules/media/processor.ts`](../src/modules/media/processor.ts).

1. `requirePermission("media", "create")` guards the endpoint (and the
   `uploadMediaAction` / `importMediaFromUrlAction` Server Actions);
   `assertSameOrigin()` adds CSRF defence on the JSON routes. **Both** the JSON
   routes **and** the two Server Actions are rate-limited to 30 requests/min per
   user, sharing one bucket per surface (`media-upload:<userId>` /
   `media-import:<userId>`, 429) — so the page-driven action can't sidestep the
   route's cap.
2. Workflow rejects non-image MIME and files over `max_upload_mb`.
3. `processImage(buffer, mime)`:
   - `sharp(input, { failOn: "error", limitInputPixels })` — every sharp decode
     in the pipeline (upload, détourage, re-process) spreads `SHARP_DECODE_LIMITS`
     from [`image-safety.ts`](../src/modules/media/image-safety.ts), capping the
     decode at ~50 MP (sharp's default is 268 MP) against decompression bombs
     that fit under the byte cap. A larger image fails with `image_too_large`
     « Image trop grande (dimensions) : 50 mégapixels maximum. ».
   - `.rotate()` — auto-orient (bakes EXIF orientation into pixels).
   - Conditional resize via `sharp.resize({ width: max_width_px, height: max_height_px,
     fit: "inside", withoutEnlargement: true })`. `max_width_px` and `max_height_px`
     are **two independent axis caps** (`0` = no cap on that axis, passed as
     `undefined`), **not** a single longest-edge cap; `fit: "inside"` scales down
     to fit within whichever bounds are set while preserving aspect ratio. The
     resize step is **skipped entirely** unless at least one cap is exceeded.
   - **EXIF handling** (note the sharp gotcha): sharp drops *all* metadata by
     default, so `strip_exif` is the no-op path; the opt-out branch calls
     `.keepMetadata()` to *retain* EXIF/ICC on the intermediate buffer. (Never
     "strip" via `.withMetadata({})` — that call **preserves** metadata.) The
     webp/avif/jpeg variants are each encoded by a fresh `sharp()` instance
     without `keepMetadata()`, so they are metadata-free whatever the toggle.
   - One sharp re-encode per enabled variant — `.webp({ quality: webp_quality,
     effort: 4 })`, `.avif({ quality: avif_quality, effort: 4 })` — **plus** a
     quality-controlled baseline JPEG (`.jpeg({ quality: jpeg_quality, mozjpeg:
     true })`) for every non-GIF input. That JPEG is the **primary** variant and
     becomes the row `url` — the universal fallback served to clients that can't
     render webp/avif.
   - **GIFs are exempt from JPEG, WebP, and AVIF generation entirely** — all three
     encode blocks are gated on `!isGif`, where `isGif` keys off sharp's
     **detected** format (`meta.format === "gif"`), **not** the caller-declared
     mime. So bytes merely *labelled* `image/gif` (e.g. a JPEG with a forged
     content-type) still get re-encoded, and a real GIF mislabelled as another
     type still keeps its animation. sharp decodes only a GIF's first frame, so
     any of these variants would be a *static* snapshot that would then win the
     resolver chain (`avif → webp → url → original`) over the animated source.
     With them skipped, `webp_url`/`avif_url` stay `null` and the resolver serves
     the GIF itself (the kept original, or — if `keep_original` is off — the raw
     input passed through as the primary so the upload never lands with zero
     variants).
   - When `keep_original` is on and `strip_exif` is on (non-GIF), the original
     is re-encoded without any metadata (orientation baked in) by
     `encodeStrippedOriginal` ([`image-safety.ts`](../src/modules/media/image-safety.ts));
     its stored mime/extension follow the bytes actually produced. Otherwise
     (`strip_exif` off, or a GIF) the raw input bytes pass through verbatim —
     this is what preserves GIF animation.
4. `putObject({ key, body, contentType })` for each variant. Keys share a common
   prefix (`<scope>/<uuid>-<safe-name>`); the variant extension differs
   (`.jpg`, `.webp`, `.avif`). The **kept original** gets a distinct
   `…<base>.original.<ext>` key so a JPEG-sourced original can't overwrite the
   quality-controlled primary JPEG at `…<base>.jpg`.
   - **Atomicity invariant**: a failed `pushVariant` logs and returns `null`. The
     workflow **aborts with a `storage_failed` failure BEFORE the DB insert** if
     the primary PUT failed (the first PUT — it returns at once) **or** if any
     *enabled, non-primary* variant (webp/avif/original) PUT failed; in the
     latter case it first best-effort-deletes EVERY key this upload could have
     written (`variantUploadKeys`, mirroring `variantStorageKeys` — so a PUT
     that landed despite throwing, or a later variant uploaded after an earlier
     failure, is reaped too). So the DB never sees a row pointing at deleted
     objects. (Disabled variants are `undefined`, so they never trip the abort;
     the `processed.original !== processed.primary` guard skips the GIF /
     no-variant case where the original reuses the primary key.) If the row
     INSERT itself throws after every PUT landed, the same purge runs before the
     error surfaces. A key whose purge delete fails is logged for manual
     removal: nothing else reclaims it (see *Orphan detection* below).
5. Insert one `media` row with every generated variant's URL + size — `url`/
   `storage_key` point at the JPEG primary, `webp_url`/`avif_url` at the modern
   variants, `original_url` at the kept original.
6. Emit `media.uploaded` on the event bus for audit + cache-invalidation subscribers.

### Deleting media

Deleting in the Médiathèque is a **soft delete**: `deleteMediaWorkflow` sets
`deleted_at` (a tombstone, so soft `media_id` links / order snapshots don't
dangle), then emits `media.deleted` carrying **every** variant storage key. The
`cleanup-media-storage` subscriber
([`src/events/subscribers/cleanup-media-storage.ts`](../src/events/subscribers/cleanup-media-storage.ts))
then **synchronously purges the objects from S3** (except order-snapshot keys,
below) — the bus awaits subscribers,
so the bytes are gone by the time the workflow returns. The tombstone is for
**referential safety, not undo**: storage is reclaimed immediately, so a deleted
row is **not byte-recoverable**. `variantStorageKeys()` in
[`storage.ts`](../src/modules/media/storage.ts) derives the sibling keys from the
base key + the `*_url` flags.

**Order snapshots are kept.** Order lines store the resolved image URL
(`order_items.product_image_url` / `variant_image_url` = `/cdn/<key>`, or
`<cdn base>/<key>`), not a media id. Every purge (the subscriber on
`media.deleted` / `media.bulk_deleted`, and the in-app détourage re-process)
skips the keys an order line still displays
(`mediaQueries.listOrderReferencedStorageKeys`), so historical order thumbnails,
the customer's order history and already-sent emails keep their image. If that
lookup fails, nothing is purged: a leaked object only costs storage.

**Storefront caches.** `media.deleted` and `media.bulk_deleted` (like
`media.updated` and `media.settings_updated`) bust the storefront list tags
(products, categories, brands, pages, blog posts) in
[`invalidate-media-cache.ts`](../src/events/subscribers/invalidate-media-cache.ts),
so a cached PDP re-resolves to the placeholder instead of pointing at a purged
object.

**In-use guard.** The single-delete confirm warns with an in-use count from
`mediaQueries.countMediaReferences()` (via `mediaUsageCountAction`). The bulk
« Supprimer la sélection » confirm lists the in-use images
(`listMediaInUseAction` → `mediaQueries.listReferencedMediaIds`) and needs an
explicit checkbox; `bulkDeleteMediaAction` re-checks server-side and refuses the
whole selection (error `in_use` + `inUseIds`, nothing deleted) unless
`confirmInUse: true`. A bulk action takes at most `BULK_MEDIA_MAX` = 200 ids
([`limits.ts`](../src/modules/media/limits.ts)): the panel refuses a larger
selection with « désélectionnez-en N », and `listMediaInUseAction` throws on
invalid input, so the confirm reads « Impossible de vérifier les usages » (never
a false « aucune utilisée »). The bulk path fans the single-delete workflow out
8 at a time, then emits one `media.bulk_deleted` summary (`mediaIds` = the rows
actually deleted, `storageKeys` empty — each row's objects were already purged by
its own `media.deleted`).

Soft links from consumers are **not** auto-detached on
delete (by design): the resolvers + read queries filter out `deleted_at`-stamped
rows (`isNull(media.deleted_at)`) and consumers fall back to placeholders, so a
stale `media_id` degrades gracefully instead of needing a cascading update.

## Storefront resolution

Three pure, synchronous resolvers in
[`url-resolver.ts`](../src/modules/media/url-resolver.ts), all funnelled through
`normalizePublicUrl` (rewrites any leftover absolute object-store URL back to a
same-origin `/cdn/<key>` path) and never throwing — they return `null` only when
no URL field is set:

| Resolver                 | Used for                                            | Fallback chain                                              |
| ------------------------ | --------------------------------------------------- | ---------------------------------------------------------- |
| `resolveMediaUrl`        | On-page `<Image>` (gallery, cards, search hits)     | `url_override → avif_url → webp_url → url → original_url`   |
| `resolveMediaThumbUrl`   | Admin grids rendering a **raw** `<img>` (no Next negotiation) | `url_override → webp_url → url → original_url` (never AVIF) |
| `resolveMediaSocialUrl`  | `og:image`, JSON-LD `image`, emails (AVIF-unsafe consumers) | same as thumbnail (AVIF-avoiding)                          |

The display resolver is **AVIF-first** because on-page images go through Next's
optimizer (`formats: ["image/avif", "image/webp"]`), so the smallest modern
format is the canonical source. The thumbnail/social resolvers deliberately
**avoid AVIF** because their consumers (a raw `<img>`, a social scraper, a mail
client) can't reliably decode it; WebP is near-universal and Next still
up-negotiates the WebP source to AVIF for on-page `<Image>` callers.

The full chain matters for imported rows: a PrestaShop/Shopify import can populate
`webp_url`/`url_override` while leaving `url` empty, so every resolver walks the
whole chain — preventing "shows in admin but not the storefront" from one missing
field.

### CDN base resolution

Public URLs default to a same-origin `/cdn/<key>` path served by the
[`/cdn/[...path]`](../src/app/cdn/[...path]/route.ts) route handler, which
streams from the internal S3 endpoint (`S3_ENDPOINT`/`S3_BUCKET`). This
sidesteps Next.js 16's SSRF guard on the image optimizer (which blocks
loopback/private-IP fetches) and keeps the object-store host off the browser.

**Kept originals are staff-only.** A `<base>.original.<ext>` key answers 404
(`no-store`) to any caller without `media:view` (anonymous visitors and
signed-in customers alike); a session holding `media:view` gets it with
`Cache-Control: private, no-store`. The resolvers reach `original_url` only as
their last fallback, and a GIF's original lives at the primary key, so the
storefront is unaffected.

The **effective** CDN base is resolved by [`cdn-base.ts`](../src/modules/media/cdn-base.ts),
precedence highest → lowest:

1. `media_settings.cdn_base_url` — admin-editable DB field (**primary**). When set,
   every `/cdn/<key>` path is rewritten to `<base>/<key>`.
2. `MEDIA_CDN_URL` env — deployment **fallback** (comma-separated; first entry
   used). Read directly from `process.env` in `cdn-base.ts` (not declared in
   `src/lib/env.ts`, but documented in `.env.example`), so it's an opt-in ops
   override.
3. `""` — **default**: same-origin `/cdn` proxy.

The resolvers read the base synchronously via `getCdnBaseSync()`. Because they
can't `await`, the base is memoised module-side (30 s TTL) and refreshed
asynchronously by `primeCdnBase()` — query helpers call it before a batch of
sync resolves so `getCdnBaseSync()` sees the DB value. `invalidateCdnBase()`
forces a re-resolve when settings change.

#### Operational coupling: `cdn_base_url` MUST also be in the `MEDIA_CDN_URL` build argument

The DB field wins for URL *building*, but two allow-lists also gate whether the
browser will actually load a CDN-hosted image, and **neither can read the DB**.
Both are compiled at **`next build`**, so `S3_PUBLIC_URL`, `MEDIA_CDN_URL` (and
`CSP_EXTRA_HOSTS`) are **build arguments** (Dockerfile `ARG` + the compose
`build.args`): changing them needs a rebuild, a restart does nothing.

- `next.config.ts` `images.remotePatterns` is built from `S3_PUBLIC_URL` +
  `MEDIA_CDN_URL`. A `<Image src>` on a host that isn't listed there **400s**
  with "hostname not configured".
- The CSP `img-src`, `media-src` and `connect-src` are built by `buildCsp()` in
  [`src/lib/security/headers.ts`](../src/lib/security/headers.ts) from the same
  two values. A host not listed is **CSP-blocked**.

`next.config.ts` snapshots the build values as `BUILD_S3_PUBLIC_URL` /
`BUILD_MEDIA_CDN_URL`, and
[`cdn-allowlist.ts`](../src/modules/media/cdn-allowlist.ts) turns them into
host + path-prefix entries. Two guards use them:

- **Runtime gate** ([`cdn-base.ts`](../src/modules/media/cdn-base.ts)): a CDN
  base (the DB field or the runtime `MEDIA_CDN_URL`) outside this build's
  allow-list is **ignored** with a one-time log warning, and resolution falls
  through to the next source (ultimately the same-origin `/cdn` proxy, which
  always works).
- **Admin warning**: Médiathèque → Réglages (`/admin/media/settings`) flags a
  `cdn_base_url` outside the build allow-list and lists the hosts this build
  allows (next/image + CSP).

The settings save
([`src/workflows/media/settings.ts`](../src/workflows/media/settings.ts)) also
validates a `cdn_base_url` against the (runtime) `S3_PUBLIC_URL` /
`MEDIA_CDN_URL` env by **HOST *and* PATH PREFIX**, returning an actionable field
error ("ajoutez-le à l'env et redéployez") on a miss:

- The host must match one of `S3_PUBLIC_URL`/`MEDIA_CDN_URL`, or `next/image`
  400s and the CSP blocks the load.
- The path must sit **under** that entry's path prefix. `S3_PUBLIC_URL` carries
  the bucket in its path (e.g. `https://host/tokyo`), and `applyCdnBase`
  joins `<base>/<key>` **without** re-inserting the bucket — so a host-correct
  but **bucket-less** base (e.g. `https://host` when
  `S3_PUBLIC_URL=https://host/tokyo`) is now **rejected**: it would pass a
  host-only check yet 404 every storefront image. A genuine external
  `MEDIA_CDN_URL` host with **no** path prefix still accepts any path.

**Procedure to add a new CDN host: add it (with its bucket path, matching
`S3_PUBLIC_URL`'s prefix) to the `MEDIA_CDN_URL` build argument, rebuild and
redeploy, *then* set `cdn_base_url` in the admin settings.**

**Cross-instance freshness.** The effective base and the media-settings row are
memoised per-instance with a ~30 s TTL (`CACHE_TTL_MS` in
[`cdn-base.ts`](../src/modules/media/cdn-base.ts) +
[`settings.service.ts`](../src/modules/media/settings.service.ts)). The editing
instance invalidates immediately — the settings workflow calls
`invalidateCdnBase()` and `mediaSettingsService.update()` calls `invalidate()` —
so a change is **instant locally** and **converges on other instances within
~30 s**.

## Using the MediaPicker

`<MediaPicker>` ([`src/components/admin/media-picker.tsx`](../src/components/admin/media-picker.tsx))
is the one component every admin form uses for image fields.

```tsx
// Single image (e.g. hero, logo, featured image)
<MediaPicker
  name="heroMediaId"
  value={initial?.heroMediaId ?? null}
  label="Image hero"
  scope="categories"
/>

// Gallery (product images, ordered, first = primary)
<MediaPicker
  name="mediaIds"
  multi
  value={initial?.mediaIds ?? []}
  label="Galerie d'images"
  scope="products"
/>
```

- `name` is the form field key — the Server Action picks it up natively via
  hidden `<input>`s, so the picker drops into Server Action forms with no JS
  round-trip.
- `value` is the current selection — pass IDs from the DB on edit pages.
- `multi` enables toggle multi-select + reordering (the first tile is the
  primary image).
- `scope` decides the S3 key prefix (`products/`, `categories/`, `brands/`,
  `cms/`, `uploads/`) so the bucket stays organised even when an image is reused.

**Permissions.** The picker is shared by the product, brand, category,
banner, blog, aide, CMS, theme and SEO forms, but it calls the
Médiathèque endpoints: browsing needs `media:view` (`GET /api/admin/media`),
uploading / importing needs `media:create`, and the inline metadata editor needs
`media:update`. A role that edits one of those modules without the Médiathèque
grants gets an empty 404 from the API (`requirePermission` → `notFound`); the
picker turns a 403/404 into a French message naming both possible causes (an
expired session, or a missing « Médiathèque : voir / créer » permission) instead
of « HTTP 404 ».

The picker (`PickerDialog`):

- Fetches the library from `GET /api/admin/media` (search by filename,
  keyset `cursor`, `limit` capped at 100; each row also carries
  `variants {webp, avif, original}` URLs and `createdAt`).
- Hydrates pre-selected IDs via `GET /api/admin/media?ids=…` (≤ 50 ids per call;
  a `requestedRef` guard stops a never-returned id from re-fetching forever).
- Lets the admin **upload inline** (`POST /api/admin/media/upload`) without
  leaving the form.
- Lets the admin **import from a URL** inline (`POST /api/admin/media/import-url`)
  — the same SSRF-hardened server-side download.
- Renders a "Principale" badge on the first picked tile in multi-mode.
- Exposes an inline metadata editor per selected tile (alt text, filename,
  external CDN `url_override`), persisted via `updateMediaAction`.
- Persists order via repeated `<input name=mediaIds>` entries — exactly what
  `productMediaLink.set()` expects.

## SSRF-safe URL import

The "import from URL" feature runs server-side with network access, so the
download is hardened in
[`src/lib/media/fetch-remote-image.ts`](../src/lib/media/fetch-remote-image.ts):

- **Scheme allow-list** — http/https only; embedded `user:pass@` credentials
  rejected.
- **DNS resolved up front**, and **every** resolved A/AAAA record must be a
  public IP. Blocks loopback, RFC1918 private, CGNAT (100.64/10), link-local
  (incl. the `169.254.169.254` cloud-metadata endpoint), ULA, multicast, and
  reserved ranges — for IPv6 it fully expands `::`-compressed and IPv4-mapped
  forms before the range check, closing the mapped-address bypass.
- **Connection pinned to the validated IP** via a custom `lookup` that never
  re-resolves, defeating DNS-rebinding/TOCTOU between check and connect (SNI/cert
  validation still uses the hostname).
- **Redirects are not followed** (a 3xx `Location` could point at an internal
  host).
- **Hard 10 s timeout + streamed size cap** against the settings-driven
  `max_upload_mb` (aborts mid-stream — no decompression-bomb buffering).
- **Content-Type must be an accepted image MIME**; sharp is the final arbiter
  downstream regardless of the header.

The route ([`/api/admin/media/import-url`](../src/app/api/admin/media/import-url/route.ts))
maps these failures to `400` (admin error), not `500`, and requires
`media:create` + same-origin + the 30/min per-user rate limit, like the upload
route. The IP classifier is shared with the outbound-webhook transport
([`src/lib/net/ssrf-fetch.ts`](../src/lib/net/ssrf-fetch.ts)).

## URL override workflow

When migrating an individual image to an external CDN:

1. Upload the asset to the CDN out of band (`aws s3 cp`, etc.).
2. Set `media.url_override` to the CDN URL — the inline editor in `<MediaPicker>`
   or the Médiathèque card ("URL externe (CDN)").
3. The storefront picks up the override on next render (it's first in every
   resolver chain). The override's domain must be allow-listed in Next
   `remotePatterns` **and** the CSP `img-src` — both compiled from the
   `S3_PUBLIC_URL` / `MEDIA_CDN_URL` build arguments (see
   [CDN base resolution](#cdn-base-resolution)) — or `<Image>` 400s and the
   browser CSP-blocks the load. `updateMediaAction` therefore validates it
   (`checkUrlOverride` in [`validation.ts`](../src/modules/media/validation.ts)):
   the value must be a `/cdn/<key>` path or an http(s) URL under a build-time
   `S3_PUBLIC_URL` / `MEDIA_CDN_URL` entry (scheme + host:port + path prefix);
   anything else (`javascript:`/`data:`, embedded credentials, another host)
   returns a field error. An unchanged stored value (e.g. written by a catalogue
   import) is accepted so an alt-text edit still saves.

To revert: clear the field. The row falls back to its object-store variants. The objects
in the object store are never deleted by this flow — they stand as the fallback. (For a
fleet-wide switch, prefer the `cdn_base_url` setting over per-row overrides.)

## Orphan detection (DB rows)

`mediaQueries.listOrphans()` in
[`queries.ts`](../src/modules/media/queries.ts) returns soft-link media rows that
**no** catalog/CMS/blog/aid/settings record references — a `NOT EXISTS`
anti-join over every column that points at media. It powers the cleanup view in
the Médiathèque admin. `countOrphans()` (same file) returns the uncapped total
with the same anti-join (both go through the private `orphanMediaWhere()`
fragment): the orphans view loads the newest `listOrphans(200)` (no cursor) and
shows « N orphelins … affichés sur M » when more exist. The library view, by
contrast, loads the newest 100 (server-side filename search) and « Charger plus »
appends older batches from `GET /api/admin/media?cursor=…` (keyset, same search).

This finds unreferenced DB **rows** only. There is **no bucket-wide object
sweep**: upload aborts (a failed variant PUT or row insert) and the delete
subscriber purge the objects they wrote, and any key whose delete fails is
logged for manual removal.

Because most references are *text* soft links to a `uuid` `media.id`, the query
casts the outer id (`m.id::text`) per branch; the one real `uuid` FK
(`product_media.media_id`) compares directly (`= m.id`). The anti-join checks
**every** reference column so SEO/OG and inline-content references are **not**
mistaken for orphans. The full consumer set (matching the query exactly):

- `product_media.media_id` — the real `uuid` FK (gallery many-to-many).
- `products.video_poster_media_id`, `products.og_image_media_id` — video poster + OG image.
- `product_variants.image_media_id` — per-variant image.
- `brands.logo_media_id`, `brands.hero_media_id`, `brands.og_image_media_id`,
  `brands.icon_media_id`.
- `categories.hero_media_id`, `categories.og_image_media_id`,
  `categories.icon_media_id`, `categories.boutique_image_media_id`.
- `banners.image_media_id`.
- `pages.og_image_media_id`.
- `hero_sections.image_media_id`.
- `cta_sections.background_image_media_id`.
- `blog_posts.featured_image_media_id`, `aid_articles.featured_image_media_id`,
  `aid_article_steps.image_media_id` — inline editorial/featured media.
- `site_settings` rows whose `key LIKE '%media_id'` (e.g. `seo.og_image_media_id`)
  — matched by suffix so any future `*_media_id` setting is covered automatically.
- **Inline rich-HTML body references** (`bodyRefMatch`): the TipTap editor inlines
  a media's `/cdn/<key>` URL — with **no** media id — into `blog_posts.body`,
  `aid_articles.intro`/`outro`, `aid_article_steps.body`, `products.description`/
  `short_desc`, `categories.editorial_body`/`description`,
  `brands.editorial_body`, and `text_sections.body`.
  Each media's **storage-key base** (`<scope>/<uuid>-<name>`, extension stripped —
  shared by every variant key, unique thanks to the uuid) is `ILIKE`-matched
  inside those columns, so an image embedded in a published body is not flagged as
  an orphan and the reclaim sweep never purges it. (A leading-`%` ILIKE can't use
  an index; these run only on admin/destructive paths over bounded content tables.)
- **Editorial value-prop custom icons** (`valuePropIconMatch`): each editorial
  value-prop card (`value_props` jsonb on `categories` AND `brands`) may carry an optional `iconMediaId` (a média uuid, set in the
  ValuePropsEditor, resolved for rendering by `resolveValuePropIcons`). There is
  **no** `*_media_id` column for it, so a `jsonb_array_elements` scan of
  `value_props[].iconMediaId` is anti-joined here (and mirrored in the two
  positive functions below) — an image used only as a value-prop icon is not
  flagged as an orphan, shows a non-zero delete-confirm count, and the reclaim
  sweep never purges it.
- **JSON-blob composer media** — images placed through a BLOCK composer live inside a JSON
  column/row, NOT a `*_media_id` column, so each gets a dedicated correlated matcher mirrored
  in all three functions: `homeBlocksMediaMatch` (the `home.blocks` settings row),
  `pageBlocksMediaMatch` (the `pages.blocks` column — no `deleted_at` filter, so a soft-deleted
  restorable page still protects its media), and `landingTrustIconMatch` (the boutique/marques landing trust-card `iconMediaId`s in their settings JSON). Média ids are UUIDs, so
  a substring/`LIKE` match covers **any** id in the blob — future block shapes are caught
  automatically. Same data-loss class: without these, the sweep would hard-delete an in-use
  composed image.

`countMediaReferences(mediaId)` (same file) is the **inverse** of this anti-join
— it sums the same set of columns for one id to power the delete-confirm in-use
count. `listReferencedMediaIds(ids)` is the batched **positive twin**: the subset
of `ids` still referenced (soft-deleted consumer rows count, since they can be
restored). It backs the bulk-delete in-use guard and every destructive sweep:
each data-job clean segment reclaims its média through `reclaimUnreferencedMedia`
([`workflows/data/segments.ts`](../src/workflows/data/segments.ts)) **after**
deleting its own rows, so an image still referenced elsewhere is never
hard-deleted (and a live product's `product_media` row can't cascade away with a
shared image).

Keep the three source lists (`orphanMediaWhere` / `listReferencedMediaIds` /
`countMediaReferences`) in lock-step when a new media reference lands. Missing a
source in the orphan query only **over-counts** orphans (safe); missing it in
`listReferencedMediaIds` is **not** safe — a sweep would delete an in-use image.

## Consumer modules and where they store the media ID

| Module               | Column                                       |
| -------------------- | -------------------------------------------- |
| `categories`         | `hero_media_id`, `og_image_media_id`, `icon_media_id`, `boutique_image_media_id` |
| `brands`             | `logo_media_id`, `hero_media_id`, `og_image_media_id`, `icon_media_id` |
| `products`           | many-to-many via `product_media` (uuid FK), plus `og_image_media_id`, `video_poster_media_id` |
| `product_variants`   | `image_media_id`                             |
| `banners`            | `image_media_id`                             |
| `blog_posts`         | `featured_image_media_id`                    |
| `aid_articles`       | `featured_image_media_id`                    |
| `aid_article_steps`  | `image_media_id`                             |
| `pages`              | `og_image_media_id`                          |
| `hero_sections`      | `image_media_id`                             |
| `cta_sections`       | `background_image_media_id`                  |
| `site_settings`      | `value` (when the key ends `media_id`, e.g. `site.logo_media_id`, `seo.og_image_media_id`) |

Apart from `product_media.media_id` (a real `uuid` FK with `ON DELETE CASCADE`),
these are **text** columns soft-linking to `media.id` — no FK, per the
cross-module rule. Orphaned references are tolerated; the storefront falls back to
placeholders when the media row is missing or soft-deleted.

## Re-processing existing product media (détourage)

Enabling `product_white_bg` only détoures **future** uploads. To back-fill the
existing catalogue (the demo, or anything imported before the toggle), an
admin-triggered background job re-cuts product packshots in place:

- **In-app:** `/admin/media/settings` → **« Détourage des produits existants »** →
  *Re-traiter les images produits*. Fires
  [`runProductWhiteBgReprocess`](../src/workflows/media/reprocess-product-white-bg.ts)
  on an `import_jobs` row; the card polls a live progress bar.
- **Offline (one-off):**
  `pnpm tsx --env-file-if-exists=.env.local scripts/reprocess-product-white-bg.ts [--limit N] [--dry]`.
  The script also flips `product_white_bg` ON so future uploads match.

Both share the per-row transform in
[`reprocess-detourage.ts`](../src/modules/media/reprocess-detourage.ts) so they
can't drift. For each eligible product image:

1. **Scan** — distinct product images **not** already on a `-nobg` key
   (`storage_key NOT LIKE '%-nobg.%'`), **excluding** animated GIFs (sharp would
   freeze the animation into a static `-nobg` family that wins the resolver
   chain) and `url_override`-pinned rows (the storefront serves the override, so
   the rewrite would be wasted / could 404).
2. **Cut** — an image that is **already transparent** (cut out at upload, or a
   transparent PNG packshot — probed on its WebP/AVIF variant) is skipped.
   Otherwise the source is the **kept original** when there is one (normalised
   like the upload pre-stage: auto-rotate + the max width/height caps), else the
   JPEG primary ([`reprocess-source.ts`](../src/modules/media/reprocess-source.ts)),
   and `removeUniformBackground` flood-fills the uniform backdrop. A non-sweep
   image is left untouched ("skipped").
3. **Re-encode** — a fresh transparent WebP + AVIF + white-flattened JPEG family
   is written under new `-nobg.{jpg,webp,avif}` keys (fresh keys bust immutable
   caches). Encoder qualities + which variants to emit come from
   `media_settings`, so the output matches a fresh upload on this store. A kept
   original is **preserved**, re-keyed as `<base>-nobg.original.<ext>` so a
   later delete still derives and reaps it.
4. **Repoint + reap** — the media row is updated to the new keys (and `filename`
   re-keyed to `.jpg`), then the old primary/webp/avif objects and the old
   original key are deleted (best-effort) so nothing leaks. The in-app job keeps
   any key an order line still displays (`listOrderReferencedStorageKeys`); the
   offline script does not check order snapshots. Otherwise irreversible.
5. **Cache-bust** — the runner is detached, so the per-product bust it emits
   through the bus is best-effort. The authoritative bust is
   `bustStorefrontForUnbustedJobs()`
   ([`bust-finished-jobs.ts`](../src/lib/cache/bust-finished-jobs.ts)), called
   by every admin job surface (`listImportJobsAction`, `listDataJobsAction` on the
   import-demo and CMS réglages pages, `getReprocessJobStatusAction`, and the
   `/admin/media/settings` render): the
   first time any job finished within the last day is seen, it expires the
   storefront tags and stamps `import_jobs.result.cacheBustedAt`.

## Coolify persistence

SeaweedFS ships as a service **inside the compose stack** (there is no
first-class Coolify "Storage / SeaweedFS" resource type). Its data — master +
volume + filer metadata + the objects themselves — lives under `/data`, backed
by the **named volume `seaweedfs_data`**, which survives redeploys. The
deployment guide
([deployment-coolify.md §2](deployment-coolify.md#2-provision-seaweedfs)) has the
verification steps and the snapshot script for moving the store between hosts.

## Future work

| Item                                 | Status                       |
| ------------------------------------ | ---------------------------- |
| `<picture>` srcset on storefront     | Pending — AVIF/WebP already served via Next's optimizer + the AVIF-first resolver; raw `<picture>` `<source>` tags are a follow-up |
| Async variant generation (pg-boss)   | Pending — synchronous is fine ≤ 16 MB (the hard `max_upload_mb` ceiling; 8 MB is only the default) |
| Bulk re-encode on settings change    | **Partial** — détourage back-fill shipped (see *Re-processing existing product media*); a general "re-encode all on any settings change" sweep is still manual |
| EXIF on the kept original            | Done — stripped (re-encoded) when `strip_exif` is on, verbatim only when off; variants are always metadata-free (sharp default) |
| Bucket-wide orphan-object sweep      | Not built — only DB-row orphan detection exists; failed object deletes are logged for manual removal |
| Video transcoding                    | Out of scope — embed YouTube/Vimeo URLs instead |
| Drag-to-reorder in MediaPicker multi | Currently arrow buttons; HTML5 DnD is a follow-up |

---

Built by **[Kawn Digital Studio](https://kawn.me)** for Tokyo Store. See [CREDITS.md](CREDITS.md).


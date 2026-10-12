# syntax=docker/dockerfile:1.7
#
# Multi-stage Next.js standalone build for Coolify.
# - deps:    install only what's needed for build
# - builder: compile + bundle with WEBPACK, then type-check separately
# - runner:  thin runtime image with non-root user
#
# Build size: ~140-180 MB.  Boot time: a couple of seconds.
#
# Why Webpack and not Turbopack for the production build:
#   Turbopack's working set lives in NATIVE (Rust) memory, which Node's
#   `--max-old-space-size` cannot bound. On a memory-constrained Coolify
#   VPS that surfaced as a silent OOM kill ~30s into "Creating an optimized
#   production build" (exit 255, no compile errors). Webpack's build memory
#   is V8 heap, so `NODE_OPTIONS=--max-old-space-size` gives it a hard,
#   predictable ceiling. `pnpm build` is pinned to `next build --webpack`.

ARG NODE_VERSION=22-alpine

# ────────────────────────────────────────────────────────────────────────────────
# 1. dependencies
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ────────────────────────────────────────────────────────────────────────────────
# 2. build
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# No telemetry pings from the build (standalone output itself is configured
# in next.config.ts).
ENV NEXT_TELEMETRY_DISABLED=1

# `NEXT_PUBLIC_*` env vars are inlined at BUILD time — they cannot be
# overridden at container start. For Coolify, set this as a Build Arg
# (Application → Build Arguments) so the sitemap, OG tags, and email
# links use your real public hostname. Defaults to localhost so dev
# builds still work without ceremony.
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}

# next.config.ts reads `S3_PUBLIC_URL` at *build time* to populate
# `images.remotePatterns` (so <Image src=".../<object-store>/tokyo/..."> is
# allowed) AND the CSP `img-src`. Without this, every uploaded image 400s
# on the first prod deploy with "hostname not configured". Set it as a
# Coolify Build Arg to match the runtime `SEAWEEDFS_PUBLIC_URL`. Only needed
# when serving media from a dedicated object-store domain; the default
# same-origin `/cdn` proxy needs no public host.
ARG S3_PUBLIC_URL=http://localhost:8333/tokyo
ENV S3_PUBLIC_URL=${S3_PUBLIC_URL}

# Same build-time baking for the optional CDN host(s) and extra CSP hosts:
# next.config.ts compiles MEDIA_CDN_URL into `images.remotePatterns` + the CSP
# img-src/media-src/connect-src, and CSP_EXTRA_HOSTS into the CSP — production
# serves the COMPILED values (routes-manifest headers + standalone config), so a
# runtime-only value never reaches them. Set both as Coolify Build Args (same
# value as the runtime env); changing either REQUIRES A REBUILD. Empty = unused.
# A runtime CDN base outside the baked list is ignored (falls back to the /cdn
# proxy) — see src/modules/media/cdn-allowlist.ts.
ARG MEDIA_CDN_URL=
ENV MEDIA_CDN_URL=${MEDIA_CDN_URL}
ARG CSP_EXTRA_HOSTS=
ENV CSP_EXTRA_HOSTS=${CSP_EXTRA_HOSTS}

# Optional build provenance — surfaced on the admin Performance page. Like the
# other NEXT_PUBLIC_* vars it is inlined at build time. Set as a Coolify Build
# Arg (e.g. the deployed git SHA) for traceability; unset ⇒ page shows "absent".
ARG NEXT_PUBLIC_BUILD_SHA=
ENV NEXT_PUBLIC_BUILD_SHA=${NEXT_PUBLIC_BUILD_SHA}

# Give the Webpack build (and the tsc step below) a hard V8 heap ceiling.
#
# CRITICAL: Coolify builds on the SAME host that runs Postgres + SeaweedFS + the
# live app, AND — during a rolling deploy — the OLD container too, until the new
# one is healthy. `next build` then spawns one worker per vCPU (each inheriting
# this ceiling): compile in the main process, then ~N workers for static-page
# generation. So this value must sit below the RAM actually FREE *during a
# deploy* — which is well under the box's nominal size once those services + the
# old container are accounted for. A ceiling above free RAM lets V8 grow lazily
# (it won't GC until it nears the ceiling) until the kernel OOM-kills a worker:
#   "Next.js build worker exited with code: null and signal: SIGKILL"
# surfacing as a bare "exit 255" right after "Creating an optimized production
# build". LOWERING the ceiling FIXES that kill — it makes V8 GC sooner and stay
# under free RAM. (Only RAISE it if you instead see a clean Node "JavaScript heap
# out of memory" — meaning the build genuinely needs more than the ceiling.)
# Rough guidance (free ≈ box RAM minus co-located services AND the old container):
#   - 2 GB box  → 1024   (+ add OS swap; this size really needs it)
#   - 4 GB box  → 2560–3072 (+ OS swap; keep the old container stopped during build)
#   - 6 GB box  → 3072–4096
#   - 8 GB+ box → 4096+ (this default)
# NOTE: 2048 was once enough but the app has grown — a 2048 MB heap now hits a CLEAN
# Node "JavaScript heap out of memory" (SIGABRT) partway through `next build`, so the
# default is 4096. On a SMALL box that instead gets OS-killed (bare "exit 255"/SIGKILL
# right after "Creating an optimized production build"), LOWER this via a Coolify Build
# Arg (NODE_BUILD_MEMORY) + add OS swap — a lower ceiling makes V8 GC sooner.
ARG NODE_BUILD_MEMORY=4096
ENV NODE_OPTIONS="--max-old-space-size=${NODE_BUILD_MEMORY}"

# Bundle only — type-checking is disabled in next.config.ts and runs as its
# own step below (Next 16 never lints during build). Keeps the bundler's
# peak memory low.
RUN pnpm build

# Type-check as a SEPARATE process so its memory doesn't stack on the
# bundler's. Runs after `pnpm build`, so the generated `next-env.d.ts`
# and `.next/types/**` that tsconfig includes already exist. A type error
# here fails the deploy — type safety is preserved despite
# `typescript.ignoreBuildErrors` in next.config.ts.
RUN pnpm exec tsc --noEmit

# Bundle the standalone migration + secret-bootstrap runners (no path-alias
# deps, no TypeScript) so they can be exec'd directly from the runtime image
# without node_modules.
#
# Output is CommonJS rather than ESM because the underlying `pg` driver uses
# dynamic require() of Node builtins (e.g. require('events')) — ESM bundling
# rewrites those calls in a way that breaks at runtime.
#
# pg-native is optional and not installed; mark it external so esbuild
# doesn't try to bundle a missing dep.
RUN pnpm exec esbuild src/lib/db/migrate.ts \
      --bundle --platform=node --format=cjs --target=node22 \
      --external:pg-native \
      --outfile=.next/migrate.cjs \
 && pnpm exec esbuild src/lib/db/init-secrets.ts \
      --bundle --platform=node --format=cjs --target=node22 \
      --external:pg-native \
      --outfile=.next/init-secrets.cjs

# ────────────────────────────────────────────────────────────────────────────────
# 3. runtime
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Optional RUNTIME V8 heap ceiling (MB) for the live server — gives V8 a hard
# bound so a leak/spike triggers graceful GC + a clean exit instead of a kernel
# OOM-kill of the container. OPT-IN (empty default = unchanged behaviour, so a
# wrong value can never starve a healthy server): set NODE_RUNTIME_MEMORY as a
# Coolify build arg, OR set NODE_OPTIONS directly as a runtime env. MUST be below
# the container's memory limit or it's a no-op. Distinct from NODE_BUILD_MEMORY
# (builder stage only). The entrypoint wires it into NODE_OPTIONS below.
ARG NODE_RUNTIME_MEMORY=""
ENV NODE_RUNTIME_MEMORY=${NODE_RUNTIME_MEMORY}

# Run as non-root.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Standalone server + public + static.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Bundled migration + secret bootstrap runners — self-contained CJS, no
# node_modules required at runtime. Migration SQL files are shipped alongside.
COPY --from=builder --chown=nextjs:nodejs /app/.next/migrate.cjs ./db-runner/migrate.cjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/init-secrets.cjs ./db-runner/init-secrets.cjs
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/db/migrations ./db-runner/migrations

# Entrypoint: apply migrations + bootstrap missing secrets + exec the server.
# Heredoc emitted by buildkit (syntax=docker/dockerfile:1.7).
COPY --chown=nextjs:nodejs --chmod=0755 <<'EOF' /app/entrypoint.sh
#!/bin/sh
set -e

# Optional runtime heap ceiling (opt-in). Apply NODE_RUNTIME_MEMORY only when set
# AND the operator hasn't already supplied an explicit NODE_OPTIONS (which wins).
# Guard: V8's --max-old-space-size takes a bare MB INTEGER (no "g"/"MB" units) —
# a non-numeric value would make every `node` invocation below exit 9, and with
# `set -e` that crash-loops the container. So ignore (and log) anything that
# isn't all-digits instead of bricking the boot.
if [ -n "${NODE_RUNTIME_MEMORY}" ] && [ -z "${NODE_OPTIONS}" ]; then
  case "${NODE_RUNTIME_MEMORY}" in
    *[!0-9]*)
      echo "[entrypoint] ignoring non-numeric NODE_RUNTIME_MEMORY='${NODE_RUNTIME_MEMORY}' (expected an MB integer, e.g. 1536)" ;;
    *)
      export NODE_OPTIONS="--max-old-space-size=${NODE_RUNTIME_MEMORY}"
      echo "[entrypoint] NODE_OPTIONS=${NODE_OPTIONS}" ;;
  esac
fi

echo "[entrypoint] applying migrations (idempotent)…"
# Uses MIGRATION_DATABASE_URL when set (a DIRECT Postgres URL — never the
# PgBouncer pooler), else DATABASE_URL. See src/lib/db/migrate.ts.
node /app/db-runner/migrate.cjs

echo "[entrypoint] bootstrapping secrets (env wins; missing → generate + persist)…"
# stdout from init-secrets is `export KEY='value'` lines; stderr is logs.
# CAPTURE first, then eval into the current shell so the exported KEYs reach
# `node server.js`. A bare `eval "$(…)"` would swallow a failure: under `set -e`
# eval of the (empty) output returns 0, and the server would boot without
# BETTER_AUTH_SECRET / PAYMENT_ENCRYPTION_KEY — 500 on every request while the
# liveness healthcheck stays green. Abort instead so the container restarts.
SECRETS="$(node /app/db-runner/init-secrets.cjs)" || {
  echo "[entrypoint] init-secrets failed — aborting boot" >&2
  exit 1
}
eval "$SECRETS"
unset SECRETS

echo "[entrypoint] starting Next.js…"
exec node server.js
EOF

USER nextjs
EXPOSE 3000

# Cold-boot reality: applying the baseline migration (extensions, all
# tables + indexes) + secret bootstrap + default-admin creation + Next.js
# compile-on-first-request can hit 60-90s on a fresh 4-vCPU VPS. A short
# start_period trips the healthcheck before the app is ready → Coolify
# restart loop.
HEALTHCHECK --interval=15s --timeout=10s --start-period=120s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["/app/entrypoint.sh"]

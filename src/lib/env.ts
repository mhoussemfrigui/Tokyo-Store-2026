import { z } from "zod";

/**
 * Server-side environment variables.
 *
 * Validated **lazily** on first access. This matters because Next.js's build
 * process imports server modules to collect page data — it would otherwise
 * blow up if production env vars aren't present at build time. In CI / Docker
 * we build first, then provide real env vars at container start.
 *
 * Import `serverEnv` only from server-side code (Server Components, route
 * handlers, Server Actions, scripts). Client code uses `clientEnv` below.
 *
 * The build-time guard `process.env.NEXT_PHASE === 'phase-production-build'`
 * relaxes required strings to defaults so the build can finish; **runtime**
 * still enforces them strictly.
 */

const booleanString = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

/**
 * Coolify (and most container orchestrators) pass *empty strings* for env
 * vars that the operator left blank in the dashboard, instead of leaving
 * them undefined. That means a `.optional()` Zod field with a format
 * check like `.email()` or `.min(8)` fails validation on the empty string
 * even though the operator intended "not set".
 *
 * This helper preprocesses any whitespace-only value (`""`, `"  "`) into
 * `undefined` BEFORE the inner schema runs — so `.optional()` actually
 * means "set or unset" regardless of how the orchestrator delivered it.
 */
function optional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    schema.optional(),
  );
}

// Only `phase-production-build` matters here — that's the phase `next build`
// runs the env validator in without a reachable DB. (An earlier second disjunct,
// `phase-development-server-collect`, was not a real Next.js phase and never
// matched, so it was removed.)
const isBuildTime = process.env.NEXT_PHASE === "phase-production-build";

// At build time, DB-touching code shouldn't run (we mark pages dynamic where
// they need DB), but the env validator still loads. Provide harmless defaults
// so the build succeeds, and let runtime enforce real values.
function buildSchema() {
  return z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),

    DATABASE_URL: isBuildTime
      ? z
          .string()
          .url()
          .default("postgresql://build:build@localhost:5432/build")
      : z.string().url(),

    // Optional CA bundle (PEM literal or file path) for verified Postgres TLS.
    // When set and DATABASE_URL has sslmode=require, the pg client verifies the
    // server certificate (rejectUnauthorized: true). See src/lib/db/ssl.ts.
    DB_SSL_CA: optional(z.string()),

    BETTER_AUTH_SECRET: isBuildTime
      ? z.string().default("build_time_placeholder_secret_replace_in_runtime_env")
      : z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 chars"),

    BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),

    ADMIN_BOOTSTRAP_TOKEN: optional(z.string().min(8)),

    // Shared secret for the scheduled data-retention purge
    // (POST /api/cron/retention). Optional so local dev boots without it; the
    // route returns 503 when it's unset (never runs the purge unguarded) and
    // 401 on an Authorization-header mismatch. Set a long random value in the
    // Coolify dashboard and pass it as `Authorization: Bearer <value>` from the
    // scheduled job. See docs/deployment-coolify.md §12.
    CRON_SECRET: optional(z.string().min(16)),

    // Opt-out for the auto-created default admin (houssem@kawn.me by default).
    // See src/lib/bootstrap/default-admin.ts. Default: enabled.
    DISABLE_DEFAULT_ADMIN: booleanString,

    // Must include every provider the resolver + admin Mailing tab accept
    // (see src/lib/email/config.ts). "internal" was missing here, so setting
    // EMAIL_PROVIDER=internal made serverEnv validation throw on first access
    // and crash-loop boot, even though the DB-selected "internal" worked.
    EMAIL_PROVIDER: z.enum(["resend", "smtp", "console", "internal"]).default("console"),
    EMAIL_FROM: z.string().default("Tokyo Store <noreply@tokyostore.tn>"),
    EMAIL_REPLY_TO: optional(z.string().email()),

    RESEND_API_KEY: optional(z.string()),

    SMTP_HOST: optional(z.string()),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: optional(z.string()),
    SMTP_PASSWORD: optional(z.string()),
    SMTP_SECURE: booleanString,
    // Local sendmail binary path for the "internal" provider — env overrides the
    // admin `mail.sendmail_path` setting (see src/lib/email/config.ts). Declared
    // here for parity with the other mail vars.
    SENDMAIL_PATH: optional(z.string()),

    // Object storage speaks the S3 protocol (SeaweedFS in dev + prod; any
    // S3-compatible endpoint works). Local dev = the SeaweedFS S3 gateway on
    // :8333 (docker-compose.dev.yml).
    S3_ENDPOINT: z.string().url().default("http://localhost:8333"),
    S3_REGION: z.string().default("us-east-1"),
    S3_BUCKET: z.string().default("tokyo"),
    S3_ACCESS_KEY: z.string().default("seaweedfs"),
    S3_SECRET_KEY: z.string().default("seaweedfs_dev_secret"),
    S3_FORCE_PATH_STYLE: booleanString,
    S3_PUBLIC_URL: z.string().url().default("http://localhost:8333/tokyo"),

    // ── Payment gateways. Credentials are configurable in the admin panel
    //    (stored encrypted in `payment_provider_settings`); these env vars
    //    FORCE-OVERRIDE the DB value when set (a blank value = unset). See
    //    src/lib/payments/config.ts. `PAYMENT_ENCRYPTION_KEY` encrypts the
    //    DB-stored secrets at rest.
    PAYMENT_ENCRYPTION_KEY: optional(z.string()),
    // ── Social login (OAuth). A provider is active only when BOTH its id +
    //    secret are set; the admin toggle (auth.social.*_enabled) then gates
    //    whether the storefront shows the button. See src/lib/auth/server.ts.
    GOOGLE_CLIENT_ID: optional(z.string()),
    GOOGLE_CLIENT_SECRET: optional(z.string()),
    FACEBOOK_CLIENT_ID: optional(z.string()),
    FACEBOOK_CLIENT_SECRET: optional(z.string()),
    CLICTOPAY_USERNAME: optional(z.string()),
    CLICTOPAY_PASSWORD: optional(z.string()),
    CLICTOPAY_TEST_MODE: optional(z.string()),
    FLOUCI_APP_TOKEN: optional(z.string()),
    FLOUCI_APP_SECRET: optional(z.string()),
    FLOUCI_TEST_MODE: optional(z.string()),

    // ── AI & Automation provider keys. Configurable in the admin hub (stored
    //    encrypted in `ai_provider_settings`); these env vars FORCE-OVERRIDE the
    //    DB value when set (a blank value = unset). See src/lib/ai/config.ts.
    OPENROUTER_API_KEY: optional(z.string()),
    DEEPSEEK_API_KEY: optional(z.string()),
    OPENAI_API_KEY: optional(z.string()),
    ANTHROPIC_API_KEY: optional(z.string()),
  });
}

const clientSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
});

type ServerEnv = z.infer<ReturnType<typeof buildSchema>>;
type ClientEnv = z.infer<typeof clientSchema>;

let cachedServer: ServerEnv | null = null;
let cachedClient: ClientEnv | null = null;

// Known dev/placeholder defaults that MUST NOT be used in production.
// Keep this list in sync with the `.default(...)` calls in `buildSchema()`.
const DEV_PLACEHOLDERS = {
  S3_SECRET_KEY: "seaweedfs_dev_secret",
  S3_ACCESS_KEY: "seaweedfs",
  BETTER_AUTH_SECRET: "build_time_placeholder_secret_replace_in_runtime_env",
} as const;

/**
 * Detect secrets that are obviously placeholders / examples rather than real
 * generated values. `.env.example` ships a 32+ char sample so a copy-paste-and-
 * deploy would otherwise satisfy the length check and run production with a
 * public, repo-known secret (trivial session-token forgery). Mirror this with
 * the example values so the two never drift apart.
 */
function isPlaceholderSecret(v: string): boolean {
  return /change[-_]?me|replace|example|placeholder|dev[-_]?secret|your[-_]?secret|secret[-_]?here|sample|minimum_32|test[-_]?secret/i.test(
    v,
  );
}

/**
 * Hard runtime check: when NODE_ENV=production, refuse to start if any
 * critical secret still equals its development placeholder or is empty.
 *
 * Coolify (and similar orchestrators) deliver blank dashboard values as
 * empty strings, which would silently fall through Zod's `.default(...)`
 * onto the dev value below. Catching this at boot prevents leaking the
 * dev object-store credentials, build-time auth secret, or localhost DB into
 * a live deployment.
 *
 * Each thrown message names the exact env var the operator must set in
 * the Coolify dashboard, so the failure is self-diagnosing.
 */
function assertProductionSecrets(env: ServerEnv): void {
  const errors: string[] = [];

  const rawSecret = (process.env.S3_SECRET_KEY ?? "").trim();
  if (
    rawSecret === "" ||
    env.S3_SECRET_KEY === DEV_PLACEHOLDERS.S3_SECRET_KEY
  ) {
    errors.push(
      "S3_SECRET_KEY is unset or still equals the dev placeholder. " +
        "Set S3_SECRET_KEY in your Coolify dashboard to the real bucket secret.",
    );
  }

  const rawAccess = (process.env.S3_ACCESS_KEY ?? "").trim();
  if (
    rawAccess === "" ||
    env.S3_ACCESS_KEY === DEV_PLACEHOLDERS.S3_ACCESS_KEY
  ) {
    errors.push(
      "S3_ACCESS_KEY is unset or still equals the dev placeholder (\"seaweedfs\"). " +
        "Set S3_ACCESS_KEY in your Coolify dashboard to the real bucket access key.",
    );
  }

  // BETTER_AUTH_SECRET guards EVERY session token, so a weak value in production
  // = forgeable sessions = full account takeover. A 32-char keyword check is not
  // enough: an operator can hand-type a 32-char low-entropy string that dodges
  // `isPlaceholderSecret()` (e.g. "aaaa…" or "abcdefgh…" repeated). Enforce, in
  // prod: (a) ≥ 40 chars — `openssl rand -base64 32` yields 44, so a real
  // generated secret always clears this while a hand-typed one usually won't;
  // (b) not the build-time default / a known placeholder keyword; (c) a minimum
  // distinct-character count, which rejects "AAAA…/0101…/abcabc…"-style
  // low-entropy strings that are long but trivially guessable.
  const secret = env.BETTER_AUTH_SECRET;
  const distinctChars = new Set(secret).size;
  if (
    secret.length < 40 ||
    secret === DEV_PLACEHOLDERS.BETTER_AUTH_SECRET ||
    isPlaceholderSecret(secret) ||
    distinctChars < 16
  ) {
    errors.push(
      "BETTER_AUTH_SECRET is weak: in production it must be ≥ 40 chars, NOT a " +
        "placeholder/example, NOT the build-time default, and have sufficient " +
        "entropy (≥ 16 distinct characters). Generate one with " +
        "`openssl rand -base64 32` and set BETTER_AUTH_SECRET in your Coolify dashboard.",
    );
  }

  // Reject a DATABASE_URL that still points at localhost — almost certainly
  // a missed env override. We match the host portion of the URL so query
  // strings (e.g. ?host=...) don't trigger false positives.
  try {
    const dbUrl = new URL(env.DATABASE_URL);
    // URL.hostname returns IPv6 hosts bracketed ("[::1]") — strip so the
    // loopback comparison below actually matches.
    const host = dbUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      errors.push(
        "DATABASE_URL points at localhost in production. " +
          "Set DATABASE_URL in your Coolify dashboard to the managed Postgres connection string.",
      );
    }
  } catch {
    // URL parse failure is already caught by the Zod `.url()` check above.
  }

  // Reject an S3_PUBLIC_URL whose host is localhost/private in production. Left
  // at its dev default, next.config's s3PublicUrlIsLocal() flips
  // images.dangerouslyAllowLocalIP=true, disabling Next's image-optimizer SSRF
  // guard. Catching it here means a prod deploy can't silently boot with the
  // guard off (mirrors the DATABASE_URL localhost check).
  try {
    // Strip IPv6 brackets ("[::1]" → "::1") so the explicit loopback check hits.
    const host = new URL(env.S3_PUBLIC_URL).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const isPrivate =
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
      /^169\.254\./.test(host) ||
      !host.includes(".") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host.endsWith(".svc");
    if (isPrivate) {
      // NON-FATAL (was a hard fail — which crash-looped the site). Many valid
      // topologies (this Coolify one) run the object store on the private Docker network
      // and serve public media via the same-origin /cdn proxy, so an internal
      // S3_PUBLIC_URL is correct, not a misconfiguration. Only warn. The
      // residual image-optimizer SSRF surface is already bounded by
      // images.remotePatterns (only the configured bucket host is allowed).
      console.warn(
        "[env] S3_PUBLIC_URL points at a localhost/private host in production — the Next.js " +
          "image-optimizer SSRF guard (dangerouslyAllowLocalIP) is relaxed for it. If media is " +
          "served from a public CDN instead, set S3_PUBLIC_URL to that domain.",
      );
    }
  } catch {
    // .url() already validated the format.
  }

  // Reject a BETTER_AUTH_URL still pointing at localhost in production. It is
  // baked into auth callback/cookie origins; left at the localhost default a
  // prod deploy would mint cookies for / redirect to localhost and silently
  // break sign-in. Mirrors the DATABASE_URL localhost guard above.
  try {
    const parsed = new URL(env.BETTER_AUTH_URL);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      errors.push(
        "BETTER_AUTH_URL points at localhost in production. " +
          "Set BETTER_AUTH_URL in your Coolify dashboard to the public site origin (e.g. https://tokyostore.tn).",
      );
    }
    // Sessions/cookies and the OAuth callback are minted against this origin; an
    // http:// value in prod exposes the auth redirect (and its tokens) to MITM.
    // The Secure cookie flag stops the browser SENDING cookies over http, but
    // the callback response itself would still travel in clear — refuse to boot.
    if (parsed.protocol !== "https:") {
      errors.push(
        "BETTER_AUTH_URL must use https:// in production. " +
          "Set it to your public HTTPS origin (e.g. https://tokyostore.tn).",
      );
    }
  } catch {
    // .url() already validated the format.
  }

  // NEXT_PUBLIC_SITE_URL is baked into the payment gateway return + webhook URLs
  // (and the canonical links). Left at the localhost default, a prod deploy
  // hands the gateway a dead `returnUrl` → a real, successful payment NEVER
  // settles (the order is stuck `pending` forever). It is a Docker BUILD
  // ARGUMENT (frozen at build), so a REBUILD — not a restart — is required to
  // change it. Mirrors the BETTER_AUTH_URL guard above.
  try {
    const parsed = new URL(env.NEXT_PUBLIC_SITE_URL);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      errors.push(
        "NEXT_PUBLIC_SITE_URL points at localhost in production. " +
          "Set it as a Coolify BUILD ARGUMENT to the public site origin (e.g. " +
          "https://tokyostore.tn) and REBUILD — payment return/webhook URLs derive " +
          "from it, so a localhost value strands every online payment as pending.",
      );
    }
    if (parsed.protocol !== "https:") {
      errors.push(
        "NEXT_PUBLIC_SITE_URL must use https:// in production (Docker build argument).",
      );
    }
  } catch {
    // .url() already validated the format.
  }

  if (errors.length > 0) {
    const banner =
      "Refusing to start: production environment variables look like dev placeholders.\n";
    throw new Error(banner + errors.map((e) => `  - ${e}`).join("\n"));
  }
}

/**
 * Render a Zod field-error map into a multiline string that fits inside an
 * Error.message. Why bother? Next.js's instrumentation hook wraps boot
 * errors with "An error occurred while loading instrumentation hook: <msg>"
 * and the wrapper only carries the error's `message`. Any explanation we
 * write to `console.error` BEFORE throwing is invisible in Coolify logs —
 * they only capture the final unhandled rejection. Embedding the field
 * details in the throw makes the problem self-diagnosing in prod.
 */
function formatFieldErrors(
  errors: Record<string, string[] | undefined>,
  banner: string,
): string {
  const lines: string[] = [];
  for (const [key, msgs] of Object.entries(errors)) {
    if (!msgs?.length) continue;
    for (const m of msgs) lines.push(`  - ${key}: ${m}`);
  }
  if (lines.length === 0) {
    // Defensive: shouldn't happen with safeParse failure, but never throw
    // an empty error message at the operator.
    return banner;
  }
  return `${banner}\n${lines.join("\n")}`;
}

function loadServerEnv(): ServerEnv {
  if (cachedServer) return cachedServer;
  const parsed = buildSchema().safeParse(process.env);
  if (!parsed.success) {
    const detail = formatFieldErrors(
      parsed.error.flatten().fieldErrors,
      "Invalid server environment variables — set these in your Coolify dashboard:",
    );
    // Still write to console.error so a `docker logs` tail surfaces it,
    // but the throw carries the same payload so Coolify's structured
    // capture sees it too.
    console.error(detail);
    throw new Error(detail);
  }
  if (!isBuildTime) {
    // NON-FATAL: the provider credentials may now be supplied from the admin
    // Mailing tab (encrypted in site_settings) instead of env, so a missing env
    // credential must not block boot. Resolution happens per-send in
    // lib/email/config.ts (env wins → DB). Warn so a genuinely-unconfigured
    // provider is still diagnosable.
    if (parsed.data.EMAIL_PROVIDER === "resend" && !parsed.data.RESEND_API_KEY) {
      console.warn(
        "[env] EMAIL_PROVIDER=resend but RESEND_API_KEY is unset in env — emails will use the " +
          "key configured in the admin Mailing tab if present, otherwise sending will fail.",
      );
    }
    if (
      parsed.data.EMAIL_PROVIDER === "smtp" &&
      (!parsed.data.SMTP_HOST || !parsed.data.SMTP_USER)
    ) {
      console.warn(
        "[env] EMAIL_PROVIDER=smtp but SMTP_HOST/SMTP_USER are unset in env — emails will use the " +
          "SMTP config from the admin Mailing tab if present, otherwise sending will fail.",
      );
    }
    if (parsed.data.NODE_ENV === "production") {
      assertProductionSecrets(parsed.data);
    }
  }
  cachedServer = parsed.data;
  return cachedServer;
}

function loadClientEnv(): ClientEnv {
  if (cachedClient) return cachedClient;
  const parsed = clientSchema.safeParse({
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  });
  if (!parsed.success) {
    const detail = formatFieldErrors(
      parsed.error.flatten().fieldErrors,
      "Invalid client environment variables:",
    );
    console.error(detail);
    throw new Error(detail);
  }
  cachedClient = parsed.data;
  return cachedClient;
}

/**
 * Proxy that defers validation until any property is actually read. This way
 * `import { serverEnv } from "@/lib/env"` is cheap; touching `serverEnv.X`
 * triggers the schema check (and caches the result).
 */
export const serverEnv: ServerEnv = new Proxy({} as ServerEnv, {
  get(_target, prop) {
    return loadServerEnv()[prop as keyof ServerEnv];
  },
});

export const clientEnv: ClientEnv = new Proxy({} as ClientEnv, {
  get(_target, prop) {
    return loadClientEnv()[prop as keyof ClientEnv];
  },
});

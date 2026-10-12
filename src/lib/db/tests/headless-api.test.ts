import "server-only";

/**
 * Headless read API (P7) — the security-critical pieces:
 *
 *  1. `getContentBundle().settings` exposes the PUBLIC subset only — a planted
 *     `payment.*` / `mail.*_enc` secret must NOT appear; a `site.*` branding
 *     value must, and so must the footer `social.*` URLs + `nav.*` label
 *     overrides the storefront renders (while `auth.social.*` stays out). (This
 *     is the leak-prevention contract of the bundle.)
 *  2. The new read routes are registered in the catalog: external tier, a
 *     `<resource>:read` scope, and `canBePublic = true` (admins can open them).
 *  3. Scope math: coarse "read" / "full" grant the new reads; a *different*
 *     resource's scope does not.
 *
 * Self-cleaning (`zztest.headless.*` setting keys).
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/headless-api.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { getContentBundle } from "@/lib/api/content";
import { routeById } from "@/lib/api-auth/route-catalog";
import { hasScope } from "@/lib/api-auth/scopes";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const KEYS = {
  realPublic: "site.zztest_headless_label", // site.* → public
  paySecret: "payment.zztest_headless_secret_key", // payment.* → excluded
  mailEnc: "mail.zztest_headless_smtp_enc", // mail.* + _enc → excluded
  social: "social.zztest_headless_instagram", // social.* (footer icons) → public
  nav: "nav.zztest_headless.name", // nav.* (renamed nav roots) → public
  authSocial: "auth.social.zztest_headless_enabled", // auth.* → excluded (not "social.")
};

async function cleanup() {
  await db.execute(sql`delete from site_settings where key like 'site.zztest_headless%' or key like 'payment.zztest_headless%' or key like 'mail.zztest_headless%' or key like 'social.zztest_headless%' or key like 'nav.zztest_headless%' or key like 'auth.social.zztest_headless%'`);
}

async function main() {
  await cleanup();

  // Plant a public branding value + two secrets.
  await db.execute(sql`
    insert into site_settings (key, value, group_key, label)
    values
      (${KEYS.realPublic}, 'Visible', 'site', 'zztest'),
      (${KEYS.paySecret}, 'sk_live_DO_NOT_LEAK', 'payment', 'zztest'),
      (${KEYS.mailEnc}, 'ENCRYPTED_DO_NOT_LEAK', 'mail', 'zztest'),
      (${KEYS.social}, 'https://instagram.example/tokyo', 'social', 'zztest'),
      (${KEYS.nav}, 'La Maison', 'nav', 'zztest'),
      (${KEYS.authSocial}, 'true', 'auth', 'zztest')
  `);

  const bundle = await getContentBundle();
  const s = bundle.settings;

  check("public site.* setting is exposed in the bundle", s[KEYS.realPublic] === "Visible");
  check("payment.* secret is NOT in the bundle", !(KEYS.paySecret in s));
  check("mail.*_enc secret is NOT in the bundle", !(KEYS.mailEnc in s));
  check("footer social.* URL is exposed in the bundle", s[KEYS.social] === "https://instagram.example/tokyo");
  check("nav.* label override is exposed in the bundle", s[KEYS.nav] === "La Maison");
  check("auth.social.* is NOT in the bundle (the social. prefix doesn't match it)", !(KEYS.authSocial in s));
  check(
    "no exposed key starts with payment. or mail. or auth.",
    Object.keys(s).every((k) => !/^(payment\.|mail\.|auth\.)/.test(k)),
  );
  check(
    "no exposed key looks secret (_enc/secret/token/password/key)",
    Object.keys(s).every((k) => !/(_enc|secret|password|token|api_?key|private)/i.test(k)),
  );
  check("bundle has the chrome shape", Array.isArray(bundle.banners.hero));
  check(
    "bundle exposes trust badges as an array of {kind,label,icon,visibility}",
    Array.isArray(bundle.trustBadges) &&
      bundle.trustBadges.every(
        (b) =>
          typeof b.label === "string" &&
          typeof b.icon === "string" &&
          typeof b.visibility === "string" &&
          ("kind" in b),
      ),
  );

  // ── route registration ──────────────────────────────────────────────────
  for (const id of ["content.bundle", "blog.list", "blog.get", "reviews.list"]) {
    const r = routeById(id);
    check(`route ${id} is registered, external, read, public-toggleable`,
      !!r && r.tier === "external" && r.action === "read" && r.canBePublic === true && /:read$/.test(r.scope ?? ""));
  }

  // ── scope math ───────────────────────────────────────────────────────────
  check("coarse 'read' grants content:read", hasScope(["read"], "content:read"));
  check("'full' grants reviews:read", hasScope(["full"], "reviews:read"));
  check("blog:read grants blog:read", hasScope(["blog:read"], "blog:read"));
  check("products:read does NOT grant content:read", !hasScope(["products:read"], "content:read"));

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));

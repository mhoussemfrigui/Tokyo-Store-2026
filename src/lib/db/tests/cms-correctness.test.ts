import "server-only";

/**
 * CMS correctness invariants (A–Z audit 2026-09-23, phase 3):
 *   - validateSiteSetting guards the contact email / phone + canonical URL, and
 *     the CSP frame-src allows the Google Maps embed origin (the store-locator
 *     page block's map);
 *   - a security-relevant setting (auth.*, checkout.payment.*, seo.site_url,
 *     site.mode, contact + link destinations…) is audited with its from → to
 *     values at warn severity; a secret-looking key never carries values;
 *   - CMS workflows keep zod's detail: the banner names the field (French
 *     label) and every issue lands in `fieldErrors`;
 *   - a DELETED page's slug is reported as reserved by that tombstone (the
 *     pages index is total) instead of a bare 23505;
 *   - every static `(shop)/<name>/page.tsx` route is a reserved slug;
 *   - a page can't be published with zero VISIBLE blocks (composer layout);
 *   - meta edits emit `page.updated` (slug + changedFields), not a section event;
 *   - the sitemap page query includes published SYSTEM pages (served by
 *     /[slug] when they have no file route — e.g. /garantie-retours).
 * Self-cleaning (`zztest-cmscorr` slugs/keys + every audit row written by the
 * synthetic actor). Run against the isolated test DB:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/cms-correctness.test.ts
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { bus, type EventEnvelope } from "@/events/bus";
import { severityFor } from "@/events/severity";
import { registerAllSubscribers } from "@/events/subscribers";
import { __resetAuditRuntimeConfig, getAuditRuntimeConfig } from "@/lib/audit/runtime-config";
import { isSecretSettingKey, isSensitiveSettingKey } from "@/lib/cms/sensitive-settings";
import { buildCsp } from "@/lib/security/headers";
import { RESERVED_ROUTES } from "@/lib/utils/slug-conflict";
import { pageService } from "@/modules/cms/page/service";
import { validateSiteSetting } from "@/workflows/cms/setting";
import { uniqueViolationFail, zodValidationFail } from "@/workflows/shared";
import { workflows } from "@/workflows";

const TAG = "zztest-cmscorr";
const KEY_PREFIX = "zztest.cmscorr.";
const ACTOR = "__cmscorr-admin";

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

async function cleanup() {
  await db.execute(sql`delete from pages where slug like ${TAG + "%"}`);
  await db.execute(
    sql`delete from nav_items where menu_id in (select id from nav_menus where key like ${TAG + "%"})`,
  );
  await db.execute(sql`delete from nav_menus where key like ${TAG + "%"}`);
  await db.execute(sql`delete from site_settings where key like ${KEY_PREFIX + "%"}`);
  await db.execute(sql`delete from audit_log where actor_user_id = ${ACTOR}`);
}

function pure() {
  // ── validateSiteSetting (contact + canonical-URL guards) ──────────────────
  check("email: valid accepted", validateSiteSetting("site.contact_email", "a@b.tn") === null);
  check("email: invalid refused", validateSiteSetting("site.contact_email", "nope") !== null);
  check("phone: valid accepted", validateSiteSetting("site.contact_phone", "+216 50 059 160") === null);
  check("phone: too short refused", validateSiteSetting("site.contact_phone", "12") !== null);
  check("seo.site_url: https accepted", validateSiteSetting("seo.site_url", "https://tokyostore.tn") === null);
  check("seo.site_url: non-http refused", validateSiteSetting("seo.site_url", "ftp://x.tn") !== null);
  check("blank → OK (clears the key)", validateSiteSetting("site.contact_email", "  ") === null);
  check("an unguarded key passes through", validateSiteSetting("site.name", "anything") === null);
  // The store-locator page block renders a Google Maps <iframe>; the CSP must
  // allow that origin (the only framed third-party host on the storefront).
  const frameSrc = buildCsp().split(";").find((d) => d.trim().startsWith("frame-src")) ?? "";
  check("CSP frame-src allows the Google Maps embed origin", frameSrc.includes("https://www.google.com"));

  // ── sensitive setting classification + severity ───────────────────────────
  for (const k of [
    "seo.site_url",
    "auth.email_verification_required",
    "checkout.payment.flouci_enabled",
    "consent.enabled",
    "redirects.enabled",
    "site.mode",
    "site.contact_email",
    "home.hero.cta_href",
  ]) {
    check(`sensitive: ${k}`, isSensitiveSettingKey(k));
  }
  for (const k of ["site.name", "auth.login.title", "checkout.payment.x_secret", "mail.smtp_password_enc"]) {
    check(`not sensitive-with-values: ${k}`, !isSensitiveSettingKey(k));
  }
  check("*_enc / api_key keys are secret", isSecretSettingKey("x.y_enc") && isSecretSettingKey("ai.api_key"));
  check(
    "severity: sensitive setting.upserted → warn",
    severityFor("setting.upserted", { key: "auth.email_verification_required", groupKey: "auth" }) === "warn",
  );
  check(
    "severity: routine setting.upserted stays info",
    severityFor("setting.upserted", { key: "site.name", groupKey: "site" }) === "info",
  );
  check("severity: name-only caller unchanged (info)", severityFor("setting.upserted") === "info");

  // ── zod detail kept (zodValidationFail) + pages_slug_unique mapping ───────
  const zerr = z
    .object({ slug: z.string().regex(/^[a-z]+$/, "Slug invalide.") })
    .safeParse({ slug: "À" }).error!;
  const zf = zodValidationFail(zerr, { slug: "Slug (URL)" });
  check("zod fail: banner names the field", zf.message === "Slug (URL) : Slug invalide.");
  check("zod fail: fieldErrors keyed by field", zf.fieldErrors?.slug === "Slug invalide.");
  const dup = uniqueViolationFail({ code: "23505", constraint: "pages_slug_unique" });
  check("pages_slug_unique 23505 → slug-keyed conflict", dup?.error === "conflict" && Boolean(dup.fieldErrors?.slug));

  // ── every static storefront route is a reserved slug ──────────────────────
  // Storefront routes live under (shop)/(shell) since the 404-chrome split.
  const shopDir = join(process.cwd(), "src", "app", "(shop)", "(shell)");
  const staticRoutes = readdirSync(shopDir).filter(
    (d) => !d.startsWith("[") && !d.startsWith("(") && existsSync(join(shopDir, d, "page.tsx")),
  );
  const unreserved = staticRoutes.filter((d) => !RESERVED_ROUTES.has(d));
  check(
    `every (shop)/<name>/page.tsx route is reserved${unreserved.length ? ` (missing: ${unreserved.join(", ")})` : ""}`,
    unreserved.length === 0,
  );
}

async function main() {
  await cleanup();
  pure();

  __resetAuditRuntimeConfig();
  const auditOn = (await getAuditRuntimeConfig()).enabled;
  registerAllSubscribers();
  const pageUpdated: EventEnvelope<"page.updated">[] = [];
  bus.on("page.updated", (env) => {
    pageUpdated.push(env);
  });
  const settingEvents: EventEnvelope<"setting.upserted">[] = [];
  bus.on("setting.upserted", (env) => {
    if (env.payload.key.startsWith(KEY_PREFIX)) settingEvents.push(env);
  });
  const ctx = { actorUserId: ACTOR };

  // ── zod detail reaches the operator (page slug, nav href) ──────────────────
  const badSlug = await workflows.cms.createPage({ slug: "À-propos", title: "X" }, ctx);
  check(
    "page: bad slug → field-labelled French message",
    !badSlug.ok && badSlug.message.startsWith("Slug (URL) :") && Boolean(badSlug.fieldErrors?.slug),
  );
  const menu = await workflows.cms.createNavMenu({ key: `${TAG}-menu`, name: "Menu test" }, ctx);
  check("nav: test menu created", menu.ok);
  if (menu.ok) {
    const badHref = await workflows.cms.createNavItem(
      { menuId: menu.data.id, label: "Insta", href: "www.instagram.com/x" },
      ctx,
    );
    check(
      "nav: bad href → the safeHref message (not a bare « Validation échouée »)",
      !badHref.ok && /URL invalide/.test(badHref.message) && Boolean(badHref.fieldErrors?.href),
    );
  }

  // ── tombstoned slug is reported upfront ────────────────────────────────────
  const tomb = await workflows.cms.createPage({ slug: `${TAG}-tomb`, title: "Tomb" }, ctx);
  check("page: create ok", tomb.ok);
  if (tomb.ok) await workflows.cms.deletePage({ pageId: tomb.data.id }, ctx);
  const reuse = await workflows.cms.createPage({ slug: `${TAG}-tomb`, title: "Again" }, ctx);
  check(
    "page: reusing a deleted page's slug → conflict naming the deleted page",
    !reuse.ok && reuse.error === "conflict" && /supprimée/.test(reuse.message) && Boolean(reuse.fieldErrors?.slug),
  );
  const other = await workflows.cms.createPage({ slug: `${TAG}-other`, title: "Other" }, ctx);
  if (other.ok) {
    const rename = await workflows.cms.updatePage({ pageId: other.data.id, slug: `${TAG}-tomb` }, ctx);
    check("page: renaming onto a tombstoned slug → conflict", !rename.ok && rename.error === "conflict");

    // ── meta edit → page.updated (not page.section.changed with "") ─────────
    const n = pageUpdated.length;
    await workflows.cms.updatePage({ pageId: other.data.id, title: "Other 2" }, ctx);
    const ev = pageUpdated[n];
    check(
      "page: title edit emits page.updated with slug + changedFields",
      ev?.payload.pageId === other.data.id && ev.payload.slug === `${TAG}-other` && ev.payload.changedFields.includes("title"),
    );
  }

  // ── publish guard runs on the block composer ──────────────────────────────
  const pg = await workflows.cms.createPage({ slug: `${TAG}-blocks`, title: "Blocs" }, ctx);
  if (pg.ok) {
    const pageId = pg.data.id;
    const empty = await workflows.cms.togglePagePublish({ pageId, publish: true }, ctx);
    check("publish: a custom page with no content is refused", !empty.ok && empty.error === "validation");

    // A layout whose only block is HIDDEN still has nothing to show → refused.
    const hidden = JSON.stringify([
      { id: "b1", type: "rich_text", visible: false, config: { body: "<p>Caché</p>" } },
    ]);
    const savedHidden = await workflows.cms.savePageBlocks({ pageId, blocks: hidden }, ctx);
    check("blocks saved (hidden)", savedHidden.ok);
    const hiddenOnly = await workflows.cms.togglePagePublish({ pageId, publish: true }, ctx);
    check("publish: a page whose blocks are ALL hidden is refused", !hiddenOnly.ok);

    // A visible block unlocks publish.
    const visible = JSON.stringify([
      { id: "b1", type: "rich_text", visible: true, config: { body: "<p>Visible</p>" } },
    ]);
    const n = pageUpdated.length;
    const savedVisible = await workflows.cms.savePageBlocks({ pageId, blocks: visible }, ctx);
    check("blocks saved (visible)", savedVisible.ok);
    check(
      "saving blocks emits page.updated with changedFields ['blocks']",
      pageUpdated[n]?.payload.pageId === pageId && pageUpdated[n]?.payload.changedFields.includes("blocks"),
    );
    const pub = await workflows.cms.togglePagePublish({ pageId, publish: true }, ctx);
    check("publish: allowed once a block is visible", pub.ok);
    // A PUBLISHED page cannot be blanked by a block save (it would serve a live 200
    // placeholder that stays indexed + in the sitemap) — the same has-content invariant
    // the publish guard enforces. A draft may be blanked; a published page may not.
    const blankWhilePublished = await workflows.cms.savePageBlocks({ pageId, blocks: hidden }, ctx);
    check(
      "blanking a PUBLISHED page via block save is refused",
      !blankWhilePublished.ok && blankWhilePublished.error === "validation",
    );
    check(
      "the page stays published after the refused blank",
      (await pageService.findById(pageId))?.is_published === true,
    );
    const editWhilePublished = await workflows.cms.savePageBlocks({ pageId, blocks: visible }, ctx);
    check("a PUBLISHED page still accepts a save that keeps visible content", editWhilePublished.ok);
    const unpub = await workflows.cms.togglePagePublish({ pageId, publish: false }, ctx);
    check("unpublish is never blocked", unpub.ok);
  }

  // ── sitemap query includes published SYSTEM pages ─────────────────────────
  const sys = await pageService.insert({
    slug: `${TAG}-sys`,
    title: "Sys",
    is_system: true,
    is_published: true,
    published_at: new Date(),
  });
  const slugs = new Set((await pageService.listPublishedCustomPageSlugs()).map((p) => p.slug));
  check("sitemap query includes a published system page", slugs.has(sys.slug));

  // ── noindex gate: listNoindexSlugs drives the sitemap drop of noindexed file routes ──
  const nox = await pageService.insert({
    slug: `${TAG}-nox`,
    title: "Nox",
    is_system: true,
    is_published: true,
    published_at: new Date(),
    noindex: true,
  });
  const states = new Map((await pageService.listPageStates()).map((p) => [p.slug, p]));
  check(
    "listPageStates reports noindex + publish state (sitemap gate)",
    states.get(nox.slug)?.noindex === true && states.get(sys.slug)?.noindex === false && states.get(sys.slug)?.isPublished === true,
  );

  // ── sensitive setting: from → to values + warn audit row ──────────────────
  const sensitiveKey = `${KEY_PREFIX}cta_href`;
  const base = { key: sensitiveKey, type: "text" as const, groupKey: "zztest", label: "CTA" };
  await workflows.cms.upsertSetting({ ...base, value: "/a" }, ctx);
  await workflows.cms.upsertSetting({ ...base, value: "/b" }, ctx);
  const last = settingEvents.at(-1)?.payload;
  check("sensitive setting carries from/to", last?.from === "/a" && last?.to === "/b");
  const plainKey = `${KEY_PREFIX}title`;
  await workflows.cms.upsertSetting({ key: plainKey, value: "x", type: "text", groupKey: "zztest", label: "T" }, ctx);
  const plain = settingEvents.at(-1)?.payload;
  check("routine setting stays name-only", plain?.key === plainKey && !("from" in plain) && !("to" in plain));
  if (auditOn) {
    const rows = (
      await db.execute<{ severity: string; summary: string }>(sql`
        select severity, summary from audit_log
        where event_name = 'setting.upserted' and target_id = ${sensitiveKey}
        order by id desc limit 1
      `)
    ).rows;
    check("sensitive audit row is warn", rows[0]?.severity === "warn");
    check("sensitive audit summary names before → after", /« \/a » → « \/b »/.test(rows[0]?.summary ?? ""));
  } else {
    console.log("  (audit capture disabled on this DB — audit-row checks skipped)");
  }

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

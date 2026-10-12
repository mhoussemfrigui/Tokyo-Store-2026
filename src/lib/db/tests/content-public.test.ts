import "server-only";

/**
 * Public content surfaces + marketing List-Unsubscribe (A–Z 2026-09-23, p5):
 *
 *  1. Headless DTOs serialise SANITISED HTML — the `/api/blog` body goes through
 *     `sanitizeRichHtml` (scripts, on*-handlers and off-origin media stripped;
 *     `/cdn/` media kept), exactly what the storefront renders. Bodies are
 *     stored raw, so the DTO is the last gate. The blog body is memoised per
 *     content hash — an edit is re-sanitised.
 *  2. An INACTIVE category is exposed as none — the enriched post (page
 *     link + breadcrumb + API DTO) carries `category: null`.
 *  3. `parseListingCursor` accepts the services' own nextCursor and drops junk
 *     (the storefront `?cursor=` pagination of /blog).
 *  4. RFC 8058 one-click unsubscribe: `listUnsubscribeHeaders` shape + token;
 *     POST /api/unsubscribe/one-click opts a valid token's address out (forged →
 *     same 200, nothing changes); GET never unsubscribes (303 → confirm page);
 *     the inline dispatch path AND the queue drain hand the headers to the
 *     provider for MARKETING mail only. Both routes are catalogued.
 *
 * Forces the console provider (captured, never a real email). Self-cleaning
 * (`zztest-cpub` slugs, `__cpubtest` addresses). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/content-public.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { blogService } from "@/modules/blog/service";
import { blogQueries } from "@/modules/blog";
import { getApiBlogPost } from "@/lib/api/blog";
import { parseListingCursor } from "@/lib/utils/listing-cursor";
import { listUnsubscribeHeaders, ONE_CLICK_UNSUBSCRIBE_PATH } from "@/lib/email/list-unsubscribe";
import { verifyUnsubToken } from "@/lib/crypto/sign";
import { consoleProvider } from "@/lib/email/providers/console";
import { invalidateMailConfigCache } from "@/lib/email/config";
import type { EmailPayload } from "@/lib/email/types";
import { newsletterService } from "@/modules/newsletter/service";
import { dispatchEmail, emailLogService } from "@/modules/mailing";
import { drainEmailQueue } from "@/lib/mailing/drain";
import { routeById } from "@/lib/api-auth/route-catalog";
import { GET as oneClickGET, POST as oneClickPOST } from "@/app/api/unsubscribe/one-click/route";

const TAG = "zztest-cpub";
const MAIL = "__cpubtest";

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

type Row = Record<string, unknown>;
function rowsOf(res: unknown): Row[] {
  const r = res as { rows?: Row[] };
  return r.rows ?? (res as Row[]);
}

async function readSetting(key: string): Promise<string | null | undefined> {
  const rows = rowsOf(await db.execute(sql`select value from site_settings where key = ${key}`));
  return rows.length ? (rows[0].value as string | null) : undefined;
}
async function writeSetting(key: string, value: string) {
  await db.execute(
    sql`insert into site_settings (key, value, type, label) values (${key}, ${value}, 'text', 'test')
        on conflict (key) do update set value = ${value}`,
  );
}
async function restoreSetting(key: string, prior: string | null | undefined) {
  if (prior === undefined) await db.execute(sql`delete from site_settings where key = ${key}`);
  else await db.execute(sql`update site_settings set value = ${prior} where key = ${key}`);
}

async function cleanup() {
  await db.execute(sql`delete from blog_posts where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from blog_categories where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from newsletter_subscriptions where email like ${MAIL + "%"}`);
  await db.execute(sql`delete from email_logs where to_email like ${MAIL + "%"}`);
}

const DIRTY =
  `<p>ok</p><script>alert(1)</script>` +
  `<img src="https://evil.test/p.gif" onerror="steal()">` +
  `<img src="/cdn/media/a.webp" alt="a">`;
const isClean = (html: string | null | undefined) =>
  typeof html === "string" &&
  !/<script/i.test(html) &&
  !/onerror/i.test(html) &&
  !html.includes("evil.test") &&
  html.includes('src="/cdn/media/a.webp"') &&
  html.includes("<p>ok</p>");

async function main() {
  await cleanup();
  const priorKey = process.env.PAYMENT_ENCRYPTION_KEY;
  // The unsubscribe token is HMAC-keyed by PAYMENT_ENCRYPTION_KEY (read lazily).
  if (!priorKey?.trim()) process.env.PAYMENT_ENCRYPTION_KEY = "cpub-test-signing-key-0123456789abcdef";
  const priorProvider = await readSetting("mail.provider");
  const priorMarketing = await readSetting("mail.marketing_enabled");

  // Capture every payload the (forced) console provider receives.
  const sent: EmailPayload[] = [];
  const originalSend = consoleProvider.send;
  consoleProvider.send = async (payload, opts) => {
    sent.push(payload);
    return originalSend.call(consoleProvider, payload, opts);
  };

  try {
    await writeSetting("mail.provider", "console");
    await writeSetting("mail.marketing_enabled", "true");
    process.env.EMAIL_PROVIDER = "console";
    invalidateMailConfigCache();

    // ── fixtures ───────────────────────────────────────────────────────────
    const blogActive = await blogService.insertCategory({ slug: `${TAG}-on`, name: "Actif" });
    const blogInactive = await blogService.insertCategory({ slug: `${TAG}-off`, name: "Inactif", is_active: false });
    const now = Date.now();
    const postOnRow = await blogService.insertPost({
      slug: `${TAG}-post-on`,
      title: "On",
      body: DIRTY,
      is_published: true,
      published_at: new Date(now - 60_000),
      category_id: blogActive.id,
    });
    await blogService.insertPost({
      slug: `${TAG}-post-off`,
      title: "Off",
      body: "<p>x</p>",
      is_published: true,
      published_at: new Date(now - 120_000),
      category_id: blogInactive.id,
    });

    // ── 1) sanitised headless DTOs ─────────────────────────────────────────
    console.log("headless DTOs serialise sanitised HTML:");
    const postOn = await getApiBlogPost(`${TAG}-post-on`);
    check("blog DTO body is sanitised (no script/on*/off-origin img, /cdn kept)", isClean(postOn?.body));
    const postOnAgain = await getApiBlogPost(`${TAG}-post-on`);
    check("memoised re-serialisation returns the identical sanitised body", !!postOnAgain && postOnAgain.body === postOn?.body);
    await blogService.updatePost(postOnRow.id, { body: `<p>edited</p><script>alert(2)</script>` });
    const postEdited = await getApiBlogPost(`${TAG}-post-on`);
    check(
      "an edited body is re-sanitised (content-hash memo never serves stale HTML)",
      !!postEdited && postEdited.body.includes("<p>edited</p>") && !/<script/i.test(postEdited.body) && !postEdited.body.includes("/cdn/media/a.webp"),
    );

    // ── 2) inactive category = no category ─────────────────────────────────
    console.log("\ninactive category:");
    check("blog post in an ACTIVE category keeps it", postOn?.category?.slug === `${TAG}-on`);
    const postOff = await getApiBlogPost(`${TAG}-post-off`);
    check("blog post in an INACTIVE category → category null (DTO)", !!postOff && postOff.category === null);
    const postOffRow = await blogQueries.getPublishedPostBySlug(`${TAG}-post-off`);
    check("blog post page data → category null (no pill link / breadcrumb)", !!postOffRow && postOffRow.category === null);

    // ── 3) listing cursor ──────────────────────────────────────────────────
    console.log("\nlisting cursor:");
    for (const junk of [undefined, "", "abc", "2025-01-01T00:00:00.000Z", "2025-13-45T00:00:00.000Z__00000000-0000-7000-8000-000000000000", "2025-01-01T00:00:00.000Z__not-a-uuid", `2025-01-01T00:00:00.000Z__00000000-0000-7000-8000-000000000000${"x".repeat(40)}`]) {
      check(`parseListingCursor rejects ${JSON.stringify(junk)?.slice(0, 40)}`, parseListingCursor(junk) === undefined);
    }

    // ── 4) List-Unsubscribe ────────────────────────────────────────────────
    console.log("\nList-Unsubscribe (RFC 8058):");
    const subscriber = `${MAIL}-nl@example.test`;
    const h = listUnsubscribeHeaders(subscriber, "https://shop.example/");
    const m = /^<https:\/\/shop\.example(\/api\/unsubscribe\/one-click)\?token=([^>]+)>$/.exec(h?.["List-Unsubscribe"] ?? "");
    check("List-Unsubscribe is one https URL on the one-click path", !!m && m[1] === ONE_CLICK_UNSUBSCRIBE_PATH);
    check("its token verifies to the recipient", !!m && verifyUnsubToken(decodeURIComponent(m[2])) === subscriber);
    check("List-Unsubscribe-Post = List-Unsubscribe=One-Click", h?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click");
    const keyNow = process.env.PAYMENT_ENCRYPTION_KEY;
    process.env.PAYMENT_ENCRYPTION_KEY = "";
    check("no signing key → no headers (send without)", listUnsubscribeHeaders(subscriber, "https://shop.example") === undefined);
    process.env.PAYMENT_ENCRYPTION_KEY = keyNow;

    check("POST one-click route is catalogued", routeById("unsubscribe.one-click")?.method === "POST");
    check("GET one-click route is catalogued", routeById("unsubscribe.one-click.get")?.method === "GET");

    // Inline dispatch (marketing) → headers; transactional → none.
    sent.length = 0;
    const inlineTo = `${MAIL}-inline@example.test`;
    const r1 = await dispatchEmail({ composed: { subject: "Promo", html: "<p>promo</p>" }, to: inlineTo });
    const inlinePayload = sent.find((p) => p.to === inlineTo || (Array.isArray(p.to) && p.to.includes(inlineTo)));
    check("inline marketing dispatch was sent", r1.sent === true && !!inlinePayload);
    check("inline marketing send carries List-Unsubscribe for its recipient", (() => {
      const mm = /token=([^>]+)>$/.exec(inlinePayload?.headers?.["List-Unsubscribe"] ?? "");
      return !!mm && verifyUnsubToken(decodeURIComponent(mm[1])) === inlineTo;
    })());
    check("inline marketing send carries List-Unsubscribe-Post", inlinePayload?.headers?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click");
    sent.length = 0;
    const txTo = `${MAIL}-tx@example.test`;
    await dispatchEmail({ composed: { subject: "Tx", html: "<p>tx</p>", category: "commerce" }, to: txTo });
    const txPayload = sent.find((p) => p.to === txTo || (Array.isArray(p.to) && p.to.includes(txTo)));
    check("transactional send has NO List-Unsubscribe", !!txPayload && !txPayload.headers);

    // Queue drain → headers on the marketing row only.
    sent.length = 0;
    const qMkt = `${MAIL}-qmkt@example.test`;
    const qTx = `${MAIL}-qtx@example.test`;
    await emailLogService.enqueue([
      { toEmail: qMkt, subject: "Campagne", body: "<p>c</p>", category: "marketing" },
      { toEmail: qTx, subject: "Commande", body: "<p>o</p>", category: "commerce" },
    ]);
    // Another run may hold the drain lock (skipped) — retry briefly.
    for (let i = 0; i < 5 && !sent.some((p) => p.to === qMkt); i++) {
      const res = await drainEmailQueue();
      if (res.status === "skipped" && !sent.some((p) => p.to === qMkt)) await new Promise((r) => setTimeout(r, 1500));
    }
    const qMktPayload = sent.find((p) => p.to === qMkt);
    const qTxPayload = sent.find((p) => p.to === qTx);
    check("drain sent the queued marketing row", !!qMktPayload);
    check("drained marketing row carries List-Unsubscribe for its recipient", (() => {
      const mm = /token=([^>]+)>$/.exec(qMktPayload?.headers?.["List-Unsubscribe"] ?? "");
      return !!mm && verifyUnsubToken(decodeURIComponent(mm[1])) === qMkt;
    })());
    check("drained marketing row carries List-Unsubscribe-Post", qMktPayload?.headers?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click");
    check("drained transactional row has NO List-Unsubscribe", !!qTxPayload && !qTxPayload.headers);

    // One-click route.
    const nl = await newsletterService.insert({ email: subscriber, source: "test" } as never);
    const oneClick = (token: string, method: "POST" | "GET") =>
      new Request(`https://shop.example${ONE_CLICK_UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`, {
        method,
        ...(method === "POST"
          ? { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }
          : {}),
      });
    const token = decodeURIComponent(m?.[2] ?? "");
    const isActive = async () => (await newsletterService.findByEmail(subscriber))?.is_active;

    const getRes = await oneClickGET(oneClick(token, "GET"));
    check("GET → 303 to the /se-desabonner confirm page with the token", getRes.status === 303 &&
      (getRes.headers.get("location") ?? "").endsWith(`/se-desabonner?token=${encodeURIComponent(token)}`));
    check("GET does NOT unsubscribe", (await isActive()) === true);

    const forged = await oneClickPOST(oneClick(`${token.split(".")[0]}.AAAA`, "POST"));
    check("forged token → same 200", forged.status === 200);
    check("forged token does NOT unsubscribe", (await isActive()) === true);

    const ok = await oneClickPOST(oneClick(token, "POST"));
    check("valid token → 200, no redirect", ok.status === 200 && !ok.headers.get("location"));
    check("valid token unsubscribes the address", (await isActive()) === false);
    const again = await oneClickPOST(oneClick(token, "POST"));
    check("replay is idempotent (200)", again.status === 200 && (await isActive()) === false);
    void nl;
  } finally {
    consoleProvider.send = originalSend;
    await restoreSetting("mail.provider", priorProvider);
    await restoreSetting("mail.marketing_enabled", priorMarketing);
    invalidateMailConfigCache();
    process.env.PAYMENT_ENCRYPTION_KEY = priorKey ?? "";
    await cleanup();
  }

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

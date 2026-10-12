import "server-only";

/**
 * Global-search visibility invariant — drafts and soft-deleted editorial
 * content must NEVER surface in public search results.
 *
 * `searchService.search()` runs raw FTS SQL (src/modules/search/queries.ts)
 * that is a DISTINCT code path from the slug getters: each editorial reader
 * gates on `deleted_at IS NULL AND is_published = true`. That WHERE clause is
 * the only thing standing between a draft/archived post and the public search
 * box (and the keyed `/api/store/search` route, which reuses this service).
 * A future edit that drops it would silently leak unpublished content — this
 * suite is the regression net for that. Self-cleaning (`zztest-search`).
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/search-visibility.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { searchService } from "@/modules/search/service";
import { workflows } from "@/workflows";

const TAG = "zztest-search";
const ACTOR = `${TAG}-actor`;
// A distinctive nonsense token: present in every test title, absent from real
// content, so the search results contain only our rows.
const TOKEN = "Zzkliffon";

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
  await db.execute(sql`delete from blog_post_tags where post_id in (select id from blog_posts where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from blog_posts where slug like ${TAG + "%"}`);
}

async function main() {
  await cleanup();

  // ── blog: published / draft / published-then-soft-deleted ────────────────
  const bPub = await workflows.blog.createPost({ title: `${TOKEN} visible`, slug: `${TAG}-blogpub`, body: "<p>x</p>" }, { actorUserId: ACTOR });
  const bDraft = await workflows.blog.createPost({ title: `${TOKEN} hidden`, slug: `${TAG}-blogdraft`, body: "<p>x</p>" }, { actorUserId: ACTOR });
  const bDel = await workflows.blog.createPost({ title: `${TOKEN} gone`, slug: `${TAG}-blogdel`, body: "<p>x</p>" }, { actorUserId: ACTOR });
  const bPubId = bPub.ok ? bPub.data.postId : "";
  const bDraftId = bDraft.ok ? bDraft.data.postId : "";
  const bDelId = bDel.ok ? bDel.data.postId : "";
  await workflows.blog.togglePostPublish({ postId: bPubId, publish: true }, { actorUserId: ACTOR });
  await workflows.blog.togglePostPublish({ postId: bDelId, publish: true }, { actorUserId: ACTOR });
  await workflows.blog.deletePost({ postId: bDelId }, { actorUserId: ACTOR });

  // ── search the token ─────────────────────────────────────────────────────
  const page = await searchService.search(TOKEN, { kinds: ["blog_post"], limit: 25, skipLog: true });
  const blogIds = new Set(page.blog_posts.map((h) => h.id));

  // sanity: the published rows ARE found (so the token matches at all) ───────
  check("published blog post is searchable", blogIds.has(bPubId));

  // the actual invariant: drafts + soft-deleted never leak ──────────────────
  check("DRAFT blog post NOT in search", !blogIds.has(bDraftId));
  check("soft-DELETED blog post NOT in search", !blogIds.has(bDelId));

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

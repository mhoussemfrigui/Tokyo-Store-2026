import "server-only";

/**
 * Blog module — workflow + service behavior against the DB. Covers the bits
 * this epic touched/built: slug-uniqueness (incl. update), reading_minutes
 * auto/override/recompute, publish→unpublish keeps published_at, tag replace,
 * soft-delete→restore, OFFSET paging (the broken-admin-pagination regression),
 * clearable category, the migration-0059 category-delete SET NULL FK,
 * draft/soft-deleted invisibility on the public read, the idempotent publish
 * toggle (no re-stamp / duplicate event), the restore publish signal, and
 * blank SEO/excerpt fields stored as NULL. Self-cleaning (`__blogtest`).
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/blog.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { blogService } from "@/modules/blog/service";
import { blogCommentService } from "@/modules/blog/comments";
import { getApprovedThread } from "@/lib/blog/comment-thread";
import { pgErrorCode } from "@/lib/db/pg-errors";
import { blogQueries } from "@/modules/blog";
import { workflows } from "@/workflows";

// Slug-valid prefix (the slug schema rejects underscores), still unique enough
// to scope cleanup safely.
const TAG = "zztest-blog";
const ACTOR = `${TAG}-actor`;

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
  await db.execute(sql`delete from blog_tags where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from blog_categories where slug like ${TAG + "%"}`);
}

async function main() {
  await cleanup();

  // Record the publish/unpublish signals (webhook consumers see these).
  const publishedEvents: string[] = [];
  const unpublishedEvents: string[] = [];
  bus.on("blog.post.published", (env) => {
    publishedEvents.push(env.payload.postId);
  });
  bus.on("blog.post.unpublished", (env) => {
    unpublishedEvents.push(env.payload.postId);
  });
  const countOf = (list: string[], id: string) => list.filter((x) => x === id).length;

  // ── slug uniqueness (create) ────────────────────────────────────────────
  const c1 = await workflows.blog.createPost({ title: "T1", slug: `${TAG}-p1`, body: "<p>hello world</p>" }, { actorUserId: ACTOR });
  check("create post ok", c1.ok === true);
  const dup = await workflows.blog.createPost({ title: "T1b", slug: `${TAG}-p1`, body: "x" }, { actorUserId: ACTOR });
  check("duplicate slug rejected (conflict)", dup.ok === false && (dup as { error?: string }).error === "conflict");

  const postId = c1.ok ? c1.data.postId : "";

  // ── reading_minutes: auto vs override vs recompute ──────────────────────
  const longBody = `<p>${"mot ".repeat(400)}</p>`; // ~400 words → ~2 min
  const cAuto = await workflows.blog.createPost({ title: "Auto", slug: `${TAG}-auto`, body: longBody }, { actorUserId: ACTOR });
  const autoRow = cAuto.ok ? await blogService.findPostById(cAuto.data.postId) : null;
  check("reading_minutes auto-computed from body (~2)", autoRow?.reading_minutes === 2);
  const cPin = await workflows.blog.createPost({ title: "Pin", slug: `${TAG}-pin`, body: longBody, readingMinutes: 9 }, { actorUserId: ACTOR });
  const pinRow = cPin.ok ? await blogService.findPostById(cPin.data.postId) : null;
  check("reading_minutes honors explicit override", pinRow?.reading_minutes === 9);
  if (cAuto.ok) {
    await workflows.blog.updatePost({ postId: cAuto.data.postId, body: "<p>tiny</p>" }, { actorUserId: ACTOR });
    const re = await blogService.findPostById(cAuto.data.postId);
    check("reading_minutes recomputed on body change (→1)", re?.reading_minutes === 1);
  }

  // ── publish → unpublish keeps the original published_at ─────────────────
  await workflows.blog.togglePostPublish({ postId, publish: true }, { actorUserId: ACTOR });
  const pub = await blogService.findPostById(postId);
  check("publish stamps published_at", pub?.published_at != null && pub?.is_published === true);
  const stamp = pub?.published_at?.getTime();
  check("publish emits blog.post.published once", countOf(publishedEvents, postId) === 1);
  // A stale second tab re-clicking « Publié » must be an ok no-op: no
  // published_at re-stamp (listing reorder) and no duplicate webhook event.
  const again = await workflows.blog.togglePostPublish({ postId, publish: true }, { actorUserId: ACTOR });
  const pubAgain = await blogService.findPostById(postId);
  check(
    "re-publish of a published post → ok no-op (published_at not re-stamped)",
    again.ok === true && pubAgain?.is_published === true && pubAgain?.published_at?.getTime() === stamp,
  );
  check("re-publish emits no duplicate blog.post.published", countOf(publishedEvents, postId) === 1);
  await workflows.blog.togglePostPublish({ postId, publish: false }, { actorUserId: ACTOR });
  const unpub = await blogService.findPostById(postId);
  check("unpublish keeps published_at + flips flag", unpub?.is_published === false && unpub?.published_at?.getTime() === stamp);
  const unpubAgain = await workflows.blog.togglePostPublish({ postId, publish: false }, { actorUserId: ACTOR });
  check(
    "re-unpublish of a draft → ok no-op, single blog.post.unpublished",
    unpubAgain.ok === true && countOf(unpublishedEvents, postId) === 1,
  );

  // ── tag replace semantics ───────────────────────────────────────────────
  const t1 = await workflows.blog.createTag({ name: "TA", slug: `${TAG}-ta` }, { actorUserId: ACTOR });
  const t2 = await workflows.blog.createTag({ name: "TB", slug: `${TAG}-tb` }, { actorUserId: ACTOR });
  const tagId1 = t1.ok ? t1.data.tagId : "";
  const tagId2 = t2.ok ? t2.data.tagId : "";
  await blogService.setPostTags(postId, [tagId1, tagId2]);
  check("setPostTags attaches 2", (await blogService.listTagsForPost(postId)).length === 2);
  await blogService.setPostTags(postId, [tagId2]);
  const afterReplace = await blogService.listTagsForPost(postId);
  check("setPostTags replaces (now 1, the kept one)", afterReplace.length === 1 && afterReplace[0].id === tagId2);
  // tag update slug-conflict
  const tagDup = await workflows.blog.updateTag({ tagId: tagId1, slug: `${TAG}-tb` }, { actorUserId: ACTOR });
  check("tag update slug-conflict rejected", tagDup.ok === false);

  // ── soft-delete → restore ───────────────────────────────────────────────
  await workflows.blog.deletePost({ postId }, { actorUserId: ACTOR });
  check("soft-deleted post not found", (await blogService.findPostById(postId)) === null);
  const pubBeforeRestore = countOf(publishedEvents, postId);
  const restored = await workflows.blog.restorePost({ postId }, { actorUserId: ACTOR });
  check("restore brings it back", restored.ok === true && (await blogService.findPostById(postId)) !== null);
  check("restoring a DRAFT emits no blog.post.published", countOf(publishedEvents, postId) === pubBeforeRestore);
  check("restore on a live post → not_found", (await workflows.blog.restorePost({ postId }, { actorUserId: ACTOR })).ok === false);
  // A PUBLISHED post archived then restored re-announces itself (consumers
  // dropped the id on blog.post.deleted).
  const cLive = await workflows.blog.createPost({ title: "Live", slug: `${TAG}-live`, body: "x", publish: true }, { actorUserId: ACTOR });
  const liveId = cLive.ok ? cLive.data.postId : "";
  await workflows.blog.deletePost({ postId: liveId }, { actorUserId: ACTOR });
  const livePubBefore = countOf(publishedEvents, liveId);
  await workflows.blog.restorePost({ postId: liveId }, { actorUserId: ACTOR });
  check(
    "restoring a PUBLISHED post emits blog.post.published",
    livePubBefore === 1 && countOf(publishedEvents, liveId) === 2,
  );

  // ── OFFSET paging (admin-pagination regression guard) ───────────────────
  const page1 = await blogService.listPosts({ search: TAG, limit: 2, offset: 0 });
  const page2 = await blogService.listPosts({ search: TAG, limit: 2, offset: 2 });
  check("offset paging: page1 has 2", page1.items.length === 2);
  check("offset paging: page2 differs from page1", page2.items.length > 0 && page2.items[0].id !== page1.items[0].id);
  check("offset paging: total counts all (≥3)", page1.total >= 3);

  // ── clearable category + category-delete SET NULL (migration 0059) ──────
  const cat = await workflows.blog.createCategory({ name: "Cat", slug: `${TAG}-cat` }, { actorUserId: ACTOR });
  const catId = cat.ok ? cat.data.categoryId : "";
  await workflows.blog.updatePost({ postId, categoryId: catId }, { actorUserId: ACTOR });
  check("category set", (await blogService.findPostById(postId))?.category_id === catId);
  await workflows.blog.updatePost({ postId, categoryId: null }, { actorUserId: ACTOR });
  check("category CLEARED (null)", (await blogService.findPostById(postId))?.category_id === null);
  // re-assign, then delete the category → FK SET NULL leaves the post intact.
  await workflows.blog.updatePost({ postId, categoryId: catId }, { actorUserId: ACTOR });
  await workflows.blog.deleteCategory({ categoryId: catId }, { actorUserId: ACTOR });
  const afterCatDelete = await blogService.findPostById(postId);
  check("category delete SET NULL (post survives, category_id null)", afterCatDelete != null && afterCatDelete.category_id === null);

  // ── blank SEO / excerpt → NULL (not "") so the page fallbacks apply ───────
  // The edit form always submits these fields and the action sends "" to mean
  // "clear" — a stored "" beat `meta_title ?? title` (site-default <title>).
  const cMeta = await workflows.blog.createPost(
    { title: "Meta", slug: `${TAG}-meta`, body: "x", excerpt: "", metaTitle: "   " },
    { actorUserId: ACTOR },
  );
  const metaId = cMeta.ok ? cMeta.data.postId : "";
  const metaCreated = await blogService.findPostById(metaId);
  check("create: blank excerpt/metaTitle stored as NULL", metaCreated?.excerpt === null && metaCreated?.meta_title === null);
  await workflows.blog.updatePost(
    { postId: metaId, excerpt: "Résumé", metaTitle: "Titre SEO", metaDescription: "Desc SEO" },
    { actorUserId: ACTOR },
  );
  const metaSet = await blogService.findPostById(metaId);
  check(
    "update: non-blank SEO/excerpt stored",
    metaSet?.excerpt === "Résumé" && metaSet?.meta_title === "Titre SEO" && metaSet?.meta_description === "Desc SEO",
  );
  await workflows.blog.updatePost(
    { postId: metaId, excerpt: "", metaTitle: "", metaDescription: "  " },
    { actorUserId: ACTOR },
  );
  const metaCleared = await blogService.findPostById(metaId);
  check(
    "update: blank excerpt/metaTitle/metaDescription CLEARED to NULL (not \"\")",
    metaCleared?.excerpt === null && metaCleared?.meta_title === null && metaCleared?.meta_description === null,
  );

  // ── public read hides draft / soft-deleted ──────────────────────────────
  check("getPublishedPostBySlug null for unpublished", (await blogQueries.getPublishedPostBySlug(`${TAG}-p1`)) === null);

  // ── cursor keyset: posts sharing one published_at must NOT be dropped ─────
  // Regression for the same-timestamp seam skip — three published posts at the
  // EXACT same published_at, paged with limit=2 via the composite cursor, must
  // all surface across the two pages (a plain lt(published_at) would drop the
  // third). Scoped by the `-cur` slug so only these three match.
  const sameTs = new Date("2030-01-01T00:00:00.000Z");
  const curIds = new Set<string>();
  for (const n of [1, 2, 3]) {
    const r = await blogService.insertPost({
      slug: `${TAG}-cur${n}`,
      title: `Cur ${n}`,
      is_published: true,
      published_at: sameTs,
    });
    curIds.add(r.id);
  }
  const cp1 = await blogService.listPosts({ publishedOnly: true, search: `${TAG}-cur`, limit: 2, withTotal: false });
  const cp2 = await blogService.listPosts({
    publishedOnly: true,
    search: `${TAG}-cur`,
    limit: 2,
    cursor: cp1.nextCursor ?? undefined,
    withTotal: false,
  });
  const cseen = new Set([...cp1.items, ...cp2.items].map((p) => p.id));
  check("cursor keyset: page1 returns 2 same-timestamp posts", cp1.items.length === 2);
  check(
    "cursor keyset: all 3 same-published_at posts surface across pages (no seam skip)",
    curIds.size === 3 && [...curIds].every((id) => cseen.has(id)),
  );

  // ── public FTS search (searchPublishedPosts) ────────────────────────────
  const sqA = await blogService.insertPost({
    slug: `${TAG}-sq-skel`,
    title: "Montre squelette en acier",
    body: "Un cadran ouvert sur le mouvement.",
    is_published: true,
    published_at: new Date("2030-04-01T00:00:00.000Z"),
  });
  const sqB = await blogService.insertPost({
    slug: `${TAG}-sq-tourb`,
    title: "Le tourbillon expliqué",
    excerpt: "Une complication fascinante.",
    body: "Le tourbillon compense les effets de la gravité.",
    is_published: true,
    published_at: new Date("2030-04-02T00:00:00.000Z"),
  });
  // A DRAFT carrying the same term must never surface in the public search.
  await blogService.insertPost({ slug: `${TAG}-sq-draft`, title: "Tourbillon secret non publié", is_published: false });

  const rSkel = await blogService.searchPublishedPosts("squelette");
  check("search: matches by title", rSkel.items.length === 1 && rSkel.items[0].id === sqA.id);
  const rTourb = await blogService.searchPublishedPosts("tourbillon");
  check("search: a draft with the term is excluded (only the published post)", rTourb.items.length === 1 && rTourb.items[0].id === sqB.id);
  const rBody = await blogService.searchPublishedPosts("gravité");
  check("search: matches a body term", rBody.items.some((p) => p.id === sqB.id));
  const rUnaccent = await blogService.searchPublishedPosts("gravite");
  check("search: accent-insensitive (gravite → gravité)", rUnaccent.items.some((p) => p.id === sqB.id));
  const rShort = await blogService.searchPublishedPosts("z");
  check("search: query under 2 chars returns empty", rShort.items.length === 0 && rShort.total === 0);
  const rWild = await blogService.searchPublishedPosts("%%");
  check("search: LIKE wildcards are escaped (no match-all)", rWild.total === 0);

  for (const n of [1, 2, 3]) {
    await blogService.insertPost({
      slug: `${TAG}-sq-kw${n}`,
      title: `Dossier zzkeyword numéro ${n}`,
      is_published: true,
      published_at: new Date(`2030-05-0${n}T00:00:00.000Z`),
    });
  }
  const kp1 = await blogService.searchPublishedPosts("zzkeyword", { limit: 2 });
  const kp2 = await blogService.searchPublishedPosts("zzkeyword", { limit: 2, offset: 2 });
  const kseen = new Set([...kp1.items, ...kp2.items].map((p) => p.id));
  check(
    "search: total + limit/offset paginate (3 total, 2+1 across pages, no dup)",
    kp1.total === 3 && kp1.items.length === 2 && kp2.items.length === 1 && kseen.size === 3,
  );

  // 2-char terms use the FTS GIN ALONE (no title-substring ILIKE, which can't use
  // the 3-gram index) — a substring-only hit is dropped at 2 chars, kept at 3.
  await blogService.insertPost({
    slug: `${TAG}-sq-2c`,
    title: "Chronoxyz test",
    is_published: true,
    published_at: new Date("2030-06-01T00:00:00.000Z"),
  });
  const r2c = await blogService.searchPublishedPosts("yz"); // substring of "chronoxyz", not an FTS token
  check("search: 2-char term is FTS-only (no substring ILIKE match)", r2c.items.every((p) => p.slug !== `${TAG}-sq-2c`));
  const r3c = await blogService.searchPublishedPosts("xyz"); // >= 3 chars → substring ILIKE arm active
  check("search: 3-char term matches a title substring", r3c.items.some((p) => p.slug === `${TAG}-sq-2c`));

  // The search projection drops the heavy body HTML (returns '' so the shape holds).
  const bodyProbe = await blogService.searchPublishedPosts("squelette");
  check("search: result rows carry no body HTML (projected out)", bodyProbe.items.every((p) => p.body === ""));

  // ── comment threading (migration 0187) ──────────────────────────────────
  // A published post to hang a thread on. Direct service inserts (status forced)
  // so the thread assertions don't depend on the admin pre-moderation setting.
  const cp = await blogService.insertPost({
    slug: `${TAG}-cmt`,
    title: "Comment host",
    is_published: true,
    published_at: new Date("2030-02-01T00:00:00.000Z"),
  });
  const U1 = `${TAG}-u1`;
  const U2 = `${TAG}-u2`;
  const mk = (over: Partial<Parameters<typeof blogCommentService.insert>[0]>) =>
    blogCommentService.insert({
      postId: cp.id,
      parentId: null,
      userId: U1,
      authorName: "U1",
      body: "body",
      rating: null,
      status: "approved",
      ...over,
    });

  const top1 = await mk({ userId: U1, authorName: "U1", rating: 4 });
  // A reply by the SAME user is allowed (the one-per-reader unique is top-level only).
  let replyAllowed = true;
  try {
    await mk({ userId: U1, parentId: top1.id, body: "reply a", authorName: "U1" });
    await mk({ userId: U1, parentId: top1.id, body: "reply b", authorName: "U1" });
  } catch {
    replyAllowed = false;
  }
  check("thread: same user may reply under their own top-level comment", replyAllowed);

  // A SECOND top-level comment by the same reader is blocked by the partial unique.
  let secondTopBlocked = false;
  try {
    await mk({ userId: U1, authorName: "U1", body: "dup top" });
  } catch (err) {
    secondTopBlocked = pgErrorCode(err) === "23505";
  }
  check("thread: second top-level comment by same reader → 23505", secondTopBlocked);

  // A reply that carries a rating violates the DB CHECK (replies are never rated).
  let ratedReplyBlocked = false;
  try {
    await mk({ userId: U2, parentId: top1.id, body: "rated reply", rating: 5, authorName: "U2" });
  } catch (err) {
    ratedReplyBlocked = pgErrorCode(err) === "23514";
  }
  check("thread: a rated reply violates blog_comments_reply_no_rating_check", ratedReplyBlocked);

  const top2 = await mk({ userId: U2, authorName: "U2", rating: 2, body: "u2 top" });
  await mk({ userId: U1, parentId: top2.id, body: "u1 replies to u2", authorName: "U1" });

  // getApprovedThread: 2 top-level nodes, replies grouped under their parent, and
  // no reply leaks in as a top-level node.
  const thread = await getApprovedThread(cp.id, { limit: 10 });
  const byId = new Map(thread.nodes.map((n) => [n.id, n]));
  check("thread: getApprovedThread returns exactly the 2 top-level comments", thread.nodes.length === 2);
  check("thread: top1 has its 2 replies grouped", (byId.get(top1.id)?.replies.length ?? 0) === 2);
  check("thread: top2 has its 1 reply grouped", (byId.get(top2.id)?.replies.length ?? 0) === 1);

  // Aggregate: only top-level ratings count (4 + 2)/2 = 3.0 over 2.
  const agg = await blogCommentService.getAggregate(cp.id);
  check("thread: aggregate counts only top-level ratings (avg 3, n 2)", agg.count === 2 && Math.round(agg.average) === 3);
  // countApproved: top-level + replies = 2 + 3.
  check("thread: countApproved counts top-level + replies (5)", (await blogCommentService.countApproved(cp.id)) === 5);
  // findByUserAndPost returns the TOP-LEVEL comment (not a reply) for the upsert.
  const mineU1 = await blogCommentService.findByUserAndPost(U1, cp.id);
  check("thread: findByUserAndPost returns the reader's top-level comment", mineU1?.id === top1.id);

  // Keyset pagination over top-level comments (limit 1 → 2 pages, no overlap).
  const pg1 = await blogCommentService.listApprovedTopLevel(cp.id, { limit: 1 });
  const pg2 = pg1.nextCursor
    ? await blogCommentService.listApprovedTopLevel(cp.id, { limit: 1, cursor: pg1.nextCursor })
    : { items: [], nextCursor: null };
  const paged = new Set([...pg1.items, ...pg2.items].map((c) => c.id));
  check(
    "thread: top-level keyset paginates (both comments across 2 pages, no dup)",
    pg1.items.length === 1 && pg2.items.length === 1 && paged.size === 2,
  );

  // Workflow: a reply-to-a-reply flattens onto the top-level ancestor (one level).
  const replyA = byId.get(top1.id)!.replies[0]!;
  const flatRes = await workflows.blogComments.submit(
    { postId: cp.id, parentId: replyA.id, body: "nested reply flattens" },
    { userId: U2, authorName: "U2" },
  );
  check("thread: workflow accepts a reply to an approved comment", flatRes.ok === true);
  if (flatRes.ok) {
    const flat = await blogCommentService.findById(flatRes.data.commentId);
    check("thread: reply-to-reply is flattened onto the top-level ancestor", flat?.parent_id === top1.id);
  }

  // Workflow: replying to a PENDING (not-approved) comment is refused.
  const pend = await mk({ userId: U2, authorName: "U2", parentId: top1.id, body: "pending target", status: "pending" });
  const pendRes = await workflows.blogComments.submit(
    { postId: cp.id, parentId: pend.id, body: "reply to pending" },
    { userId: U1, authorName: "U1" },
  );
  check("thread: workflow refuses a reply to a non-approved parent", pendRes.ok === false);

  // Moderating a top-level comment hides its replies AND drops them from the count
  // (no counted-but-invisible orphans). top2 had 1 approved reply; before rejecting,
  // the approved+visible set is {top1, replyA, replyB, top2, u1→u2} = 5.
  await blogCommentService.setStatus(top2.id, "rejected");
  const afterReject = await getApprovedThread(cp.id, { limit: 10 });
  check(
    "thread: rejecting a top-level removes it (and its replies) from the thread",
    !afterReject.nodes.some((n) => n.id === top2.id),
  );
  check(
    "thread: countApproved excludes a reply orphaned by a rejected parent (3, not 4)",
    (await blogCommentService.countApproved(cp.id)) === 3,
  );
  // The workflow also refuses a reply whose top-level ANCESTOR is now rejected
  // (flatten re-check): replyA's parent (top1) is still approved, so swap targets —
  // reply to the u1→u2 reply under the rejected top2.
  const deadReply = (await blogCommentService.listApprovedRepliesFor([top2.id]))[0];
  if (deadReply) {
    const orphanRes = await workflows.blogComments.submit(
      { postId: cp.id, parentId: deadReply.id, body: "reply under a rejected ancestor" },
      { userId: U1, authorName: "U1" },
    );
    check("thread: workflow refuses a reply whose top-level ancestor is rejected", orphanRes.ok === false);
  }

  // Restore guard: a category that claimed an archived post's flat slug blocks the
  // restore (else the restored post would silently shadow the category at /blog/<slug>).
  const rp = await blogService.insertPost({
    slug: `${TAG}-shadow`,
    title: "Shadow",
    is_published: true,
    published_at: new Date("2030-03-01T00:00:00.000Z"),
  });
  await blogService.softDeletePost(rp.id);
  await blogService.insertCategory({ slug: `${TAG}-shadow`, name: "Shadow cat" });
  const restoreRes = await workflows.blog.restorePost({ postId: rp.id }, { actorUserId: ACTOR });
  check("restore: blocked when a category took the archived post's slug", restoreRes.ok === false);

  // Create guard: a name that slugifies to "" (all-symbol / non-Latin) is rejected
  // with a validation error rather than persisting a dead, unreachable row.
  const emptyCat = await workflows.blog.createCategory({ name: "######" }, { actorUserId: ACTOR });
  check("category create: all-symbol name (empty derived slug) is rejected", emptyCat.ok === false);

  // Moderation: approving a REPLY whose top-level parent isn't approved is refused
  // (it would be a silent no-op on the storefront otherwise).
  const pendTop = await mk({ userId: `${TAG}-pu`, authorName: "PU", status: "pending" });
  const pendRep = await mk({ userId: `${TAG}-pr`, parentId: pendTop.id, authorName: "PR", status: "pending" });
  const apR = await workflows.blogComments.setStatus({ id: pendRep.id, status: "approved" }, { actorUserId: ACTOR });
  check("moderation: approving a reply before its parent is refused", apR.ok === false);

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

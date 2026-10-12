"use client";

import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Star, Loader2, MessageSquare, CornerDownRight } from "lucide-react";

import { submitBlogCommentAction, loadMoreBlogCommentsAction } from "@/lib/actions/blog-comment";
import { type ActionState } from "@/lib/actions/types";
import { type CommentNode } from "@/lib/blog/comment-thread";

type Props = {
  postId: string;
  slug: string;
  /** Page 1 of the thread (top-level comments + their replies), newest first. */
  nodes: CommentNode[];
  /** Keyset cursor for the next page of top-level comments, or null when exhausted. */
  nextCursor: string | null;
  /** Total approved comments (top-level + replies) — the header count. */
  totalCount: number;
  aggregate: { average: number; count: number };
  ratingsEnabled: boolean;
  loggedIn: boolean;
  /** The current reader's own top-level comment, if any — the form pre-fills it (edit). */
  mine: { body: string; rating: number | null } | null;
};

export function ArticleComments({
  postId,
  slug,
  nodes,
  nextCursor,
  totalCount,
  aggregate,
  ratingsEnabled,
  loggedIn,
  mine,
}: Props) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    submitBlogCommentAction,
    null,
  );
  const [rating, setRating] = useState(mine?.rating ?? 0);
  const [hover, setHover] = useState(0);

  // Pages loaded via « Charger plus » (page 1 stays in props so it refreshes live).
  const [appended, setAppended] = useState<CommentNode[]>([]);
  const [cursor, setCursor] = useState<string | null>(nextCursor);
  const [loadingMore, startLoadMore] = useTransition();
  const [replyOpen, setReplyOpen] = useState<string | null>(null);

  // On a successful top-level submit, refresh so an auto-approved comment appears.
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  // Props (page 1) are authoritative for the ids they carry; appended pages are
  // older comments. Dedupe so a refresh of page 1 can't double a loaded comment.
  const all = useMemo(() => {
    const seen = new Set<string>();
    const out: CommentNode[] = [];
    for (const n of [...nodes, ...appended]) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
    }
    return out;
  }, [nodes, appended]);

  const loadMore = () => {
    if (!cursor) return;
    startLoadMore(async () => {
      const res = await loadMoreBlogCommentsAction(postId, cursor);
      if (res.ok) {
        setAppended((prev) => [...prev, ...res.nodes]);
        setCursor(res.nextCursor);
      } else {
        setCursor(null);
      }
    });
  };

  return (
    <section id="commentaires" className="mt-16 border-t border-border pt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-2xl font-semibold tracking-tight">
          Commentaires
          {totalCount > 0 && <span className="ml-2 text-base font-normal text-muted-foreground">{totalCount}</span>}
        </h2>
        {ratingsEnabled && aggregate.count > 0 && (
          <div className="inline-flex items-center gap-2 text-sm">
            <Stars value={Math.round(aggregate.average)} />
            <span className="font-semibold">{aggregate.average.toFixed(1)}</span>
            <span className="text-muted-foreground">({aggregate.count})</span>
          </div>
        )}
      </div>

      {/* ── Form / login prompt ──────────────────────────────────────── */}
      {loggedIn ? (
        <form action={formAction} className="mt-6 rounded-3xl border border-border bg-card p-5">
          <input type="hidden" name="postId" value={postId} />
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="rating" value={rating} />
          <p className="text-sm font-medium">{mine ? "Modifier votre commentaire" : "Laisser un commentaire"}</p>

          {ratingsEnabled && (
            <div className="mt-3 flex items-center gap-1" aria-label="Votre note">
              {[1, 2, 3, 4, 5].map((i) => (
                <button
                  key={i}
                  type="button"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(0)}
                  onClick={() => setRating((r) => (r === i ? 0 : i))}
                  aria-label={`${i} étoile${i > 1 ? "s" : ""}`}
                  className="p-0.5"
                >
                  <Star
                    className={`h-6 w-6 transition ${
                      (hover || rating) >= i ? "fill-amber-400 text-amber-400" : "text-border"
                    }`}
                  />
                </button>
              ))}
              {rating > 0 && (
                <button type="button" onClick={() => setRating(0)} className="ml-2 text-[11px] text-muted-foreground hover:text-foreground">
                  effacer
                </button>
              )}
            </div>
          )}

          <textarea
            name="body"
            required
            rows={4}
            defaultValue={mine?.body ?? ""}
            placeholder="Partagez votre avis sur cet article…"
            className="mt-3 w-full rounded-2xl border border-border bg-background p-3 text-sm focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />

          {state && !state.ok && <p className="mt-2 text-xs text-destructive">{state.message}</p>}
          {state?.ok && <p className="mt-2 text-xs text-primary">{state.message}</p>}

          <button
            type="submit"
            disabled={pending}
            className="mt-3 inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
            {mine ? "Mettre à jour" : "Publier"}
          </button>
        </form>
      ) : (
        <div className="mt-6 rounded-3xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
          <Link href={`/login?from=/blog/${slug}`} className="font-semibold text-primary hover:underline">
            Connectez-vous
          </Link>{" "}
          pour laisser un commentaire{ratingsEnabled ? " et une note" : ""}.
        </div>
      )}

      {/* ── Thread ───────────────────────────────────────────────────── */}
      {all.length > 0 && (
        <ul className="mt-8 space-y-6">
          {all.map((c) => (
            <li key={c.id}>
              <CommentItem authorName={c.authorName} body={c.body} createdAt={c.createdAt} rating={c.rating}>
                {loggedIn && (
                  <button
                    type="button"
                    onClick={() => setReplyOpen((id) => (id === c.id ? null : c.id))}
                    className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-primary"
                  >
                    <CornerDownRight className="h-3.5 w-3.5" />
                    Répondre
                  </button>
                )}

                {(c.replies.length > 0 || replyOpen === c.id) && (
                  <div className="mt-4 space-y-4 border-l border-border pl-4 sm:pl-5">
                    {c.replies.map((r) => (
                      <CommentItem
                        key={r.id}
                        authorName={r.authorName}
                        body={r.body}
                        createdAt={r.createdAt}
                        rating={null}
                        small
                      />
                    ))}
                    {replyOpen === c.id && (
                      <ReplyForm
                        postId={postId}
                        slug={slug}
                        parentId={c.id}
                        onDone={() => {
                          setReplyOpen(null);
                          // Reset to page 1 (drop the « Charger plus » pages) before
                          // refreshing: an auto-approved reply then surfaces from the
                          // fresh server render, and there is no stale appended node
                          // whose missing reply would prompt a duplicate re-submit.
                          setAppended([]);
                          setCursor(nextCursor);
                          router.refresh();
                        }}
                      />
                    )}
                  </div>
                )}
              </CommentItem>
            </li>
          ))}
        </ul>
      )}

      {cursor && (
        <div className="mt-8 flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2 text-sm font-medium transition hover:border-foreground/20 disabled:opacity-60"
          >
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
            Charger plus de commentaires
          </button>
        </div>
      )}
    </section>
  );
}

/** One comment (or reply) row: avatar + header + body, with optional children (reply affordances). */
function CommentItem({
  authorName,
  body,
  createdAt,
  rating,
  small,
  children,
}: {
  authorName: string;
  body: string;
  createdAt: string;
  rating: number | null;
  small?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span
        className={`grid shrink-0 place-items-center rounded-full bg-foreground/90 font-semibold text-background ${
          small ? "h-8 w-8 text-[10px]" : "h-9 w-9 text-[11px]"
        }`}
      >
        {initials(authorName)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{authorName}</span>
          {rating != null && <Stars value={rating} size="sm" />}
          <span className="text-[11px] text-muted-foreground">
            {new Date(createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}
          </span>
        </div>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{body}</p>
        {children}
      </div>
    </div>
  );
}

/** Inline reply composer — posts with a parentId (no rating), closes on success. */
function ReplyForm({
  postId,
  slug,
  parentId,
  onDone,
}: {
  postId: string;
  slug: string;
  parentId: string;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    submitBlogCommentAction,
    null,
  );
  useEffect(() => {
    if (state?.ok) {
      const t = setTimeout(onDone, 1200);
      return () => clearTimeout(t);
    }
  }, [state, onDone]);

  return (
    <form action={formAction} className="rounded-2xl border border-border bg-surface/40 p-3">
      <input type="hidden" name="postId" value={postId} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="parentId" value={parentId} />
      <textarea
        name="body"
        required
        rows={3}
        placeholder="Votre réponse…"
        className="w-full rounded-xl border border-border bg-background p-2.5 text-sm focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
      />
      {state && !state.ok && <p className="mt-1.5 text-xs text-destructive">{state.message}</p>}
      {state?.ok && <p className="mt-1.5 text-xs text-primary">{state.message}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CornerDownRight className="h-3.5 w-3.5" />}
          Répondre
        </button>
        <button type="button" onClick={onDone} className="text-xs text-muted-foreground hover:text-foreground">
          Annuler
        </button>
      </div>
    </form>
  );
}

function Stars({ value, size = "md" }: { value: number; size?: "sm" | "md" }) {
  const cls = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${value}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`${cls} ${i <= value ? "fill-amber-400 text-amber-400" : "text-border"}`} />
      ))}
    </span>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

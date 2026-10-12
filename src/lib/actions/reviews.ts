"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { getCurrentUser, requirePermission } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { bustStorefrontCache } from "@/lib/cache/bust-storefront";
import { withLongStatement } from "@/lib/db/client";
import { type ActionState } from "@/lib/actions/types";
import { getReviewConfig, reviewService, type ReviewStatus } from "@/modules/catalog/review";

/**
 * Submit a product review from the PDP. Any signed-in user may post (the
 * workflow enforces the admin "policy" + dedupe + verified-purchase rules).
 */
export async function submitReviewAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, error: "auth", message: "Connectez-vous pour laisser un avis." };
  }

  // Rate limit like our other public-write endpoints (cf. newsletter): a
  // per-user cap as the primary guard, plus a wider per-IP bucket so one
  // network can't flood reviews even across several accounts. A few
  // submissions/min is plenty for a genuine reviewer.
  const h = await headers();
  const ip = getClientIp(h);
  const userRl = await checkRateLimit({
    bucket: `review:user:${user.id}`,
    max: 5,
    windowSeconds: 60,
  });
  const ipRl = await checkRateLimit({
    bucket: `review:ip:${ip ?? "anon"}`,
    max: 10,
    windowSeconds: 60,
  });
  if (!userRl.ok || !ipRl.ok) {
    return {
      ok: false,
      error: "rate_limited",
      message: "Trop d'avis envoyés. Réessayez dans un instant.",
    };
  }

  const slug = String(formData.get("slug") ?? "").trim();
  const authorName =
    ((user.name ?? "").trim() || (user.email ?? "").split("@")[0] || "Client").slice(0, 80);

  const res = await workflows.catalog.review.create(
    {
      productId: String(formData.get("productId") ?? ""),
      rating: Number(formData.get("rating") ?? 0),
      title: String(formData.get("title") ?? ""),
      body: String(formData.get("body") ?? ""),
    },
    { userId: user.id, authorName },
  );
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  if (slug) revalidatePath(`/${slug}`);
  revalidatePath("/", "layout");
  return {
    ok: true,
    message:
      res.data.status === "approved"
        ? "Merci ! Votre avis est publié."
        : "Merci ! Votre avis sera publié après validation.",
  };
}

/**
 * Admin: create a MANUAL (fake/seed) review for a product. user_id stays NULL,
 * source='manual'. Default status = pending; admin may publish directly +
 * optionally backdate. Routes through the createManual workflow.
 */
export async function createManualReviewAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("reviews", "create");
  const createdAtRaw = String(formData.get("createdAt") ?? "").trim();
  let createdAt: string | undefined;
  if (createdAtRaw) {
    // A date-only ("YYYY-MM-DD") or datetime-local value → ISO at local midday
    // (avoids TZ edge flipping the day); the workflow clamps to ≤ now.
    const d = new Date(createdAtRaw.length <= 10 ? `${createdAtRaw}T12:00:00` : createdAtRaw);
    if (!Number.isNaN(d.getTime())) createdAt = d.toISOString();
  }
  const res = await workflows.catalog.review.createManual(
    {
      productId: String(formData.get("productId") ?? ""),
      authorName: String(formData.get("authorName") ?? ""),
      rating: Number(formData.get("rating") ?? 0),
      title: String(formData.get("title") ?? ""),
      body: String(formData.get("body") ?? ""),
      status: formData.get("status") === "approved" ? "approved" : "pending",
      verifiedPurchase: formData.get("verifiedPurchase") === "on",
      ...(createdAt ? { createdAt } : {}),
    },
    { actorUserId: session.user.id },
  );
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  revalidatePath("/admin/catalog/reviews");
  if (res.data.slug) revalidatePath(`/${res.data.slug}`);
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: res.data.status === "approved" ? "Avis créé et publié." : "Avis créé (en attente).",
  };
}

/** Admin: bulk-delete all fake reviews of a given origin (manual | ai). */
export async function deleteReviewsBySourceAction(source: "manual" | "ai"): Promise<ActionState> {
  const session = await requirePermission("reviews", "delete");
  const res = await workflows.catalog.review.deleteBySource({ source }, { actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  revalidatePath("/admin/catalog/reviews");
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: `Avis ${source === "ai" ? "IA" : "manuels"} supprimés (${res.data.deletedProducts} produit(s) recalculé(s)).`,
  };
}

export async function setReviewStatusAction(id: string, status: ReviewStatus): Promise<ActionState> {
  const session = await requirePermission("reviews", "manage");
  const res = await workflows.catalog.review.setStatus({ id, status }, { actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  revalidatePath("/admin/catalog/reviews");
  revalidatePath("/", "layout");
  return { ok: true, message: "Avis mis à jour." };
}

export async function deleteReviewAction(id: string): Promise<ActionState> {
  const session = await requirePermission("reviews", "delete");
  const res = await workflows.catalog.review.delete({ id }, { actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  revalidatePath("/admin/catalog/reviews");
  revalidatePath("/", "layout");
  return { ok: true, message: "Avis supprimé." };
}

/** Save the review policy controls (reviews.* settings). */
export async function saveReviewSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("reviews", "update");
  const enabled = formData.get("reviews.enabled") === "on";
  const requireApproval = formData.get("reviews.require_approval") === "on";
  const policy =
    String(formData.get("reviews.policy") ?? "all") === "buyers_only" ? "buyers_only" : "all";
  const ratingSource =
    String(formData.get("reviews.rating_source") ?? "all") === "customers" ? "customers" : "all";

  // The public-rating source drives the STORED product aggregate. Read the
  // current value first so we only rebuild every product's stars (and bust the
  // storefront) when it actually changes.
  const prevRatingSource = (await getReviewConfig().catch(() => null))?.ratingSource ?? "all";

  const updates = [
    { key: "reviews.enabled", value: enabled ? "true" : "false", type: "boolean", label: "Avis — activés" },
    {
      key: "reviews.require_approval",
      value: requireApproval ? "true" : "false",
      type: "boolean",
      label: "Avis — modération avant publication",
    },
    { key: "reviews.policy", value: policy, type: "text", label: "Avis — qui peut publier" },
    {
      key: "reviews.rating_source",
      value: ratingSource,
      type: "text",
      label: "Avis — source de la note publique",
    },
  ] as const;

  for (const u of updates) {
    const res = await workflows.cms.upsertSetting(
      {
        key: u.key,
        value: u.value,
        type: u.type as never,
        groupKey: "reviews",
        label: u.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  let recomputed = false;
  if (ratingSource !== prevRatingSource) {
    // Rebuild every product's stored stars/count under the new policy in one bulk
    // UPDATE, then bust the storefront so the PDPs, product cards, JSON-LD, and
    // feeds reflect it immediately instead of healing one moderation at a time.
    // This one correlated-subquery UPDATE spans the whole catalog, so run it on a
    // dedicated connection with a 60s budget rather than the pool-wide 10s timeout
    // (rare, operator-triggered — safe to reserve one extra connection).
    await withLongStatement(60_000, (tx) => reviewService.recomputeAll(ratingSource, tx));
    bustStorefrontCache();
    recomputed = true;
  }

  revalidatePath("/admin/catalog/reviews");
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: recomputed
      ? "Réglages enregistrés. Notes produits recalculées selon la nouvelle source."
      : "Réglages des avis enregistrés.",
  };
}

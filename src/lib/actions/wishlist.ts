"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";

import { resolveWishlist, readWishlistSlugs, WISHLIST_COOKIE } from "@/lib/wishlist/session";
import { favoritesPublicEnabled } from "@/lib/wishlist/config";
import { getSession, requireSession, requirePermission } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { wishlistService } from "@/modules/wishlist/service";
import { productService } from "@/modules/catalog/product/service";
import { workflows } from "@/workflows";
import { bus } from "@/events/bus";
import { validatePublicSlug } from "@/lib/wishlist/public-slug";
import { listFavoritedProducts, favoritesDemandStats } from "@/lib/wishlist/favorites-filter";
import type { FavoritesFilter, FavoritedProductRow, FavoritesStats } from "@/lib/wishlist/favorites-filter-shared";
import { type ActionState } from "@/lib/actions/types";

export type WishlistToggleState = { ok: boolean; wishlisted?: boolean; message?: string };

/**
 * Toggle a product in the caller's wishlist by slug (cards/PDP carry the slug,
 * not the DB id). Works for guests (cookie list) and signed-in users.
 */
export async function toggleWishlistAction(slug: string): Promise<WishlistToggleState> {
  // Generous per-IP throttle on ANONYMOUS toggles only: a cookieless caller
  // creates a new guest list (+ cookie) on every hit, so an unthrottled script
  // could grow `wishlists` without bound. Far above any human heart-clicking;
  // signed-in toggles are bounded by their single list and skip it.
  const session = await getSession();
  if (!session?.user) {
    const ip = getClientIp(await headers()) ?? "anon";
    const rl = await checkRateLimit({ bucket: `wishlist:ip:${ip}`, max: 60, windowSeconds: 60 });
    if (!rl.ok) {
      return { ok: false, message: "Trop de requêtes. Réessayez dans un instant." };
    }
  }
  const product = await productService.findBySlug(slug);
  if (!product) return { ok: false, message: "Produit introuvable." };
  const wl = await resolveWishlist();
  const has = await wishlistService.hasItem(wl.id, product.id);
  if (has) {
    // Removal must always work — including for a product that was unpublished
    // after it was favourited — so the heart can never get stuck.
    await wishlistService.removeItem(wl.id, product.id);
  } else {
    if (!product.is_published) return { ok: false, message: "Produit indisponible." };
    await wishlistService.addItem(wl.id, product.id);
  }
  revalidatePath("/favoris");
  return { ok: true, wishlisted: !has };
}

/**
 * Hydrate the client WishlistProvider with the current wishlisted slugs. Runs
 * on every shop page mount, so it's also where the guest list is MERGED into a
 * just-logged-in user's list (this is a Server Action → it may write cookies,
 * unlike a layout render). Idempotent: the guest cookie is cleared only AFTER a
 * successful merge — a failed merge (transient DB error) keeps the cookie, so
 * the guest list isn't orphaned and the next page mount retries (the merge is
 * ON CONFLICT DO NOTHING, safe to replay). The actual slug read is delegated to
 * `readWishlistSlugs` so the read logic lives in exactly one place.
 */
export async function getWishlistSlugsAction(): Promise<string[]> {
  const session = await getSession();
  if (session?.user) {
    const jar = await cookies();
    const guestToken = jar.get(WISHLIST_COOKIE)?.value;
    if (guestToken) {
      try {
        await wishlistService.mergeTokenIntoUser(guestToken, session.user.id);
        jar.delete(WISHLIST_COOKIE);
      } catch (err) {
        console.warn("[wishlist] guest list merge failed — cookie kept, retried on next mount", err);
      }
    }
  }
  return readWishlistSlugs();
}

/**
 * Customer sets their public-favorites preferences. Requires the global feature
 * to be ON; validates the slug (when making public); maps a slug clash to a
 * field error. Off-by-default + per-user opt-in.
 */
export async function setPublicFavoritesAction(input: {
  isPublic: boolean;
  slug: string;
  displayName: string;
}): Promise<ActionState> {
  const session = await requireSession();
  if (!(await favoritesPublicEnabled())) {
    return { ok: false, error: "disabled", message: "Le partage public des favoris est désactivé." };
  }
  // A moderation lock overrides the customer's own control: they cannot re-publish
  // (nor edit the handle) until an admin lifts it. Checked here so the message is
  // clear about WHY (rather than a silent no-op).
  const own = await wishlistService.getOwnPublicState(session.user.id);
  if (own?.locked) {
    return {
      ok: false,
      error: "locked",
      message: "Le partage public de vos favoris a été suspendu par un administrateur. Contactez le support pour le rétablir.",
    };
  }

  let slug: string | null = null;
  if (input.isPublic) {
    const v = validatePublicSlug(input.slug);
    if (!v.ok) return { ok: false, error: "validation", message: v.message, fieldErrors: { slug: v.message } };
    slug = v.slug;
  } else {
    // Keep any existing slug reserved to the user even while private (so toggling
    // back on doesn't lose their handle) — only normalize if they supplied one.
    const s = input.slug.trim();
    if (s) {
      const v = validatePublicSlug(s);
      if (!v.ok) return { ok: false, error: "validation", message: v.message, fieldErrors: { slug: v.message } };
      slug = v.slug;
    }
  }

  const displayName = input.displayName.trim().slice(0, 60) || null;
  const res = await wishlistService.setPublicProfile(session.user.id, { isPublic: input.isPublic, slug, displayName });
  if (!res.ok) {
    return { ok: false, error: "slug_taken", message: "Cet identifiant public est déjà pris.", fieldErrors: { slug: "Déjà pris" } };
  }
  revalidatePath("/favoris");
  if (slug) revalidatePath(`/u/${slug}`);
  return { ok: true, message: input.isPublic ? "Vos favoris sont désormais publics." : "Vos favoris sont privés." };
}

/**
 * Admin: flip the global public-favorites feature flag (favorites:manage).
 * Surfaced ONLY via the dedicated toggle on the Favoris admin tab — the
 * groupKey/label are metadata for the raw settings table, not a generic panel
 * (this app has no group-iterating settings UI).
 */
export async function saveFavoritesPublicEnabledAction(enabled: boolean): Promise<ActionState> {
  const session = await requirePermission("favorites", "manage");
  const res = await workflows.cms.upsertSetting(
    {
      key: "social.favorites_public_enabled",
      value: enabled ? "true" : "false",
      type: "boolean",
      groupKey: "social",
      label: "Partage public des favoris",
      description: "Permet aux clients de rendre leur liste de favoris publique (page /u/<identifiant>).",
    },
    { actorUserId: session.user.id },
  );
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  revalidatePath("/admin/customers/favorites");
  revalidatePath("/", "layout");
  return { ok: true, message: enabled ? "Partage public activé." : "Partage public désactivé." };
}

/**
 * Admin: force a public profile back to private AND LOCK it (moderation;
 * favorites:manage). The lock stops the customer re-publishing the same abusive
 * handle and clears the slug/pseudonym; lifted via `liftFavoritesLockAction`.
 * Emits `favorites.moderated` so the decision is on the audit trail.
 */
export async function forceFavoritesPrivateAction(wishlistId: string): Promise<ActionState> {
  const session = await requirePermission("favorites", "manage");
  await wishlistService.forcePrivate(wishlistId);
  await bus
    .emit("favorites.moderated", { wishlistId, action: "locked" }, { actorUserId: session.user.id })
    .catch(() => {});
  revalidatePath("/admin/customers/favorites");
  return { ok: true, message: "Profil rendu privé et verrouillé." };
}

/** Admin: lift a favorites moderation lock so the customer can share again
 *  (with a fresh handle). favorites:manage; audited. */
export async function liftFavoritesLockAction(wishlistId: string): Promise<ActionState> {
  const session = await requirePermission("favorites", "manage");
  await wishlistService.liftModerationLock(wishlistId);
  await bus
    .emit("favorites.moderated", { wishlistId, action: "unlocked" }, { actorUserId: session.user.id })
    .catch(() => {});
  revalidatePath("/admin/customers/favorites");
  return { ok: true, message: "Verrou levé — le client peut de nouveau partager." };
}

/**
 * Filter + paginate the Favoris demand board (ranked favorited products), gated by
 * favorites:view. Backs the initial server render and the client filter panel's keyset
 * pagination (Précédent/Suivant). Product-level filters (name search / stock / category /
 * published) are applied server-side; each page is keyset-ranked (count desc, id desc).
 */
export async function searchFavoritesAction(input: {
  filter: FavoritesFilter;
  cursor?: string;
}): Promise<{ items: FavoritedProductRow[]; nextCursor: string | null }> {
  await requirePermission("favorites", "view");
  return listFavoritedProducts(input.filter, { cursor: input.cursor, limit: 30 });
}

/**
 * Demand stat counts for the CURRENTLY-FILTERED favorited-product set (the header cards).
 * Same query shape as the list, so the counts always match what's shown / exported.
 */
export async function favoritesStatsAction(filter: FavoritesFilter): Promise<FavoritesStats> {
  await requirePermission("favorites", "view");
  return favoritesDemandStats(filter);
}

import type { Metadata } from "next";
import Link from "next/link";
import { Heart, Users as UsersIcon, Package, FolderTree, Globe, Layers } from "lucide-react";

import { AdminPageHeader } from "@/components/admin/page-header";
import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { wishlistService } from "@/modules/wishlist/service";
import { favoritesPublicEnabled } from "@/lib/wishlist/config";
import {
  listFavoritedProducts,
  favoritesDemandStats,
  favoritedCategories,
  favoritesComposition,
} from "@/lib/wishlist/favorites-filter";
import { EMPTY_FAVORITES_FILTER } from "@/lib/wishlist/favorites-filter-shared";
import { FavoritesPublicAdmin } from "./favorites-public-admin";
import { FavoritesBrowser } from "./favorites-browser";

export const metadata: Metadata = { title: "Favoris" };
export const dynamic = "force-dynamic";

/** Public-profile moderation list page size (`?q=` search + `?page=` pager). */
const PROFILES_PAGE_SIZE = 50;

/**
 * Favoris (SAV merchandising) — its own Clients tab. Aggregate demand signal from
 * customer wishlists: a filterable, keyset-paged ranked product board (the « En rupture »
 * quick-filter surfaces high-demand out-of-stock products = restock priority) with a
 * filtered CSV export, most-favorited categories, and — gated on `favorites:manage` — the
 * public-profile moderation board (searched + paged in SQL over EVERY public profile).
 * Gated by the dedicated `favorites` permission.
 */
export default async function FavoritesAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const session = await requirePermission("favorites", "view");
  const sp = await searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim().slice(0, 100);
  const requestedPage = Math.max(1, Math.floor(Number(sp.page ?? "1")) || 1);
  const perms = await resolveUserPermissions(session.user.id);
  const canManage = permissionSetAllows(perms, "favorites", "manage");
  const canExport = permissionSetAllows(perms, "favorites", "export");

  const [stats, demandStats, demandList, cats, composition, topCats, publicCount, publicEnabled, matchCount] =
    await Promise.all([
      wishlistService.globalStats(),
      favoritesDemandStats(EMPTY_FAVORITES_FILTER),
      listFavoritedProducts(EMPTY_FAVORITES_FILTER, { limit: 30 }),
      favoritedCategories(),
      favoritesComposition(),
      wishlistService.topCategories(12),
      wishlistService.publicProfileCount(),
      favoritesPublicEnabled(),
      canManage ? wishlistService.publicProfileCount(q || undefined) : Promise.resolve(0),
    ]);

  const activeLists = composition.memberLists + composition.guestLists;
  const avgPerList = activeLists > 0 ? stats.totalItems / activeLists : 0;

  // Clamp to the last page (a force-private on the last row of the last page would
  // otherwise leave an empty page behind).
  const totalPages = Math.max(1, Math.ceil(matchCount / PROFILES_PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const publicProfiles =
    canManage && matchCount > 0
      ? await wishlistService.listPublicProfiles({
          q: q || undefined,
          limit: PROFILES_PAGE_SIZE,
          offset: (page - 1) * PROFILES_PAGE_SIZE,
        })
      : [];
  const maxCat = Math.max(1, ...topCats.map((c) => c.count));

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Favoris"
        description="Signal de demande issu des listes d'envies des clients — produits & catégories les plus ajoutés, avec les ruptures de stock à réapprovisionner en priorité."
      />

      {/* KPI strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Kpi icon={<Heart className="h-4 w-4" />} label="Favoris (total)" value={stats.totalItems.toLocaleString("fr-FR")} />
        <Kpi
          icon={<UsersIcon className="h-4 w-4" />}
          label="Listes actives"
          value={activeLists.toLocaleString("fr-FR")}
          hint={`${composition.memberLists.toLocaleString("fr-FR")} membres · ${composition.guestLists.toLocaleString("fr-FR")} visiteurs`}
        />
        <Kpi icon={<Layers className="h-4 w-4" />} label="Favoris / liste" value={avgPerList.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} hint="moyenne par liste active" />
        <Kpi icon={<Package className="h-4 w-4" />} label="Produits favoris" value={stats.products.toLocaleString("fr-FR")} hint="produits distincts en favori" />
        <Kpi icon={<Globe className="h-4 w-4" />} label="Profils publics" value={publicCount.toLocaleString("fr-FR")} hint={publicEnabled ? "partage activé" : "partage désactivé"} />
      </div>

      {canManage && (
        <FavoritesPublicAdmin
          enabled={publicEnabled}
          profiles={publicProfiles.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() }))}
          publicTotal={publicCount}
          filters={{ q }}
          pagination={{ page, pageSize: PROFILES_PAGE_SIZE, total: matchCount }}
        />
      )}

      {/* Ranked demand board — filterable, paginated, exportable */}
      <FavoritesBrowser
        initialItems={demandList.items}
        initialNextCursor={demandList.nextCursor}
        initialStats={demandStats}
        categories={cats}
        canExport={canExport}
      />

      {/* Top categories */}
      <section className="rounded-[28px] border border-border bg-card p-5">
        <h2 className="mb-3 inline-flex items-center gap-2 text-[18px] font-black">
          <FolderTree className="h-4 w-4 text-muted-foreground" /> Catégories les plus favorites
        </h2>
        {topCats.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune donnée — les favoris sont comptés via la catégorie principale du produit.</p>
        ) : (
          <ul className="grid gap-2.5 sm:grid-cols-2">
            {topCats.map((c) => {
              const pct = Math.round((c.count / maxCat) * 100);
              return (
                <li key={c.categoryId} className="text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/${c.slug}`} className="truncate text-foreground hover:text-primary hover:underline">
                      {c.name}
                    </Link>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{c.count.toLocaleString("fr-FR")}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Kpi({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-[22px] border border-border bg-card p-5">
      <div className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
        {icon} {label}
      </div>
      <p className="mt-2 text-2xl font-black tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

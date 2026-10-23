import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock, CheckCircle2, Package, Pencil, Sparkles } from "lucide-react";

import { productQueries } from "@/modules/catalog/product";
import { orderQueries } from "@/modules/order";
import { productMediaLink } from "@/associations/catalog.service";
import { findMediaByIds } from "@/modules/media/queries";
import { resolveMediaThumbUrl } from "@/modules/media/url-resolver";
import { formatCents } from "@/lib/price";
import { requirePermission } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Précommandes" };
export const dynamic = "force-dynamic";

const FR_DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };

type Row = {
  id: string;
  slug: string;
  name: string;
  price: string;
  releasesAt: Date | null;
  isPublished: boolean;
  thumbUrl: string | null;
  units: number;
  orders: number;
};

/**
 * Dedicated admin queue for products on précommande.
 *
 * Buckets by urgency: Sortie cette semaine (≤ 7 j) · À venir · Sans date ·
 * Récemment sorties (release date passed within the last N days — kept so an
 * operator can still track their orders; the storefront reverts to a normal sale
 * at release) · Anomalies (still flagged > N days after release). Each row shows
 * its open reservation units + order count; the pencil opens the product editor
 * (release date / status). Single source of truth: the product row + its orders.
 */
export default async function PreordersAdminPage() {
  await requirePermission("preorders", "view");
  const WINDOW_DAYS = productQueries.RECENTLY_RELEASED_DEFAULT_DAYS;
  const [queue, totalPreorders, recentlyReleased, recentlyReleasedTotal] = await Promise.all([
    productQueries.listPreorderQueue({ limit: 500 }),
    productQueries.countPreorderQueue(),
    productQueries.listRecentlyReleasedPreorders({ limit: 500 }),
    productQueries.countRecentlyReleasedPreorders(),
  ]);

  // Union of every product shown (queue + recently-released, which overlap for unswept rows).
  const byId = new Map<string, (typeof queue)[number]>();
  for (const p of [...queue, ...recentlyReleased]) if (!byId.has(p.id)) byId.set(p.id, p);
  const allIds = Array.from(byId.keys());

  const primaryMediaIds = await productMediaLink.primaryMediaIdsForProducts(allIds);
  const [mediaMap, counts] = await Promise.all([
    findMediaByIds(Array.from(primaryMediaIds.values())),
    orderQueries.openPreorderCountsByProduct(allIds),
  ]);

  const toRow = (p: (typeof queue)[number]): Row => {
    const mediaId = primaryMediaIds.get(p.id);
    const c = counts.get(p.id);
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      price: formatCents(p.price_cents),
      releasesAt: p.preorder_releases_at,
      isPublished: p.is_published,
      thumbUrl: resolveMediaThumbUrl(mediaId ? mediaMap.get(mediaId) : null),
      units: c?.units ?? 0,
      orders: c?.orders ?? 0,
    };
  };

  // Server component (`force-dynamic`) — `Date.now()` is request-time, equivalent to a prop.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const inOneWeek = now + 7 * 24 * 60 * 60 * 1000;
  const recentCutoff = now - WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const soon: Row[] = [];
  const future: Row[] = [];
  const undated: Row[] = [];
  const stale: Row[] = [];
  for (const p of queue) {
    const ts = p.preorder_releases_at ? p.preorder_releases_at.getTime() : null;
    const row = toRow(p);
    if (ts === null) undated.push(row);
    else if (ts > now) (ts <= inOneWeek ? soon : future).push(row);
    else if (ts < recentCutoff) stale.push(row); // past the window, still flagged
    // else released within the window → « Récemment sorties » below
  }
  const recent: Row[] = recentlyReleased.map(toRow);
  const totalUnits = [...soon, ...future, ...undated].reduce((s, p) => s + p.units, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-foreground sm:text-3xl">Précommandes</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            File des produits en précommande, classés par date de sortie. Dès la date de sortie, la
            boutique revend l&apos;article normalement&nbsp;; il reste listé ici dans «&nbsp;Récemment
            sorties&nbsp;» pendant {WINDOW_DAYS} jours pour en suivre les commandes. L&apos;icône
            crayon ouvre le produit (date de sortie / statut).
          </p>
        </div>
        <Link
          href="/admin/catalog/products"
          className="inline-flex h-10 items-center gap-2 rounded-full border border-border bg-card px-4 text-sm font-medium hover:bg-surface"
        >
          <Package className="h-4 w-4" />
          Tous les produits
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Kpi label="Unités réservées" value={totalUnits} accent hint="Précommandées (non déduites du stock)" />
        <Kpi label="≤ 7 jours" value={soon.length} />
        <Kpi label="À venir" value={future.length} />
        <Kpi label="Sans date" value={undated.length} />
        <Kpi label="Récemment sorties" value={recentlyReleasedTotal} />
      </div>

      {totalPreorders > queue.length && (
        <p className="rounded-2xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
          {totalPreorders} précommandes au total ; les {queue.length} plus urgentes sont affichées.
        </p>
      )}

      <Section title="Sortie cette semaine" empty="Rien ne sort dans les 7 prochains jours." accent items={soon} />
      <Section title="À venir" empty="Aucune précommande planifiée." items={future} />
      {undated.length > 0 && (
        <Section
          title="Sans date"
          empty=""
          items={undated}
          hint="Marqués comme précommande mais sans date de sortie. Ouvrez-les pour préciser."
        />
      )}
      <Section
        title={`Récemment sorties (${WINDOW_DAYS} derniers jours)`}
        empty="Aucun article sorti récemment."
        released
        items={recent}
        hint="Date de sortie passée : la boutique les revend normalement. Gardés ici pour suivre leurs commandes jusqu'à expiration de la fenêtre."
      />
      {stale.length > 0 && (
        <Section
          title="Anomalies (date dépassée)"
          empty=""
          items={stale}
          warn
          hint="Toujours marqués « précommande » plus de 3 semaines après la sortie — pensez à ajuster la date ou retirer la précommande (icône crayon)."
        />
      )}
    </div>
  );
}

/** Per-product open-reservation cue (units + distinct orders). */
function CountCue({ units, orders }: { units: number; orders: number }) {
  if (orders === 0) return <span className="text-[11px] text-muted-foreground">Aucune commande</span>;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-foreground">
      {units} unité{units > 1 ? "s" : ""} · {orders} cmd{orders > 1 ? "s" : ""}
    </span>
  );
}

function Section({
  title,
  empty,
  items,
  accent,
  warn,
  released,
  hint,
}: {
  title: string;
  empty: string;
  items: Row[];
  accent?: boolean;
  warn?: boolean;
  released?: boolean;
  hint?: string;
}) {
  if (items.length === 0 && !empty) return null;
  return (
    <section
      className={`rounded-3xl border bg-card ${
        accent
          ? "border-accent/30"
          : released
            ? "border-primary/30"
            : warn
              ? "border-destructive/30"
              : "border-border"
      }`}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="inline-flex items-center gap-2 text-base font-bold">
          {released ? <CheckCircle2 className="h-4 w-4" /> : <CalendarClock className="h-4 w-4" />}
          {title}
        </h2>
        <span className="text-xs text-muted-foreground">{items.length}</span>
      </header>
      {hint && (
        <p className="border-b border-border bg-surface/40 px-4 py-2 text-[11px] text-muted-foreground">
          {hint}
        </p>
      )}
      {items.length === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 p-3 transition hover:bg-surface/50">
              <Link
                href={`/admin/catalog/products/${p.id}`}
                className="flex min-w-0 flex-1 items-center gap-3"
                aria-label={`Modifier ${p.name}`}
              >
                <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-surface">
                  {p.thumbUrl ? (
                    <img src={p.thumbUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <Sparkles className="h-4 w-4 text-muted-foreground" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{p.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {p.releasesAt
                      ? `Sortie le ${p.releasesAt.toLocaleDateString("fr-FR", FR_DATE)}`
                      : "Aucune date — à préciser"}
                    {!p.isPublished && " · brouillon"}
                  </p>
                </div>
              </Link>
              <CountCue units={p.units} orders={p.orders} />
              <span className="text-sm font-semibold">{p.price}</span>
              <Link
                href={`/admin/catalog/products/${p.id}`}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border text-muted-foreground transition hover:bg-surface hover:text-foreground"
                aria-label={`Modifier ${p.name}`}
                title="Modifier le produit"
              >
                <Pencil className="h-4 w-4" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Kpi({
  label,
  value,
  accent,
  warn,
  hint,
}: {
  label: string;
  value: number;
  accent?: boolean;
  warn?: boolean;
  hint?: string;
}) {
  return (
    <div
      className={`rounded-2xl border p-4 ${
        warn
          ? "border-destructive/30 bg-destructive/5"
          : accent
            ? "border-accent/30 bg-accent/5"
            : "border-border bg-card"
      }`}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-black">{value}</p>
      {hint && <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">{hint}</p>}
    </div>
  );
}

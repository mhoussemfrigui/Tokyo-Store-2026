import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ChevronLeft,
  Heart,
  Mail,
  MapPin,
  Phone,
  ReceiptText,
  ShieldCheck,
  ShoppingCart,
  Star,
  User as UserIcon,
  Wallet,
} from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveAccountType, resolveUserPermissions } from "@/lib/rbac/authorize";
import { ACCOUNT_TYPE_LABEL } from "@/lib/rbac/account-type";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { getUserOrderSummary, listOrdersForUserOrEmail } from "@/modules/order/queries";
import { getUserCartForAdmin } from "@/modules/cart/queries";
import { reviewService } from "@/modules/catalog/review/service";
import { wishlistService } from "@/modules/wishlist/service";
import { newsletterService } from "@/modules/newsletter/service";
import { promotionService } from "@/modules/promotion";
import { isUuid } from "@/lib/utils/uuid";
import { orderStatusLabel } from "@/lib/order/status";
import { REVIEW_STATUS_LABELS, REVIEW_STATUS_COLORS } from "@/modules/catalog/review/status";
import { formatMoneyExact } from "@/lib/price";
import { StarRating } from "@/components/ui/star-rating";

import {
  AddressDefaultButtons,
  AdminNotesEditor,
  ProfileBirthdayEditor,
  ProfileGenderEditor,
  ProfilePhoneEditor,
} from "./customer-detail-panel";
import { AccountControls, CustomerDangerZone } from "./account-controls";
import { PromoOptOutControl } from "./promo-optout-control";
import { ResetTwoFactorButton } from "@/components/admin/reset-two-factor-button";

export const metadata: Metadata = { title: "Détail client" };

const formatTnd = formatMoneyExact;

/** Rendered-list caps. `listOrdersForUserOrEmail` defaults to 100 and
 *  `reviewService.listByUser` is fixed at 100. Headers state the cap instead of
 *  passing a capped length off as the customer's total. */
const ORDERS_SHOWN = 100;
const REVIEWS_CAP = 100;

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const session = await requirePermission("customers", "view");

  // The account-control buttons (disable / enable / force-logout / password
  // reset) call actions gated on `users:manage`. Only render them when the actor
  // actually holds that permission, so a `customers`-only admin isn't shown
  // controls that would 404 on click (UI honesty over the server-side guard).
  const actorPerms = await resolveUserPermissions(session.user.id);
  const canManageUsers = permissionSetAllows(actorPerms, "users", "manage");
  // The GRANT power (assign roles + per-user overlay) is its own slice: users:roles
  // (not users:manage). Editing it lives on a dedicated Système → Utilisateurs page
  // (/admin/users/<id>/access); here we only surface a LINK to it for holders.
  const canAssignRoles = permissionSetAllows(actorPerms, "users", "roles");
  // The promo-exclusion toggle is a customer-area mutation (customers:update),
  // distinct from the users:manage account controls below.
  const canEditCustomer = permissionSetAllows(actorPerms, "customers", "update");
  // « Tout voir » deep links — only offered when the target page would open.
  const canViewOrders = permissionSetAllows(actorPerms, "orders", "view");
  const canViewAudit = permissionSetAllows(actorPerms, "system_audit", "view");

  const profile = await customerService.findProfileById(id);
  if (!profile) notFound();

  const [link, addresses] = await Promise.all([
    customerUserLink.findByProfileId(id),
    customerService.listAddressesByProfile(id),
  ]);

  // Resolve the linked auth user first (we need its email to match guest
  // orders + newsletter), then fan out every "node" keyed on user.id / email.
  const user = link ? await authService.findById(link.user_id) : null;
  const userId = link?.user_id ?? null;
  const email = user?.email ?? null;

  // Account TYPE (Client/Staff/Admin) is DERIVED from the linked account's RBAC
  // grants — no stored enum. Null when there is no linked login. The role + overlay
  // EDITORS live on /admin/users/<id>/access (gated users:roles); this page only
  // shows the derived type + a link there.
  const accountType = userId ? await resolveAccountType(userId) : null;

  const [summary, orders, reviews, favorites, newsletter, couponCount, cart] = await Promise.all([
    getUserOrderSummary(userId, email),
    listOrdersForUserOrEmail(userId, email, { limit: ORDERS_SHOWN }),
    userId
      ? reviewService.listByUser(userId)
      : Promise.resolve([] as Awaited<ReturnType<typeof reviewService.listByUser>>),
    userId
      ? wishlistService
          .findByUserId(userId)
          .then((wl) => (wl ? wishlistService.listForOwner(wl.id) : []))
      : Promise.resolve([] as Awaited<ReturnType<typeof wishlistService.listForOwner>>),
    email ? newsletterService.findByEmail(email) : Promise.resolve(null),
    // Coupons redeemed (LTV context, orders:view-gated like the rest).
    userId && canViewOrders
      ? promotionService.countRedemptionsForUser(userId).catch(() => 0)
      : Promise.resolve(0),
    userId ? getUserCartForAdmin(userId) : Promise.resolve(null),
  ]);

  const aovCents = summary.orderCount > 0 ? Math.round(summary.lifetimeSpendCents / summary.orderCount) : 0;
  // The orders header uses the UNCAPPED summary count (same user-or-email
  // predicate as the list), so it agrees with the « Commandes » KPI above.
  const ordersTruncated = summary.orderCount > orders.length;
  const reviewsCapped = reviews.length >= REVIEWS_CAP;
  // /admin/orders searches number + contact email + phone — the account email
  // finds the guest orders and the orders placed with it.
  const ordersHref = email ? `/admin/orders?q=${encodeURIComponent(email)}` : null;
  const auditHref = userId ? `/admin/system/audit?actor=${encodeURIComponent(userId)}` : null;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/customers"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour aux clients
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-black text-foreground sm:text-3xl">
              {profile.first_name} {profile.last_name}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {user?.email ?? "Compte non lié"}
            </p>
          </div>
        </div>
      </div>

      {/* Lifetime value snapshot — orders (incl. guest). The order-derived tiles
          need orders:view (a customers:view-only delegate must not see order
          totals/counts here — same rule as the Commandes section + the « Tout
          voir » link below). */}
      {canViewOrders && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat
            icon={<Wallet className="h-4 w-4" />}
            label="Total dépensé"
            value={formatTnd(summary.paidSpendCents)}
            hint={
              summary.lifetimeSpendCents !== summary.paidSpendCents
                ? `${formatTnd(summary.lifetimeSpendCents)} commandé`
                : undefined
            }
          />
          <Stat icon={<ReceiptText className="h-4 w-4" />} label="Commandes" value={String(summary.orderCount)} />
          <Stat label="Panier moyen" value={formatTnd(aovCents)} />
          <Stat
            label="Dernière commande"
            value={summary.lastOrderAt ? summary.lastOrderAt.toLocaleDateString("fr-FR") : "—"}
          />
          <Stat label="Coupons utilisés" value={String(couponCount)} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Left column — profile + orders */}
        <div className="space-y-4">
          {/* Profil */}
          <Section title="Profil" icon={<UserIcon className="h-4 w-4" />}>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Field label="Prénom" value={profile.first_name} />
              <Field label="Nom" value={profile.last_name} />
              <div>
                <p className="text-[13px] font-bold text-foreground">
                  Téléphone
                </p>
                <ProfilePhoneEditor profileId={profile.id} initialPhone={profile.phone} canEdit={canEditCustomer} />
              </div>
              <div>
                <p className="text-[13px] font-bold text-foreground">
                  Anniversaire
                </p>
                <ProfileBirthdayEditor profileId={profile.id} initialBirthday={profile.birthday} canEdit={canEditCustomer} />
              </div>
              <div>
                <p className="text-[13px] font-bold text-foreground">
                  Genre
                </p>
                <ProfileGenderEditor profileId={profile.id} initialGender={profile.gender} canEdit={canEditCustomer} />
              </div>
              <Field
                label="Marketing"
                value={profile.marketing_opt_in ? "Opt-in" : "Opt-out"}
              />
              <Field
                label="Membre depuis"
                value={new Date(profile.created_at).toLocaleDateString("fr-FR", {
                  dateStyle: "medium",
                })}
              />
            </div>
            {canEditCustomer && (
              <div className="mt-3 border-t border-border pt-3">
                <PromoOptOutControl
                  profileId={profile.id}
                  optedOut={profile.promo_opt_out}
                />
              </div>
            )}
          </Section>

          {/* Adresses */}
          <Section title="Adresses" icon={<MapPin className="h-4 w-4" />}>
            {addresses.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune adresse enregistrée.</p>
            ) : (
              <ul className="space-y-3">
                {addresses.map((a) => (
                  <li
                    key={a.id}
                    className="rounded-[14px] border border-border bg-surface/40 p-3 text-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{a.full_name}</p>
                      <div className="flex gap-1">
                        {a.is_default_shipping && (
                          <span className="rounded-full bg-[#fdecef] px-2.5 py-1 text-[10px] font-bold text-[#d40530]">
                            Livraison
                          </span>
                        )}
                        {a.is_default_billing && (
                          <span className="rounded-full bg-[#eef2ff] px-2.5 py-1 text-[10px] font-bold text-[#3730a3]">
                            Facturation
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="mt-1 text-[12px] text-muted-foreground">
                      {a.street_line1}
                      {a.street_line2 ? `, ${a.street_line2}` : ""}
                      <br />
                      {a.postal_code ? `${a.postal_code} ` : ""}
                      {a.city}
                      {a.region ? `, ${a.region}` : ""}
                      {" — "}
                      {a.country}
                    </p>
                    {a.phone && (
                      <p className="mt-1 inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                        <Phone className="h-3 w-3" /> {a.phone}
                      </p>
                    )}
                    {canEditCustomer && (
                      <AddressDefaultButtons
                        customerProfileId={profile.id}
                        addressId={a.id}
                        isDefaultShipping={a.is_default_shipping}
                        isDefaultBilling={a.is_default_billing}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Notes admin (jamais affichées au client) — the EDITOR needs
              customers:update; a customers:view-only operator sees them read-only. */}
          <Section title="Notes admin">
            <p className="mb-2 text-[11px] text-muted-foreground">
              Notes internes visibles uniquement par les administrateurs.
            </p>
            {canEditCustomer ? (
              <AdminNotesEditor profileId={profile.id} initialNotes={profile.admin_notes} />
            ) : (
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {profile.admin_notes || "—"}
              </p>
            )}
          </Section>

          {/* Commandes — order data needs orders:view; a customers:view-only
              delegate sees a neutral placeholder, not real order numbers/totals. */}
          {canViewOrders ? (
          <Section
            title={`Commandes (${summary.orderCount})`}
            icon={<ReceiptText className="h-4 w-4" />}
            action={
              canViewOrders && ordersHref && summary.orderCount > 0 ? (
                <SeeAllLink href={ordersHref} />
              ) : undefined
            }
          >
            {ordersTruncated && (
              <p className="mb-2 text-[11px] text-muted-foreground">
                {orders.length} plus récentes affichées sur {summary.orderCount}.
              </p>
            )}
            {orders.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aucune commande pour ce client.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                    <tr>
                      <th className="py-2 pr-3">Numéro</th>
                      <th className="py-2 pr-3">Statut</th>
                      <th className="py-2 pr-3">Total</th>
                      <th className="py-2 pr-3">Date</th>
                      <th className="py-2 text-right" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {orders.map((o) => (
                      <tr key={o.id} className="hover:bg-[#fffbfb]">
                        <td className="py-2 pr-3 font-medium">
                          {o.order_number}
                          {!o.user_id && (
                            <span className="ml-2 rounded-full bg-[#f6f2ed] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#5b5d62]">
                              Invité
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-[12px] text-muted-foreground">
                          {orderStatusLabel(o.status)}
                        </td>
                        <td className="py-2 pr-3">{formatTnd(o.total_cents)}</td>
                        <td className="py-2 pr-3 text-[12px] text-muted-foreground">
                          {new Date(o.created_at).toLocaleDateString("fr-FR")}
                        </td>
                        <td className="py-2 text-right">
                          <Link
                            href={`/admin/orders/${o.id}`}
                            className="text-[11px] font-semibold text-primary hover:underline"
                          >
                            Détail
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
          ) : (
            <Section title="Commandes" icon={<ReceiptText className="h-4 w-4" />}>
              <p className="text-sm text-muted-foreground">
                Vous n&apos;avez pas l&apos;autorisation de voir les commandes de ce client.
              </p>
            </Section>
          )}

          {/* Avis publiés */}
          <Section
            title={reviewsCapped ? `Avis (${REVIEWS_CAP} plus récents)` : `Avis (${reviews.length})`}
            icon={<Star className="h-4 w-4" />}
          >
            {reviews.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun avis publié.</p>
            ) : (
              <ul className="space-y-3">
                {reviews.map((r) => (
                  <li key={r.review.id} className="rounded-[14px] border border-border bg-surface/40 p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <StarRating value={r.review.rating} size="sm" />
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${REVIEW_STATUS_COLORS[r.review.status as keyof typeof REVIEW_STATUS_COLORS] ?? "bg-muted text-muted-foreground"}`}
                      >
                        {REVIEW_STATUS_LABELS[r.review.status as keyof typeof REVIEW_STATUS_LABELS] ?? r.review.status}
                      </span>
                    </div>
                    <p className="mt-1 font-medium">{r.review.title}</p>
                    {r.productName && (
                      <Link
                        href={r.productSlug ? `/${r.productSlug}` : "#"}
                        className="text-[11px] text-primary hover:underline"
                      >
                        {r.productName}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Panier actuel — the customer's live cart */}
          <Section title="Panier actuel" icon={<ShoppingCart className="h-4 w-4" />}>
            {!cart || cart.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">Panier vide.</p>
            ) : (
              <div className="space-y-2">
                <ul className="divide-y divide-border">
                  {cart.items.map((it) => (
                    <li
                      key={`${it.productId}:${it.variantId}`}
                      className="flex items-center justify-between gap-3 py-2 text-sm"
                    >
                      <div className="min-w-0">
                        {it.slug ? (
                          <Link
                            href={`/${it.slug}`}
                            className="font-medium hover:text-primary hover:underline"
                          >
                            {it.name ?? it.slug}
                          </Link>
                        ) : (
                          <span className="font-medium">{it.name ?? "Produit"}</span>
                        )}
                        <span className="ml-2 text-[11px] text-muted-foreground">× {it.quantity}</span>
                      </div>
                      <span className="shrink-0 tabular-nums">
                        {formatTnd(it.unitPriceCents * it.quantity)}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="flex justify-between border-t border-border pt-2 text-sm font-semibold">
                  <span>Sous-total</span>
                  <span className="tabular-nums">{formatTnd(cart.subtotalCents)}</span>
                </div>
                <Link
                  href={`/admin/cart/${cart.cartId}`}
                  className="inline-block text-[12px] font-medium text-primary hover:underline"
                >
                  Ouvrir le panier →
                </Link>
              </div>
            )}
          </Section>
        </div>

        {/* Right column — account & meta */}
        <div className="space-y-4">
          {user && (
            <Section title="Compte & accès">
              <div className="space-y-1 text-sm">
                <p className="font-medium">{user.email}</p>
                <p className="text-[11px] text-muted-foreground">
                  Type de compte :{" "}
                  <span className="font-semibold">
                    {accountType ? ACCOUNT_TYPE_LABEL[accountType] : "—"}
                  </span>
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Email{" "}
                  {user.emailVerified ? (
                    <span className="text-primary">vérifié</span>
                  ) : (
                    <span className="text-muted-foreground">non vérifié</span>
                  )}
                </p>
                {user.disabledAt && (
                  <p className="text-[11px] font-semibold text-destructive">
                    Compte désactivé
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  2FA :{" "}
                  <span className="font-semibold">
                    {user.twoFactorEnabled ? "active" : "inactive"}
                  </span>
                </p>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Inscrit le{" "}
                  {new Date(user.createdAt).toLocaleDateString("fr-FR")}
                </p>
                {canViewAudit && auditHref && (
                  <Link
                    href={auditHref}
                    className="mt-1 inline-block text-[11px] font-semibold text-primary hover:underline"
                  >
                    Journal d&apos;activité du compte →
                  </Link>
                )}
              </div>
              {canManageUsers && user.twoFactorEnabled && (
                <div className="mt-4 border-t border-border pt-4">
                  <ResetTwoFactorButton userId={user.id} />
                </div>
              )}
              {canManageUsers && (
                <div className="mt-4 border-t border-border pt-4">
                  <AccountControls
                    userId={user.id}
                    email={user.email}
                    name={user.name || user.email}
                    disabled={!!user.disabledAt}
                  />
                </div>
              )}
              {canAssignRoles && (
                <div className="mt-4 border-t border-border pt-4">
                  {/* Rôles + per-user permission overlay live on the dedicated
                      Système → Utilisateurs page (users:roles), not in Clients. */}
                  <Link
                    href={`/admin/users/${user.id}/access`}
                    className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full border-[1.5px] border-input bg-card text-[14px] font-bold text-foreground transition hover:bg-surface"
                  >
                    <ShieldCheck className="h-4 w-4" /> Éditer les rôles &amp; permissions
                  </Link>
                </div>
              )}
            </Section>
          )}

          {/* Favoris — the actual saved products */}
          <Section title={`Favoris (${favorites.length})`} icon={<Heart className="h-4 w-4" />}>
            {favorites.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun favori.</p>
            ) : (
              <ul className="space-y-1.5">
                {favorites.map((f) => (
                  <li key={f.productId} className="text-sm">
                    {f.slug ? (
                      <Link
                        href={`/${f.slug}`}
                        className="text-foreground hover:text-primary hover:underline"
                      >
                        {f.name ?? f.slug}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{f.name ?? "Produit supprimé"}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Newsletter */}
          <Section title="Newsletter" icon={<Mail className="h-4 w-4" />}>
            {newsletter ? (
              newsletter.is_active ? (
                <p className="text-sm font-semibold text-[#15803d]">Abonné</p>
              ) : (
                <p className="text-sm font-semibold text-muted-foreground">Désabonné</p>
              )
            ) : (
              <p className="text-sm text-muted-foreground">Non inscrit</p>
            )}
          </Section>
        </div>
      </div>

      {/* Zone dangereuse — suppression (archivage) du client. Gated on
          customers:delete (the action's permission), copy worded by the linked
          account's DERIVED type (only a plain-customer login is disabled). */}
      {permissionSetAllows(actorPerms, "customers", "delete") && (
        <CustomerDangerZone
          customerProfileId={profile.id}
          customerName={`${profile.first_name} ${profile.last_name}`}
          accountRole={accountType}
        />
      )}
    </div>
  );
}

function Section({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  /** Optional header-right slot (e.g. a « Tout voir » link). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-border bg-card p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="inline-flex items-center gap-2 text-[18px] font-black">
          {icon}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function SeeAllLink({ href }: { href: string }) {
  return (
    <Link href={href} className="shrink-0 text-[11px] font-semibold text-primary hover:underline">
      Tout voir →
    </Link>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[13px] font-bold text-foreground">
        {label}
      </p>
      <p className="mt-0.5 text-muted-foreground">{value}</p>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-[22px] border border-border bg-card p-4">
      <p className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className="mt-1 truncate text-xl font-black text-foreground">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

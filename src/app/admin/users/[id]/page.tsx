import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft, ScrollText, ShieldCheck } from "lucide-react";

import { authService } from "@/modules/auth/service";
import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveAccountType, resolveUserPermissions } from "@/lib/rbac/authorize";
import { ACCOUNT_TYPE_LABEL } from "@/lib/rbac/account-type";
import { customerUserLink } from "@/associations/customer-user.service";
import { auditQueries } from "@/modules/audit";

import { UsersSubnav } from "../users-subnav";
import { SetPasswordButton } from "../set-password-modal";
import { AccountControls } from "@/app/admin/customers/[id]/account-controls";
import { ResetTwoFactorButton } from "@/components/admin/reset-two-factor-button";

export const metadata: Metadata = { title: "Détail utilisateur" };

/** Most recent audit entries rendered inline; the full history is one click
 *  away on /admin/system/audit?actor=<id>. */
const AUDIT_SHOWN = 30;

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requirePermission("users", "view");
  const user = await authService.findById(id);
  if (!user) notFound();

  // Per-control gates (UI honesty — every action also re-checks server-side):
  //   users:roles  → the GRANT power (assign roles + per-user overlay). Only a
  //                  full (wildcard) admin additionally sees SYSTEM roles.
  //   users:manage → routine account ops (password / disable / force-logout / 2FA).
  //   system_audit:view → this account's activity trail (same gate as the full
  //                  audit page, so a users:view-only operator can't read it here).
  const actorPerms = await resolveUserPermissions(session.user.id);
  const canAssignRoles = permissionSetAllows(actorPerms, "users", "roles");
  const canManageUsers = permissionSetAllows(actorPerms, "users", "manage");
  const canViewAudit = permissionSetAllows(actorPerms, "system_audit", "view");

  // A user that has a LIVE customer profile → send straight to the rich customer
  // 360 (orders, spend, addresses, reviews, wishlist, newsletter). The link row
  // survives "Supprimer le client" (soft-delete), and the 360 404s on an archived
  // profile — so only redirect when the profile is live; otherwise fall through
  // to this detail view so roles / 2FA reset / account controls stay reachable.
  const liveProfile = (await customerUserLink.findProfileSummariesByUserIds([id])).get(id);
  if (liveProfile) redirect(`/admin/customers/${liveProfile.profileId}`);
  const archivedProfile = !!(await customerUserLink.findByUserId(id));

  // Staff / admin (no live customer profile) → identity + their activity (they
  // are the actors in the audit log; customers usually aren't). The activity trail
  // is gated on `system_audit:view` — the SAME grant the full audit page needs —
  // so a users:view-only operator never reads it (nor pays the query).
  // `nextCursor` says whether older entries exist beyond the rendered window, so
  // the header never presents the capped length as the account's total.
  const { items: audit, nextCursor: moreAudit } = canViewAudit
    ? await auditQueries.listAuditEntries({ actorUserId: id, limit: AUDIT_SHOWN })
    : ({ items: [], nextCursor: null } as Awaited<ReturnType<typeof auditQueries.listAuditEntries>>);

  // The derived account TYPE for the summary. Role assignment + the per-user
  // overlay now live on a dedicated « Rôles & accès » page (/access), gated
  // users:roles — not inline here.
  const targetType = await resolveAccountType(id);

  return (
    <div className="space-y-6">
      <UsersSubnav show={["comptes", "roles", "reglages"]} />
      <div>
        <Link
          href="/admin/users"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour aux utilisateurs
        </Link>
        <h1 className="mt-2 text-[26px] font-black tracking-[-0.02em] text-foreground sm:text-[30px]">
          {user.name || user.email}
        </h1>
        <p className="mt-1 text-[14px] text-muted-foreground">{user.email}</p>
        {archivedProfile && (
          <p className="mt-2 text-[12px] text-muted-foreground">
            Le profil client lié à ce compte a été supprimé (archivé) — la fiche client
            n&apos;est plus disponible.
          </p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <section className="space-y-2 rounded-[22px] border border-border bg-card p-5 text-sm">
          <h2 className="mb-2 inline-flex items-center gap-2 text-[18px] font-black text-foreground">
            <ShieldCheck className="h-4 w-4" /> Compte
          </h2>
          <DRow label="Type de compte" value={ACCOUNT_TYPE_LABEL[targetType]} />
          <DRow label="Email" value={user.emailVerified ? "Vérifié" : "Non vérifié"} />
          <DRow label="Statut" value={user.disabledAt ? "Désactivé" : "Actif"} />
          <DRow label="2FA" value={user.twoFactorEnabled ? "Active" : "Inactive"} />
          <DRow label="Inscrit le" value={new Date(user.createdAt).toLocaleDateString("fr-FR")} />

          {canAssignRoles && (
            <div className="border-t border-border pt-3">
              <Link
                href={`/admin/users/${user.id}/access`}
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full border-[1.5px] border-input bg-card text-[14px] font-bold text-foreground transition hover:bg-surface"
              >
                <ShieldCheck className="h-4 w-4" /> Gérer les rôles &amp; permissions
              </Link>
            </div>
          )}

          {canManageUsers && (
            <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
              <span className="text-[12px] font-semibold text-muted-foreground">
                Mot de passe
              </span>
              <SetPasswordButton userId={user.id} name={user.name} email={user.email} />
            </div>
          )}

          {canManageUsers && (
            <div className="border-t border-border pt-3">
              <AccountControls
                userId={user.id}
                email={user.email}
                name={user.name || user.email}
                disabled={!!user.disabledAt}
              />
            </div>
          )}
          {canManageUsers && user.twoFactorEnabled && (
            <div className="border-t border-border pt-3">
              <ResetTwoFactorButton userId={user.id} />
            </div>
          )}
        </section>

        {canViewAudit && (
          <section className="rounded-[22px] border border-border bg-card p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="inline-flex items-center gap-2 text-[18px] font-black text-foreground">
                <ScrollText className="h-4 w-4" />
                {moreAudit
                  ? `Journal d'activité (${audit.length} dernières actions)`
                  : `Journal d'activité (${audit.length})`}
              </h2>
              {audit.length > 0 && (
                <Link
                  href={`/admin/system/audit?actor=${encodeURIComponent(user.id)}`}
                  className="shrink-0 text-[11px] font-semibold text-primary hover:underline"
                >
                  Tout voir →
                </Link>
              )}
            </div>
            {audit.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune action enregistrée.</p>
            ) : (
              <ul className="space-y-2">
                {audit.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-start justify-between gap-3 border-b border-border pb-2 text-sm last:border-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="font-medium">{a.event_name}</p>
                      {a.summary && (
                        <p className="text-[12px] text-muted-foreground">{a.summary}</p>
                      )}
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {new Date(a.created_at).toLocaleString("fr-FR")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function DRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

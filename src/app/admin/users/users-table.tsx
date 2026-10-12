"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  KeyRound,
  Loader2,
  LogOut,
  MailCheck,
  ShieldCheck,
  ShieldOff,
  UserRound,
  X,
} from "lucide-react";

import {
  disableUserAction,
  enableUserAction,
  forceLogoutUserAction,
  toggleEmailVerifiedAction,
  triggerPasswordResetAction,
} from "@/lib/actions/auth";
import { ACCOUNT_TYPE_LABEL, type AccountType } from "@/lib/rbac/account-type";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { AdminSearch, AdminToolbar, SegmentedFilter } from "@/components/admin/_components/filter-bar";
import { SetPasswordButton } from "./set-password-modal";

type Row = {
  id: string;
  email: string;
  name: string;
  /** DERIVED account type (RBAC grants), not a stored enum. */
  accountType: AccountType;
  emailVerified: boolean;
  disabled: boolean;
  createdAt: string;
  /** The linked customer-profile id (→ 360), or null for an internal account. */
  customerProfileId: string | null;
};

type StatusFilter = "active" | "disabled" | "all";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "Tous" },
  { value: "active", label: "Actifs" },
  { value: "disabled", label: "Désactivés" },
];

/** Badge tone per derived account type (admin = emphasis, staff = neutral-info, client = muted). */
const TYPE_BADGE: Record<AccountType, string> = {
  admin: "bg-[#fdecef] text-[#d40530]",
  staff: "bg-[#eef2ff] text-[#3730a3]",
  customer: "bg-[#f6f2ed] text-[#5b5d62]",
};

export function UsersTable({
  initialItems,
  nextCursor,
  currentSearch,
  currentStatus,
}: {
  initialItems: Row[];
  nextCursor: string | null;
  currentSearch: string;
  currentStatus: StatusFilter;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(currentSearch);
  const [navPending, startNav] = useTransition();

  const go = (p: URLSearchParams) => startNav(() => router.push(`/admin/users?${p.toString()}`));

  const setStatusFilter = (status: StatusFilter) => {
    const p = new URLSearchParams(searchParams);
    if (status === "all") p.delete("statut");
    else p.set("statut", status);
    p.delete("cursor");
    go(p);
  };

  const submitSearch = () => {
    const p = new URLSearchParams(searchParams);
    if (search.trim()) p.set("q", search.trim());
    else p.delete("q");
    p.delete("cursor");
    go(p);
  };

  const clearSearch = () => {
    setSearch("");
    if (currentSearch) {
      const p = new URLSearchParams(searchParams);
      p.delete("q");
      p.delete("cursor");
      go(p);
    }
  };

  const loadMore = () => {
    if (!nextCursor) return;
    const p = new URLSearchParams(searchParams);
    p.set("cursor", nextCursor);
    go(p);
  };

  const columns: ColumnDef<Row>[] = [
    {
      accessorKey: "name",
      header: "Nom",
      cell: ({ row }) => {
        const u = row.original;
        // Customer accounts link straight to their 360 (where their profile +
        // RBAC roles are edited); staff/admin link to the user detail. A small
        // badge makes the cross-section jump expected, not a surprise redirect.
        const href = u.customerProfileId
          ? `/admin/customers/${u.customerProfileId}`
          : `/admin/users/${u.id}`;
        return (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <Link
                href={href}
                title={u.customerProfileId ? "Voir la fiche client" : "Voir le compte"}
                className={`w-fit text-sm font-medium hover:text-primary hover:underline ${
                  u.disabled ? "text-muted-foreground line-through" : "text-foreground"
                }`}
              >
                {u.name || u.email}
              </Link>
              {u.customerProfileId && (
                <span
                  className="inline-flex items-center gap-0.5 rounded-full bg-[#f6f2ed] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[#8a857f]"
                  title="Compte client — fiche 360"
                >
                  <UserRound className="h-2.5 w-2.5" /> Client
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">{u.email}</p>
          </div>
        );
      },
    },
    {
      accessorKey: "accountType",
      header: "Type",
      cell: ({ row }) => (
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${
            TYPE_BADGE[row.original.accountType]
          }`}
          title="Type déduit des rôles d'accès"
        >
          {ACCOUNT_TYPE_LABEL[row.original.accountType]}
        </span>
      ),
    },
    {
      accessorKey: "emailVerified",
      header: "Email",
      cell: ({ row }) => (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${
            row.original.emailVerified
              ? "border border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]"
              : "bg-[#f6f2ed] text-[#5b5d62]"
          }`}
        >
          {row.original.emailVerified ? "Vérifié" : "Non vérifié"}
        </span>
      ),
    },
    {
      accessorKey: "disabled",
      header: "Statut",
      cell: ({ row }) =>
        row.original.disabled ? (
          <span className="inline-flex items-center rounded-full bg-[#fdecef] px-2.5 py-1 text-[11px] font-bold text-[#d40530]">
            Désactivé
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full border border-[#cdebd6] bg-[#eaf7ee] px-2.5 py-1 text-[11px] font-bold text-[#15803d]">
            Actif
          </span>
        ),
    },
    {
      accessorKey: "createdAt",
      header: "Inscrit le",
      cell: ({ row }) => (
        <span className="text-[12px] text-muted-foreground">
          {new Date(row.original.createdAt).toLocaleDateString("fr-FR")}
        </span>
      ),
    },
  ];

  const table = useReactTable({
    data: initialItems,
    columns,
    getCoreRowModel: getCoreRowModel(),
    // Key rows by USER id (not list index) so a row's action feedback stays with
    // that user across the router.refresh() that follows each action — a row
    // leaving the filtered list must not hand its message to the next user.
    getRowId: (r) => r.id,
  });

  return (
    <div className="space-y-4">
      <AdminToolbar>
        <div className="flex min-w-[220px] flex-1 items-center gap-2">
          <AdminSearch
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitSearch();
            }}
            placeholder="Rechercher email ou nom…"
            aria-label="Rechercher un utilisateur"
            className="flex-1"
          />
          {search && (
            <button
              type="button"
              onClick={clearSearch}
              aria-label="Effacer la recherche"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={submitSearch}
            disabled={navPending}
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
          >
            {navPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Filtrer
          </button>
        </div>

        <SegmentedFilter
          ariaLabel="Filtrer par statut"
          value={currentStatus}
          onChange={setStatusFilter}
          options={STATUS_OPTIONS}
        />
      </AdminToolbar>

      <div className="overflow-x-auto rounded-[22px] border border-border bg-card">
        <table className="w-full text-sm" aria-label="Liste des utilisateurs">
          <thead className="border-b border-border bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th key={h.id} className="px-4 py-3 font-bold">
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
                <th className="px-4 py-3 font-bold text-right">Actions</th>
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-border">
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td className="px-4 py-12 text-center text-[14px] text-muted-foreground" colSpan={6}>
                  {currentSearch
                    ? `Aucun résultat pour « ${currentSearch} ».`
                    : "Aucun utilisateur."}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="transition hover:bg-[#fffbfb]">
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-3 align-middle">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                  <td className="px-4 py-3 align-middle text-right">
                    <RowActions row={row.original} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {nextCursor && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={navPending}
            className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-5 text-[14px] font-bold text-foreground transition hover:bg-surface disabled:opacity-60"
          >
            {navPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Charger plus
          </button>
        </div>
      )}
    </div>
  );
}

type Feedback = { kind: "ok" | "err"; msg: string };

/**
 * Right-aligned row actions: disable/enable + force-logout + password reset +
 * email-verify toggle. Role assignment (which determines the derived account
 * TYPE) lives on the account's detail page (« Rôles d'accès »), not inline here.
 * Disable + force-logout are gated behind the shared confirm modal —
 * irreversible-feeling actions deserve a click pause. A success message stays
 * visible after the modal closes (refresh only — clearing it in the same tick
 * hid every one).
 */
function RowActions({ row }: { row: Row }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmForceLogout, setConfirmForceLogout] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmVerify, setConfirmVerify] = useState(false);

  return (
    <div className="flex flex-col items-end gap-2">
      {feedback && (
        <span
          className={`text-[11px] ${
            feedback.kind === "ok" ? "text-primary" : "text-destructive"
          }`}
        >
          {feedback.msg}
        </span>
      )}
      <div className="flex items-center gap-2" role="group" aria-label="Actions du compte">
        {row.disabled ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              startTransition(async () => {
                const res = await enableUserAction(row.id);
                setFeedback(
                  res.ok
                    ? { kind: "ok", msg: res.message ?? "OK" }
                    : { kind: "err", msg: res.message },
                );
                if (res.ok) router.refresh();
              });
            }}
            className="grid h-9 w-9 place-items-center rounded-[11px] bg-surface text-[#15803d] transition hover:bg-[#eaf7ee] disabled:opacity-50"
            aria-label="Réactiver"
            title="Réactiver"
          >
            <ShieldCheck className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirmDisable(true)}
            className="grid h-9 w-9 place-items-center rounded-[11px] bg-surface text-muted-foreground transition hover:bg-[#fdecef] hover:text-[#d40530] disabled:opacity-50"
            aria-label="Désactiver"
            title="Désactiver"
          >
            <ShieldOff className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirmForceLogout(true)}
          className="grid h-9 w-9 place-items-center rounded-[11px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:opacity-50"
          aria-label="Forcer la déconnexion"
          title="Forcer la déconnexion"
        >
          <LogOut className="h-4 w-4" />
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirmReset(true)}
          className="grid h-9 w-9 place-items-center rounded-[11px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:opacity-50"
          aria-label="Envoyer un lien de réinitialisation"
          title="Envoyer un lien de réinitialisation"
        >
          <KeyRound className="h-4 w-4" />
        </button>
        <SetPasswordButton userId={row.id} name={row.name} email={row.email} />
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirmVerify(true)}
          className={`grid h-9 w-9 place-items-center rounded-[11px] bg-surface transition disabled:opacity-50 ${
            row.emailVerified
              ? "text-primary hover:bg-[var(--accent)]"
              : "text-muted-foreground hover:bg-secondary hover:text-foreground"
          }`}
          aria-label={
            row.emailVerified ? "Marquer email non vérifié" : "Marquer email vérifié"
          }
          title={row.emailVerified ? "Email vérifié — basculer" : "Marquer email vérifié"}
        >
          <MailCheck className="h-4 w-4" />
        </button>
      </div>

      {confirmDisable && (
        <ConfirmDeleteModal
          title="Désactiver ce compte ?"
          description="Toutes ses sessions actives seront révoquées et son abonnement marketing (newsletter) annulé. Le compte peut être réactivé ; l'abonnement, lui, n'est pas rétabli."
          confirmLabel="Désactiver"
          preview={
            <div className="rounded-[14px] border border-border bg-[#fbf9f8] p-2 text-xs">
              <p className="font-medium">{row.name}</p>
              <p className="text-[11px] text-muted-foreground">{row.email}</p>
            </div>
          }
          onCancel={() => setConfirmDisable(false)}
          onConfirm={async () => {
            const res = await disableUserAction(row.id);
            if (res.ok) {
              setFeedback({ kind: "ok", msg: res.message ?? "OK" });
              router.refresh();
              return null;
            }
            return res.message ?? "Erreur";
          }}
        />
      )}

      {confirmForceLogout && (
        <ConfirmDeleteModal
          title="Forcer la déconnexion ?"
          description="Toutes les sessions actives de cet utilisateur seront révoquées."
          confirmLabel="Forcer"
          preview={
            <div className="rounded-[14px] border border-border bg-[#fbf9f8] p-2 text-xs">
              <p className="font-medium">{row.name}</p>
              <p className="text-[11px] text-muted-foreground">{row.email}</p>
            </div>
          }
          onCancel={() => setConfirmForceLogout(false)}
          onConfirm={async () => {
            const res = await forceLogoutUserAction(row.id);
            if (res.ok) {
              setFeedback({ kind: "ok", msg: res.message ?? "OK" });
              router.refresh();
              return null;
            }
            return res.message ?? "Erreur";
          }}
        />
      )}

      {confirmReset && (
        <ConfirmDeleteModal
          variant="neutral"
          icon={KeyRound}
          title="Envoyer un lien de réinitialisation ?"
          description="L'utilisateur recevra un email avec un lien temporaire pour choisir un nouveau mot de passe."
          confirmLabel="Envoyer"
          preview={
            <div className="rounded-[14px] border border-border bg-[#fbf9f8] p-2 text-xs">
              <p className="font-medium">{row.name}</p>
              <p className="text-[11px] text-muted-foreground">{row.email}</p>
            </div>
          }
          onCancel={() => setConfirmReset(false)}
          onConfirm={async () => {
            const res = await triggerPasswordResetAction(row.id);
            if (res.ok) {
              setFeedback({ kind: "ok", msg: res.message ?? "OK" });
              router.refresh();
              return null;
            }
            return res.message ?? "Erreur";
          }}
        />
      )}

      {confirmVerify && (
        <ConfirmDeleteModal
          variant="neutral"
          icon={MailCheck}
          title={
            row.emailVerified
              ? "Marquer l'email comme non vérifié ?"
              : "Marquer l'email comme vérifié ?"
          }
          description={
            row.emailVerified
              ? "L'adresse sera de nouveau considérée comme non vérifiée."
              : "L'adresse sera considérée comme vérifiée sans envoi d'email de confirmation."
          }
          confirmLabel={row.emailVerified ? "Marquer non vérifié" : "Marquer vérifié"}
          preview={
            <div className="rounded-[14px] border border-border bg-[#fbf9f8] p-2 text-xs">
              <p className="font-medium">{row.name}</p>
              <p className="text-[11px] text-muted-foreground">{row.email}</p>
            </div>
          }
          onCancel={() => setConfirmVerify(false)}
          onConfirm={async () => {
            const res = await toggleEmailVerifiedAction(row.id);
            if (res.ok) {
              setFeedback({ kind: "ok", msg: res.message ?? "OK" });
              router.refresh();
              return null;
            }
            return res.message ?? "Erreur";
          }}
        />
      )}
    </div>
  );
}

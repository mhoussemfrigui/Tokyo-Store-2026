"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { KeyRound, LogOut, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";

import {
  disableUserAction,
  enableUserAction,
  forceLogoutUserAction,
  triggerPasswordResetAction,
} from "@/lib/actions/auth";
import { deleteCustomerAction } from "@/lib/actions/admin";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";

/**
 * "Compte & accès" controls on the customer detail page — kick (force
 * logout), ban/unban (disable/enable) and password-reset link, reusing the
 * exact admin actions + confirm-modal patterns of the users table
 * (`users-table.tsx`). Rendered only when a linked auth user exists.
 */
export function AccountControls({
  userId,
  email,
  name,
  disabled,
}: {
  userId: string;
  email: string;
  name: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null,
  );
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmForceLogout, setConfirmForceLogout] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const preview = (
    <div className="rounded-[14px] border border-border bg-surface/40 p-2 text-xs">
      <p className="font-medium">{name}</p>
      <p className="text-[11px] text-muted-foreground">{email}</p>
    </div>
  );

  const done = (msg: string) => {
    setFeedback({ kind: "ok", msg });
    router.refresh();
  };

  return (
    <div className="space-y-2">
      {feedback && (
        <p
          className={`text-[11px] ${
            feedback.kind === "ok" ? "text-primary" : "text-destructive"
          }`}
        >
          {feedback.msg}
        </p>
      )}

      <button
        type="button"
        disabled={pending}
        onClick={() => setConfirmForceLogout(true)}
        className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-full border-[1.5px] border-input bg-card text-xs font-bold text-foreground transition hover:bg-surface disabled:opacity-50"
      >
        <LogOut className="h-3.5 w-3.5" /> Forcer la déconnexion
      </button>

      {disabled ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setFeedback(null);
            startTransition(async () => {
              const res = await enableUserAction(userId);
              if (res.ok) done(res.message ?? "Compte réactivé.");
              else setFeedback({ kind: "err", msg: res.message });
            });
          }}
          className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-full border-[1.5px] border-input bg-card text-xs font-bold text-[#15803d] transition hover:bg-[#eaf7ee] disabled:opacity-50"
        >
          <ShieldCheck className="h-3.5 w-3.5" /> Réactiver
        </button>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirmDisable(true)}
          className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-full border-[1.5px] border-input bg-card text-xs font-bold text-muted-foreground transition hover:bg-[var(--accent)] hover:text-destructive disabled:opacity-50"
        >
          <ShieldOff className="h-3.5 w-3.5" /> Désactiver le compte
        </button>
      )}

      <button
        type="button"
        disabled={pending}
        onClick={() => setConfirmReset(true)}
        className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-full border-[1.5px] border-input bg-card text-xs font-bold text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:opacity-50"
      >
        <KeyRound className="h-3.5 w-3.5" /> Envoyer un lien de réinitialisation
      </button>

      {confirmDisable && (
        <ConfirmDeleteModal
          title="Désactiver ce compte ?"
          description="Toutes ses sessions actives seront révoquées et son abonnement marketing (newsletter) annulé. Le compte peut être réactivé ; l'abonnement, lui, n'est pas rétabli."
          confirmLabel="Désactiver"
          preview={preview}
          onCancel={() => setConfirmDisable(false)}
          onConfirm={async () => {
            const res = await disableUserAction(userId);
            if (res.ok) {
              done(res.message ?? "Compte désactivé.");
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
          preview={preview}
          onCancel={() => setConfirmForceLogout(false)}
          onConfirm={async () => {
            const res = await forceLogoutUserAction(userId);
            if (res.ok) {
              done(res.message ?? "Sessions révoquées.");
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
          preview={preview}
          onCancel={() => setConfirmReset(false)}
          onConfirm={async () => {
            const res = await triggerPasswordResetAction(userId);
            if (res.ok) {
              done(res.message ?? "Lien envoyé.");
              return null;
            }
            return res.message ?? "Erreur";
          }}
        />
      )}
    </div>
  );
}

/** DERIVED account type of the login linked to a customer profile (null = no account). */
export type LinkedAccountRole = "customer" | "staff" | "admin" | null;

/**
 * What « Supprimer le client » does, worded for the LINKED account's derived
 * type — mirrors the delete-customer workflow: only a plain-customer login (no
 * RBAC role grant) is disabled (sessions + API keys revoked); a staff/admin
 * login (any role grant) stays active and is managed from Utilisateurs. Consent
 * + public favourites are withdrawn for any linked account.
 */
function deleteCustomerConsequences(accountRole: LinkedAccountRole): string {
  const archived = "Le profil client est archivé (commandes conservées) ainsi que ses adresses.";
  if (accountRole === "customer") {
    return `${archived} Son compte de connexion est désactivé : sessions et clés API révoquées. Son abonnement marketing (newsletter) est annulé et sa page de favoris publique est masquée.`;
  }
  if (accountRole === "staff" || accountRole === "admin") {
    return `${archived} Le compte de connexion lié est un compte équipe (${accountRole === "admin" ? "administrateur" : "staff"}) : il reste actif — gérez-le depuis Utilisateurs. Son abonnement marketing (newsletter) est annulé et sa page de favoris publique est masquée.`;
  }
  return `${archived} Aucun compte de connexion n'est lié à ce client.`;
}

/**
 * « Zone dangereuse » of the customer detail page — the consequence copy
 * (by linked-account role) + the delete button. The page renders it only when
 * the actor holds customers:delete (the action's gate), like the other controls.
 */
export function CustomerDangerZone({
  customerProfileId,
  customerName,
  accountRole,
}: {
  customerProfileId: string;
  customerName: string;
  accountRole: LinkedAccountRole;
}) {
  return (
    <section className="rounded-[28px] border border-destructive/30 bg-card p-5">
      <h2 className="text-[18px] font-black text-destructive">Zone dangereuse</h2>
      <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
        {deleteCustomerConsequences(accountRole)}
      </p>
      <div className="mt-4">
        <DeleteCustomerButton
          customerProfileId={customerProfileId}
          customerName={customerName}
          accountRole={accountRole}
        />
      </div>
    </section>
  );
}

/**
 * Destructive "Supprimer le client" — archives the profile via
 * `deleteCustomerAction` then navigates back to the customers list.
 */
function DeleteCustomerButton({
  customerProfileId,
  customerName,
  accountRole,
}: {
  customerProfileId: string;
  customerName: string;
  /** Linked login's role, for accurate modal copy. */
  accountRole: LinkedAccountRole;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="inline-flex h-11 items-center gap-2 rounded-full bg-destructive px-5 text-[14px] font-extrabold text-destructive-foreground transition hover:brightness-110"
      >
        <Trash2 className="h-4 w-4" /> Supprimer le client
      </button>

      {confirming && (
        <ConfirmDeleteModal
          title="Supprimer ce client ?"
          description={deleteCustomerConsequences(accountRole)}
          confirmLabel="Supprimer"
          preview={
            <div className="rounded-[14px] border border-border bg-surface/40 p-2 text-xs">
              <p className="font-medium">{customerName}</p>
            </div>
          }
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            const res = await deleteCustomerAction(customerProfileId);
            if (res.ok) {
              router.push("/admin/customers");
              return null;
            }
            return res.message ?? "Erreur";
          }}
        />
      )}
    </>
  );
}

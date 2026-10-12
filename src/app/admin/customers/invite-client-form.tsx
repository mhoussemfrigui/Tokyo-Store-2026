"use client";

import { useActionState, useState, type ReactNode } from "react";
import { Send, UserPlus, X } from "lucide-react";

import { AdminPageHeader } from "@/components/admin/page-header";
import { inviteUserAction } from "@/lib/actions/admin";
import { InviteField } from "@/app/admin/users/invite-user-form";
import { type ActionState } from "@/lib/actions/types";

/**
 * Clients page header — the shared AdminPageHeader card (the page description on
 * the left) with "Inviter un client" as its right-aligned action, and the
 * toggled invite form expanding full-width in a card below it (so nothing floats
 * loose on the canvas).
 *
 * Same invite flow as the users panel but the role is fixed to "customer" (no
 * role select) and an optional phone is collected so guest orders placed with it
 * are claimed at invite time.
 */
export function InviteClientForm({
  title,
  description,
  canInvite = true,
}: {
  title: string;
  description?: ReactNode;
  /** Whether the actor holds `users:create`. When false the invite control is
   *  hidden (the header still shows its description) so it can't 404 on submit. */
  canInvite?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    inviteUserAction,
    null,
  );

  const err = (key: string) => (state && !state.ok ? state.fieldErrors?.[key] : undefined);

  return (
    <div className="space-y-4">
      <AdminPageHeader
        title={title}
        description={description}
        action={
          canInvite ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
            >
              {open ? (
                <>
                  <X className="h-4 w-4" /> Fermer
                </>
              ) : (
                <>
                  <UserPlus className="h-4 w-4" /> Inviter un client
                </>
              )}
            </button>
          ) : undefined
        }
      />

      {canInvite && open && (
        <div className="rounded-[28px] border border-border bg-card p-5">
          <h2 className="text-[18px] font-black text-foreground">
            Inviter un client
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Le compte client est créé immédiatement — la personne reçoit un
            email pour choisir son mot de passe et l&apos;activer.
          </p>

          {state?.ok && (
            <div
              role="status"
              className="mt-3 rounded-[14px] border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-primary"
            >
              {state.message}
            </div>
          )}
          {state && !state.ok && !state.fieldErrors && (
            <div
              role="alert"
              className="mt-3 rounded-[14px] border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
            >
              {state.message}
            </div>
          )}

          <form action={formAction} className="mt-4 grid gap-4 sm:grid-cols-2">
            <InviteField
              className="sm:col-span-2"
              label="Email"
              name="email"
              type="email"
              placeholder="client@exemple.com"
              required
              error={err("email")}
            />
            <InviteField
              label="Prénom"
              name="firstName"
              type="text"
              placeholder="Yanis"
              required
              error={err("firstName")}
            />
            <InviteField
              label="Nom"
              name="lastName"
              type="text"
              placeholder="Benali"
              required
              error={err("lastName")}
            />
            <InviteField
              className="sm:col-span-2"
              label="Téléphone (optionnel)"
              name="phone"
              type="tel"
              placeholder="+216 XX XXX XXX"
              error={err("phone")}
              hint="Le rattachement des commandes passées en tant qu'invité (et leur comptabilisation dans la dépense du client) se fait par l'adresse email, pas par le téléphone."
            />
            <div className="flex items-end sm:col-span-2">
              <button
                type="submit"
                disabled={isPending}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
              >
                <Send className="h-4 w-4" />
                {isPending ? "Envoi…" : "Envoyer l'invitation"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

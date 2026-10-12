"use client";

import { useActionState, useState } from "react";
import { Check, Send, UserPlus, X } from "lucide-react";

import { inviteUserAction } from "@/lib/actions/admin";
import { type ActionState } from "@/lib/actions/types";

type RoleOption = { id: string; name: string };

/**
 * "Inviter un utilisateur" — header button + inline card form for the users
 * panel. The account is created immediately; the invitee receives an email
 * with a link to choose their password (see workflows/auth/invite-user.ts).
 *
 * Attaching one or more RBAC roles makes the invitee an internal (staff) account;
 * with none it is a plain customer. The account TYPE is derived from the granted
 * permissions — there is no separate role field.
 *
 * Rendered as a fragment inside the page header's `flex-wrap` row: the
 * button sits next to the title, and the card (w-full) wraps onto its own
 * full-width line below — same toggle pattern as the banners panel.
 */
export function InviteUserForm({ roles }: { roles: RoleOption[] }) {
  const [open, setOpen] = useState(false);
  const [roleIds, setRoleIds] = useState<Set<string>>(new Set());
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    inviteUserAction,
    null,
  );

  const err = (key: string) => (state && !state.ok ? state.fieldErrors?.[key] : undefined);

  const toggleRole = (id: string) =>
    setRoleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a]"
      >
        {open ? (
          <>
            <X className="h-4 w-4" /> Fermer
          </>
        ) : (
          <>
            <UserPlus className="h-4 w-4" /> Inviter un utilisateur
          </>
        )}
      </button>

      {open && (
        <div className="w-full rounded-[28px] border border-border bg-card p-5">
          <h2 className="text-[18px] font-black text-foreground">
            Inviter un utilisateur
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Le compte est créé immédiatement — la personne reçoit un email pour
            choisir son mot de passe et l&apos;activer. (Pour fixer le mot de
            passe vous-même sans email, utilisez « Créer un utilisateur ».)
          </p>

          {state?.ok && (
            <div
              role="status"
              className="mt-3 rounded-[14px] border border-primary/30 bg-primary/5 px-4 py-3 text-[14px] text-primary"
            >
              {state.message}
            </div>
          )}
          {state && !state.ok && !state.fieldErrors && (
            <div
              role="alert"
              className="mt-3 rounded-[14px] border border-destructive/30 bg-destructive/5 px-4 py-3 text-[14px] text-destructive"
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
              placeholder="personne@exemple.com"
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
              label="Téléphone"
              name="phone"
              type="tel"
              placeholder="+216 12 345 678"
              hint="Optionnel — enregistré sur le profil client (les commandes invité passées avec cet email sont rattachées automatiquement)."
              error={err("phone")}
            />
            {roles.length > 0 && (
              <div className="sm:col-span-2">
                <p className="mb-2 text-[13px] font-bold text-foreground">
                  Rôles d&apos;accès (optionnel)
                </p>
                <p className="mb-2 text-[12px] leading-relaxed text-muted-foreground">
                  Attribuer au moins un rôle crée un compte interne (staff). Sans rôle, c&apos;est un compte client.
                </p>
                <div className="flex flex-wrap gap-2">
                  {roles.map((r) => {
                    const on = roleIds.has(r.id);
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => toggleRole(r.id)}
                        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] transition ${
                          on
                            ? "bg-primary font-extrabold text-primary-foreground"
                            : "border-[1.5px] border-input bg-card font-semibold text-muted-foreground hover:bg-surface"
                        }`}
                      >
                        {on && <Check className="h-3 w-3" />} {r.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {/* Submit the selected RBAC roles as repeated `roleIds` fields. */}
            {Array.from(roleIds).map((id) => (
              <input key={id} type="hidden" name="roleIds" value={id} />
            ))}
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
    </>
  );
}

/** Labeled admin input — matches the panel's rounded field styling. */
export function InviteField({
  label,
  name,
  type,
  placeholder,
  required,
  error,
  hint,
  className,
}: {
  label: string;
  name: string;
  type: string;
  placeholder?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  className?: string;
}) {
  const id = `invite-${name}`;
  return (
    <div className={className}>
      <label
        htmlFor={id}
        className="mb-2 block text-[13px] font-bold text-foreground"
      >
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        placeholder={placeholder}
        required={required}
        className={`h-11 w-full rounded-[14px] border-[1.5px] bg-[#fbf9f8] px-4 text-[15px] text-foreground placeholder:text-muted-foreground transition-colors focus:bg-white focus:outline-none ${
          error
            ? "border-destructive/60"
            : "border-input focus:border-foreground"
        }`}
      />
      {error ? (
        <p className="mt-2 text-[11px] leading-relaxed text-destructive">{error}</p>
      ) : hint ? (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

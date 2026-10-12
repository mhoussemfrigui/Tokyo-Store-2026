"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, X, Check } from "lucide-react";

import { createUserAction } from "@/lib/actions/rbac";

type RoleOption = { id: string; name: string };

/**
 * "Créer un utilisateur" — admin creates an account directly with a chosen
 * password (no invite email). Differs from « Inviter »: the password is set
 * here and the account is usable immediately. Attaching one or more RBAC roles
 * turns the account into an internal (staff) one — the account TYPE is derived
 * from the granted permissions, there is no separate role field.
 */
export function CreateUserForm({ roles }: { roles: RoleOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [roleIds, setRoleIds] = useState<Set<string>>(new Set());

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const toggleRole = (id: string) =>
    setRoleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = () => {
    setError(null);
    setFieldErrors({});
    setSuccess(null);
    startTransition(async () => {
      const res = await createUserAction({
        email,
        firstName,
        lastName,
        password,
        phone: phone || undefined,
        roleIds: Array.from(roleIds),
      });
      if (res.ok) {
        setSuccess(res.message ?? "Compte créé.");
        setEmail("");
        setFirstName("");
        setLastName("");
        setPassword("");
        setPhone("");
        setRoleIds(new Set());
        router.refresh();
      } else {
        setError(res.fieldErrors ? null : res.message);
        setFieldErrors(res.fieldErrors ?? {});
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground transition hover:bg-surface"
      >
        {open ? (
          <>
            <X className="h-4 w-4" /> Fermer
          </>
        ) : (
          <>
            <UserPlus className="h-4 w-4" /> Créer un utilisateur
          </>
        )}
      </button>

      {open && (
        <div className="w-full rounded-[28px] border border-border bg-card p-5">
          <h2 className="text-[18px] font-black text-foreground">
            Créer un utilisateur
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Le compte est créé avec le mot de passe choisi et activé
            immédiatement — aucun email n&apos;est envoyé.
          </p>

          {success && (
            <div role="status" className="mt-3 rounded-[14px] border border-primary/30 bg-primary/5 px-4 py-3 text-[14px] text-primary">
              {success}
            </div>
          )}
          {error && (
            <div role="alert" className="mt-3 rounded-[14px] border border-destructive/30 bg-destructive/5 px-4 py-3 text-[14px] text-destructive">
              {error}
            </div>
          )}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <ControlledField label="Email" value={email} onChange={setEmail} type="email" placeholder="personne@exemple.com" required error={fieldErrors.email} className="sm:col-span-2" />
            <ControlledField label="Prénom" value={firstName} onChange={setFirstName} placeholder="Yanis" required error={fieldErrors.firstName} />
            <ControlledField label="Nom" value={lastName} onChange={setLastName} placeholder="Benali" required error={fieldErrors.lastName} />
            <ControlledField label="Mot de passe" value={password} onChange={setPassword} type="password" placeholder="12 caractères minimum" required error={fieldErrors.password} />
            <ControlledField label="Téléphone (optionnel)" value={phone} onChange={setPhone} placeholder="+216 …" className="sm:col-span-2" />

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

            <div className="flex items-end sm:col-span-2">
              <button
                type="button"
                disabled={pending}
                onClick={submit}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
              >
                <UserPlus className="h-4 w-4" />
                {pending ? "Création…" : "Créer le compte"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Controlled twin of InviteField (the same styling, but value-bound). */
function ControlledField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  required,
  error,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  error?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="mb-2 block text-[13px] font-bold text-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        placeholder={placeholder}
        autoComplete={type === "password" ? "new-password" : "off"}
        className={`h-11 w-full rounded-[14px] border-[1.5px] bg-[#fbf9f8] px-4 text-[15px] text-foreground placeholder:text-muted-foreground transition-colors focus:bg-white focus:outline-none ${
          error
            ? "border-destructive/60"
            : "border-input focus:border-foreground"
        }`}
      />
      {error && <p className="mt-2 text-[11px] leading-relaxed text-destructive">{error}</p>}
    </div>
  );
}

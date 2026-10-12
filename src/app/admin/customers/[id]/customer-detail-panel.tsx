"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Save, Star } from "lucide-react";

import {
  setDefaultAddressAction,
  updateCustomerNotesAction,
  updateCustomerProfileAction,
} from "@/lib/actions/admin";
import { type ActionState } from "@/lib/actions/types";
import { SelectField } from "@/components/ui/select-field";
import { DateField, todayYmd } from "@/components/ui/date-field";

/**
 * Inline editable phone for the customer's Profil card. The phone powers
 * guest↔client matching, so editing it here re-derives phone_normalized
 * server-side (customerService) — the change is immediately searchable.
 */
export function ProfilePhoneEditor({
  profileId,
  initialPhone,
  canEdit = true,
}: {
  profileId: string;
  initialPhone: string | null;
  /** When false (customers:view without :update), render the value read-only —
   *  the server action would refuse the write, so we don't offer the affordance. */
  canEdit?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <div className="mt-0.5 flex items-center gap-2">
        <span>{initialPhone ?? "—"}</span>
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setPhone(initialPhone ?? "");
              setError(null);
              setEditing(true);
            }}
            className="inline-flex items-center gap-1 text-[10px] font-semibold text-primary hover:underline"
          >
            <Pencil className="h-3 w-3" /> Modifier
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-0.5 space-y-2">
      <input
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="Téléphone"
        className="h-10 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[13px] focus:outline-none focus:border-foreground focus:bg-white"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const res = await updateCustomerProfileAction({
                profileId,
                phone: phone.trim() || null,
              });
              if (res.ok) {
                setEditing(false);
                router.refresh();
              } else {
                setError(res.message);
              }
            });
          }}
          className="inline-flex h-8 items-center gap-1 rounded-full bg-primary px-3 text-[11px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          Enregistrer
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="inline-flex h-8 items-center rounded-full border-[1.5px] border-input bg-card px-3 text-[11px] font-bold text-foreground hover:bg-surface"
        >
          Annuler
        </button>
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

/** Format a stored 'YYYY-MM-DD' birthday for display, parsed as LOCAL midnight
 *  so the calendar date never shifts a day under a negative UTC offset. */
function formatBirthday(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("fr-FR", { dateStyle: "long" });
}

/**
 * Inline editable birthday for the customer's Profil card. Mirrors
 * ProfilePhoneEditor. The birthday drives the `birthday_month` dynamic-segment
 * rule (birthday-month promotion targeting). Clearing the field unsets it.
 */
export function ProfileBirthdayEditor({
  profileId,
  initialBirthday,
  canEdit = true,
}: {
  profileId: string;
  initialBirthday: string | null;
  canEdit?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [birthday, setBirthday] = useState(initialBirthday ?? "");
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <div className="mt-0.5 flex items-center gap-2">
        <span>{initialBirthday ? formatBirthday(initialBirthday) : "—"}</span>
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setBirthday(initialBirthday ?? "");
              setError(null);
              setEditing(true);
            }}
            className="inline-flex items-center gap-1 text-[10px] font-semibold text-primary hover:underline"
          >
            <Pencil className="h-3 w-3" /> Modifier
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-0.5 space-y-2">
      <DateField
        ariaLabel="Date de naissance"
        value={birthday}
        max={todayYmd()}
        onChange={setBirthday}
        triggerClassName="flex h-10 w-full items-center gap-2 rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-left text-[13px] text-foreground transition focus:outline-none focus-visible:border-foreground focus-visible:bg-white"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const res = await updateCustomerProfileAction({
                profileId,
                birthday: birthday.trim() || null,
              });
              if (res.ok) {
                setEditing(false);
                router.refresh();
              } else {
                setError(res.message);
              }
            });
          }}
          className="inline-flex h-8 items-center gap-1 rounded-full bg-primary px-3 text-[11px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          Enregistrer
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="inline-flex h-8 items-center rounded-full border-[1.5px] border-input bg-card px-3 text-[11px] font-bold text-foreground hover:bg-surface"
        >
          Annuler
        </button>
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

const GENDER_ADMIN_LABELS: Record<string, string> = { female: "Femme", male: "Homme", other: "Autre" };

/**
 * Inline editable gender for the customer's Profil card. Mirrors ProfileBirthdayEditor.
 * Drives the `gender` dynamic-segment rule; an ADMIN write never earns the customer the
 * `provide_gender` reward (the grant is owner-actor gated). Clearing unsets it.
 */
export function ProfileGenderEditor({
  profileId,
  initialGender,
  canEdit = true,
}: {
  profileId: string;
  initialGender: string | null;
  canEdit?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [gender, setGender] = useState(initialGender ?? "");
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <div className="mt-0.5 flex items-center gap-2">
        <span>{initialGender ? (GENDER_ADMIN_LABELS[initialGender] ?? initialGender) : "—"}</span>
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setGender(initialGender ?? "");
              setError(null);
              setEditing(true);
            }}
            className="inline-flex items-center gap-1 text-[10px] font-semibold text-primary hover:underline"
          >
            <Pencil className="h-3 w-3" /> Modifier
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-0.5 space-y-2">
      <SelectField
        ariaLabel="Genre"
        size="sm"
        value={gender}
        onChange={setGender}
        options={[
          { value: "", label: "Non renseigné" },
          { value: "female", label: "Femme" },
          { value: "male", label: "Homme" },
          { value: "other", label: "Autre" },
        ]}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const res = await updateCustomerProfileAction({
                profileId,
                gender: (gender || null) as "female" | "male" | "other" | null,
              });
              if (res.ok) {
                setEditing(false);
                router.refresh();
              } else {
                setError(res.message);
              }
            });
          }}
          className="inline-flex h-8 items-center gap-1 rounded-full bg-primary px-3 text-[11px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          Enregistrer
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="inline-flex h-8 items-center rounded-full border-[1.5px] border-input bg-card px-3 text-[11px] font-bold text-foreground hover:bg-surface"
        >
          Annuler
        </button>
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

/**
 * Free-form notes the support team writes about a customer. Never surfaced
 * to the customer themselves. Saves through a server action that revalidates
 * the customer detail page. Empty value clears the notes back to null.
 */
export function AdminNotesEditor({
  profileId,
  initialNotes,
}: {
  profileId: string;
  initialNotes: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null,
  );

  return (
    <form
      action={(formData) => {
        const notes = String(formData.get("notes") ?? "");
        setFeedback(null);
        startTransition(async () => {
          const res = await updateCustomerNotesAction({ profileId, notes });
          setFeedback(
            res.ok
              ? { kind: "ok", msg: res.message ?? "OK" }
              : { kind: "err", msg: res.message },
          );
        });
      }}
      className="space-y-2"
    >
      <textarea
        name="notes"
        rows={5}
        defaultValue={initialNotes ?? ""}
        placeholder="Notes internes — invisibles pour le client. Ex.: VIP, problème de paiement, suivi commercial…"
        className="w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] p-3 text-sm focus:outline-none focus:border-foreground focus:bg-white"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          Enregistrer
        </button>
        {feedback && (
          <span
            className={`text-[11px] ${
              feedback.kind === "ok" ? "text-primary" : "text-destructive"
            }`}
          >
            {feedback.msg}
          </span>
        )}
      </div>
    </form>
  );
}

/**
 * Per-address "set as default" buttons. Each button renders only if the
 * address isn't already the default of its kind — for a kind the address
 * already holds, the button is omitted and the parent page shows the static
 * "Livraison"/"Facturation" badge instead.
 */
export function AddressDefaultButtons({
  customerProfileId,
  addressId,
  isDefaultShipping,
  isDefaultBilling,
}: {
  customerProfileId: string;
  addressId: string;
  isDefaultShipping: boolean;
  isDefaultBilling: boolean;
}) {
  const [pendingKind, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {!isDefaultShipping && (
        <button
          type="button"
          disabled={pendingKind}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const res = await setDefaultAddressAction({
                customerProfileId,
                addressId,
                kind: "shipping",
              });
              if (!res.ok) setError(res.message);
            });
          }}
          className="inline-flex h-7 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-2.5 text-[10px] font-bold text-foreground transition hover:bg-surface disabled:opacity-60"
        >
          <Star className="h-3 w-3" /> Définir livraison par défaut
        </button>
      )}
      {!isDefaultBilling && (
        <button
          type="button"
          disabled={pendingKind}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const res = await setDefaultAddressAction({
                customerProfileId,
                addressId,
                kind: "billing",
              });
              if (!res.ok) setError(res.message);
            });
          }}
          className="inline-flex h-7 items-center gap-1 rounded-full border-[1.5px] border-input bg-card px-2.5 text-[10px] font-bold text-foreground transition hover:bg-surface disabled:opacity-60"
        >
          <Star className="h-3 w-3" /> Définir facturation par défaut
        </button>
      )}
      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </div>
  );
}

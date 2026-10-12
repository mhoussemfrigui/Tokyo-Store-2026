"use client";

import { useActionState, useState } from "react";
import { Check, Loader2, Plus, Star, Trash2 } from "lucide-react";

import {
  createCurrencyAction,
  updateCurrencyAction,
  setActiveCurrencyAction,
  deleteCurrencyAction,
} from "@/lib/actions/currency";
import { type ActionState } from "@/lib/actions/types";
import { useNoResetSubmit } from "@/components/admin/_components/form-tabs";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { SelectField } from "@/components/ui/select-field";

type CurrencyView = {
  id: string;
  code: string;
  name: string;
  symbol: string;
  symbolPosition: "before" | "after";
  isActive: boolean;
  displayOrder: number;
};

/** What the viewer may do (`system_currency:*`) — controls they lack are hidden. */
export type CurrencyPerms = {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
};

const inputCls =
  "h-10 w-full rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-sm text-foreground transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]";
const labelCls = "text-[13px] font-bold text-foreground";

function PositionSelect({ defaultValue }: { defaultValue: "before" | "after" }) {
  return (
    <SelectField
      name="symbol_position"
      ariaLabel="Position du symbole"
      defaultValue={defaultValue}
      triggerClassName="h-10"
      options={[
        { value: "after", label: "Après (1 000 TND)" },
        { value: "before", label: "Avant (TND 1 000)" },
      ]}
    />
  );
}

function Feedback({ state, className = "" }: { state: ActionState | null; className?: string }) {
  if (!state?.message) return null;
  return (
    <div
      role={state.ok ? "status" : "alert"}
      className={`rounded-[12px] border p-2.5 text-xs font-semibold ${
        state.ok
          ? "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]"
          : "border-destructive/40 bg-destructive/5 text-destructive"
      } ${className}`}
    >
      {state.message}
    </div>
  );
}

export function CurrencyPanel({
  currencies,
  perms,
}: {
  currencies: CurrencyView[];
  perms: CurrencyPerms;
}) {
  return (
    <div className="space-y-6">
      {/* Existing currencies */}
      <section className="space-y-4">
        {currencies.length === 0 && (
          <p className="rounded-[16px] border border-dashed border-border bg-surface/40 px-5 py-6 text-sm text-muted-foreground">
            Aucune devise. Ajoutez-en une ci-dessous (TND est normalement créée par la migration).
          </p>
        )}
        {currencies.map((c) => (
          <CurrencyCard key={c.id} currency={c} perms={perms} />
        ))}
      </section>

      {/* Add a currency */}
      {perms.canCreate && <AddCurrencyForm />}
    </div>
  );
}

/**
 * One currency row. The edit form runs through useActionState (a duplicate ISO
 * code is SHOWN on the code field, and the typed values are kept); « Définir
 * active » (a store-wide relabel of every price, JSON-LD and new order) and the
 * delete both go through a confirm modal that reports a refusal inline.
 */
function CurrencyCard({ currency: c, perms }: { currency: CurrencyView; perms: CurrencyPerms }) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(
    updateCurrencyAction,
    null,
  );
  const onSubmit = useNoResetSubmit(action, state);
  const [confirming, setConfirming] = useState<"activate" | "delete" | null>(null);
  const [activation, setActivation] = useState<ActionState | null>(null);
  const codeError = state && !state.ok ? state.fieldErrors?.code : undefined;

  const run = async (
    fn: (prev: ActionState | null, fd: FormData) => Promise<ActionState>,
  ): Promise<ActionState> => {
    const fd = new FormData();
    fd.set("currencyId", c.id);
    return fn(null, fd);
  };

  return (
    <div
      className={`rounded-[22px] border bg-card p-4 shadow-soft ${
        c.isActive ? "border-primary/50 ring-1 ring-primary/20" : "border-border"
      }`}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[16px] font-black text-foreground">{c.code}</span>
          {c.isActive && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              <Star className="h-3 w-3 fill-current" /> Active
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!c.isActive && perms.canUpdate && (
            <button
              type="button"
              onClick={() => setConfirming("activate")}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-input px-3 text-xs font-bold text-foreground transition hover:bg-surface"
            >
              <Check className="h-3.5 w-3.5" /> Définir active
            </button>
          )}
          {!c.isActive && perms.canDelete && (
            <button
              type="button"
              onClick={() => setConfirming("delete")}
              aria-label={`Supprimer ${c.code}`}
              className="grid h-9 w-9 place-items-center rounded-full border border-border text-muted-foreground transition hover:border-destructive/40 hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <form action={action} onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <input type="hidden" name="currencyId" value={c.id} />
        <fieldset disabled={!perms.canUpdate} className="contents">
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Code (ISO)</span>
            <input
              name="code"
              defaultValue={c.code}
              maxLength={3}
              required
              aria-invalid={codeError ? true : undefined}
              className={`${inputCls} ${codeError ? "border-destructive" : ""}`}
            />
            {codeError && <span className="text-[11px] font-medium text-destructive">{codeError}</span>}
          </label>
          <label className="flex flex-col gap-1 lg:col-span-2">
            <span className={labelCls}>Nom</span>
            <input name="name" defaultValue={c.name} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Symbole</span>
            <input name="symbol" defaultValue={c.symbol} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Position</span>
            <PositionSelect defaultValue={c.symbolPosition} />
          </label>
          {/* Per-currency "décimales" removed: display precision is governed
              globally by the price.decimals setting (Réglages commande), not per
              currency — the old input set a value nothing read. */}
        </fieldset>
        {perms.canUpdate && (
          <div className="sm:col-span-2 lg:col-span-6">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-foreground px-4 text-xs font-semibold text-background transition hover:bg-foreground/90 disabled:opacity-60"
            >
              {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {pending ? "Enregistrement…" : "Enregistrer"}
            </button>
          </div>
        )}
      </form>
      <Feedback state={state} className="mt-3" />
      <Feedback state={activation} className="mt-3" />

      {confirming === "activate" && (
        <ConfirmDeleteModal
          variant="neutral"
          icon={Star}
          title={`Définir « ${c.code} » comme devise active ?`}
          description="Tous les prix de la boutique, les données structurées (JSON-LD), les flux et les nouvelles commandes seront étiquetés dans cette devise. Les montants ne sont PAS convertis — ré-ajustez vos prix si besoin."
          confirmLabel="Définir active"
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            const res = await run(setActiveCurrencyAction);
            if (!res.ok) return res.message;
            setActivation(res);
            return null;
          }}
        />
      )}
      {confirming === "delete" && (
        <ConfirmDeleteModal
          title={`Supprimer la devise « ${c.code} » ?`}
          description="Elle ne pourra plus être activée. Les commandes passées gardent la devise enregistrée à leur création."
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            const res = await run(deleteCurrencyAction);
            return res.ok ? null : res.message;
          }}
        />
      )}
    </div>
  );
}

function AddCurrencyForm() {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(
    createCurrencyAction,
    null,
  );
  const onSubmit = useNoResetSubmit(action, state);
  const codeError = state && !state.ok ? state.fieldErrors?.code : undefined;
  return (
    <section className="rounded-[22px] border border-border bg-card p-4 shadow-soft">
      <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-foreground">Ajouter une devise</h2>
      <form action={action} onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <label className="flex flex-col gap-1">
          <span className={labelCls}>
            Code (ISO)<span className="ml-0.5 text-destructive">*</span>
          </span>
          <input
            name="code"
            placeholder="EUR"
            maxLength={3}
            required
            aria-invalid={codeError ? true : undefined}
            className={`${inputCls} ${codeError ? "border-destructive" : ""}`}
          />
          {codeError && <span className="text-[11px] font-medium text-destructive">{codeError}</span>}
        </label>
        <label className="flex flex-col gap-1 lg:col-span-2">
          <span className={labelCls}>Nom</span>
          <input name="name" placeholder="Euro" className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Symbole</span>
          <input name="symbol" placeholder="€" className={inputCls} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Position</span>
          <PositionSelect defaultValue="after" />
        </label>
        {/* No per-currency "décimales" — display precision is the global
            price.decimals setting (Réglages commande). */}
        <div className="sm:col-span-2 lg:col-span-6">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-extrabold text-primary-foreground shadow-soft transition hover:bg-[#b8042a] disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Ajouter
          </button>
        </div>
      </form>
      <Feedback state={state} className="mt-3" />
      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        La devise ajoutée n&apos;est pas active tant que vous ne cliquez pas « Définir active ».
        Changer la devise active ré-étiquette les prix — les montants ne sont pas convertis.
      </p>
    </section>
  );
}

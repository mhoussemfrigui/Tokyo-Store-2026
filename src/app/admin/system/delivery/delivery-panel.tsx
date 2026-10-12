"use client";

import { useActionState, useState } from "react";
import { Loader2, Save, Plus, Trash2 } from "lucide-react";

import {
  saveDeliveryMethodsAction,
  createDeliveryAgentAction,
  updateDeliveryAgentAction,
  deleteDeliveryAgentAction,
  createPickupLocationAction,
  updatePickupLocationAction,
  deletePickupLocationAction,
  createDeliveryZoneAction,
  updateDeliveryZoneAction,
  deleteDeliveryZoneAction,
} from "@/lib/actions/delivery";
import { type ActionState } from "@/lib/actions/types";
import { FieldSection, ToggleField } from "@/components/admin/_components/setting-fields";
import { FormTabs, FormTab, useNoResetSubmit } from "@/components/admin/_components/form-tabs";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { SelectField } from "@/components/ui/select-field";

/** What the viewer may do (`system_delivery:*`) — controls they lack are hidden
 *  (or read-only) instead of posting to an action that would refuse them. */
export type DeliveryPerms = {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
};

/** Per-field errors from a refused save, keyed by form input name. */
type FieldErrors = Record<string, string> | undefined;

/** Method-enable toggles (the methods offered storewide) + region pricing +
 *  the global home-delivery base fee / free-shipping threshold (TND strings,
 *  "" when unset → cart falls back to the built-in constants). */
export type MethodsView = {
  homeEnabled: boolean;
  driveByEnabled: boolean;
  inStoreEnabled: boolean;
  zonePricingEnabled: boolean;
  /** Master switch for the global free-shipping threshold offer (default on). */
  freeShippingEnabled: boolean;
  /** Global flat home-delivery fee, TND string ("" = unset → fallback). */
  defaultFeeTnd: string;
  /** Global free-shipping threshold, TND string ("" = unset → fallback). */
  freeThresholdTnd: string;
};

/** A delivery zone + its per-courier rate inputs (TND strings). */
export type ZoneView = {
  id: string;
  name: string;
  governorates: string;
  enabled: boolean;
  displayOrder: number;
  rates: Array<{ agentId: string; agentName: string; feeTnd: string; thresholdTnd: string }>;
};

/** One home-delivery agent row, fees pre-converted to TND strings for inputs. */
export type AgentView = {
  id: string;
  name: string;
  /** TND string, or "" when NULL (inherit the global base fee). */
  feeTnd: string;
  /** TND string, or "" when NULL (inherit the global free threshold). */
  freeThresholdTnd: string;
  phone: string;
  zoneLabel: string;
  enabled: boolean;
  displayOrder: number;
};

/** One pickup-location row. */
export type LocationView = {
  id: string;
  name: string;
  kind: "drive_by_pickup" | "in_store";
  /** Flat fee, TND string ("" → 0). */
  feeTnd: string;
  addressLine: string;
  city: string;
  region: string;
  phone: string;
  hoursLabel: string;
  enabled: boolean;
  displayOrder: number;
};

const labelCls =
  "block text-[13px] font-bold text-foreground";
const inputCls =
  "mt-1.5 h-10 w-full rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-sm text-foreground transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]";

function MiniField({
  name,
  label,
  defaultValue,
  placeholder,
  type = "text",
  required = false,
  error,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  type?: string;
  /** Marks the input required so the browser blocks a blank submit + shows a `*`. */
  required?: boolean;
  /** Field error from the last refused save — shown under the input. */
  error?: string;
}) {
  return (
    <label className="block">
      <span className={labelCls}>
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        inputMode={type === "number" ? "decimal" : undefined}
        min={type === "number" ? 0 : undefined}
        step={type === "number" ? "any" : undefined}
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        className={`${inputCls} ${type === "number" ? "tabular-nums" : ""} ${error ? "border-destructive" : ""}`}
      />
      <FieldErrorText error={error} />
    </label>
  );
}

function FieldErrorText({ error }: { error?: string }) {
  if (!error) return null;
  return <span className="mt-1 block text-[11px] font-medium text-destructive">{error}</span>;
}

/** Inline result banner for the row cards + add-forms (mirrors the methods tab's banner). */
function RowFeedback({ state }: { state: ActionState | null }) {
  if (!state?.message) return null;
  return (
    <div
      role={state.ok ? "status" : "alert"}
      className={`rounded-xl border p-2.5 text-xs ${
        state.ok
          ? "border-primary/40 bg-primary/5 text-primary"
          : "border-destructive/40 bg-destructive/5 text-destructive"
      }`}
    >
      {state.message}
    </div>
  );
}

function EnabledToggle({ defaultChecked }: { defaultChecked: boolean }) {
  return (
    <label className="flex h-10 cursor-pointer items-center gap-2 rounded-[12px] border-[1.5px] border-input bg-card px-3 text-sm has-[:checked]:border-primary/40 has-[:checked]:bg-primary/5">
      <input
        type="checkbox"
        name="enabled"
        defaultChecked={defaultChecked}
        className="h-4 w-4 accent-[var(--primary)]"
      />
      Activé
    </label>
  );
}

type RowAction = (prev: ActionState | null, formData: FormData) => Promise<ActionState>;

/**
 * One editable row card (courier, pickup point or zone). The update runs
 * through useActionState — a refused save (a phone over 40 characters, a
 * negative fee…) shows its message + inline field errors and KEEPS what was
 * typed (useNoResetSubmit) instead of silently snapping back to the old values.
 * The delete goes through the shared confirm modal, which shows a refusal
 * inline. Controls the viewer's role lacks are hidden (inputs read-only
 * without `update`).
 */
function EditableRow({
  idName,
  idValue,
  updateAction,
  deleteAction,
  deleteTitle,
  deleteDescription,
  perms,
  children,
}: {
  idName: string;
  idValue: string;
  updateAction: RowAction;
  deleteAction: RowAction;
  deleteTitle: string;
  deleteDescription: string;
  perms: DeliveryPerms;
  children: (errors: FieldErrors) => React.ReactNode;
}) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(updateAction, null);
  const onSubmit = useNoResetSubmit(action, state);
  const [confirming, setConfirming] = useState(false);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form
      action={action}
      onSubmit={onSubmit}
      className="space-y-3 rounded-[22px] border border-border bg-surface/30 p-4"
    >
      <input type="hidden" name={idName} value={idValue} />
      <fieldset disabled={!perms.canUpdate} className="space-y-3">
        {children(errors)}
      </fieldset>
      <RowFeedback state={state} />
      {(perms.canUpdate || perms.canDelete) && (
        <div className="flex items-center justify-end gap-2">
          {perms.canDelete && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-destructive/30 px-3 text-xs font-bold text-destructive transition hover:bg-[var(--accent)]"
            >
              <Trash2 className="h-3.5 w-3.5" /> Supprimer
            </button>
          )}
          {perms.canUpdate && (
            <button
              type="submit"
              disabled={pending}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {pending ? "Enregistrement…" : "Enregistrer"}
            </button>
          )}
        </div>
      )}
      {confirming && (
        <ConfirmDeleteModal
          title={deleteTitle}
          description={deleteDescription}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            const fd = new FormData();
            fd.set(idName, idValue);
            const res = await deleteAction(null, fd);
            return res.ok ? null : res.message;
          }}
        />
      )}
    </form>
  );
}

/** Shared "add" form shell: useActionState + keep-input-on-error + pending. */
function AddRowForm({
  title,
  submitLabel,
  createAction,
  children,
}: {
  title: string;
  submitLabel: string;
  createAction: RowAction;
  children: (errors: FieldErrors) => React.ReactNode;
}) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(createAction, null);
  const onSubmit = useNoResetSubmit(action, state);
  return (
    <form
      action={action}
      onSubmit={onSubmit}
      className="space-y-3 rounded-[22px] border border-dashed border-primary/40 bg-primary/[0.03] p-4"
    >
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {children(state && !state.ok ? state.fieldErrors : undefined)}
      <RowFeedback state={state} />
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

// ──────────────────────────────────────────────────────────────── agents
function AgentFields({ agent, errors }: { agent?: AgentView; errors?: FieldErrors }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <MiniField
          name="name"
          label="Nom du transporteur"
          defaultValue={agent?.name}
          placeholder="Aramex, First Delivery…"
          required
          error={errors?.name}
        />
        <MiniField name="phone" label="Téléphone" defaultValue={agent?.phone} placeholder="+216 …" error={errors?.phone} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MiniField
          name="fee_tnd"
          label="Frais (TND)"
          type="number"
          defaultValue={agent?.feeTnd}
          placeholder="vide = défaut"
          error={errors?.fee_tnd}
        />
        <MiniField
          name="free_threshold_tnd"
          label="Livraison gratuite dès (TND)"
          type="number"
          defaultValue={agent?.freeThresholdTnd}
          placeholder="vide = défaut"
          error={errors?.free_threshold_tnd}
        />
        <MiniField
          name="zone_label"
          label="Zone"
          defaultValue={agent?.zoneLabel}
          placeholder="Grand Tunis…"
          error={errors?.zone_label}
        />
        <MiniField
          name="display_order"
          label="Ordre d'affichage"
          type="number"
          defaultValue={agent ? String(agent.displayOrder) : "0"}
          error={errors?.display_order}
        />
      </div>
      <div className="flex justify-start">
        <EnabledToggle defaultChecked={agent?.enabled ?? true} />
      </div>
    </>
  );
}

function AgentCard({ agent, perms }: { agent: AgentView; perms: DeliveryPerms }) {
  return (
    <EditableRow
      idName="agentId"
      idValue={agent.id}
      updateAction={updateDeliveryAgentAction}
      deleteAction={deleteDeliveryAgentAction}
      deleteTitle={`Supprimer le transporteur « ${agent.name} » ?`}
      deleteDescription="Il ne sera plus proposé au paiement. Les commandes passées gardent son nom."
      perms={perms}
    >
      {(errors) => <AgentFields agent={agent} errors={errors} />}
    </EditableRow>
  );
}

function AddAgentForm() {
  return (
    <AddRowForm
      title="Ajouter un transporteur"
      submitLabel="Ajouter le transporteur"
      createAction={createDeliveryAgentAction}
    >
      {(errors) => <AgentFields errors={errors} />}
    </AddRowForm>
  );
}

// ──────────────────────────────────────────────────────── pickup locations
const KIND_OPTIONS = [
  { value: "drive_by_pickup", label: "Retrait drive (Drive-by)" },
  { value: "in_store", label: "Retrait en magasin" },
];

function LocationFields({ location, errors }: { location?: LocationView; errors?: FieldErrors }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <MiniField
          name="name"
          label="Nom du point"
          defaultValue={location?.name}
          placeholder="Magasin Lac 2…"
          required
          error={errors?.name}
        />
        <div>
          <span className={labelCls}>Type</span>
          <div className="mt-1.5">
            <SelectField
              name="kind"
              ariaLabel="Type de point de retrait"
              options={KIND_OPTIONS}
              defaultValue={location?.kind ?? "drive_by_pickup"}
              size="sm"
            />
          </div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MiniField
          name="fee_tnd"
          label="Frais (TND)"
          type="number"
          defaultValue={location?.feeTnd}
          placeholder="0 = gratuit"
          error={errors?.fee_tnd}
        />
        <MiniField name="city" label="Ville" defaultValue={location?.city} placeholder="Tunis…" error={errors?.city} />
        <MiniField name="region" label="Région" defaultValue={location?.region} placeholder="Tunis…" error={errors?.region} />
        <MiniField name="phone" label="Téléphone" defaultValue={location?.phone} placeholder="+216 …" error={errors?.phone} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <MiniField
          name="address_line"
          label="Adresse"
          defaultValue={location?.addressLine}
          placeholder="Avenue …"
          error={errors?.address_line}
        />
        <MiniField
          name="hours_label"
          label="Horaires"
          defaultValue={location?.hoursLabel}
          placeholder="Lun–Sam 9h–19h"
          error={errors?.hours_label}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <MiniField
          name="display_order"
          label="Ordre d'affichage"
          type="number"
          defaultValue={location ? String(location.displayOrder) : "0"}
          error={errors?.display_order}
        />
        <EnabledToggle defaultChecked={location?.enabled ?? true} />
      </div>
    </>
  );
}

function LocationCard({ location, perms }: { location: LocationView; perms: DeliveryPerms }) {
  return (
    <EditableRow
      idName="locationId"
      idValue={location.id}
      updateAction={updatePickupLocationAction}
      deleteAction={deletePickupLocationAction}
      deleteTitle={`Supprimer le point « ${location.name} » ?`}
      deleteDescription="Il ne sera plus proposé au paiement. Les commandes passées gardent son adresse."
      perms={perms}
    >
      {(errors) => <LocationFields location={location} errors={errors} />}
    </EditableRow>
  );
}

function AddLocationForm() {
  return (
    <AddRowForm
      title="Ajouter un point de retrait"
      submitLabel="Ajouter le point"
      createAction={createPickupLocationAction}
    >
      {(errors) => <LocationFields errors={errors} />}
    </AddRowForm>
  );
}

// ──────────────────────────────────────────────────────────────── zones
function ZoneFields({
  zone,
  agents,
  errors,
}: {
  zone?: ZoneView;
  agents: AgentView[];
  errors?: FieldErrors;
}) {
  // When creating, there are no rates yet; show the courier list so the operator
  // knows rates can be set after the zone exists (edit). On edit, prefill rates.
  const rateRows = zone?.rates ?? agents.map((a) => ({ agentId: a.id, agentName: a.name, feeTnd: "", thresholdTnd: "" }));
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MiniField
          name="name"
          label="Nom de la zone"
          defaultValue={zone?.name}
          placeholder="Grand Tunis…"
          required
          error={errors?.name}
        />
        <MiniField
          name="display_order"
          label="Ordre"
          type="number"
          defaultValue={zone ? String(zone.displayOrder) : "0"}
          error={errors?.display_order}
        />
        <div className="sm:col-span-2 lg:col-span-2">
          <EnabledToggle defaultChecked={zone?.enabled ?? true} />
        </div>
      </div>
      <MiniField
        name="governorates"
        label="Gouvernorats (séparés par des virgules)"
        defaultValue={zone?.governorates}
        placeholder="Tunis, Ariana, Ben Arous, La Manouba"
        error={errors?.governorates}
      />
      <p className="-mt-1 text-[11px] leading-relaxed text-muted-foreground">
        Utilisez les noms officiels des gouvernorats (ceux du menu déroulant au
        paiement). La casse et les accents sont ignorés, et l&apos;article «&nbsp;La&nbsp;»/«&nbsp;Le&nbsp;»
        est toléré — les noms sont normalisés à l&apos;enregistrement.
      </p>
      {zone && rateRows.length > 0 && (
        <div className="rounded-[16px] border border-border bg-card/60 p-3">
          <p className="mb-2 text-[13px] font-bold text-foreground">
            Tarif par transporteur pour cette zone (TND) — vide = tarif forfaitaire du transporteur
          </p>
          <div className="space-y-2">
            {rateRows.map((r) => {
              const feeError = errors?.[`rate_${r.agentId}_fee`];
              const thresholdError = errors?.[`rate_${r.agentId}_threshold`];
              return (
                <div key={r.agentId}>
                  <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2">
                    <span className="truncate text-xs font-medium text-foreground">{r.agentName}</span>
                    <input
                      name={`rate_${r.agentId}_fee`}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      defaultValue={r.feeTnd}
                      placeholder="frais"
                      aria-label={`Frais ${r.agentName} (TND)`}
                      aria-invalid={feeError ? true : undefined}
                      className={`h-9 w-24 rounded-[10px] border-[1.5px] bg-[#fbf9f8] px-2 text-xs tabular-nums text-foreground transition focus:bg-white focus:outline-none ${feeError ? "border-destructive" : "border-border"}`}
                    />
                    <input
                      name={`rate_${r.agentId}_threshold`}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      defaultValue={r.thresholdTnd}
                      placeholder="gratuit dès"
                      aria-label={`Livraison gratuite dès, ${r.agentName} (TND)`}
                      aria-invalid={thresholdError ? true : undefined}
                      className={`h-9 w-28 rounded-[10px] border-[1.5px] bg-[#fbf9f8] px-2 text-xs tabular-nums text-foreground transition focus:bg-white focus:outline-none ${thresholdError ? "border-destructive" : "border-border"}`}
                    />
                  </div>
                  <FieldErrorText error={feeError ?? thresholdError} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function ZoneCard({ zone, agents, perms }: { zone: ZoneView; agents: AgentView[]; perms: DeliveryPerms }) {
  return (
    <EditableRow
      idName="zoneId"
      idValue={zone.id}
      updateAction={updateDeliveryZoneAction}
      deleteAction={deleteDeliveryZoneAction}
      deleteTitle={`Supprimer la zone « ${zone.name} » ?`}
      deleteDescription="Ses tarifs par transporteur sont supprimés aussi : ces gouvernorats reviennent au tarif forfaitaire de chaque transporteur."
      perms={perms}
    >
      {(errors) => <ZoneFields zone={zone} agents={agents} errors={errors} />}
    </EditableRow>
  );
}

function AddZoneForm({ agents }: { agents: AgentView[] }) {
  return (
    <AddRowForm title="Ajouter une zone" submitLabel="Ajouter la zone" createAction={createDeliveryZoneAction}>
      {(errors) => <ZoneFields agents={agents} errors={errors} />}
    </AddRowForm>
  );
}

const DELIVERY_TABS = [
  { id: "methods", label: "Méthodes & règles" },
  { id: "zones", label: "Zones régionales" },
  { id: "carriers", label: "Transporteurs & points" },
] as const;

export function DeliveryPanel({
  methods,
  agents,
  locations,
  zones,
  perms,
}: {
  methods: MethodsView;
  agents: AgentView[];
  locations: LocationView[];
  zones: ZoneView[];
  perms: DeliveryPerms;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveDeliveryMethodsAction,
    null,
  );
  const onMethodsSubmit = useNoResetSubmit(formAction, state);
  const methodErrors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <FormTabs tabs={DELIVERY_TABS} defaultTab="methods">
      {(active) => (
        <div className="space-y-10">
          {/* ── Méthodes & règles ─────────────────────────────────── */}
          <FormTab id="methods" active={active}>
      <form action={formAction} onSubmit={onMethodsSubmit} className="space-y-6">
        <fieldset disabled={!perms.canUpdate} className="space-y-6">
        <FieldSection
          title="Méthodes proposées"
          description="Activez ou désactivez chaque méthode de livraison offerte à la commande. Une méthode désactivée masque ses options au paiement."
        >
          <ToggleField
            name="home_enabled"
            label="Livraison à domicile"
            description="Livraison par transporteur au tarif global (ou par transporteur ci-dessous)."
            defaultChecked={methods.homeEnabled}
          />
          <ToggleField
            name="drive_by_enabled"
            label="Retrait drive"
            description="Le client récupère sa commande sans descendre du véhicule, à un point dédié."
            defaultChecked={methods.driveByEnabled}
          />
          <ToggleField
            name="in_store_enabled"
            label="Retrait en magasin"
            description="Le client retire sa commande dans l'un de vos points de vente."
            defaultChecked={methods.inStoreEnabled}
          />
          <ToggleField
            name="zone_pricing_enabled"
            label="Tarification par région (gouvernorat)"
            description="Quand activé, le tarif d'un transporteur est pris dans sa grille par zone (onglet « Zones régionales ») selon le gouvernorat de la commande. Désactivé = tarif forfaitaire par transporteur."
            defaultChecked={methods.zonePricingEnabled}
          />
        </FieldSection>

        <FieldSection
          title="Tarif de base — livraison à domicile"
          description="Le tarif forfaitaire facturé pour la livraison à domicile et le seuil au-delà duquel elle devient offerte. Laissez vide pour utiliser les valeurs par défaut (7 TND / 250 TND). Ces réglages alimentent le « Plus que X pour la livraison offerte » du panier."
        >
          <ToggleField
            name="free_shipping_enabled"
            label="Activer la livraison offerte au-delà d'un seuil"
            description="Désactivé : la livraison à domicile est toujours facturée et le panier n'affiche plus « Plus que X… ». Les promotions « livraison offerte » restent indépendantes."
            defaultChecked={methods.freeShippingEnabled}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <MiniField
              name="global_default_fee_tnd"
              label="Frais de livraison (TND)"
              type="number"
              defaultValue={methods.defaultFeeTnd}
              placeholder="vide = 7 TND"
              error={methodErrors?.global_default_fee_tnd}
            />
            <MiniField
              name="global_free_threshold_tnd"
              label="Livraison offerte dès (TND)"
              type="number"
              defaultValue={methods.freeThresholdTnd}
              placeholder="vide = 250 TND"
              error={methodErrors?.global_free_threshold_tnd}
            />
          </div>
        </FieldSection>

        <p className="rounded-[16px] border border-dashed border-border bg-surface/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
          La livraison offerte peut aussi venir d&apos;un transporteur (seuil propre, ci-dessous),
          ou d&apos;une promotion « livraison offerte ». Le tarif de
          base global ci-dessus est partagé avec Réglages commande (même réglage).
        </p>
        </fieldset>

        {state?.message && (
          <div
            role={state.ok ? "status" : "alert"}
            className={`rounded-2xl border p-3 text-xs ${
              state.ok
                ? "border-primary/40 bg-primary/5 text-primary"
                : "border-destructive/40 bg-destructive/5 text-destructive"
            }`}
          >
            {state.message}
          </div>
        )}

        {perms.canUpdate && (
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
          >
            <Save className="h-4 w-4" />
            {pending ? "Enregistrement…" : "Enregistrer les méthodes"}
          </button>
        )}
      </form>
          </FormTab>

          {/* ── Zones régionales ──────────────────────────────────── */}
          <FormTab id="zones" active={active}>
            <section className="space-y-4">
              <header>
                <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">Zones régionales</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Regroupez les gouvernorats en zones (ex. Grand Tunis, Intérieur) et fixez un
                  tarif par transporteur et par zone. Actif uniquement quand « Tarification par
                  région » est activé (onglet Méthodes). Sinon, chaque transporteur utilise son
                  tarif forfaitaire.
                </p>
              </header>

              {zones.length === 0 ? (
                <p className="rounded-[16px] border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
                  Aucune zone. Ajoutez-en une ci-dessous, puis renseignez les tarifs par transporteur.
                </p>
              ) : (
                <div className="space-y-3">
                  {zones.map((z) => (
                    <ZoneCard key={z.id} zone={z} agents={agents} perms={perms} />
                  ))}
                </div>
              )}

              {perms.canCreate && <AddZoneForm agents={agents} />}
            </section>
          </FormTab>

          {/* ── Transporteurs & points ────────────────────────────── */}
          <FormTab id="carriers" active={active}>
            <div className="space-y-10">
      {/* ── Transporteurs ────────────────────────────────────────── */}
      <section className="space-y-4">
        <header>
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">Transporteurs</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Transporteurs de livraison à domicile. Laissez les frais ou le seuil
            de gratuité vides pour hériter du tarif global de la boutique.
          </p>
        </header>

        {agents.length === 0 ? (
          <p className="rounded-[16px] border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
            Aucun transporteur pour l'instant. Ajoutez-en un ci-dessous.
          </p>
        ) : (
          <div className="space-y-3">
            {agents.map((a) => (
              <AgentCard key={a.id} agent={a} perms={perms} />
            ))}
          </div>
        )}

        {perms.canCreate && <AddAgentForm />}
      </section>

      {/* ── Points de retrait ────────────────────────────────────── */}
      <section className="space-y-4">
        <header>
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">Points de retrait</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Points de retrait drive ou en magasin. Le type détermine la méthode
            de livraison à laquelle le point est rattaché. Les frais sont
            forfaitaires (pas de seuil de gratuité).
          </p>
        </header>

        {locations.length === 0 ? (
          <p className="rounded-[16px] border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
            Aucun point de retrait pour l'instant. Ajoutez-en un ci-dessous.
          </p>
        ) : (
          <div className="space-y-3">
            {locations.map((l) => (
              <LocationCard key={l.id} location={l} perms={perms} />
            ))}
          </div>
        )}

        {perms.canCreate && <AddLocationForm />}
      </section>
            </div>
          </FormTab>
        </div>
      )}
    </FormTabs>
  );
}

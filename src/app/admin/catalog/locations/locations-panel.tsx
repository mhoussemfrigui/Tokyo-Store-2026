"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
import {
  Building2,
  Check,
  Loader2,
  Pencil,
  Plus,
  Star,
  Trash2,
  Truck,
  X,
} from "lucide-react";

import { type ActionState } from "@/lib/actions/types";
import { type InventoryConfig } from "@/lib/inventory/locations-config";
import {
  createLocationAction,
  deleteLocationAction,
  setDefaultLocationAction,
  updateLocationAction,
} from "@/lib/actions/stock-locations";
import { SelectField } from "@/components/ui/select-field";

export type CarrierOption = { id: string; label: string; kind: "Transporteur" | "Point de retrait" };

export type LocationView = {
  id: string;
  name: string;
  code: string | null;
  carrierRef: string | null;
  isDefault: boolean;
  isActive: boolean;
  units: number;
};

const inputCls =
  "h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] placeholder:text-muted-foreground/60 focus:border-foreground focus:bg-white focus:outline-none disabled:opacity-60";

export function LocationsPanel({
  canManage,
  config,
  carrierOptions,
  locations,
}: {
  canManage: boolean;
  config: InventoryConfig;
  carrierOptions: CarrierOption[];
  locations: LocationView[];
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Always rendered inside the Stock page's Emplacements card (which supplies the
  // heading); the old standalone /admin/catalog/locations route only redirects here.
  return (
    <div className="space-y-6">
      <section className="rounded-[28px] border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            <h2 className="text-[18px] font-black text-foreground">
              Emplacements ({locations.length})
            </h2>
          </div>
          {canManage && !adding && (
            <button
              type="button"
              onClick={() => {
                setAdding(true);
                setEditingId(null);
              }}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-xs font-extrabold text-primary-foreground hover:bg-[#b8042a]"
            >
              <Plus className="h-4 w-4" /> Ajouter
            </button>
          )}
        </div>

        <div className="divide-y divide-border">
          {adding && (
            <div className="bg-[#fbf9f8] p-5">
              <LocationForm
                mode="create"
                carrierOptions={carrierOptions}
                carrierLinkEnabled={config.carrierLinkEnabled}
                onDone={() => setAdding(false)}
              />
            </div>
          )}

          {locations.map((loc) =>
            editingId === loc.id ? (
              <div key={loc.id} className="bg-[#fbf9f8] p-5">
                <LocationForm
                  mode="edit"
                  location={loc}
                  carrierOptions={carrierOptions}
                  carrierLinkEnabled={config.carrierLinkEnabled}
                  onDone={() => setEditingId(null)}
                />
              </div>
            ) : (
              <LocationRow
                key={loc.id}
                loc={loc}
                canManage={canManage}
                carrierLabel={
                  config.carrierLinkEnabled && loc.carrierRef
                    ? carrierOptions.find((c) => c.id === loc.carrierRef)?.label ?? null
                    : null
                }
                transferTargets={locations
                  .filter((l) => l.isActive && l.id !== loc.id)
                  .map((l) => ({ id: l.id, name: l.name }))}
                onEdit={() => {
                  setEditingId(loc.id);
                  setAdding(false);
                }}
              />
            ),
          )}

          {locations.length === 0 && !adding && (
            <p className="p-8 text-center text-[14px] text-muted-foreground">
              Aucun emplacement. Ajoutez votre premier magasin ou dépôt.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

/** A read row for one location with its actions. */
function LocationRow({
  loc,
  canManage,
  carrierLabel,
  transferTargets,
  onEdit,
}: {
  loc: LocationView;
  canManage: boolean;
  carrierLabel: string | null;
  /** Other ACTIVE locations this one's stock could be transferred to. */
  transferTargets: { id: string; name: string }[];
  onEdit: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [transferTo, setTransferTo] = useState("");

  const run = (fn: () => Promise<ActionState>) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.message ?? "Action impossible.");
      else router.refresh();
    });

  const onDeleteClick = () => {
    // Empty location → a plain confirm. Holds stock → open the options panel.
    if (loc.units > 0) {
      setConfirmDelete(true);
      return;
    }
    if (!window.confirm(`Supprimer l'emplacement « ${loc.name} » ? Action irréversible.`)) return;
    run(() => deleteLocationAction(loc.id));
  };

  return (
    <div className="p-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-foreground">{loc.name}</span>
            {loc.isDefault && (
              <span
                className="inline-flex items-center gap-1.5 rounded-full bg-[#fdecef] px-2.5 py-1 text-[11px] font-bold uppercase text-[#d40530]"
                title="Dépôt central : l'emplacement depuis lequel le site web est expédié (et, en mode « stock central », le seul stock vendable en ligne)."
              >
                <Star className="h-3 w-3" /> Centrale · site web
              </span>
            )}
            {!loc.isActive && (
              <span className="inline-flex items-center rounded-full bg-[#f6f2ed] px-2.5 py-1 text-[11px] font-bold uppercase text-[#5b5d62]">
                Inactif
              </span>
            )}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted-foreground">
            {loc.code && (
              <span className="font-mono" title="Code / réf. ERP de l'emplacement">
                {loc.code}
              </span>
            )}
            {loc.units > 0 && (
              <span className="tabular-nums">{loc.units} unité{loc.units > 1 ? "s" : ""}</span>
            )}
            {carrierLabel && (
              <span className="inline-flex items-center gap-1">
                <Truck className="h-3 w-3" /> {carrierLabel}
              </span>
            )}
          </p>
          {error && <p className="mt-1 text-[12px] text-destructive">{error}</p>}
        </div>

        {canManage && (
          <div className="flex items-center gap-1.5">
            {/* Only an ACTIVE location can become the default (reactivate first —
                that's what puts its units back into the totals). */}
            {!loc.isDefault && loc.isActive && (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (!window.confirm(`Définir « ${loc.name} » comme dépôt central (site web) ?\n\nC'est l'emplacement depuis lequel les commandes en ligne sont expédiées — et, en mode « stock central », le seul stock vendable sur le site.`)) return;
                  run(() => setDefaultLocationAction(loc.id));
                }}
                title="Définir comme dépôt central (site web)"
                className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-xs font-bold text-foreground transition hover:bg-surface disabled:opacity-50"
              >
                <Star className="h-3.5 w-3.5" /> Centrale
              </button>
            )}
            <button
              type="button"
              onClick={onEdit}
              title="Modifier"
              className="grid h-9 w-9 place-items-center rounded-[11px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            {!loc.isDefault && (
              <button
                type="button"
                disabled={pending}
                onClick={onDeleteClick}
                title="Supprimer"
                className="grid h-9 w-9 place-items-center rounded-[11px] bg-surface text-muted-foreground transition hover:bg-[var(--accent)] hover:text-destructive disabled:opacity-50"
              >
                {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Delete with stock → choose what happens to the units first. */}
      {confirmDelete && loc.units > 0 && (
        <div className="mt-3 rounded-[16px] border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-[14px] font-bold text-foreground">
            « {loc.name} » contient {loc.units} unité{loc.units > 1 ? "s" : ""}. Que faire de ce stock avant la suppression ?
          </p>
          <div className="mt-3 space-y-2.5">
            {transferTargets.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] text-muted-foreground">Transférer vers</span>
                <SelectField
                  ariaLabel="Transférer vers"
                  value={transferTo}
                  onChange={setTransferTo}
                  placeholder="— Choisir un emplacement —"
                  size="sm"
                  className="w-64"
                  triggerClassName="h-9"
                  options={transferTargets.map((t) => ({ value: t.id, label: t.name }))}
                />
                <button
                  type="button"
                  disabled={pending || !transferTo}
                  onClick={() => run(() => deleteLocationAction(loc.id, { stock: "transfer", destinationId: transferTo }))}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-xs font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-50"
                >
                  Transférer &amp; supprimer
                </button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  // An inactive location's units are already out of the totals
                  // (taken out on deactivation) — the writeoff only clears them.
                  const msg = loc.isActive
                    ? `Retirer définitivement ${loc.units} unité(s) des totaux de stock, puis supprimer « ${loc.name} » ? Action irréversible.`
                    : `Retirer définitivement les ${loc.units} unité(s) de « ${loc.name} » (emplacement inactif : déjà exclues des totaux), puis le supprimer ? Action irréversible.`;
                  if (!window.confirm(msg)) return;
                  run(() => deleteLocationAction(loc.id, { stock: "writeoff" }));
                }}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-destructive/40 px-4 text-xs font-bold text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" /> Retirer le stock &amp; supprimer
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  setTransferTo("");
                  setError(null);
                }}
                className="inline-flex h-9 items-center rounded-full px-3 text-xs font-bold text-muted-foreground hover:text-foreground"
              >
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Create / edit form for one location. */
function LocationForm({
  mode,
  location,
  carrierOptions,
  carrierLinkEnabled,
  onDone,
}: {
  mode: "create" | "edit";
  location?: LocationView;
  carrierOptions: CarrierOption[];
  carrierLinkEnabled: boolean;
  onDone: () => void;
}) {
  const action = mode === "create" ? createLocationAction : updateLocationAction;
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(action, null);
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) {
      onDone();
      router.refresh();
    }
  }, [state, onDone, router]);

  return (
    <form action={formAction} className="space-y-4">
      {mode === "edit" && <input type="hidden" name="id" value={location!.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-bold text-foreground">
            Nom de l&apos;emplacement
          </span>
          <input
            name="name"
            defaultValue={location?.name ?? ""}
            required
            maxLength={120}
            placeholder="Magasin centre-ville"
            className={inputCls}
            autoComplete="off"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-bold text-foreground">
            Code / réf. ERP (facultatif)
          </span>
          <input
            name="code"
            defaultValue={location?.code ?? ""}
            maxLength={40}
            placeholder="MAG-01"
            className={`${inputCls} font-mono`}
            autoComplete="off"
          />
        </label>
      </div>

      {carrierLinkEnabled && (
        <SelectField
          name="carrier_ref"
          label="Transporteur / point de retrait (facultatif)"
          labelClassName="mb-1.5 block text-[13px] font-bold text-foreground"
          defaultValue={location?.carrierRef ?? ""}
          placeholder="— Aucun —"
          triggerClassName="h-11 rounded-[14px]"
          options={carrierOptions.map((c) => ({ value: c.id, label: `${c.label} (${c.kind})` }))}
        />
      )}

      {/* The default location can't be deactivated. The box posts "on" when
          ticked and nothing when unticked (the action reads === "on"). */}
      {!location?.isDefault && (
        <div className="space-y-1">
          <label className="inline-flex cursor-pointer items-center gap-2.5 text-[14px] text-foreground">
            <input
              type="checkbox"
              name="is_active"
              defaultChecked={location?.isActive ?? true}
              className="h-4 w-4 accent-[var(--primary)]"
            />
            Emplacement actif
          </label>
          {location && location.units > 0 && (
            <p className="text-[12px] text-muted-foreground">
              {location.isActive
                ? `Désactiver retire jusqu'à ${location.units} unité(s) des totaux vendables (jamais plus que le stock restant) ; le réactiver remet exactement ce qui a été retiré.`
                : `Réactiver remet ses ${location.units} unité(s) dans les totaux vendables.`}
            </p>
          )}
        </div>
      )}

      {state && !state.ok && <p className="text-[14px] text-destructive">{state.message}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {mode === "create" ? "Créer" : "Enregistrer"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground transition hover:bg-surface"
        >
          <X className="h-4 w-4" /> Annuler
        </button>
      </div>
    </form>
  );
}

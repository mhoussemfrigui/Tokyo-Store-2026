"use client";

import { useActionState, useState, useTransition } from "react";
import { ExternalLink, Info, Pencil, Plus, Trash2, X } from "lucide-react";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { AdminKpiStrip } from "@/components/admin/kpi-strip";
import { AdminCallout, AdminNote } from "@/components/admin/_components/filter-bar";
import { FieldSection, SelectField, ToggleField } from "@/components/admin/_components/setting-fields";
import { useNoResetSubmit } from "@/components/admin/_components/form-tabs";
import { SelectField as UiSelectField } from "@/components/ui/select-field";
import { TRUST_ICON_MAP, TRUST_ICON_NAMES } from "@/lib/home/trust-icons";
import {
  type TrustBadgeAppearance,
  TRUST_BADGE_SETTING_KEYS,
  TRUST_STRIP_STYLES,
  TRUST_ICON_STYLES,
} from "@/lib/cms/trust-badge-appearance";
import {
  createTrustBadgeAction,
  deleteTrustBadgeAction,
  saveTrustBadgeSettingsAction,
  toggleTrustBadgeActiveAction,
  updateTrustBadgeAction,
} from "@/lib/actions/cms";
import { type ActionState } from "@/lib/actions/types";

type Item = {
  id: string;
  label: string;
  icon: string;
  kind: string | null;
  visibility: string;
  isActive: boolean;
  displayOrder: number;
};

type CheckoutCopy = { eta: string; warranty: string; returns: string };

const KIND_OPTIONS = [
  { value: "", label: "Personnalisé" },
  { value: "security", label: "Sécurité (paiement)" },
  { value: "delivery", label: "Livraison (reprend le délai Checkout)" },
  { value: "returns", label: "Retours (reprend la politique Checkout)" },
  { value: "warranty", label: "Garantie (reprend la garantie du produit)" },
];
const KIND_LABEL: Record<string, string> = {
  security: "Sécurité",
  delivery: "Livraison",
  returns: "Retours",
  warranty: "Garantie",
};

const VISIBILITY_OPTIONS = [
  { value: "always", label: "Toujours" },
  { value: "in_stock", label: "En stock uniquement" },
];
const VISIBILITY_LABEL: Record<string, string> = {
  always: "Toujours",
  in_stock: "En stock",
};

const STYLE_LABELS: Record<string, string> = {
  list: "Liste (filets)",
  inline: "En ligne (compact)",
  grid: "Grille (cartes)",
};
const ICON_STYLE_LABELS: Record<string, string> = {
  circle: "Pastille ronde",
  plain: "Icône simple",
  square: "Pastille carrée",
};

/** How a built-in kind resolves on the storefront — so the admin never promises
 *  text the renderer will substitute. Returns the text to preview + a note. */
function resolvedPreview(
  kind: string | null,
  label: string,
  copy: CheckoutCopy,
): { text: string; note: string | null } {
  if (kind === "warranty")
    return { text: copy.warranty || "Garantie du produit", note: "= garantie du produit · le libellé est ignoré" };
  if (kind === "delivery")
    return { text: copy.eta || label || "Délai de livraison", note: "= délai de livraison (Système → Checkout)" };
  if (kind === "returns")
    return { text: copy.returns || label || "Politique de retours", note: "= politique de retours (Système → Checkout)" };
  return { text: label || "Aperçu", note: null };
}

export function TrustBadgesPanel({
  items,
  appearance,
  nextOrder,
  sampleProductSlug,
  checkoutCopy,
}: {
  items: Item[];
  appearance: TrustBadgeAppearance;
  nextOrder: number;
  sampleProductSlug: string | null;
  checkoutCopy: CheckoutCopy;
}) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Item | null>(null);

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <AdminNote className="max-w-3xl">
          La bande de réassurance (Paiement sécurisé, Retours, Garantie…). Réordonnez,
          ajoutez ou masquez les badges, puis choisissez leur style et où ils apparaissent.
          La garantie reprend la couverture propre au produit.
        </AdminNote>
        {sampleProductSlug ? (
          <a
            href={`/${sampleProductSlug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground shadow-sm hover:bg-surface"
          >
            <ExternalLink className="h-4 w-4" /> Voir sur une fiche produit
          </a>
        ) : null}
      </div>

      <WhereCallout appearance={appearance} />

      <AppearanceForm appearance={appearance} />

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <h2 className="text-[18px] font-black text-foreground">Les badges</h2>
        <button
          type="button"
          onClick={() => {
            setEditingId(null);
            setCreating((v) => !v);
          }}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
        >
          {creating ? (
            <>
              <X className="h-4 w-4" /> Fermer
            </>
          ) : (
            <>
              <Plus className="h-4 w-4" /> Nouveau badge
            </>
          )}
        </button>
      </div>

      <AdminKpiStrip
        items={[
          { label: "Total", value: items.length, tone: "default" },
          { label: "Actifs", value: items.filter((i) => i.isActive).length, tone: "success" },
          {
            label: "Toujours affichés",
            value: items.filter((i) => i.isActive && i.visibility === "always").length,
            tone: "info",
          },
          {
            label: "Selon le stock",
            value: items.filter((i) => i.isActive && i.visibility === "in_stock").length,
            tone: "muted",
          },
        ]}
      />
      <AdminNote className="-mt-3">
        Compte les badges <em>configurés</em>. Un badge Garantie n&apos;apparaît que sur les
        produits couverts, et Livraison/Retours dépendent des textes Checkout.
      </AdminNote>

      {creating && (
        <BadgeForm
          mode="create"
          defaultOrder={nextOrder}
          checkoutCopy={checkoutCopy}
          onDone={() => setCreating(false)}
        />
      )}

      {items.length === 0 ? (
        <div className="rounded-[16px] border border-dashed border-border bg-[#fbf9f8] p-12 text-center text-[14px] text-muted-foreground">
          Aucun badge. Créez-en un — il apparaîtra sur les surfaces activées ci-dessus.
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-[22px] border border-border bg-card">
          {items.map((it) => (
            <li key={it.id} className="p-4">
              {editingId === it.id ? (
                <BadgeForm
                  mode="edit"
                  initial={it}
                  checkoutCopy={checkoutCopy}
                  onDone={() => setEditingId(null)}
                />
              ) : (
                <BadgeRow
                  item={it}
                  onEdit={() => {
                    setCreating(false);
                    setEditingId(it.id);
                  }}
                  onAskDelete={() => setToDelete(it)}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {toDelete && (
        <ConfirmDeleteModal
          title="Supprimer ce badge ?"
          description="Il sera retiré de la bande de réassurance."
          preview={
            <div className="rounded-[14px] border border-border bg-[#fbf9f8] p-3 text-[13px]">
              <p className="font-bold">{toDelete.label}</p>
            </div>
          }
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            const res = await deleteTrustBadgeAction(toDelete.id);
            return res.ok ? null : (res.message ?? "Erreur");
          }}
        />
      )}
    </div>
  );
}

/** "Où apparaissent ces badges" — resolves the owner's "not clear where they
 *  appear" confusion: names the live surfaces + distinguishes the separate
 *  home/landing « Réassurance » block. */
function WhereCallout({ appearance }: { appearance: TrustBadgeAppearance }) {
  const surfaces = [
    appearance.showOnProduct && "la fiche produit (sous le bouton d'achat)",
    appearance.showOnCart && "le panier",
    appearance.showOnCheckout && "le checkout",
  ].filter(Boolean) as string[];
  return (
    <AdminCallout tone="info" icon={Info}>
      <div className="space-y-1.5">
        <p>
          <span className="font-semibold text-foreground">Où apparaissent ces badges&nbsp;:</span>{" "}
          {surfaces.length > 0 ? surfaces.join(", ") : "aucune surface activée"} — selon les
          interrupteurs ci-dessous. Ils alimentent aussi l&apos;API headless{" "}
          <code className="rounded bg-card px-1">/api/content</code>.
        </p>
        <p>
          À ne pas confondre avec le bloc « Réassurance » des pages d&apos;accueil et vitrines
          (Page d&apos;accueil / Pages / Boutique / Marques), qui est un bloc éditorial distinct
          (image + titre + texte) édité dans son propre composeur.
        </p>
        <p>
          Les textes <span className="font-medium text-foreground">Livraison</span> et{" "}
          <span className="font-medium text-foreground">Retours</span> proviennent de{" "}
          <a href="/admin/system/checkout" className="font-medium text-primary hover:underline">
            Système → Checkout
          </a>
          , et la <span className="font-medium text-foreground">Garantie</span> de la fiche produit.
        </p>
      </div>
    </AdminCallout>
  );
}

/** Appearance (one style for the whole strip) + per-surface placement. Saved as
 *  `storefront.trust_badges.*` settings. useNoResetSubmit keeps every field on a
 *  failed save. */
function AppearanceForm({ appearance }: { appearance: TrustBadgeAppearance }) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    async (prev, fd) => saveTrustBadgeSettingsAction(prev, fd),
    null,
  );
  const onSubmit = useNoResetSubmit(formAction, state);
  return (
    <form
      action={formAction}
      onSubmit={onSubmit}
      className="space-y-6 rounded-[28px] border border-border bg-card p-5 sm:p-6"
    >
      <FieldSection
        title="Apparence"
        description="Un seul style s'applique à toute la bande. Les badges « Sécurité » restent une ligne discrète en bas."
      >
        <SelectField
          name={TRUST_BADGE_SETTING_KEYS.style}
          label="Disposition"
          defaultValue={appearance.style}
          options={TRUST_STRIP_STYLES.map((s) => ({ value: s, label: STYLE_LABELS[s] }))}
          helper="Liste = colonne de lignes · En ligne = rangée compacte · Grille = cartes (2 colonnes)."
        />
        <SelectField
          name={TRUST_BADGE_SETTING_KEYS.iconStyle}
          label="Style d'icône"
          defaultValue={appearance.iconStyle}
          options={TRUST_ICON_STYLES.map((s) => ({ value: s, label: ICON_STYLE_LABELS[s] }))}
        />
      </FieldSection>

      <FieldSection
        title="Emplacements"
        description="Où la bande apparaît. Le panier remplace l'ancienne bande fixe ; le checkout est optionnel (la ligne « paiement sécurisé » du formulaire reste)."
      >
        <ToggleField
          name={TRUST_BADGE_SETTING_KEYS.showOnProduct}
          label="Fiche produit"
          description="Sous le bouton d'achat."
          defaultChecked={appearance.showOnProduct}
        />
        <ToggleField
          name={TRUST_BADGE_SETTING_KEYS.showOnCart}
          label="Panier"
          description="Dans le récapitulatif du panier."
          defaultChecked={appearance.showOnCart}
        />
        <ToggleField
          name={TRUST_BADGE_SETTING_KEYS.showOnCheckout}
          label="Checkout"
          description="Sous le formulaire de commande (optionnel)."
          defaultChecked={appearance.showOnCheckout}
        />
      </FieldSection>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? "Enregistrement…" : "Enregistrer l'apparence"}
        </button>
        {state && (
          <span className={`text-[13px] ${state.ok ? "text-[#15803d]" : "text-destructive"}`}>
            {state.message}
          </span>
        )}
      </div>
    </form>
  );
}

function BadgeRow({
  item,
  onEdit,
  onAskDelete,
}: {
  item: Item;
  onEdit: () => void;
  onAskDelete: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const Icon = TRUST_ICON_MAP[item.icon] ?? TRUST_ICON_MAP.ShieldCheck;
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-[12px] bg-surface text-foreground">
          <Icon className="h-4 w-4" strokeWidth={2} />
        </span>
        <div>
          <p className="text-[14px] font-bold text-foreground">
            {item.label}
            {!item.isActive && (
              <span className="ml-2 rounded-full bg-[#f6f2ed] px-2.5 py-1 text-[10px] font-bold uppercase text-[#5b5d62]">
                désactivé
              </span>
            )}
            {item.kind === "security" && (
              <span className="ml-2 rounded-full bg-[#fdecef] px-2.5 py-1 text-[10px] font-bold uppercase text-[#d40530]">
                ligne du bas
              </span>
            )}
          </p>
          <p className="text-[12px] text-muted-foreground">
            {item.kind ? `${KIND_LABEL[item.kind]} · ` : ""}
            {VISIBILITY_LABEL[item.visibility] ?? item.visibility} · ordre {item.displayOrder}
          </p>
          {error && (
            <p role="alert" className="text-[12px] font-bold text-destructive">
              {error}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const res = await toggleTrustBadgeActiveAction(item.id, !item.isActive);
              if (!res.ok) setError(res.message || "La modification n'a pas pu être enregistrée.");
            })
          }
          className="rounded-full px-3 py-1.5 text-[13px] font-bold text-foreground hover:bg-surface hover:text-foreground disabled:opacity-50"
        >
          {item.isActive ? "Désactiver" : "Activer"}
        </button>
        <button
          type="button"
          onClick={onEdit}
          aria-label="Modifier"
          className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-surface hover:text-foreground"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onAskDelete}
          aria-label="Supprimer"
          className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function BadgeForm({
  mode,
  initial,
  defaultOrder,
  checkoutCopy,
  onDone,
}: {
  mode: "create" | "edit";
  initial?: Item;
  defaultOrder?: number;
  checkoutCopy: CheckoutCopy;
  onDone: () => void;
}) {
  const action = mode === "create" ? createTrustBadgeAction : updateTrustBadgeAction;
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    async (prev, fd) => {
      const res = await action(prev, fd);
      if (res.ok) onDone();
      return res;
    },
    null,
  );
  const onSubmit = useNoResetSubmit(formAction, state);
  const fieldErr = (key: string) => (state && !state.ok ? state.fieldErrors?.[key] : undefined);

  const [label, setLabel] = useState(initial?.label ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "ShieldCheck");
  const [kind, setKind] = useState(initial?.kind ?? "");
  const [visibility, setVisibility] = useState(initial?.visibility ?? "always");

  const preview = resolvedPreview(kind || null, label, checkoutCopy);
  const PreviewIcon = TRUST_ICON_MAP[icon] ?? TRUST_ICON_MAP.ShieldCheck;
  const labelIsIgnored = kind === "warranty";
  const labelIsFallback = kind === "delivery" || kind === "returns";

  return (
    <form
      action={formAction}
      onSubmit={onSubmit}
      className="grid gap-4 rounded-[18px] border border-border bg-[#fbf9f8] p-4 sm:grid-cols-2"
    >
      {mode === "edit" && initial && <input type="hidden" name="id" value={initial.id} />}
      {/* Visual icon picker sets this controlled value; the form reads it from here. */}
      <input type="hidden" name="icon" value={icon} />

      <label className="flex flex-col gap-1">
        <span className="text-[13px] font-bold text-foreground">
          Libellé{labelIsIgnored ? " (ignoré pour la Garantie)" : labelIsFallback ? " (texte de secours)" : ""}
        </span>
        <input
          name="label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
          maxLength={80}
          placeholder="Retours sous conditions"
          aria-invalid={fieldErr("label") ? true : undefined}
          className={`h-11 rounded-[14px] border-[1.5px] bg-white px-4 text-[15px] transition focus:border-foreground focus:outline-none ${
            fieldErr("label") ? "border-destructive" : "border-input"
          }`}
        />
        {fieldErr("label") && (
          <span className="text-[12px] text-destructive">{fieldErr("label")}</span>
        )}
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-bold text-foreground">Type</span>
        <UiSelectField name="kind" ariaLabel="Type" value={kind} onChange={setKind} options={KIND_OPTIONS} />
        {kind === "delivery" || kind === "returns" ? (
          <a href="/admin/system/checkout" className="text-[12px] text-primary hover:underline">
            Modifier le texte dans Système → Checkout →
          </a>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-bold text-foreground">Visibilité</span>
        <UiSelectField
          name="visibility"
          ariaLabel="Visibilité"
          value={visibility}
          onChange={setVisibility}
          options={VISIBILITY_OPTIONS}
        />
        <span className="text-[12px] text-muted-foreground">
          « En stock uniquement » masque le badge quand le produit est épuisé.
        </span>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[13px] font-bold text-foreground">Ordre d&apos;affichage</span>
        <input
          name="displayOrder"
          type="number"
          min={0}
          defaultValue={String(initial?.displayOrder ?? defaultOrder ?? 0)}
          aria-invalid={fieldErr("displayOrder") ? true : undefined}
          className={`h-11 rounded-[14px] border-[1.5px] bg-white px-4 text-[15px] transition focus:border-foreground focus:outline-none ${
            fieldErr("displayOrder") ? "border-destructive" : "border-input"
          }`}
        />
        {fieldErr("displayOrder") && (
          <span className="text-[12px] text-destructive">{fieldErr("displayOrder")}</span>
        )}
      </label>

      {/* Icône — visual grid picker (names are opaque otherwise). */}
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-[13px] font-bold text-foreground">Icône</span>
        <div className="flex flex-wrap gap-1.5">
          {TRUST_ICON_NAMES.map((name) => {
            const I = TRUST_ICON_MAP[name];
            const selected = name === icon;
            return (
              <button
                key={name}
                type="button"
                onClick={() => setIcon(name)}
                aria-label={name}
                aria-pressed={selected}
                title={name}
                className={`grid h-9 w-9 place-items-center rounded-[12px] border transition ${
                  selected
                    ? "border-primary bg-[#fdecef] text-[#d40530]"
                    : "border-input bg-card text-muted-foreground hover:bg-surface hover:text-foreground"
                }`}
              >
                <I className="h-4 w-4" strokeWidth={1.75} />
              </button>
            );
          })}
        </div>
      </div>

      {mode === "edit" && (
        <label className="flex items-center gap-2 self-end pb-2">
          <input type="checkbox" name="isActive" defaultChecked={initial?.isActive ?? true} className="h-4 w-4 rounded-[4px] border-input accent-[var(--primary)]" />
          <span className="text-[13px] font-bold text-foreground">Actif</span>
        </label>
      )}

      {/* Faithful preview — resolves built-in copy + shows the right render group. */}
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-[13px] font-bold text-foreground">Aperçu</span>
        {kind === "security" ? (
          // Matches the storefront SecurityRow: a bare uppercase caption (icon +
          // text), NOT a bordered pill — the storefront renders no per-item chrome.
          <span className="inline-flex w-fit items-center gap-1.5 text-[0.6rem] uppercase tracking-[0.16em] text-muted-foreground/70">
            <PreviewIcon className="h-3 w-3 text-primary" strokeWidth={2} />
            {preview.text}
          </span>
        ) : (
          <span className="inline-flex w-fit items-center gap-3 rounded-[14px] border border-border bg-card px-3 py-2 font-body text-[0.82rem] text-foreground/80">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
              <PreviewIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
            </span>
            {preview.text}
          </span>
        )}
        {preview.note && <span className="text-[12px] text-muted-foreground">{preview.note}</span>}
      </div>

      <div className="flex items-center gap-3 sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="ml-auto inline-flex h-11 items-center rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? "…" : mode === "create" ? "Créer" : "Enregistrer"}
        </button>
      </div>

      {state && !state.ok && <p className="text-[13px] text-destructive sm:col-span-2">{state.message}</p>}
    </form>
  );
}

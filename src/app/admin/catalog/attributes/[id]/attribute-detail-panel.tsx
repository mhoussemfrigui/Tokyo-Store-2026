"use client";

import Link from "next/link";
import { useActionState, useRef, useState, useTransition } from "react";
import {
  ChevronDown,
  ChevronUp,
  Info,
  Loader2,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { IconButton } from "@/components/admin/icon-button";
import { SelectField } from "@/components/ui/select-field";
import { AdminCallout } from "@/components/admin/_components/filter-bar";
import { slugify as slugifyClient } from "@/lib/slug";
import {
  createValueAction,
  deleteValueAction,
  setAttributeCategoriesAction,
  setAttributeValueOrderAction,
  updateAttributeAction,
  updateValueAction,
} from "@/lib/actions/attribute";
import { type ActionState } from "@/lib/actions/types";
import type { AttributeKind } from "@/modules/catalog/attribute/schema";

import { KIND_OPTIONS, hasEditableValues, isColorKind } from "../_kinds";

type AttributeMeta = {
  id: string;
  slug: string;
  name: string;
  kind: AttributeKind;
  displayOrder: number;
  isActive: boolean;
};

type AttributeValue = {
  id: string;
  slug: string;
  label: string;
  displayOrder: number;
  colorHex: string | null;
};

type CategoryOption = { id: string; name: string; depth: number };

export function AttributeDetailPanel({
  attribute,
  values,
  categories,
  selectedCategoryIds,
  usedByProducts,
}: {
  attribute: AttributeMeta;
  values: AttributeValue[];
  categories: CategoryOption[];
  selectedCategoryIds: string[];
  /** Capped, name-ordered page (`rows`) + the TRUE distinct count (`total`). */
  usedByProducts: { rows: { id: string; name: string; slug: string }[]; total: number };
}) {
  return (
    <div className="space-y-5">
      <AttributeMetaForm attribute={attribute} />
      {hasEditableValues(attribute.kind) ? (
        <AttributeValuesEditor
          attributeId={attribute.id}
          kind={attribute.kind}
          initialValues={values}
        />
      ) : (
        <ScalarNote kind={attribute.kind} />
      )}
      <AttributeCategoriesEditor
        attributeId={attribute.id}
        categories={categories}
        initialSelected={selectedCategoryIds}
      />
      <ProductsUsingAttribute
        products={usedByProducts.rows}
        total={usedByProducts.total}
      />
    </div>
  );
}

/**
 * Cross-product usage — which products currently carry this attribute (value or
 * scalar). Gives the admin a way to FIND and jump to each product to remove the
 * attribute (the per-attribute « Effacer » in the product editor) — answering
 * "search for them across multiple products".
 */
function ProductsUsingAttribute({
  products,
  total,
}: {
  products: { id: string; name: string; slug: string }[];
  /** True distinct count — `products` is a capped page of it. */
  total: number;
}) {
  const truncated = total > products.length;
  return (
    <section className="rounded-[28px] border border-border bg-card p-5">
      <h2 className="text-[18px] font-black text-foreground">
        Produits utilisant cet attribut
      </h2>
      <p className="mt-1 text-[13px] text-muted-foreground">
        {total === 0
          ? "Aucun produit n'utilise cet attribut pour le moment."
          : `${
              truncated
                ? `${products.length} affichés sur ${total} produits (par ordre alphabétique)`
                : `${total} produit${total > 1 ? "s" : ""}`
            }. Ouvrez un produit pour retirer l'attribut (onglet Attributs → « Effacer »).`}
      </p>
      {products.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {products.map((p) => (
            <li key={p.id}>
              <Link
                href={`/admin/catalog/products/${p.id}`}
                className="inline-flex max-w-xs items-center gap-1 truncate rounded-full border border-border bg-surface px-3 py-1 text-xs font-bold text-foreground transition hover:border-primary/40 hover:text-primary"
                title={p.name}
              >
                {p.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────── Attribute meta form
function AttributeMetaForm({ attribute }: { attribute: AttributeMeta }) {
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    updateAttributeAction,
    null,
  );

  return (
    <Section
      title="Informations"
      description="Identité de l'attribut et son comportement de filtre."
    >
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="attributeId" value={attribute.id} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field name="name" label="Nom" required defaultValue={attribute.name} />
          <Field
            name="slug"
            label="Slug"
            defaultValue={attribute.slug}
            helper="Unique. Évitez de changer après publication."
          />
          <SelectField
            name="kind"
            label="Type"
            defaultValue={attribute.kind}
            options={KIND_OPTIONS}
            helper="Changer de type après création peut laisser des données inutilisées."
          />
          <Field
            name="displayOrder"
            label="Ordre d'affichage"
            type="number"
            defaultValue={attribute.displayOrder}
          />
        </div>
        <label className="flex items-center gap-2 text-[14px]">
          <input
            type="checkbox"
            name="isActive"
            defaultChecked={attribute.isActive}
            className="h-4 w-4 accent-[var(--primary)]"
          />
          Actif (visible dans les filtres)
        </label>

        {state && !state.ok && <AdminCallout tone="danger">{state.message}</AdminCallout>}
        {state?.ok && <AdminCallout tone="success">{state.message}</AdminCallout>}

        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
          >
            <Save className="h-4 w-4" />
            {isPending ? "Enregistrement…" : "Enregistrer"}
          </button>
          <Link
            href="/admin/catalog/attributes"
            className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground hover:bg-surface"
          >
            <X className="h-4 w-4" /> Fermer
          </Link>
        </div>
      </form>
    </Section>
  );
}

// ─────────────────────────────────────────────────── Scalar / boolean note
function ScalarNote({ kind }: { kind: AttributeKind }) {
  return (
    <Section
      title="Valeurs"
      description="Ce type ne porte pas de liste de valeurs modifiable ici."
    >
      <AdminCallout tone="info" icon={Info}>
        {kind === "boolean"
          ? "Le type booléen gère une seule valeur automatiquement (présent ou absent sur le produit)."
          : "Ce type stocke une donnée par produit, saisie depuis la fiche produit (onglet Attributs)."}
      </AdminCallout>
    </Section>
  );
}

// ─────────────────────────────────────────────────── Values editor
type ValueDraft = {
  id: string;
  slug: string;
  label: string;
  colorHex: string;
  /** `id` is a synthetic `new-…` until the inline Save persists the row. */
  isNew?: boolean;
  /** Tracks local edits so we know when to enable the Save button. */
  dirty?: boolean;
};

function toDraft(v: AttributeValue): ValueDraft {
  return {
    id: v.id,
    slug: v.slug,
    label: v.label,
    colorHex: v.colorHex ?? "",
  };
}

function AttributeValuesEditor({
  attributeId,
  kind,
  initialValues,
}: {
  attributeId: string;
  kind: AttributeKind;
  initialValues: AttributeValue[];
}) {
  const [rows, setRows] = useState<ValueDraft[]>(initialValues.map(toDraft));
  const [toDelete, setToDelete] = useState<ValueDraft | null>(null);
  const [orderPending, startOrder] = useTransition();
  const [orderErr, setOrderErr] = useState<string | null>(null);
  const colorMode = isColorKind(kind);
  // Monotonic counter for synthetic ids — never derived from mutable list state
  // (a derived id like `new-${length}-${labelSum}` can collide after add/delete,
  // producing duplicate React keys and cross-row input bleed).
  const keyRef = useRef(0);

  const addRow = () => {
    keyRef.current += 1;
    setRows((r) => [
      ...r,
      {
        id: `new-${keyRef.current}`,
        slug: "",
        label: "",
        colorHex: "",
        isNew: true,
        dirty: true,
      },
    ]);
  };

  const patchRow = (id: string, patch: Partial<ValueDraft>) =>
    setRows((r) => r.map((row) => (row.id === id ? { ...row, ...patch, dirty: true } : row)));

  const removeUnsavedRow = (id: string) =>
    setRows((r) => r.filter((row) => row.id !== id));

  // Persist the order of SAVED rows (synthetic new rows are excluded — they
  // get their order on creation from their array index).
  const persistOrder = (list: ValueDraft[]) => {
    const ids = list.filter((row) => !row.isNew).map((row) => row.id);
    if (ids.length < 2) return;
    setOrderErr(null);
    startOrder(async () => {
      const res = await setAttributeValueOrderAction(attributeId, ids);
      if (!res.ok) setOrderErr(res.message ?? "Ordre non enregistré.");
    });
  };

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    setRows(next);
    persistOrder(next);
  };

  return (
    <Section
      title="Valeurs"
      description={
        colorMode
          ? "Valeurs sélectionnables avec leur pastille de couleur. Réordonnez avec les flèches."
          : "Liste des valeurs sélectionnables pour cet attribut. Réordonnez avec les flèches."
      }
      action={
        <button
          type="button"
          onClick={addRow}
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-3.5 text-xs font-extrabold text-primary-foreground hover:bg-[#b8042a]"
        >
          <Plus className="h-3.5 w-3.5" />
          Valeur
        </button>
      }
    >
      {orderErr && (
        <p className="rounded-[12px] border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-[12px] text-destructive">
          {orderErr}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="rounded-[16px] border border-dashed border-border bg-[#fbf9f8] p-6 text-center text-[13px] text-muted-foreground">
          Aucune valeur. Cliquez sur « Valeur » pour en ajouter.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row, index) => (
            <ValueRow
              key={row.id}
              attributeId={attributeId}
              row={row}
              index={index}
              total={rows.length}
              colorMode={colorMode}
              orderPending={orderPending}
              onMove={(dir) => move(index, dir)}
              onPatch={(patch) => patchRow(row.id, patch)}
              onAskDelete={() => {
                if (row.isNew) removeUnsavedRow(row.id);
                else setToDelete(row);
              }}
              onSaved={(saved) =>
                setRows((r) =>
                  r.map((current) =>
                    current.id === row.id
                      ? { ...saved, isNew: false, dirty: false }
                      : current,
                  ),
                )
              }
            />
          ))}
        </ul>
      )}

      {toDelete && (
        <ConfirmDeleteModal
          title="Supprimer cette valeur ?"
          description="Les assignations produit pour cette valeur seront perdues."
          preview={
            <div className="rounded-[16px] border border-border bg-[#fbf9f8] p-2">
              <p className="text-[13px] font-bold">{toDelete.label}</p>
              <p className="text-[12px] text-muted-foreground">/{toDelete.slug}</p>
            </div>
          }
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            const res = await deleteValueAction(toDelete.id, attributeId);
            if (!res.ok) return res.message ?? "Erreur";
            setRows((r) => r.filter((row) => row.id !== toDelete.id));
            return null;
          }}
        />
      )}
    </Section>
  );
}

function ValueRow({
  attributeId,
  row,
  index,
  total,
  colorMode,
  orderPending,
  onMove,
  onPatch,
  onAskDelete,
  onSaved,
}: {
  attributeId: string;
  row: ValueDraft;
  index: number;
  total: number;
  colorMode: boolean;
  orderPending: boolean;
  onMove: (dir: -1 | 1) => void;
  onPatch: (patch: Partial<ValueDraft>) => void;
  onAskDelete: () => void;
  onSaved: (saved: ValueDraft) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const saveRow = () => {
    setErr(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("attributeId", attributeId);
      formData.set("label", row.label);
      if (row.slug) formData.set("slug", row.slug);
      formData.set("displayOrder", String(index));
      // For colour attributes always submit the hex (empty clears it); other
      // kinds omit it entirely so the field is left unchanged.
      if (colorMode) formData.set("colorHex", row.colorHex.trim());

      if (row.isNew) {
        const res = await createValueAction(null, formData);
        if (!res.ok) {
          setErr(res.message ?? "Erreur");
          return;
        }
        if (res.id) {
          onSaved({
            id: res.id,
            slug: row.slug || slugifyClient(row.label),
            label: row.label,
            colorHex: colorMode ? row.colorHex.trim() : row.colorHex,
          });
        }
      } else {
        formData.set("valueId", row.id);
        const res = await updateValueAction(null, formData);
        if (!res.ok) {
          setErr(res.message ?? "Erreur");
          return;
        }
        onSaved({
          id: row.id,
          slug: row.slug,
          label: row.label,
          colorHex: colorMode ? row.colorHex.trim() : row.colorHex,
        });
      }
    });
  };

  return (
    <li className="rounded-[16px] border border-border bg-[#fbf9f8] p-3">
      <div
        className={
          colorMode
            ? "grid gap-2 sm:grid-cols-[auto_auto_1fr_1fr_auto]"
            : "grid gap-2 sm:grid-cols-[auto_1fr_1fr_auto]"
        }
      >
        <div className="flex items-center">
          <button
            type="button"
            disabled={index === 0 || orderPending}
            onClick={() => onMove(-1)}
            aria-label="Monter"
            className="grid h-9 w-7 place-items-center rounded-l-[12px] border-[1.5px] border-input bg-card text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:opacity-30"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={index === total - 1 || orderPending}
            onClick={() => onMove(1)}
            aria-label="Descendre"
            className="grid h-9 w-7 place-items-center rounded-r-[12px] border-[1.5px] border-l-0 border-input bg-card text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:opacity-30"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>

        {colorMode && (
          <div className="flex items-center gap-1.5">
            <input
              type="color"
              value={row.colorHex || "#cccccc"}
              onChange={(e) => onPatch({ colorHex: e.target.value })}
              aria-label="Couleur"
              className="h-9 w-10 cursor-pointer rounded-[10px] border border-input bg-[#fbf9f8] p-0.5"
            />
            <input
              value={row.colorHex}
              onChange={(e) => onPatch({ colorHex: e.target.value })}
              placeholder="#RRGGBB"
              className="h-9 w-24 rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-2 text-[13px] focus:outline-none"
            />
          </div>
        )}

        <input
          value={row.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          placeholder="Label (ex: 18+)"
          className="h-9 w-full rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[13px] focus:outline-none"
        />
        <input
          value={row.slug}
          onChange={(e) => onPatch({ slug: e.target.value })}
          placeholder="Slug (auto si vide)"
          className="h-9 w-full rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[13px] focus:outline-none"
        />
        <div className="inline-flex items-center justify-end gap-1">
          <button
            type="button"
            disabled={pending || !row.dirty || row.label.trim().length === 0}
            onClick={saveRow}
            className="inline-flex h-9 items-center gap-1 rounded-full bg-primary px-3 text-[11px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            {row.isNew ? "Créer" : "Sauver"}
          </button>
          <IconButton
            icon={<Trash2 className="h-3.5 w-3.5" />}
            aria-label="Retirer"
            tone="danger"
            size="sm"
            onClick={onAskDelete}
          />
        </div>
      </div>
      {err && (
        <p className="mt-2 rounded-[12px] border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-[12px] text-destructive">
          {err}
        </p>
      )}
    </li>
  );
}

// ─────────────────────────────────────────────────── Categories editor
function AttributeCategoriesEditor({
  attributeId,
  categories,
  initialSelected,
}: {
  attributeId: string;
  categories: CategoryOption[];
  initialSelected: string[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));
  const [dirty, setDirty] = useState(false);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setDirty(true);
    setMsg(null);
  };

  const save = () => {
    setMsg(null);
    startTransition(async () => {
      const res = await setAttributeCategoriesAction(attributeId, [...selected]);
      setMsg({ ok: res.ok, text: res.message ?? (res.ok ? "Enregistré." : "Erreur") });
      if (res.ok) setDirty(false);
    });
  };

  return (
    <Section
      title="Catégories"
      description="Les catégories où cet attribut apparaît comme filtre. Modifiable aussi depuis l'onglet Filtres de chaque catégorie."
      action={
        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty}
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-3.5 text-xs font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Enregistrer
        </button>
      }
    >
      {categories.length === 0 ? (
        <p className="rounded-[16px] border border-dashed border-border bg-[#fbf9f8] p-6 text-center text-[13px] text-muted-foreground">
          Aucune catégorie. Créez d&apos;abord des catégories pour pouvoir les lier.
        </p>
      ) : (
        <ul className="max-h-80 space-y-0.5 overflow-auto rounded-[16px] border border-border bg-[#fbf9f8] p-2">
          {categories.map((c) => (
            <li key={c.id}>
              <label
                className="flex cursor-pointer items-center gap-2 rounded-[10px] px-2 py-1.5 text-[14px] hover:bg-surface"
                style={{ paddingLeft: `${8 + c.depth * 16}px` }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={() => toggle(c.id)}
                  className="h-4 w-4 accent-[var(--primary)]"
                />
                <span className={c.depth === 0 ? "font-medium" : "text-muted-foreground"}>
                  {c.name}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {msg && <AdminCallout tone={msg.ok ? "success" : "danger"}>{msg.text}</AdminCallout>}
    </Section>
  );
}

// ─────────────────────────────────────────────────── Section primitive
function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-[28px] border border-border bg-card p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[18px] font-black text-foreground">{title}</h2>
          {description && (
            <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

// ─────────────────────────────────────────────────── Form primitives
function Field({
  name,
  label,
  required,
  type,
  defaultValue,
  helper,
}: {
  name: string;
  label: string;
  required?: boolean;
  type?: string;
  defaultValue?: string | number | null;
  helper?: string;
}) {
  const id = `f-${name}`;
  return (
    <div>
      <label
        htmlFor={id}
        className="text-[13px] font-bold text-foreground"
      >
        {label}
        {required && <span className="text-destructive"> *</span>}
      </label>
      <input
        id={id}
        name={name}
        type={type ?? "text"}
        required={required}
        defaultValue={defaultValue ?? ""}
        className="mt-1 h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[14px] focus:border-foreground focus:bg-white focus:outline-none"
      />
      {helper && <p className="mt-1 text-[12px] text-muted-foreground">{helper}</p>}
    </div>
  );
}

// Client-side slug preview (`slugifyClient`) is imported from the isomorphic
// src/lib/slug.ts so it matches the server's authoritative normalisation
// exactly — a locally copied algorithm could silently diverge.

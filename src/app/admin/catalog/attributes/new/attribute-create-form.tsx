"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { Info, Plus, Save, Trash2 } from "lucide-react";

import { IconButton } from "@/components/admin/icon-button";
import { SelectField } from "@/components/ui/select-field";
import { createAttributeAction } from "@/lib/actions/attribute";
import { type ActionState } from "@/lib/actions/types";
import type { AttributeKind } from "@/modules/catalog/attribute/schema";

import { KIND_OPTIONS, hasEditableValues, isColorKind } from "../_kinds";

type SeedRow = { key: string; label: string; slug: string; colorHex: string };

export function AttributeCreateForm() {
  const router = useRouter();
  const [kind, setKind] = useState<AttributeKind>("multiselect");
  const [rows, setRows] = useState<SeedRow[]>([]);
  const keyRef = useRef(0);

  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    createAttributeAction,
    null,
  );

  // On success the action returns the new id — jump straight to its editor so
  // the admin can keep going (more values, category links…).
  useEffect(() => {
    if (state?.ok && state.id) {
      router.push(`/admin/catalog/attributes/${state.id}`);
    }
  }, [state, router]);

  const showValues = hasEditableValues(kind);
  const colorMode = isColorKind(kind);

  const addRow = () => {
    keyRef.current += 1;
    setRows((r) => [...r, { key: `s${keyRef.current}`, label: "", slug: "", colorHex: "" }]);
  };
  const patchRow = (key: string, patch: Partial<SeedRow>) =>
    setRows((r) => r.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const removeRow = (key: string) => setRows((r) => r.filter((row) => row.key !== key));

  // Serialised payload for the server action (parsed by `parseSeedValues`).
  const valuesJson = showValues
    ? JSON.stringify(
        rows
          .filter((r) => r.label.trim())
          .map((r) => ({
            label: r.label.trim(),
            slug: r.slug.trim() || undefined,
            colorHex: colorMode && r.colorHex.trim() ? r.colorHex.trim() : undefined,
          })),
      )
    : "[]";

  return (
    <form action={formAction} className="space-y-5">
      {showValues && <input type="hidden" name="valuesJson" value={valuesJson} />}

      <section className="space-y-4 rounded-[28px] border border-border bg-card p-5">
        <header>
          <h2 className="text-[18px] font-black text-foreground">Informations</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Identité de l&apos;attribut et type de filtre.
          </p>
        </header>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field name="name" label="Nom" required placeholder="Matière, Couleur, Mouvement…" />
          <Field name="slug" label="Slug" placeholder="matiere" helper="Auto si vide. Unique." />
          <SelectField
            name="kind"
            label="Type"
            value={kind}
            onChange={(v) => setKind(v as AttributeKind)}
            options={KIND_OPTIONS}
          />
          <Field name="displayOrder" label="Ordre d'affichage" type="number" defaultValue={0} />
        </div>

        <label className="flex items-center gap-2 text-[14px]">
          <input
            type="checkbox"
            name="isActive"
            defaultChecked
            className="h-4 w-4 accent-[var(--primary)]"
          />
          Actif (visible dans les filtres)
        </label>
      </section>

      {showValues ? (
        <section className="space-y-4 rounded-[28px] border border-border bg-card p-5">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-[18px] font-black text-foreground">Valeurs</h2>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {colorMode
                  ? "Ajoutez les valeurs et leur pastille de couleur. Optionnel — vous pourrez compléter après création."
                  : "Ajoutez les premières valeurs. Optionnel — vous pourrez en ajouter d'autres après création."}
              </p>
            </div>
            <button
              type="button"
              onClick={addRow}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 text-xs font-extrabold text-primary-foreground hover:bg-[#b8042a]"
            >
              <Plus className="h-3.5 w-3.5" />
              Valeur
            </button>
          </header>

          {rows.length === 0 ? (
            <p className="rounded-[16px] border border-dashed border-border bg-[#fbf9f8] p-6 text-center text-[13px] text-muted-foreground">
              Aucune valeur pour l&apos;instant.
            </p>
          ) : (
            <ul className="space-y-2">
              {rows.map((row) => (
                <li key={row.key} className="rounded-[16px] border border-border bg-[#fbf9f8] p-3">
                  <div
                    className={
                      colorMode
                        ? "grid gap-2 sm:grid-cols-[auto_1fr_1fr_auto]"
                        : "grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
                    }
                  >
                    {colorMode && (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="color"
                          value={row.colorHex || "#cccccc"}
                          onChange={(e) => patchRow(row.key, { colorHex: e.target.value })}
                          aria-label="Couleur"
                          className="h-9 w-10 cursor-pointer rounded-[10px] border border-input bg-[#fbf9f8] p-0.5"
                        />
                        <input
                          value={row.colorHex}
                          onChange={(e) => patchRow(row.key, { colorHex: e.target.value })}
                          placeholder="#RRGGBB"
                          className="h-9 w-24 rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-2 text-[13px] focus:outline-none"
                        />
                      </div>
                    )}
                    <input
                      value={row.label}
                      onChange={(e) => patchRow(row.key, { label: e.target.value })}
                      placeholder="Label (ex: Rouge)"
                      className="h-9 w-full rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[13px] focus:outline-none"
                    />
                    <input
                      value={row.slug}
                      onChange={(e) => patchRow(row.key, { slug: e.target.value })}
                      placeholder="Slug (auto si vide)"
                      className="h-9 w-full rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[13px] focus:outline-none"
                    />
                    <div className="flex items-center justify-end">
                      <IconButton
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        aria-label="Retirer"
                        tone="danger"
                        size="sm"
                        onClick={() => removeRow(row.key)}
                      />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section className="flex items-start gap-3 rounded-[22px] border border-border bg-[#fbf9f8] p-5">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">
            {kind === "boolean"
              ? "Le type booléen gère une seule valeur automatiquement (présent ou absent sur le produit) — aucune valeur à saisir ici."
              : "Ce type stocke une donnée par produit (saisie depuis la fiche produit) — il n'a pas de liste de valeurs."}
          </p>
        </section>
      )}

      {state && !state.ok && (
        <div className="rounded-[14px] border border-destructive/40 bg-destructive/5 p-3 text-[13px] text-destructive">
          {state.message}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
        >
          <Save className="h-4 w-4" />
          {isPending ? "Création…" : "Créer l'attribut"}
        </button>
        <Link
          href="/admin/catalog/attributes"
          className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground hover:bg-surface"
        >
          Annuler
        </Link>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────── Form primitive
function Field({
  name,
  label,
  required,
  type,
  defaultValue,
  placeholder,
  helper,
}: {
  name: string;
  label: string;
  required?: boolean;
  type?: string;
  defaultValue?: string | number | null;
  placeholder?: string;
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
        placeholder={placeholder}
        className="mt-1 h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[14px] focus:outline-none"
      />
      {helper && <p className="mt-1 text-[12px] text-muted-foreground">{helper}</p>}
    </div>
  );
}

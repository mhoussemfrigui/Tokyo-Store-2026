"use client";

import { useActionState } from "react";
import { Save } from "lucide-react";

import { SelectField } from "@/components/ui/select-field";
import { AdminNote } from "@/components/admin/_components/filter-bar";
import { saveHomeSettingsAction } from "@/lib/actions/home";
import { type ActionState } from "@/lib/actions/types";

/**
 * Compact editor for the LISTING-page settings the home block composer doesn't own:
 * the product-grid pagination mode + the « Besoin d'un conseil » help CTA that render
 * on every category / brand listing page. Collapsed by default so it sits
 * quietly beneath the composer. Posts to saveHomeSettingsAction (home:update). Values
 * arrive resolved from the settings map; blank title OR blank button label hides the
 * help block on the storefront (hide-when-unset).
 */
export function ListingSettingsPanel({ values }: { values: Record<string, string | null> }) {
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    saveHomeSettingsAction,
    null,
  );
  const v = (k: string) => values[k] ?? "";

  return (
    <details className="rounded-[28px] border border-border bg-card">
      <summary className="cursor-pointer px-5 py-4 text-[14px] font-bold">
        Réglages des pages de liste
        <span className="ml-2 font-normal text-muted-foreground">
          (pagination + bloc « Besoin d&apos;un conseil » — catégories / marques)
        </span>
      </summary>
      <form action={formAction} className="space-y-5 border-t border-border p-5">
        <div>
          <SelectField
            name="storefront.listing_display_mode"
            label="Mode d'affichage de la grille"
            defaultValue={v("storefront.listing_display_mode") || "load_more"}
            options={[
              { value: "load_more", label: "Bouton « Charger plus » (par défaut)" },
              { value: "infinite", label: "Défilement infini" },
              { value: "pagination", label: "Pagination (pages numérotées)" },
            ]}
            labelClassName="mb-1 block text-[13px] font-bold text-foreground"
          />
          <AdminNote className="mt-1">
            S&apos;applique aux pages catégorie et marque.
          </AdminNote>
        </div>

        <div className="border-t border-border pt-5">
          <p className="mb-1 text-[13px] font-bold text-foreground">
            Bloc « Besoin d&apos;un conseil »
          </p>
          <AdminNote className="mb-3">
            Laissez le titre OU le libellé du bouton vide pour masquer le bloc. Le bouton secondaire
            n&apos;apparaît que si son libellé ET son lien sont remplis.
          </AdminNote>
          <div className="grid gap-3 sm:grid-cols-2">
            <Text name="storefront.help_cta.eyebrow" label="Eyebrow" value={v("storefront.help_cta.eyebrow")} placeholder="Besoin d'un conseil ?" />
            <Text name="storefront.help_cta.title" label="Titre" value={v("storefront.help_cta.title")} placeholder="Pas sûr de votre choix ?" />
          </div>
          <div className="mt-3">
            <Label>Texte</Label>
            <textarea
              name="storefront.help_cta.body"
              defaultValue={v("storefront.help_cta.body")}
              rows={2}
              placeholder="Notre équipe répond rapidement, du lundi au samedi."
              className="w-full resize-y rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] p-3 text-[15px] transition focus:border-foreground focus:bg-white focus:outline-none"
            />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Text name="storefront.help_cta.button_label" label="Bouton — label" value={v("storefront.help_cta.button_label")} placeholder="Discuter avec un expert" />
            <Text name="storefront.help_cta.button_href" label="Bouton — lien" value={v("storefront.help_cta.button_href")} placeholder="/aide" />
            <Text name="storefront.help_cta.secondary_label" label="Bouton secondaire — label" value={v("storefront.help_cta.secondary_label")} placeholder="Voir le guide d'achat" />
            <Text name="storefront.help_cta.secondary_href" label="Bouton secondaire — lien" value={v("storefront.help_cta.secondary_href")} placeholder="/guide" />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
          >
            <Save className="h-4 w-4" />
            {isPending ? "Enregistrement…" : "Enregistrer"}
          </button>
          {state && !state.ok && <p className="text-[14px] text-destructive">{state.message}</p>}
          {state?.ok && <p className="text-[14px] text-[#15803d]">{state.message}</p>}
        </div>
      </form>
    </details>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[13px] font-bold text-foreground">
      {children}
    </span>
  );
}

function Text({ name, label, value, placeholder }: { name: string; label: string; value: string; placeholder?: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <input
        name={name}
        defaultValue={value}
        placeholder={placeholder}
        className="h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] transition focus:border-foreground focus:bg-white focus:outline-none"
      />
    </div>
  );
}

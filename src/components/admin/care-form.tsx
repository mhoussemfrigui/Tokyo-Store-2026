"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { SelectField } from "@/components/ui/select-field";
import { createCarePlanAction, updateCarePlanAction } from "@/lib/actions/care";
import type { ActionState } from "@/lib/actions/types";

export type CareCategoryOpt = { id: string; name: string; depth: number };

export type CareFormInitial = {
  planId: string;
  name: string;
  slug: string;
  description: string;
  durationMonths: number;
  pricingMode: "flat" | "percent";
  /** dinars (string) for the flat price input */
  priceFlat: string;
  /** percent (string) for the percent input */
  pricePercent: string;
  priceRoundTo: string;
  minCharge: string;
  minProductPrice: string;
  requireWarranty: boolean;
  applicableConditions: string[];
  perksText: string;
  icon: string;
  isActive: boolean;
  displayPriority: number;
  scopeCategoryIds: string[];
  scopeIncludeDescendants: boolean;
};

const CONDITIONS: { value: string; label: string }[] = [
  { value: "new", label: "Neuf" },
  { value: "used", label: "Occasion" },
  { value: "refurbished", label: "Reconditionné" },
];

const inputCls =
  "mt-1 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 py-2.5 text-[14px] text-foreground focus:border-foreground focus:bg-white focus:outline-none";
const labelCls = "block text-[13px] font-bold text-foreground";
const hintCls = "mt-1 text-[12px] text-muted-foreground";

export function CareForm({
  mode,
  categories,
  initial,
}: {
  mode: "create" | "edit";
  categories: CareCategoryOpt[];
  initial?: CareFormInitial;
}) {
  const router = useRouter();
  const action = mode === "create" ? createCarePlanAction : updateCarePlanAction;
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(action, null);
  const [pricingMode, setPricingMode] = useState<"flat" | "percent">(initial?.pricingMode ?? "percent");

  useEffect(() => {
    if (state?.ok) router.push("/admin/catalog/care");
  }, [state?.ok, router]);

  const err = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);

  return (
    <form action={formAction} className="max-w-3xl space-y-8">
      {mode === "edit" && <input type="hidden" name="planId" value={initial?.planId} />}

      {state && !state.ok && (
        <p role="alert" className="rounded-[14px] border border-[#f3c6ce] bg-[#fdecef] px-4 py-2.5 text-[14px] font-bold text-[#d40530]">
          {state.message}
        </p>
      )}

      {/* ── Identité ── */}
      <section className="space-y-4 rounded-[28px] border border-border bg-card p-5">
        <h2 className="text-[18px] font-black text-foreground">Identité</h2>
        <div>
          <label className={labelCls} htmlFor="name">Nom du plan *</label>
          <input id="name" name="name" defaultValue={initial?.name} required maxLength={120} className={inputCls} placeholder="Tokyo Care 24 mois" />
          {err("name") && <p className="mt-1 text-[12px] font-medium text-[#d40530]">{err("name")}</p>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="slug">Slug</label>
            <input id="slug" name="slug" defaultValue={initial?.slug} maxLength={120} className={inputCls} placeholder="(auto depuis le nom)" />
            {err("slug") && <p className="mt-1 text-[12px] font-medium text-[#d40530]">{err("slug")}</p>}
          </div>
          <div>
            <label className={labelCls} htmlFor="icon">Icône (clé lucide)</label>
            <input id="icon" name="icon" defaultValue={initial?.icon} maxLength={60} className={inputCls} placeholder="ShieldCheck" />
          </div>
        </div>
        <div>
          <label className={labelCls} htmlFor="description">Description (ligne marketing)</label>
          <input id="description" name="description" defaultValue={initial?.description} maxLength={2000} className={inputCls} placeholder="Casse, oxydation & panne couvertes" />
        </div>
        <div>
          <label className={labelCls} htmlFor="perksText">Couverture — un avantage par ligne</label>
          <textarea id="perksText" name="perksText" defaultValue={initial?.perksText} rows={4} className={inputCls} placeholder={"Écran cassé, chutes et dégâts des eaux couverts\nRéparation à l'atelier Tokyo Repair ou échange"} />
          <p className={hintCls}>Jusqu'à 20 lignes. Affichées sur la fiche produit et au panier.</p>
        </div>
      </section>

      {/* ── Tarif & durée ── */}
      <section className="space-y-4 rounded-[28px] border border-border bg-card p-5">
        <h2 className="text-[18px] font-black text-foreground">Tarif & durée</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="durationMonths">Durée (mois) *</label>
            <input id="durationMonths" name="durationMonths" type="number" min={1} max={600} defaultValue={initial?.durationMonths ?? 12} required className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Mode de tarification</label>
            <SelectField
              name="pricingMode"
              ariaLabel="Mode de tarification"
              value={pricingMode}
              onChange={(v) => setPricingMode(v as "flat" | "percent")}
              options={[
                { value: "percent", label: "Pourcentage du prix produit" },
                { value: "flat", label: "Prix fixe" },
              ]}
              className="mt-1"
              triggerClassName="h-10"
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className={pricingMode === "percent" ? "" : "hidden"}>
            <label className={labelCls} htmlFor="pricePercent">Pourcentage (%)</label>
            <input id="pricePercent" name="pricePercent" defaultValue={initial?.pricePercent} inputMode="decimal" className={inputCls} placeholder="7" />
            <p className={hintCls}>Ex. 7 = 7 % du prix du produit.</p>
          </div>
          <div className={pricingMode === "flat" ? "" : "hidden"}>
            <label className={labelCls} htmlFor="priceFlat">Prix fixe (TND)</label>
            <input id="priceFlat" name="priceFlat" defaultValue={initial?.priceFlat} inputMode="decimal" className={inputCls} placeholder="29" />
          </div>
          <div>
            <label className={labelCls} htmlFor="minCharge">Montant minimum (TND)</label>
            <input id="minCharge" name="minCharge" defaultValue={initial?.minCharge} inputMode="decimal" className={inputCls} placeholder="19" />
            <p className={hintCls}>Plancher du tarif calculé (0 = aucun).</p>
          </div>
          <div>
            <label className={labelCls} htmlFor="priceRoundTo">Arrondir au pas de (TND)</label>
            <input id="priceRoundTo" name="priceRoundTo" defaultValue={initial?.priceRoundTo} inputMode="decimal" className={inputCls} placeholder="10" />
            <p className={hintCls}>0 = pas d'arrondi ; 10 = au multiple de 10 TND.</p>
          </div>
        </div>
      </section>

      {/* ── Éligibilité ── */}
      <section className="space-y-4 rounded-[28px] border border-border bg-card p-5">
        <h2 className="text-[18px] font-black text-foreground">Éligibilité</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="minProductPrice">Prix produit minimum (TND)</label>
            <input id="minProductPrice" name="minProductPrice" defaultValue={initial?.minProductPrice} inputMode="decimal" className={inputCls} placeholder="150" />
          </div>
          <label className="flex items-center gap-2 pt-7 text-[14px] text-foreground">
            <input type="checkbox" name="requireWarranty" defaultChecked={initial?.requireWarranty ?? true} className="size-4 rounded border-input accent-[var(--primary)]" />
            Produits garantis uniquement
          </label>
        </div>
        <div>
          <span className={labelCls}>Conditions applicables</span>
          <div className="mt-2 flex flex-wrap gap-4">
            {CONDITIONS.map((c) => (
              <label key={c.value} className="flex items-center gap-2 text-[14px] text-foreground">
                <input type="checkbox" name="applicableConditions" value={c.value} defaultChecked={initial ? initial.applicableConditions.includes(c.value) : true} className="size-4 rounded border-input accent-[var(--primary)]" />
                {c.label}
              </label>
            ))}
          </div>
          <p className={hintCls}>Aucune cochée = toutes les conditions.</p>
        </div>
      </section>

      {/* ── Activation (catégories) ── */}
      <section className="space-y-4 rounded-[28px] border border-border bg-card p-5">
        <h2 className="text-[18px] font-black text-foreground">Activation par catégorie</h2>
        <p className="text-[13px] text-muted-foreground">
          Le plan est proposé sur les produits des catégories cochées. L'activation par produit se fait
          depuis la fiche produit (onglet Tokyo Care).
        </p>
        <label className="flex items-center gap-2 text-[14px] text-foreground">
          <input type="checkbox" name="scopeIncludeDescendants" defaultChecked={initial?.scopeIncludeDescendants ?? true} className="size-4 rounded border-input accent-[var(--primary)]" />
          Inclure les sous-catégories
        </label>
        <div className="max-h-72 overflow-y-auto rounded-[16px] border border-border bg-[#fbf9f8] p-3">
          {categories.length === 0 ? (
            <p className="text-[14px] text-muted-foreground">Aucune catégorie.</p>
          ) : (
            categories.map((c) => (
              <label key={c.id} className="flex items-center gap-2 py-1 text-[14px] text-foreground" style={{ paddingLeft: `${c.depth * 16}px` }}>
                <input type="checkbox" name="scopeCategoryIds" value={c.id} defaultChecked={initial?.scopeCategoryIds.includes(c.id)} className="size-4 rounded border-input accent-[var(--primary)]" />
                {c.name}
              </label>
            ))
          )}
        </div>
      </section>

      {/* ── Affichage ── */}
      <section className="space-y-4 rounded-[28px] border border-border bg-card p-5">
        <h2 className="text-[18px] font-black text-foreground">Affichage</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="displayPriority">Priorité d'affichage</label>
            <input id="displayPriority" name="displayPriority" type="number" min={0} defaultValue={initial?.displayPriority ?? 0} className={inputCls} />
            <p className={hintCls}>Plus élevé = affiché en premier.</p>
          </div>
          <label className="flex items-center gap-2 pt-7 text-[14px] text-foreground">
            <input type="checkbox" name="isActive" defaultChecked={initial?.isActive ?? true} className="size-4 rounded border-input accent-[var(--primary)]" />
            Actif (proposé aux clients)
          </label>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60">
          {pending ? "Enregistrement…" : mode === "create" ? "Créer le plan" : "Enregistrer"}
        </button>
        <Link href="/admin/catalog/care" className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground hover:bg-surface">
          Annuler
        </Link>
      </div>
    </form>
  );
}

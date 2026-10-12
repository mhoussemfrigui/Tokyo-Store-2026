import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { AdminPageHeader } from "@/components/admin/page-header";
import {
  getTaxConfigStrict,
  getCareTaxConfigStrict,
  percentFromBps,
} from "@/lib/tax";
import { taxQueries } from "@/modules/tax";
import { listAttributesWithValues } from "@/modules/catalog/attribute/queries";
import { saveBrandTaxRatesAction, saveCategoryTaxRatesAction } from "@/lib/actions/tax";
import { db } from "@/lib/db/client";
import { brands } from "@/modules/catalog/brand/schema";
import { categories } from "@/modules/catalog/category/schema";
import { asc, isNull } from "drizzle-orm";

import { TaxSettingsPanel } from "./tax-settings-panel";
import { TaxRulesPanel, type TaxRuleGroup } from "./tax-rules-panel";
import { EntityTaxEditor, type TaxRateItem } from "./entity-tax-editor";
import { TaxTabs } from "./tax-tabs";

export const metadata: Metadata = { title: "Taxes" };

/**
 * Tax control — the global TVA config plus the per-filter, per-brand and
 * per-category override tiers.
 *
 * Precedence (most-specific-wins): produit → filtre → marque → catégorie →
 * global (brand outranks category). This page owns the GLOBAL base (mode +
 * default rate + label + shipping), the FILTRE tier (per-attribute-value
 * rules), and the MARQUE + CATÉGORIE tiers (bulk `tax_rate_bps` editors below).
 * Product-level overrides are edited on the product page; brands/categories
 * stay editable on their own pages too (same `tax_rate_bps` column).
 *
 * Server-loads in parallel: the resolved config, every attribute value, and
 * the current rules — then builds a percent-per-value map for the rules panel.
 */
export default async function TaxSettingsPage() {
  await requirePermission("system_tax", "view");
  // STRICT config read (no soft "disabled" fallback): a failed settings read
  // must reach the admin error boundary (retry), not prefill the form with
  // mode « désactivée » that a save would then persist over the live mode.
  const [config, careTax, attributes, rules, brandRows, categoryRows] = await Promise.all([
    getTaxConfigStrict(),
    getCareTaxConfigStrict(),
    listAttributesWithValues(),
    taxQueries.taxService.listWithLabels(),
    db.select({ id: brands.id, name: brands.name, bps: brands.tax_rate_bps }).from(brands).where(isNull(brands.deleted_at)).orderBy(asc(brands.name)),
    db.select({ id: categories.id, name: categories.name, bps: categories.tax_rate_bps }).from(categories).where(isNull(categories.deleted_at)).orderBy(asc(categories.name)),
  ]);

  const brandItems: TaxRateItem[] = brandRows.map((b) => ({ id: b.id, name: b.name, percent: b.bps != null ? percentFromBps(b.bps) : null }));
  const categoryItems: TaxRateItem[] = categoryRows.map((c) => ({ id: c.id, name: c.name, percent: c.bps != null ? percentFromBps(c.bps) : null }));

  // attribute_value_id → current rule rate in PERCENT.
  const ruleByValueId = new Map<string, number>();
  for (const r of rules) {
    ruleByValueId.set(r.attribute_value_id, percentFromBps(r.rate_bps));
  }

  const groups: TaxRuleGroup[] = attributes.map((a) => ({
    attributeName: a.name,
    values: a.values.map((v) => ({
      valueId: v.id,
      label: v.label,
      currentPercent: ruleByValueId.get(v.id) ?? null,
    })),
  }));

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/system"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour au Système
        </Link>
        <div className="mt-2">
          <AdminPageHeader
            title="Taxes"
            description="Configuration de la TVA : mode, taux global et surcharges par filtre. Les valeurs sont stockées dans les réglages site (clés tax.*)."
          />
        </div>
      </div>

      {/* Precedence explainer — the cascade is the mental model for the whole page. */}
      <div className="rounded-2xl border border-dashed border-border bg-surface/40 px-5 py-4 text-xs leading-relaxed text-muted-foreground">
        <p className="font-semibold text-foreground">Ordre de priorité du taux</p>
        <p className="mt-1.5">
          Pour chaque ligne, le taux le plus spécifique l&apos;emporte :{" "}
          <span className="font-semibold text-foreground">produit</span>
          {" → "}
          <span className="font-semibold text-foreground">filtre</span>
          {" → "}
          <span className="font-semibold text-foreground">marque</span>
          {" → "}
          <span className="font-semibold text-foreground">catégorie</span>
          {" → "}
          <span className="font-semibold text-foreground">global</span>. Une marque
          prime sur la catégorie ; un filtre prime sur la marque ; le produit prime
          sur tout. Le taux par produit se règle sur la fiche produit ; marque,
          catégorie et filtre se règlent ci-dessous.
        </p>
      </div>

      <TaxTabs
        global={<TaxSettingsPanel config={config} careTax={careTax} />}
        brands={
          <EntityTaxEditor
            title="Taux par marque"
            description="TVA spécifique à une marque (entre le tier filtre et catégorie). Laissez vide pour hériter de la catégorie / du taux global."
            items={brandItems}
            action={saveBrandTaxRatesAction}
            emptyLabel="Aucune marque."
          />
        }
        categories={
          <EntityTaxEditor
            title="Taux par catégorie"
            description="TVA spécifique à une catégorie (entre le tier marque et global). Une sous-catégorie sans taux hérite de son parent. Laissez vide pour hériter du taux global."
            items={categoryItems}
            action={saveCategoryTaxRatesAction}
            emptyLabel="Aucune catégorie."
          />
        }
        filters={<TaxRulesPanel groups={groups} />}
      />
    </div>
  );
}

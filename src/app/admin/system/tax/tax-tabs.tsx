"use client";

import { FormTabs, FormTab, type FormTabDef } from "@/components/admin/_components/form-tabs";

type TaxTabId = "global" | "brands" | "categories" | "filters";

const TAX_TABS: ReadonlyArray<FormTabDef<TaxTabId>> = [
  { id: "global", label: "Global" },
  { id: "brands", label: "Marques" },
  { id: "categories", label: "Catégories" },
  { id: "filters", label: "Filtres" },
];

/**
 * Sub-tab shell for the Taxes page — one tab per cascade tier so each gets its
 * own screen instead of one long scroll (Global · Marques · Catégories ·
 * Filtres). A thin client wrapper because `FormTabs` is a client render-prop
 * component and the page is a server component: the four tier panels are passed
 * in as already-rendered slots. Each tier keeps its own independent `<form>`
 * (or per-row forms for Filtres); `FormTab` keeps every panel mounted via the
 * `hidden` attribute, so saving one tier never disturbs the others. Product-
 * level tax stays on the product page, so it is intentionally not a tab here.
 */
export function TaxTabs({
  global,
  brands,
  categories,
  filters,
}: {
  global: React.ReactNode;
  brands: React.ReactNode;
  categories: React.ReactNode;
  filters: React.ReactNode;
}) {
  return (
    <FormTabs tabs={TAX_TABS} defaultTab="global">
      {(active) => (
        <>
          <FormTab id="global" active={active}>
            {global}
          </FormTab>
          <FormTab id="brands" active={active}>
            {brands}
          </FormTab>
          <FormTab id="categories" active={active}>
            {categories}
          </FormTab>
          <FormTab id="filters" active={active}>
            {filters}
          </FormTab>
        </>
      )}
    </FormTabs>
  );
}

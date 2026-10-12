"use client";

import { useState } from "react";

import { SelectField } from "@/components/ui/select-field";
import type { ProductFormCarePlan } from "@/components/admin/product-form";

/**
 * "Tokyo Care" product sub-tab. For each active plan the operator picks how it
 * applies to THIS product:
 *   - Auto      — follow the plan's category scope (no product_care row).
 *   - Toujours  — force the plan ON for this product (include), with an optional
 *                 price override.
 *   - Jamais    — force it OFF for this product (exclude).
 * Only non-Auto rows emit FormData (`careMode.<id>` + `careOverride.<id>`), which
 * `pickCareLinks` (catalog action) turns into the workflow's `careLinks`. The
 * picker is pre-filled from the stored overrides so a plain save preserves them.
 */
type Mode = "auto" | "include" | "exclude";

type CareInitialLink = { carePlanId: string; mode: "include" | "exclude"; overrideDinars: string };

const selectCls =
  "rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none";

export function CareAssignmentPicker({
  plans,
  scopeOfferedIds = [],
  initial = [],
}: {
  plans: ProductFormCarePlan[];
  scopeOfferedIds?: string[];
  initial?: CareInitialLink[];
}) {
  const initialByPlan = new Map(initial.map((l) => [l.carePlanId, l]));
  const scoped = new Set(scopeOfferedIds);
  const [rows, setRows] = useState<Record<string, { mode: Mode; override: string }>>(() => {
    const out: Record<string, { mode: Mode; override: string }> = {};
    for (const p of plans) {
      const ov = initialByPlan.get(p.id);
      out[p.id] = { mode: ov?.mode ?? "auto", override: ov?.overrideDinars ?? "" };
    }
    return out;
  });

  const setMode = (id: string, mode: Mode) =>
    setRows((r) => ({ ...r, [id]: { ...r[id], mode } }));
  const setOverride = (id: string, override: string) =>
    setRows((r) => ({ ...r, [id]: { ...r[id], override } }));

  if (plans.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
        Aucun plan Tokyo Care actif. Créez-en un dans Catalogue → Tokyo Care, puis revenez ici pour
        l&apos;activer ou l&apos;exclure sur ce produit.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        « Auto » suit le périmètre (catégories) défini sur le plan. « Toujours » force le plan sur ce
        produit (avec un tarif personnalisé facultatif) ; « Jamais » l&apos;exclut, même si sa catégorie
        le couvre.
      </p>
      <div className="overflow-hidden rounded-2xl border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-surface/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-semibold">Plan</th>
              <th className="px-3 py-2 font-semibold">Tarif</th>
              <th className="px-3 py-2 font-semibold">Sur ce produit</th>
              <th className="px-3 py-2 font-semibold">Tarif personnalisé (TND)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {plans.map((p) => {
              const row = rows[p.id] ?? { mode: "auto" as Mode, override: "" };
              return (
                <tr key={p.id}>
                  <td className="px-3 py-2 font-medium text-foreground">{p.name}</td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">{p.priceSummary}</td>
                  <td className="px-3 py-2">
                    <SelectField
                      ariaLabel={`Tokyo Care — ${p.name}`}
                      size="sm"
                      value={row.mode}
                      onChange={(v) => setMode(p.id, v as Mode)}
                      options={[
                        {
                          value: "auto",
                          label: `Auto ${scoped.has(p.id) ? "(proposé via catégorie)" : "(non proposé)"}`,
                        },
                        { value: "include", label: "Toujours proposer" },
                        { value: "exclude", label: "Ne jamais proposer" },
                      ]}
                    />
                    {row.mode !== "auto" && (
                      <input type="hidden" name={`careMode.${p.id}`} value={row.mode} />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {row.mode === "include" ? (
                      <input
                        inputMode="decimal"
                        placeholder="(tarif du plan)"
                        className={`${selectCls} w-32`}
                        name={`careOverride.${p.id}`}
                        value={row.override}
                        onChange={(e) => setOverride(p.id, e.target.value)}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

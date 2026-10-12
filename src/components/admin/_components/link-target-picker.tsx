"use client";

import { useState } from "react";

import { LINK_KIND_OPTIONS, resolveLinkHref, type LinkKind } from "@/lib/links/link-target";
import { SelectField } from "@/components/ui/select-field";

export type LinkOption = { value: string; label: string };

const CONTROL_CLASS =
  "h-10 w-full rounded-xl border border-border bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40";

/**
 * Unified link-target picker used by BOTH promo chips and nav items. The admin
 * picks a kind (manual URL, or an internal target: system page / category /
 * brand / CMS page) then the specific target. Posts two fields the server
 * action reads: `linkKind` and `linkValue`. Shows a live resolved-URL preview.
 *
 * A value per kind is kept in state so toggling kinds doesn't lose input, and a
 * target that no longer exists (deleted category, etc.) is surfaced as
 * "(introuvable)" instead of silently clearing.
 */
export function LinkTargetPicker({
  initialKind,
  initialValue,
  systemPages,
  categories,
  brands,
  pages,
}: {
  initialKind: LinkKind;
  initialValue: string;
  systemPages: LinkOption[];
  categories: LinkOption[];
  brands: LinkOption[];
  pages: LinkOption[];
}) {
  const [kind, setKind] = useState<LinkKind>(initialKind);
  const [urlValue, setUrlValue] = useState(initialKind === "url" ? initialValue : "");
  const [refValue, setRefValue] = useState(initialKind === "url" ? "" : initialValue);

  const optionsByKind: Record<Exclude<LinkKind, "url">, LinkOption[]> = {
    system: systemPages,
    category: categories,
    brand: brands,
    page: pages,
  };

  const value = kind === "url" ? urlValue : refValue;
  const preview =
    kind === "url"
      ? resolveLinkHref({ href: urlValue })
      : resolveLinkHref({ internalKind: kind, internalRef: refValue });

  let entityOptions: LinkOption[] = [];
  if (kind !== "url") {
    const base = optionsByKind[kind] ?? [];
    entityOptions =
      refValue && !base.some((o) => o.value === refValue)
        ? [{ value: refValue, label: `${refValue} (introuvable)` }, ...base]
        : base;
  }

  return (
    <div className="space-y-2 sm:col-span-2">
      <span className="text-xs font-medium text-muted-foreground">Lien / cible</span>
      {/* Read by the server action (readLinkTarget). */}
      <input type="hidden" name="linkKind" value={kind} />
      <input type="hidden" name="linkValue" value={value} />

      <div className="grid gap-2 sm:grid-cols-2">
        <SelectField
          ariaLabel="Type de cible"
          size="sm"
          value={kind}
          onChange={(v) => setKind(v as LinkKind)}
          options={LINK_KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />

        {kind === "url" ? (
          <input
            type="text"
            aria-label="URL ou chemin"
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            placeholder="/promotions ou https://…"
            className={CONTROL_CLASS}
          />
        ) : (
          <SelectField
            ariaLabel="Cible"
            size="sm"
            placeholder="— Choisir —"
            value={refValue}
            onChange={setRefValue}
            options={[
              { value: "", label: "— Choisir —" },
              ...entityOptions.map((o) => ({ value: o.value, label: o.label })),
            ]}
          />
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        {preview === "#" ? (
          kind === "url" ? (
            urlValue.trim() ? (
              <span className="text-destructive">
                URL non autorisée (http(s)://, mailto:, tel:, /chemin ou #ancre).
              </span>
            ) : (
              "Saisissez une URL ou un chemin."
            )
          ) : (
            "Choisissez une cible."
          )
        ) : (
          <>
            Destination : <code className="rounded bg-surface px-1.5 py-0.5">{preview}</code>
          </>
        )}
      </p>
    </div>
  );
}

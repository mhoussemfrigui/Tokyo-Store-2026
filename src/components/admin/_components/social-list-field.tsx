"use client";

import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";

import { fieldInputCls } from "@/components/admin/_components/setting-fields";
import { PLATFORM_META } from "@/components/social-icons";
import {
  SOCIAL_LINKS_KEY,
  SOCIAL_PLATFORMS,
  type SocialLink,
  type SocialPlatform,
} from "@/lib/cms/social-list";

type Row = { id: string; url: string; label: string };

/**
 * Repeatable social-links editor, grouped by platform — the operator can add
 * MORE THAN ONE link per platform (two Facebook pages, two Instagram accounts…).
 * Each platform shows its icon + name and a list of {url, optional label} rows
 * with add/remove. Posts ONE hidden `social.links[]` input per non-empty row
 * carrying JSON `{p,u,l?}` (order preserved), read by `readSocialListFromForm`.
 * Shared by « Identité & contact » and the Footer tab, so both edit the SAME
 * list (mirrors ContactListField).
 */
export function SocialListField({ initial }: { initial: SocialLink[] }) {
  const counter = useRef(0);
  const mkRow = (url = "", label = ""): Row => ({ id: `s${counter.current++}`, url, label });

  const [groups, setGroups] = useState<Record<SocialPlatform, Row[]>>(() => {
    const g = {} as Record<SocialPlatform, Row[]>;
    for (const p of SOCIAL_PLATFORMS) {
      const links = initial.filter((l) => l.platform === p);
      g[p] = links.length ? links.map((l) => mkRow(l.url, l.label ?? "")) : [mkRow()];
    }
    return g;
  });

  const setRow = (p: SocialPlatform, id: string, patch: Partial<Row>) =>
    setGroups((g) => ({ ...g, [p]: g[p].map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  const addRow = (p: SocialPlatform) => setGroups((g) => ({ ...g, [p]: [...g[p], mkRow()] }));
  const removeRow = (p: SocialPlatform, id: string) =>
    setGroups((g) => {
      const next = g[p].filter((r) => r.id !== id);
      return { ...g, [p]: next.length ? next : [mkRow()] };
    });

  return (
    <div className="space-y-5">
      {SOCIAL_PLATFORMS.map((p) => {
        const { name, Icon } = PLATFORM_META[p];
        const rows = groups[p];
        return (
          <div key={p}>
            <div className="mb-2 flex items-center gap-2">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-foreground">
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="text-[13px] font-bold text-foreground">{name}</span>
            </div>
            <div className="space-y-2">
              {rows.map((row, i) => (
                <div key={row.id} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                  <input
                    type="url"
                    inputMode="url"
                    value={row.url}
                    onChange={(e) => setRow(p, row.id, { url: e.target.value })}
                    placeholder={`https://${p === "x" ? "x.com" : p === "linkedin" ? "linkedin.com/company" : `${p}.com`}/tokyostore`}
                    aria-label={`${name} — URL ${i + 1}`}
                    className={`${fieldInputCls} min-w-0 flex-1`}
                  />
                  <input
                    type="text"
                    value={row.label}
                    onChange={(e) => setRow(p, row.id, { label: e.target.value })}
                    placeholder="Libellé (optionnel)"
                    aria-label={`${name} — libellé ${i + 1}`}
                    className={`${fieldInputCls} w-full sm:w-44`}
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(p, row.id)}
                    aria-label={`Retirer ce lien ${name}`}
                    className="grid size-[50px] shrink-0 place-items-center rounded-[14px] border-[1.5px] border-input text-muted-foreground transition-colors hover:border-destructive/50 hover:text-destructive"
                  >
                    <X className="size-4" />
                  </button>
                  {row.url.trim() && (
                    <input
                      type="hidden"
                      name={`${SOCIAL_LINKS_KEY}[]`}
                      value={JSON.stringify({
                        p,
                        u: row.url.trim(),
                        ...(row.label.trim() ? { l: row.label.trim() } : {}),
                      })}
                    />
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => addRow(p)}
              className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-primary/50 hover:text-primary"
            >
              <Plus className="size-3.5" />
              Ajouter un lien {name}
            </button>
          </div>
        );
      })}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Ajoutez plusieurs liens par réseau (ex. deux pages Facebook). Le libellé
        optionnel s&apos;affiche à côté de l&apos;icône dans le pied de page. Laissez un
        réseau vide pour masquer son icône.
      </p>
    </div>
  );
}

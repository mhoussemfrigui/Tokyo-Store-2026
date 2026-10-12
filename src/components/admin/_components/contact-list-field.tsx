"use client";

import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";

import { fieldInputCls, labelCls } from "@/components/admin/_components/setting-fields";
import type { ContactEntry } from "@/lib/cms/contact-list";

type Row = ContactEntry & { id: string };

/**
 * Repeatable contact-list editor (phones / emails / addresses). Each row is a
 * value input + a « Footer » checkbox that selects whether that entry shows in
 * the storefront footer. Shared by « Identité & contact » and the Footer tab, so
 * both edit the SAME list. Submits ONE hidden input per non-empty row named
 * `${base}[]` carrying JSON `{v,f}` — the save action reads it with
 * `readContactListFromForm` (order preserved, no index-misalignment). Controlled
 * (React state) because rows add/remove; empty rows are dropped on save. Rows
 * carry a stable id so a mid-list removal keeps focus + survives future reorder.
 */
export function ContactListField({
  base,
  label,
  placeholder,
  type = "text",
  initial,
  helper,
  addLabel = "Ajouter",
}: {
  base: string;
  label: string;
  placeholder?: string;
  type?: "text" | "email" | "tel";
  initial: ContactEntry[];
  helper?: string;
  addLabel?: string;
}) {
  const seed = initial.length ? initial : [{ value: "", footer: true }];
  const [rows, setRows] = useState<Row[]>(() => seed.map((r, i) => ({ ...r, id: `r${i}` })));
  const nextId = useRef(seed.length);
  const blank = (): Row => ({ value: "", footer: true, id: `r${nextId.current++}` });

  const setValue = (id: string, value: string) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, value } : r)));
  const setFooter = (id: string, footer: boolean) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, footer } : r)));
  const remove = (id: string) =>
    setRows((rs) => {
      const next = rs.filter((r) => r.id !== id);
      return next.length ? next : [blank()];
    });
  const add = () => setRows((rs) => [...rs, blank()]);

  return (
    <div>
      <span className={labelCls}>{label}</span>
      <div className="mt-2 space-y-2">
        {rows.map((row, i) => (
          <div key={row.id} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
            <input
              type={type}
              value={row.value}
              onChange={(e) => setValue(row.id, e.target.value)}
              placeholder={placeholder}
              aria-label={`${label} ${i + 1}`}
              className={`${fieldInputCls} min-w-0 flex-1`}
            />
            {/* « Footer » switch — whether this entry shows in the storefront footer.
                Compact sibling of the ToggleField switch (same track/knob colours). */}
            <label className="inline-flex h-[50px] shrink-0 cursor-pointer items-center gap-2 rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3.5 text-[12px] font-bold text-muted-foreground">
              <span className="relative inline-flex h-5 w-[34px] shrink-0 items-center">
                <input
                  type="checkbox"
                  checked={row.footer}
                  onChange={(e) => setFooter(row.id, e.target.checked)}
                  aria-label={`Afficher dans le pied de page — ${label} ${i + 1}`}
                  className="peer sr-only"
                />
                <span className="h-5 w-[34px] rounded-full bg-[#d8d1c9] transition-colors peer-checked:bg-[#16a34a] peer-focus-visible:ring-2 peer-focus-visible:ring-[rgba(14,18,24,0.18)]" />
                <span className="absolute left-[3px] size-[14px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-transform peer-checked:translate-x-[14px]" />
              </span>
              Footer
            </label>
            <button
              type="button"
              onClick={() => remove(row.id)}
              aria-label="Retirer cette ligne"
              className="grid size-[50px] shrink-0 place-items-center rounded-[14px] border-[1.5px] border-input text-muted-foreground transition-colors hover:border-destructive/50 hover:text-destructive"
            >
              <X className="size-4" />
            </button>
            {/* Submitted value — JSON per row; empty rows are dropped on save. */}
            {row.value.trim() && (
              <input type="hidden" name={`${base}[]`} value={JSON.stringify({ v: row.value.trim(), f: row.footer })} />
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-primary/50 hover:text-primary"
      >
        <Plus className="size-3.5" />
        {addLabel}
      </button>
      {helper && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{helper}</p>}
    </div>
  );
}

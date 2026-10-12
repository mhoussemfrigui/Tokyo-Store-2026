"use client";

import { useState } from "react";

/**
 * Color picker field for the theme panel — a native swatch + a free-text hex
 * input kept in sync, submitting a single value under `name`. The server
 * re-validates (getThemeConfig only accepts strict hex), so a pasted bad value
 * is rejected on save; this is purely the editing UX.
 *
 * `defaultValue` is the STORED value (blank when the operator never set it), and
 * `placeholder` is the effective default shown greyed-in + used as the swatch
 * fallback. A BLANK field therefore submits blank — the setting stays unset, so
 * the storefront keeps its built-in default (nothing is materialised on save).
 */
export function ColorField({
  name,
  label,
  defaultValue,
  placeholder,
  helper,
  onValueChange,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  /** Effective default hex (greyed placeholder + swatch fallback when blank). */
  placeholder?: string;
  helper?: string;
  /** Mirror changes up to the panel (for the live preview) — input stays here. */
  onValueChange?: (value: string) => void;
}) {
  const [val, setVal] = useState((defaultValue || "").trim());
  const update = (next: string) => {
    setVal(next);
    onValueChange?.(next);
  };
  // The native <input type=color> needs a valid #rrggbb. When the field is blank
  // the swatch shows the effective default (the placeholder), falling back to the
  // brand crimson if that isn't a 6-digit hex either.
  const ph = (placeholder || "").trim();
  const fallback = /^#[0-9a-fA-F]{6}$/.test(ph) ? ph : "#d40530";
  const swatch = /^#[0-9a-fA-F]{6}$/.test(val) ? val : fallback;

  return (
    <div>
      <span className="flex flex-wrap items-center gap-2 text-[13px] font-bold text-foreground">
        {label}
      </span>
      <div className="mt-2 flex items-center gap-3">
        <input
          type="color"
          aria-label={`${label} — sélecteur`}
          value={swatch}
          onChange={(e) => update(e.target.value)}
          className="h-11 w-14 shrink-0 cursor-pointer rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] p-1"
        />
        <input
          type="text"
          inputMode="text"
          spellCheck={false}
          value={val}
          onChange={(e) => update(e.target.value)}
          aria-label={`${label} — code hexadécimal`}
          placeholder={ph || "#d40530"}
          className="h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 font-mono text-[15px] transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]"
        />
      </div>
      {/* The submitted value — the raw text (blank = keep default), so the server
          can validate/reject and an untouched field never materialises a token. */}
      <input type="hidden" name={name} value={val} />
      {helper && <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">{helper}</p>}
    </div>
  );
}

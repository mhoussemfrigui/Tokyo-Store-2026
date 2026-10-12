"use client";

import { useMemo, useState, type ReactNode } from "react";
import { BadgeCheck, ShieldAlert } from "lucide-react";

import { SelectField } from "@/components/ui/select-field";
import { COUNTRY_DIAL_CODES, composePhone, splitPhone } from "@/lib/format/country-codes";

/**
 * Phone input with an international dial-code selector (e.g. « +216 » for
 * Tunisia). Ported from Game Zone, adapted to this app's SelectField.
 *
 *  - the country picker shows the DIAL CODE only (« +216 »); the country name
 *    rides along as each option's muted description (no flag emoji — it degrades
 *    to raw ISO letters on Windows);
 *  - the two visible parts (dial + national number) are joined into ONE hidden
 *    `<input name>` carrying e.g. « +216 20123456 », so any `formData.get(name)`
 *    consumer keeps working (they normalize it to digits via normalizePhoneDigits);
 *  - `defaultValue` is re-split for editing so a bare 8-digit local number stays
 *    Tunisian.
 */
const DEFAULT_LABEL_CLASS =
  "mb-1.5 block text-[0.6rem] font-medium uppercase tracking-[0.15em] text-muted-foreground/70";
const DEFAULT_CONTROL_CLASS =
  "h-12 border-border/40 bg-transparent text-sm text-foreground";

// Options show ONLY the dial code « +216 »; the country name is the muted description
// AND a search keyword (so typing « france » or « 33 » finds « +33 »). The value is the
// dial code, so shared codes (+1 US/CA, +7 RU/KZ) collapse to ONE option — the first
// (priority-ordered) country labels it, and the others' names ride along as keywords so
// « canada » / « kazakhstan » still find it.
const DIAL_OPTIONS = (() => {
  const byDial = new Map<
    string,
    { value: string; label: string; description: string; keywords: string[] }
  >();
  for (const c of COUNTRY_DIAL_CODES) {
    const existing = byDial.get(c.dial);
    if (existing) {
      existing.keywords.push(c.name);
    } else {
      byDial.set(c.dial, {
        value: c.dial,
        label: `+${c.dial}`,
        description: c.name,
        keywords: [c.name, c.dial, `+${c.dial}`],
      });
    }
  }
  return [...byDial.values()];
})();

export function PhoneNumberField({
  name,
  label,
  defaultValue,
  required,
  id,
  autoComplete = "tel",
  ariaLabel,
  labelClassName = DEFAULT_LABEL_CLASS,
  /** Extra classes merged onto BOTH controls (height/border/bg — not radius). */
  controlClassName = DEFAULT_CONTROL_CLASS,
  verifyStatus,
  readOnly = false,
  note,
}: {
  name: string;
  label?: string;
  defaultValue?: string | null;
  required?: boolean;
  id?: string;
  autoComplete?: string;
  ariaLabel?: string;
  labelClassName?: string;
  controlClassName?: string;
  verifyStatus?: "verified" | "unverified";
  readOnly?: boolean;
  note?: ReactNode;
}) {
  const initial = useMemo(() => splitPhone(defaultValue), [defaultValue]);
  const [dial, setDial] = useState(initial.dial);
  const [national, setNational] = useState(initial.national);
  const fieldId = id ?? `phone-${name}`;
  const combined = composePhone(dial, national);

  const badge =
    verifyStatus === "verified" ? (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-olive/10 px-2 py-0.5 text-[11px] font-semibold text-olive">
        <BadgeCheck className="h-3.5 w-3.5" /> Vérifié
      </span>
    ) : verifyStatus === "unverified" ? (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600">
        <ShieldAlert className="h-3.5 w-3.5" /> Non vérifié
      </span>
    ) : null;

  const labelEl = label ? (
    <label htmlFor={fieldId} className={labelClassName}>
      {label}
      {required && <span className="ml-0.5 text-destructive">*</span>}
    </label>
  ) : null;

  // READ-ONLY — static display + badge; the hidden input still submits the value.
  if (readOnly) {
    return (
      <div>
        {labelEl}
        <div
          className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3.5 ${controlClassName}`}
        >
          <span className="truncate text-sm text-foreground">{national ? combined : "—"}</span>
          {badge}
        </div>
        {note && <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{note}</p>}
        <input type="hidden" name={name} value={combined} />
      </div>
    );
  }

  return (
    <div>
      {labelEl}
      <div className="flex gap-2">
        <SelectField
          ariaLabel="Indicatif pays"
          options={DIAL_OPTIONS}
          value={dial}
          onChange={setDial}
          searchable
          className="w-28 shrink-0"
          triggerClassName={controlClassName}
        />
        <div className="relative w-full">
          <input
            id={fieldId}
            type="tel"
            inputMode="tel"
            autoComplete={autoComplete}
            required={required}
            aria-label={label ? undefined : (ariaLabel ?? "Numéro de téléphone")}
            value={national}
            onChange={(e) => setNational(e.target.value)}
            placeholder="20 123 456"
            className={`w-full rounded-xl border px-3.5 transition placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-0 ${controlClassName} ${badge ? "pr-28" : ""}`}
          />
          {badge && (
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
              {badge}
            </span>
          )}
        </div>
      </div>
      {note && <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{note}</p>}
      {/* The value every consumer form reads — country code + national number. */}
      <input type="hidden" name={name} value={combined} />
    </div>
  );
}

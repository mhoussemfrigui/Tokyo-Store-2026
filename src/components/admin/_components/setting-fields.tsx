"use client";

import { Lock } from "lucide-react";

import { SelectField as CanonicalSelectField } from "@/components/ui/select-field";

/**
 * Shared admin settings field primitives — so the payments + showcase panels
 * render identical chrome to the checkout panel. Each field posts its own input
 * into the surrounding single `<form>` (the settings pattern).
 *
 * `locked` marks a value FORCED by an environment variable (payment keys): the
 * input is disabled with an explanatory badge. A disabled input is excluded
 * from FormData — exactly right, because the server skips env-locked fields
 * (the env value already wins).
 */

export function LockedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[#f3e3bd] bg-[#fff4e0] px-2 py-0.5 text-[10px] font-semibold text-[#b45309]">
      <Lock className="h-3 w-3" strokeWidth={2.5} />
      Forcé par variable d&apos;environnement
    </span>
  );
}

export const labelCls =
  "flex flex-wrap items-center gap-2 text-[13px] font-bold text-foreground";
// The shared field chrome. Exported (without the `mt-2` top-margin, added by the
// field wrappers) so repeatable editors (contact lists, social links) render
// rows with the EXACT same 50px / rounded-14 / #fbf9f8 / ink-ring look.
export const fieldInputCls =
  "h-[50px] w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] text-foreground placeholder:text-muted-foreground/60 transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)] disabled:cursor-not-allowed disabled:opacity-60";
const inputCls = `mt-2 ${fieldInputCls}`;
// Same chrome as `inputCls` but multi-line: drop the fixed height, add vertical
// padding + resize, so a <textarea> reads as a taller sibling of TextField.
const textareaCls =
  "mt-2 w-full resize-y rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 py-3 text-[15px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)] disabled:cursor-not-allowed disabled:opacity-60";

const fieldId = (name: string) => `f-${name.replace(/[^a-z0-9]/gi, "-")}`;

export function FieldSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <header className="mb-5">
        <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">{title}</h2>
        {description && (
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        )}
      </header>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

export function ToggleField({
  name,
  label,
  description,
  defaultChecked,
  disabled,
  locked,
  onChange,
}: {
  name: string;
  label: string;
  description?: string;
  defaultChecked: boolean;
  disabled?: boolean;
  locked?: boolean;
  /** Optional change listener (the input stays uncontrolled via defaultChecked) —
   *  e.g. to mirror the checked state into a live "shown/hidden" badge. */
  onChange?: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-3.5 rounded-[16px] border-[1.5px] border-input bg-card px-4 py-3.5 transition ${
        disabled ? "opacity-70" : "cursor-pointer hover:bg-surface/40"
      }`}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-[14px] font-extrabold leading-tight text-foreground">
          {label}
          {locked && <LockedBadge />}
        </p>
        {description && (
          <p className="text-[12px] leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {/* Switch — mockup's 46×28 toggle; the checkbox stays uncontrolled (name +
          defaultChecked) so it posts into the surrounding <form> as before. */}
      <span className="relative inline-flex h-7 w-[46px] shrink-0 items-center">
        <input
          type="checkbox"
          name={name}
          defaultChecked={defaultChecked}
          disabled={disabled}
          onChange={onChange ? (e) => onChange(e.target.checked) : undefined}
          className="peer sr-only"
        />
        <span className="h-7 w-[46px] rounded-full bg-[#d8d1c9] transition-colors peer-checked:bg-[#16a34a] peer-focus-visible:ring-2 peer-focus-visible:ring-[rgba(14,18,24,0.18)]" />
        <span className="absolute left-[3px] h-[22px] w-[22px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-transform peer-checked:translate-x-[18px]" />
      </span>
    </label>
  );
}

export function TextField({
  name,
  label,
  defaultValue,
  helper,
  placeholder,
  type = "text",
  disabled,
  locked,
  onChange,
  list,
  autoComplete = "off",
}: {
  name: string;
  label: string;
  defaultValue?: string;
  helper?: string;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  locked?: boolean;
  /** Optional change listener (the input stays uncontrolled via defaultValue). */
  onChange?: (value: string) => void;
  /** id of a sibling `<datalist>` to offer typeahead suggestions (still free-text). */
  list?: string;
  /**
   * Browser autofill hint. Defaults to "off": these are ADMIN settings fields
   * (never login/registration), and a text field sitting next to the payments
   * form's password inputs was getting the operator's saved login email
   * autofilled into it (then persisted as e.g. the COD label). Best-effort —
   * browsers may ignore the hint for credential fields, so server-side
   * validation remains the authoritative guard.
   */
  autoComplete?: string;
}) {
  const id = fieldId(name);
  return (
    <div>
      <label htmlFor={id} className={labelCls}>
        {label}
        {locked && <LockedBadge />}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        disabled={disabled}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        list={list}
        autoComplete={autoComplete}
        className={inputCls}
      />
      {helper && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{helper}</p>}
    </div>
  );
}

/**
 * Multi-line text input — same `{label,name,defaultValue?,helper?,placeholder?}`
 * contract as {@link TextField} (plus an optional `rows`), rendering a
 * `<textarea>` with matching chrome. Used for non-secret long-form settings
 * such as AI generation prompts.
 */
export function TextareaField({
  name,
  label,
  defaultValue,
  helper,
  placeholder,
  rows = 4,
  disabled,
  autoComplete = "off",
}: {
  name: string;
  label: string;
  defaultValue?: string;
  helper?: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  /** Browser autofill hint (defaults "off" — admin settings, not credentials). */
  autoComplete?: string;
}) {
  const id = fieldId(name);
  return (
    <div>
      <label htmlFor={id} className={labelCls}>
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        rows={rows}
        defaultValue={defaultValue}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete={autoComplete}
        className={textareaCls}
      />
      {helper && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{helper}</p>}
    </div>
  );
}

/**
 * Settings-form select. Re-points to the canonical {@link CanonicalSelectField}
 * so payments/showcase/checkout settings inherit the shared pill look (styled
 * popover, focus ring, chevron) in one shot — while keeping this wrapper's
 * exact prop signature so every existing caller stays unchanged. The canonical
 * component renders its own visible `label` + `helper`, so the submission
 * contract (a hidden `<input name>` carrying the value) is identical to the
 * native `<select>` it replaces.
 */
export function SelectField({
  name,
  label,
  defaultValue,
  options,
  helper,
  disabled,
  onChange,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  options: Array<{ value: string; label: string }>;
  helper?: string;
  disabled?: boolean;
  /** Optional change listener (uncontrolled via defaultValue) — e.g. to reveal a
   *  style-specific sub-panel when the operator switches the selected option. */
  onChange?: (value: string) => void;
}) {
  return (
    <CanonicalSelectField
      name={name}
      label={label}
      defaultValue={defaultValue}
      options={options}
      helper={helper}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

export function NumberField({
  name,
  label,
  defaultValue,
  helper,
  min = 0,
  max,
  step,
  disabled,
  locked,
  onChange,
  autoComplete = "off",
}: {
  name: string;
  label: string;
  defaultValue?: string;
  helper?: string;
  min?: number;
  /** Optional upper bound (HTML `max`); omitted → unbounded in the browser. */
  max?: number;
  /**
   * Optional HTML `step`; omitted → the browser default of 1 (integer-only).
   * Pass "any" or a decimal (e.g. 0.1) for fractional values like a similarity
   * threshold or scoring weight.
   */
  step?: number | string;
  disabled?: boolean;
  locked?: boolean;
  /** Optional change listener (the input stays uncontrolled via defaultValue) —
   *  e.g. to mirror a live cap into a sibling warning. */
  onChange?: (value: string) => void;
  /** Browser autofill hint (defaults "off" — admin settings, not credentials). */
  autoComplete?: string;
}) {
  const id = fieldId(name);
  // Integer inputMode only when the step is whole; fractional steps want the
  // decimal keypad on mobile.
  const isFractional = step != null && step !== 1 && step !== "1";
  return (
    <div>
      <label htmlFor={id} className={labelCls}>
        {label}
        {locked && <LockedBadge />}
      </label>
      <input
        id={id}
        name={name}
        type="number"
        min={min}
        max={max}
        step={step}
        inputMode={isFractional ? "decimal" : "numeric"}
        defaultValue={defaultValue}
        disabled={disabled}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        autoComplete={autoComplete}
        className={`${inputCls} tabular-nums`}
      />
      {helper && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{helper}</p>}
    </div>
  );
}

/**
 * Secret input — never round-trips the actual value to the client. The page
 * passes only `hasValue` (a secret exists, env or DB). An empty submit means
 * "keep the existing value"; a non-empty submit replaces it. Disabled +
 * badged when forced by env.
 */
export function SecretField({
  name,
  label,
  hasValue,
  helper,
  locked,
}: {
  name: string;
  label: string;
  hasValue: boolean;
  helper?: string;
  locked?: boolean;
}) {
  const id = fieldId(name);
  const placeholder = locked
    ? "Défini via variable d'environnement"
    : hasValue
      ? "•••••••• — laisser vide pour conserver"
      : "Saisir la valeur";
  return (
    <div>
      <label htmlFor={id} className={labelCls}>
        {label}
        {locked ? (
          <LockedBadge />
        ) : hasValue ? (
          <span className="rounded-full bg-[#eaf7ee] px-2 py-0.5 text-[10px] font-semibold text-[#15803d]">
            défini
          </span>
        ) : null}
      </label>
      <input
        id={id}
        name={name}
        type="password"
        autoComplete="off"
        placeholder={placeholder}
        disabled={locked}
        className={inputCls}
      />
      {helper && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{helper}</p>}
    </div>
  );
}

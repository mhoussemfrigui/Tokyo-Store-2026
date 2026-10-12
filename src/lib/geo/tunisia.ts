/**
 * The 24 governorates (gouvernorats) of Tunisia, in French.
 *
 * Used as the option set for every "Gouvernorat" / region picker (checkout,
 * account address book, …) so the value is constrained instead of free-typed.
 * The stored value IS the French name (value === label), so existing free-text
 * region data that already matches a governorate name keeps displaying, and a
 * newly-picked value is a clean canonical string.
 */
export const TUNISIA_GOVERNORATES = [
  "Ariana",
  "Béja",
  "Ben Arous",
  "Bizerte",
  "Gabès",
  "Gafsa",
  "Jendouba",
  "Kairouan",
  "Kasserine",
  "Kébili",
  "La Manouba",
  "Le Kef",
  "Mahdia",
  "Médenine",
  "Monastir",
  "Nabeul",
  "Sfax",
  "Sidi Bouzid",
  "Siliana",
  "Sousse",
  "Tataouine",
  "Tozeur",
  "Tunis",
  "Zaghouan",
] as const;

/** `{ value, label }` option list for the shared `SelectField` / `NativeSelect`. */
export const TUNISIA_GOVERNORATE_OPTIONS: { value: string; label: string }[] =
  TUNISIA_GOVERNORATES.map((g) => ({ value: g, label: g }));

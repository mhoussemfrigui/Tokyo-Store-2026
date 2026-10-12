/**
 * Multi-value contact lists (phones / emails / addresses) for « Identité & contact ».
 *
 * Each list is stored as a JSON array of { v: value, f: show-in-footer } under a
 * `*s` key (site.contact_phones / site.contact_emails / site.addresses), and the
 * legacy SINGLE key (site.contact_phone / site.contact_email / site.address) is
 * kept in sync as the PRIMARY (first entry's value) so the single-value consumers
 * — invoice, SEO structured data, llms.txt, email brand, the page-builder contact
 * block — keep working unchanged. The footer (and anything that wants the full
 * list) reads the array and filters on the `f` flag.
 *
 * Isomorphic + client-safe: pure string/JSON logic, no server imports. The admin
 * editor, the save actions and the storefront reader all share this one model.
 */

export type ContactEntry = {
  /** The value (phone number / email / address line). */
  value: string;
  /** Show this entry in the storefront footer (operator-selectable per entry). */
  footer: boolean;
};

/** The three multi-value contact lists + their primary single-key mirror. */
export const CONTACT_LISTS = [
  { base: "site.contact_phones", primary: "site.contact_phone", label: "Téléphones", kind: "phone" },
  { base: "site.contact_emails", primary: "site.contact_email", label: "Emails de contact", kind: "email" },
  { base: "site.addresses", primary: "site.address", label: "Adresses", kind: "text" },
] as const;

export type ContactListKind = (typeof CONTACT_LISTS)[number]["kind"];

/**
 * Parse a stored list value into entries. Tolerant: a JSON array of {v,f} is the
 * canonical form; a bare non-JSON string is treated as a single footer-visible
 * entry (migration path from the old single key); anything unparseable → [].
 */
/** One entry from a loosely-typed value ({v,f} object, or a bare string). */
function toEntry(e: unknown): ContactEntry | null {
  if (e && typeof e === "object" && typeof (e as { v?: unknown }).v === "string") {
    const value = (e as { v: string }).v.trim();
    return value ? { value, footer: (e as { f?: unknown }).f !== false } : null;
  }
  if (typeof e === "string" && e.trim()) return { value: e.trim(), footer: true };
  return null;
}

export function parseContactList(raw: string | null | undefined): ContactEntry[] {
  const t = (raw ?? "").trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t);
      if (!Array.isArray(arr)) return [];
      return arr.map(toEntry).filter((e): e is ContactEntry => e !== null);
    } catch {
      return [];
    }
  }
  // A `{`-prefixed string is a malformed (non-array) JSON value → ignore it.
  if (t.startsWith("{")) return [];
  // Legacy single value stored as a plain string.
  return [{ value: t, footer: true }];
}

/** Serialize entries back to the stored JSON form (empty values dropped). */
export function serializeContactList(entries: ContactEntry[]): string {
  const clean = entries
    .map((e) => ({ v: e.value.trim(), f: e.footer }))
    .filter((e) => e.v);
  return clean.length ? JSON.stringify(clean) : "";
}

/**
 * Resolve a list from the settings map: the array key when present, else the
 * legacy single key as a one-entry fallback (so a site that never used the list
 * editor still shows its single contact).
 */
export function resolveContactList(
  settings: Record<string, string | null>,
  base: string,
  primary: string,
): ContactEntry[] {
  const fromArray = parseContactList(settings[base]);
  if (fromArray.length) return fromArray;
  const single = (settings[primary] ?? "").trim();
  return single ? [{ value: single, footer: true }] : [];
}

export type SiteContacts = {
  phones: ContactEntry[];
  emails: ContactEntry[];
  addresses: ContactEntry[];
  hours: string | null;
  whatsapp: string | null;
};

/** All contact lists + the single contact singles, from a loaded settings map. */
export function getSiteContacts(settings: Record<string, string | null>): SiteContacts {
  return {
    phones: resolveContactList(settings, "site.contact_phones", "site.contact_phone"),
    emails: resolveContactList(settings, "site.contact_emails", "site.contact_email"),
    addresses: resolveContactList(settings, "site.addresses", "site.address"),
    hours: (settings["site.hours"] ?? "").trim() || null,
    whatsapp: (settings["site.whatsapp"] ?? "").trim() || null,
  };
}

/** Entries the operator chose to show in the footer (footer flag true). */
export const footerEntries = (entries: ContactEntry[]): ContactEntry[] => entries.filter((e) => e.footer);

/**
 * Read a list's entries from submitted FormData. The admin editor posts ONE
 * hidden input per row named `${base}[]` whose value is JSON `{v,f}` — so order
 * is preserved and an unchecked footer box can't misalign (vs two parallel
 * getAll arrays). FormData is available on both server + client.
 */
export function readContactListFromForm(formData: FormData, base: string): ContactEntry[] {
  return formData.getAll(`${base}[]`).flatMap((raw) => {
    if (typeof raw !== "string") return [];
    const t = raw.trim();
    if (!t) return [];
    try {
      const entry = toEntry(JSON.parse(t));
      if (entry) return [entry];
    } catch {
      /* fall through to the bare-value tolerance below */
    }
    const entry = toEntry(t);
    return entry ? [entry] : [];
  });
}

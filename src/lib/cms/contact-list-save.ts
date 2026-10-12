import { validateSiteSetting } from "@/workflows/cms/setting";

import { CONTACT_LISTS, readContactListFromForm, serializeContactList } from "./contact-list";

/** A settings row ready for `workflows.cms.upsertSettingsBatch`. */
export type ContactSettingEntry = {
  key: string;
  value: string;
  type: "text";
  groupKey: string;
  label: string;
};

type Result =
  | { ok: false; label: string; message: string }
  | { ok: true; settings: ContactSettingEntry[] };

/**
 * Parse the three contact lists (phones / emails / addresses) from submitted
 * FormData, validate every entry (email / phone format via the existing site-key
 * validators), and return the settings to upsert: the JSON array key PLUS the
 * legacy single PRIMARY key (= first entry's value) kept in sync for the
 * single-value consumers (invoice / SEO / llms / email brand / page contact
 * block). Shared by saveSiteSettingsAction + saveFooterAction so both tabs write
 * the lists identically. Returns the first offending field on a validation error.
 */
export function buildContactListSettings(formData: FormData): Result {
  const settings: ContactSettingEntry[] = [];
  for (const list of CONTACT_LISTS) {
    const entries = readContactListFromForm(formData, list.base);
    for (const e of entries) {
      const err = validateSiteSetting(list.primary, e.value);
      if (err) return { ok: false, label: list.label, message: `${list.label} — ${err}` };
    }
    settings.push({
      key: list.base,
      value: serializeContactList(entries),
      type: "text",
      groupKey: "contact",
      label: list.label,
    });
    settings.push({
      key: list.primary,
      value: entries[0]?.value ?? "",
      type: "text",
      groupKey: "contact",
      label: `${list.label} — principal`,
    });
  }
  return { ok: true, settings };
}

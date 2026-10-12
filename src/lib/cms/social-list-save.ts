import {
  PLATFORM_LABELS,
  readSocialListFromForm,
  serializeSocialList,
  SOCIAL_LINKS_KEY,
} from "./social-list";

/** A settings row ready for `workflows.cms.upsertSettingsBatch`. */
export type SocialSettingEntry = {
  key: string;
  value: string;
  type: "text";
  groupKey: string;
  label: string;
};

type Result =
  | { ok: false; label: string; message: string }
  | { ok: true; settings: SocialSettingEntry[] };

/** http(s) absolute URL (social links were previously accepted RAW + only
 *  sanitized at render; validating on save is a net safety improvement). */
function isValidUrl(u: string): boolean {
  if (!/^https?:\/\//i.test(u)) return false;
  try {
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the ordered social links from submitted FormData, validate every URL,
 * and return the single `social.links` settings row to upsert. Shared by
 * saveSiteSettingsAction + saveFooterAction so both tabs write the list
 * identically (mirrors buildContactListSettings).
 *
 * The 6 legacy `social.<platform>` single keys are NOT written here — they are
 * left intact so `resolveSocialList`'s read-time backfill still works for an
 * un-migrated row, and migration 0213 folds them into the array. Once saved
 * through this editor, `social.links` is the authoritative source every consumer
 * reads.
 */
export function buildSocialListSettings(formData: FormData): Result {
  const links = readSocialListFromForm(formData);
  for (const l of links) {
    if (!isValidUrl(l.url)) {
      return {
        ok: false,
        label: "Réseaux sociaux",
        message: `Réseaux sociaux — « ${PLATFORM_LABELS[l.platform]} » : URL invalide (doit commencer par http:// ou https://).`,
      };
    }
  }
  return {
    ok: true,
    settings: [
      {
        key: SOCIAL_LINKS_KEY,
        value: serializeSocialList(links),
        type: "text",
        groupKey: "social",
        label: "Réseaux sociaux",
      },
    ],
  };
}

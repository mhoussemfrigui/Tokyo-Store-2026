import {
  DEMO_IMAGES,
  DEMO_LOGO_SETTING,
  DEMO_SETTINGS,
  type DemoImageKey,
} from "./data";

/**
 * Pure planner behind the « Nettoyer › Réglages » segment (`cleanSettings`).
 *
 * The demo seeds are insert-if-missing, and the SAME keys are the store's live
 * identity/contact/social/home settings the admin edits in CMS → Réglages / Page
 * d'accueil (and that `scripts/seed-tokyo-design.ts` or the boot bootstrap may
 * have written first). Deleting by key alone therefore wiped an operator's real
 * store name, logo, contact details and home copy. The rule now is
 * "only what still looks exactly like the demo seeded it":
 *
 *   - text / boolean keys (DEMO_SETTINGS): deleted only while the stored value is
 *     byte-for-byte the demo value — any edit keeps it (an admin-edited store name
 *     or contact detail survives the clean, never silently reset to the demo
 *     default);
 *   - média keys (site.logo_media_id): deleted only while they still point at the
 *     image the demo uploader created for THAT slot — an admin-picked image (or a
 *     feed packshot from seed-tokyo-design) is kept. The
 *     demo média ids are returned so the caller can reclaim them (through the
 *     in-use guard: the same image may still back a banner).
 *
 * DB-free on purpose (unit-tested by data-clean-scoping.test.ts).
 */

/** Médiathèque fields the provenance check reads. */
export type DemoMediaProbe = { alt_text: string | null; filename: string };

/** Every settings key a demo seed may write — the keys `cleanSettings` inspects. */
export const DEMO_SETTINGS_CLEAN_KEYS: readonly string[] = [
  ...DEMO_SETTINGS.map((s) => s.key),
  DEMO_LOGO_SETTING.settingKey,
];

/** The média-valued slots, with the demo image each one is seeded from. */
export const DEMO_MEDIA_SETTING_SLOTS: readonly { settingKey: string; image: DemoImageKey }[] = [
  { settingKey: DEMO_LOGO_SETTING.settingKey, image: DEMO_LOGO_SETTING.image },
];

/**
 * Was this média row created by the demo uploader from `DEMO_IMAGES[key]`?
 * `workflows/data/_image-uploader.ts` stamps alt text `Demo <key>` and the upload
 * pipeline stores the demo file's base name + the (possibly re-encoded) primary
 * extension as the filename. BOTH must still match — an admin who re-labelled or
 * renamed the image has taken ownership of it, so it is kept (safe direction).
 */
export function isDemoUploadedMedia(row: DemoMediaProbe, key: DemoImageKey): boolean {
  if (row.alt_text !== `Demo ${key}`) return false;
  const base = baseName(DEMO_IMAGES[key]);
  return baseName(row.filename) === base;
}

function baseName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

export type DemoSettingsCleanPlan = {
  /** Keys still holding their demo-seeded value → safe to delete. */
  deleteKeys: string[];
  /** Demo-uploaded média behind the deleted média keys → reclaim candidates. */
  mediaIds: string[];
  /** Keys present but customised (or unverifiable) → kept. */
  keptKeys: string[];
};

/**
 * @param current  the stored value of every demo key that EXISTS (absent key = no row).
 * @param media    live média rows by id, for the média-valued keys' current values.
 */
export function planDemoSettingsClean(
  current: ReadonlyMap<string, string | null>,
  media: ReadonlyMap<string, DemoMediaProbe>,
): DemoSettingsCleanPlan {
  const deleteKeys: string[] = [];
  const mediaIds: string[] = [];
  const keptKeys: string[] = [];

  for (const s of DEMO_SETTINGS) {
    if (!current.has(s.key)) continue;
    if (current.get(s.key) === s.value) deleteKeys.push(s.key);
    else keptKeys.push(s.key);
  }

  for (const slot of DEMO_MEDIA_SETTING_SLOTS) {
    if (!current.has(slot.settingKey)) continue;
    const mediaId = current.get(slot.settingKey);
    const row = mediaId ? media.get(mediaId) : undefined;
    if (mediaId && row && isDemoUploadedMedia(row, slot.image)) {
      deleteKeys.push(slot.settingKey);
      mediaIds.push(mediaId);
    } else {
      keptKeys.push(slot.settingKey);
    }
  }

  return { deleteKeys, mediaIds: Array.from(new Set(mediaIds)), keptKeys };
}

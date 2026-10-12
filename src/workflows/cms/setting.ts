import "server-only";

import { z } from "zod";

import { settingService } from "@/modules/cms/setting/service";
import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { fail, ok, workflow, ZOD_FR, zodValidationFail } from "../shared";
import { normalizePhoneDigits } from "@/lib/format/phone";
import { isSensitiveSettingKey } from "@/lib/cms/sensitive-settings";

// The security-relevant key classification lives in the PURE
// lib/cms/sensitive-settings module (shared with the severity model).
export { SENSITIVE_SETTING_KEYS, isSensitiveSettingKey } from "@/lib/cms/sensitive-settings";

export const upsertSettingSchema = z.object({
  key: z.string().trim().min(1).max(100),
  value: z.string().nullable(),
  type: z.enum(["text", "number", "boolean", "media"]).default("text"),
  groupKey: z.string().trim().default("general"),
  label: z.string().trim().min(1).max(120),
  description: z.string().optional(),
});

/** French field labels for the validation banner (zodValidationFail). */
const SETTING_FIELD_LABELS: Record<string, string> = {
  key: "Clé",
  value: "Valeur",
  type: "Type",
  groupKey: "Groupe",
  label: "Libellé",
  description: "Description",
};

/**
 * Validators for well-known `site.*` setting keys. Returning a non-null
 * string surfaces an inline field error to the admin; null means OK. Kept
 * intentionally tolerant — international phone numbers are messy, so we
 * accept any non-empty digit/punctuation pattern.
 */
export function validateSiteSetting(key: string, value: string | null): string | null {
  if (!value || !value.trim()) return null;
  const v = value.trim();
  if (key === "site.contact_email") {
    // Pragmatic email regex — local@domain.tld with no whitespace.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "Email invalide.";
  } else if (key === "site.contact_phone") {
    // Tolerate "+216 12 345 678", "+33 1 23 45 67 89", spaces, dashes.
    // At least 6 digits total; allow leading +.
    const digits = normalizePhoneDigits(v);
    if (!/^\+?[\d\s().-]{6,30}$/.test(v) || digits.length < 6) {
      return "Numéro de téléphone invalide.";
    }
  } else if (key === "seo.site_url") {
    // (The legacy `site.url` alias was removed from the read path in
    // lib/seo/config.ts — no panel/seed writes it, so it's not validated here.)
    try {
      const u = new URL(v);
      if (!/^https?:$/.test(u.protocol)) return "URL invalide (http/https requis).";
    } catch {
      return "URL invalide.";
    }
  }
  return null;
}

/**
 * Who performed a settings/CMS write — forwarded as the `bus.emit` meta so the
 * audit row carries the acting admin instead of "· système". Optional: the
 * bootstrap/seed paths genuinely have no actor; every admin Server Action
 * passes `{ actorUserId: session.user.id }`.
 */
export type CmsActorCtx = { actorUserId?: string | null; actorIp?: string | null };

export const upsertSettingWorkflow = workflow<
  [z.input<typeof upsertSettingSchema>, CmsActorCtx?],
  { key: string }
>("cms.setting.upsert", async (input, ctx = {}) => {
  const parsed = upsertSettingSchema.safeParse(input, ZOD_FR);
  if (!parsed.success) return zodValidationFail(parsed.error, SETTING_FIELD_LABELS);

  // Site-key validators run after Zod so the value's already trimmed; they
  // surface inline errors via `fieldErrors.value` so the form's existing
  // error rendering picks them up.
  const siteErr = validateSiteSetting(parsed.data.key, parsed.data.value);
  if (siteErr) {
    return fail("validation", siteErr, { value: siteErr });
  }

  // No-op save: every settings panel re-submits ALL its keys, so without this
  // a single click wrote one row + one curated audit row (+ webhook fan-out)
  // per UNCHANGED key. Skip both the write and the event when the stored row
  // already matches (an omitted `description` is left untouched by the upsert,
  // so it never counts as a change). First-time inserts always go through.
  const existing = await settingService.findByKey(parsed.data.key);
  if (
    existing &&
    existing.value === parsed.data.value &&
    existing.type === parsed.data.type &&
    existing.group_key === parsed.data.groupKey &&
    existing.label === parsed.data.label &&
    (parsed.data.description === undefined || existing.description === parsed.data.description)
  ) {
    return ok({ key: parsed.data.key });
  }

  await settingService.upsert({
    key: parsed.data.key,
    value: parsed.data.value,
    type: parsed.data.type,
    group_key: parsed.data.groupKey,
    label: parsed.data.label,
    description: parsed.data.description,
  });
  // Security-relevant keys (SENSITIVE_SETTING_KEYS — never a secret) carry the
  // before/after values so the audit row can show WHAT changed (a re-pointed
  // canonical origin / CTA, verification switched off…), and are warn severity
  // (severityFor). Every other key stays name-only.
  const values = isSensitiveSettingKey(parsed.data.key)
    ? { from: existing?.value ?? null, to: parsed.data.value }
    : {};
  await bus.emit(
    "setting.upserted",
    { key: parsed.data.key, groupKey: parsed.data.groupKey, ...values },
    ctx,
  );
  return ok({ key: parsed.data.key });
});

export const upsertSettingsBatchSchema = z.object({
  settings: z.array(upsertSettingSchema).min(1).max(100),
});

/**
 * ATOMIC multi-key settings save — validates EVERY key (Zod + the site-key
 * validators) up front, then writes only the CHANGED rows in ONE transaction, so a
 * multi-key panel (e.g. the /boutique landing's 15 keys) can never be left
 * half-saved by a mid-loop failure. Post-commit it emits `setting.upserted` per
 * changed key (same audit / webhook / sensitive-key before-after payload the
 * single-key workflow emits), mirroring setCategoryTaxRatesWorkflow's
 * validate-all → one tx → emit-per-change shape.
 */
export const upsertSettingsBatchWorkflow = workflow<
  [z.input<typeof upsertSettingsBatchSchema>, CmsActorCtx?],
  { changedKeys: string[] }
>("cms.setting.upsert_batch", async (input, ctx = {}) => {
  const parsed = upsertSettingsBatchSchema.safeParse(input, ZOD_FR);
  if (!parsed.success) return zodValidationFail(parsed.error, SETTING_FIELD_LABELS);

  // Validate the WHOLE batch before touching the DB — one bad value rejects the
  // save wholesale instead of committing the keys before it.
  for (const s of parsed.data.settings) {
    const siteErr = validateSiteSetting(s.key, s.value);
    if (siteErr) return fail("validation", siteErr, { value: siteErr });
  }

  // Resolve the current rows once so unchanged keys are skipped (no audit-row /
  // webhook noise for a re-save that changed nothing — every panel re-submits all
  // its keys). An omitted `description` is treated as "leave untouched", matching
  // the single-key workflow's no-op rule.
  const existingByKey = new Map(
    (await settingService.findManyByKeys(parsed.data.settings.map((s) => s.key))).map(
      (row) => [row.key, row] as const,
    ),
  );
  const changed = parsed.data.settings.filter((s) => {
    const cur = existingByKey.get(s.key);
    return !(
      cur &&
      cur.value === s.value &&
      cur.type === s.type &&
      cur.group_key === s.groupKey &&
      cur.label === s.label &&
      (s.description === undefined || cur.description === s.description)
    );
  });
  if (changed.length === 0) return ok({ changedKeys: [] });

  await db.transaction(async (tx) => {
    for (const s of changed) {
      await settingService.upsert(
        {
          key: s.key,
          value: s.value,
          type: s.type,
          group_key: s.groupKey,
          label: s.label,
          description: s.description,
        },
        tx,
      );
    }
  });

  // Post-commit, per changed key: same payload the single-key workflow emits
  // (sensitive keys carry before/after; every other key stays name-only).
  for (const s of changed) {
    const values = isSensitiveSettingKey(s.key)
      ? { from: existingByKey.get(s.key)?.value ?? null, to: s.value }
      : {};
    await bus.emit("setting.upserted", { key: s.key, groupKey: s.groupKey, ...values }, ctx);
  }
  return ok({ changedKeys: changed.map((s) => s.key) });
});

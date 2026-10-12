"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { resetAuthInstance } from "@/lib/auth/server";
import { SESSION_POLICY_BOUNDS, SESSION_POLICY_KEYS } from "@/lib/auth/policy";
import { parseFormNumber } from "@/lib/settings/form-number";
import { type ActionState } from "@/lib/actions/types";

/**
 * Save the admin-tunable session policy (Utilisateurs → Réglages):
 * session lifetime, refresh age, and the session cookie-cache duration. Each
 * value is clamped to the shared [min, max] bounds, persisted to `site_settings`,
 * then `resetAuthInstance()` drops the cached Better Auth instance so the next
 * request rebuilds with the new policy — no redeploy.
 *
 * Gated on `users:policy` — the dedicated shop-wide session-policy slice (split
 * off `users:manage` so tuning everyone's login lifetime is delegable on its own,
 * apart from per-account ops). Applies equally to customers AND staff/admins.
 * Note: raising the cookie cache only delays an explicit force-logout; a
 * disable/role-change still takes effect live (the request gates re-fetch the
 * user row), so this is a perf/UX knob, not a hole.
 */
export async function saveSessionPolicyAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("users", "policy");

  // A BLANK field means "default", not the minimum: `Number("")` is 0, which the
  // clamp used to raise to `min` (a cleared lifetime became a 1-day session).
  const clamp = (raw: FormDataEntryValue | null, c: { def: number; min: number; max: number }): number => {
    const v = parseFormNumber(raw);
    if (v === null) return c.def;
    return Math.min(c.max, Math.max(c.min, Math.round(v)));
  };

  const values: Array<{ key: string; value: number; label: string }> = [
    {
      key: SESSION_POLICY_KEYS.expiresDays,
      value: clamp(formData.get("expiresDays"), SESSION_POLICY_BOUNDS.expiresDays),
      label: "Session — durée de vie (jours)",
    },
    {
      key: SESSION_POLICY_KEYS.updateAgeDays,
      value: clamp(formData.get("updateAgeDays"), SESSION_POLICY_BOUNDS.updateAgeDays),
      label: "Session — fréquence de renouvellement (jours)",
    },
    {
      key: SESSION_POLICY_KEYS.cookieCacheMinutes,
      value: clamp(formData.get("cookieCacheMinutes"), SESSION_POLICY_BOUNDS.cookieCacheMinutes),
      label: "Session — cache cookie (minutes)",
    },
  ];

  const errors: string[] = [];
  for (const v of values) {
    const r = await workflows.cms.upsertSetting(
      {
        key: v.key,
        value: String(v.value),
        type: "text",
        groupKey: "auth",
        label: v.label,
      },
      { actorUserId: session.user.id },
    );
    if (!r.ok) errors.push(`${v.label}: ${r.message}`);
  }

  if (errors.length > 0) {
    return { ok: false, error: "partial", message: `Erreurs : ${errors.join(" · ")}` };
  }

  // Better Auth captured the OLD policy at build time — drop the cached instance
  // so the next request rebuilds with the new values.
  resetAuthInstance();
  // The session-policy panel lives on Utilisateurs → Réglages (/admin/users/settings).
  revalidatePath("/admin/users/settings");
  return { ok: true, message: "Politique de session enregistrée." };
}

/**
 * PURE (no server-only / no DB import) site-availability resolver, so the parsing +
 * the FAIL-OPEN contract can be unit-tested. `config.ts` wraps `getSettingsMap()`
 * around `resolveSiteModeConfig`.
 *
 * The store has three availability modes, driven by the `site.mode` setting:
 *   • live         — normal storefront (default; the ONLY non-gated mode).
 *   • maintenance  — temporary "we'll be right back" full-page state.
 *   • coming_soon  — pre-launch "bientôt disponible" state (optional countdown).
 *
 * SAFETY: anything unrecognised — a missing setting, a typo, a DB read that threw
 * (config.ts passes `{}`) — resolves to `live`. Maintenance mode must FAIL OPEN: a
 * settings glitch can never take the whole storefront down.
 */

import { parseStoreLocalDateTime } from "@/lib/time/store-tz";

export type SiteMode = "live" | "maintenance" | "coming_soon";

export const SITE_MODES: readonly SiteMode[] = ["live", "maintenance", "coming_soon"] as const;

export type SiteModeConfig = {
  mode: SiteMode;
  /** Headline shown on the gated page. */
  title: string;
  /** Sub-copy shown on the gated page. */
  message: string;
  /** ISO datetime to count down to (coming_soon only). Null = no target. */
  launchAt: string | null;
  /** Whether to render the live countdown (coming_soon + a valid launchAt). */
  showCountdown: boolean;
};

/** Per-mode default copy — used when the admin leaves the title/message blank. */
export const SITE_MODE_DEFAULT_COPY: Record<Exclude<SiteMode, "live">, { title: string; message: string }> = {
  maintenance: {
    title: "Site en maintenance",
    message:
      "Nous peaufinons quelques détails. La boutique sera de retour très vite — merci de votre patience.",
  },
  coming_soon: {
    title: "Bientôt disponible",
    message:
      "Notre enseigne high-tech ouvre ses portes très prochainement. Revenez vite pour découvrir la collection.",
  },
};

function bool(v: string | null | undefined, fb: boolean): boolean {
  if (v == null) return fb;
  const s = v.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return fb;
}

function str(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length ? t : null;
}

/** Coerce any input to a valid {@link SiteMode}; unknown ⇒ `live` (fail open). */
export function parseSiteMode(v: string | null | undefined): SiteMode {
  const s = (v ?? "").trim().toLowerCase();
  return (SITE_MODES as readonly string[]).includes(s) ? (s as SiteMode) : "live";
}

/** Parse an ISO-ish datetime to a normalized ISO string, or null when unusable. */
export function normalizeLaunchAt(v: string | null | undefined): string | null {
  const s = str(v);
  if (!s) return null;
  // The admin picks the launch instant on a `datetime-local` control (a naked
  // wall-clock). Interpret it in the STORE zone (Africa/Tunis), not the UTC
  // runtime, so the storefront countdown targets the hour the operator meant
  // (a bare "09:00" is 09:00 Tunis, not 09:00 UTC = 10:00 Tunis). See store-tz.ts.
  const dt = parseStoreLocalDateTime(s);
  return dt ? dt.toISOString() : null;
}

/** Whether a mode hides the storefront from the public (everything except `live`). */
export function isSiteGated(mode: SiteMode): boolean {
  return mode !== "live";
}

/** Build the full config from a raw settings map. Never throws. */
export function resolveSiteModeConfig(s: Record<string, string | null>): SiteModeConfig {
  const mode = parseSiteMode(s["site.mode"]);
  const defaults = mode === "coming_soon" ? SITE_MODE_DEFAULT_COPY.coming_soon : SITE_MODE_DEFAULT_COPY.maintenance;
  const launchAt = normalizeLaunchAt(s["site.launch_at"]);
  return {
    mode,
    title: str(s["site.maintenance_title"]) ?? defaults.title,
    message: str(s["site.maintenance_message"]) ?? defaults.message,
    launchAt,
    // Countdown is an INDEPENDENT toggle — activatable/deactivatable in EITHER gated
    // mode. It shows only when explicitly enabled AND a real target date is set (no
    // date ⇒ nothing to count down to). Defaults ON so a date alone is enough.
    showCountdown: launchAt != null && bool(s["site.show_countdown"], true),
  };
}

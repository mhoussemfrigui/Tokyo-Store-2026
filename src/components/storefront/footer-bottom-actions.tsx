"use client";

import { useConsent } from "@/components/consent/consent-provider";
import { DarkModeToggle } from "@/components/storefront/dark-mode-toggle";

/**
 * Bottom-bar interactive controls, styled for the dark onyx footer:
 * "Gérer les cookies" (only when the consent banner is enabled) + the optional
 * admin dark-mode toggle (shown only when darkMode !== "off").
 */
export function FooterBottomActions({
  darkMode = "off",
}: {
  darkMode?: "off" | "system" | "on";
}) {
  const consent = useConsent();

  return (
    <div className="flex items-center gap-4">
      {consent?.config.enabled && (
        <button
          type="button"
          onClick={() => consent.openPreferences()}
          className="text-[0.52rem] uppercase tracking-[0.15em] text-background/[0.12] transition-colors duration-500 hover:text-background/35"
        >
          Gérer les cookies
        </button>
      )}
      {darkMode !== "off" && <DarkModeToggle />}
    </div>
  );
}

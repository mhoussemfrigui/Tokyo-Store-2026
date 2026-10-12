/**
 * OWNER-ONLY tracking keys — the `tracking.*` settings that can execute
 * ARBITRARY JavaScript on every storefront page: the two raw-HTML snippets
 * (injected, their <script>s re-executed) and the GTM container id (an
 * attacker-owned container ships Custom-HTML tags). The admin shares the
 * storefront origin + session cookie, so such a script runs with the session of
 * any staff member who browses the shop — writing these through the delegable
 * `system_analytics:update` grant would be a privilege escalation to full
 * admin. They therefore require the `*` wildcard (enforced in
 * saveAnalyticsSettingsAction). GA4 / Meta Pixel ids and the toggles stay
 * delegable.
 *
 * Pure (no server-only / DB imports) so the rule is unit-testable — a
 * "use server" module can only export async functions.
 */
export const TRACKING_SCRIPT_KEYS: ReadonlySet<string> = new Set([
  "tracking.gtm_id",
  "tracking.custom_head",
  "tracking.custom_body",
]);

/**
 * Does this save request touch an owner-only key it isn't allowed to? True when
 * a non-owner POSTED any of TRACKING_SCRIPT_KEYS (the panel renders them
 * disabled for non-owners, so a request that still carries one is refused
 * outright rather than silently half-applied). An owner is never refused.
 */
export function ownerOnlyTrackingViolation(
  isOwner: boolean,
  posted: (key: string) => boolean,
): boolean {
  if (isOwner) return false;
  for (const key of TRACKING_SCRIPT_KEYS) if (posted(key)) return true;
  return false;
}

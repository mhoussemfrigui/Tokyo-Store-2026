/**
 * PURE decision for the profile→users.name mirror (no DB / server-only), so the
 * gating logic is unit-testable.
 *
 * `users.name` is a denormalised `${first_name} ${last_name}` copy of the linked
 * customer profile (the Utilisateurs list + audit actor names + order
 * link-candidate names all read it). It's written in lockstep at signup, but the
 * profile-edit workflows only touch `customer_profiles`, so without a sync the
 * two drift. This helper decides whether — and to what — `users.name` should be
 * rewritten after a `customer.profile_updated` event.
 *
 * Returns `update` ONLY when:
 *   - a name field actually changed (`first_name`/`last_name` in changedFields) —
 *     also the guarantee that the event's `userId` is the CUSTOMER's (the notes /
 *     loyalty emitters carry the actor id but never name fields), and
 *   - there's a linked user (`userId` non-empty), and
 *   - the composed, trimmed name is non-empty (never blank the NOT NULL column), and
 *   - it actually differs from the current `users.name` (idempotent no-op guard).
 */
export type NameSyncDecision = { action: "skip" } | { action: "update"; name: string };

export function decideNameSync(input: {
  changedFields: string[];
  userId: string | null | undefined;
  firstName: string | null | undefined;
  lastName: string | null | undefined;
  currentName: string | null | undefined;
}): NameSyncDecision {
  const nameChanged =
    input.changedFields.includes("first_name") || input.changedFields.includes("last_name");
  if (!nameChanged) return { action: "skip" };
  if (!input.userId) return { action: "skip" };

  // Compose EXACTLY like signup's `${first} ${last}` then trim, so a missing
  // last name yields "First" (not "First ") and a fully-blank name never wipes
  // the NOT NULL users.name.
  const name = `${input.firstName ?? ""} ${input.lastName ?? ""}`.trim();
  if (!name) return { action: "skip" };
  if (name === input.currentName) return { action: "skip" };
  return { action: "update", name };
}

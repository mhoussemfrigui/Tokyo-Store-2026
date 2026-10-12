import { ALL_PERMISSION_KEYS, PERMISSION_MODULES, WILDCARD } from "./registry";

/**
 * PURE per-user permission OVERLAY resolution (migration 0191) — layers a user's
 * allow/deny deltas over the union of their role grants, so a role is a
 * customizable template. No DB / no server-only → unit-testable
 * (`permission-overlay.test.ts` exercises the wildcard-materialization corners).
 *
 * Effective = union(roles) ∪ allow − deny. The subtlety is DENY × WILDCARD: a role
 * granting `products:*` with a per-user deny of `products:delete` can't be expressed
 * by removing a key from the set (the wildcard is still there), so when — and ONLY
 * when — a deny exists we MATERIALIZE every wildcard to its concrete keys and then
 * subtract. With no denies the set is returned wildcard-intact (the fast,
 * future-proof path that ~99% of resolves take).
 *
 * INVARIANT (enforced by the write path, not here): overrides never target the
 * GLOBAL `*` directly — `*` can only be granted by a role. A `<module>:*` override
 * is fine (module-scoped). But note a DENY override still MATERIALIZES a role's
 * `*` into concrete keys (dropping the literal `*`): a role-`*` holder who carries
 * any deny is NOT a literal `*` holder here, so the last-admin floor
 * (`countEffectiveWildcardAdmins` in guards.ts) MUST — and does — exclude role-`*`
 * holders that have a deny override, to stay in lockstep with this resolution.
 */
export type PermissionOverride = { permission: string; effect: string };

/** module id → its concrete "<id>:<action>" keys (for wildcard materialization). */
const MODULE_ACTION_KEYS = new Map<string, string[]>(
  PERMISSION_MODULES.map((m) => [m.id, m.actions.map((a) => `${m.id}:${a}`)]),
);

export function applyPermissionOverlay(
  roleGrants: readonly string[],
  overrides: readonly PermissionOverride[],
): Set<string> {
  if (overrides.length === 0) return new Set(roleGrants); // FAST PATH — identical to pre-overlay
  const allows: string[] = [];
  const denies: string[] = [];
  for (const o of overrides) (o.effect === "deny" ? denies : allows).push(o.permission);
  const granted = new Set<string>([...roleGrants, ...allows]);
  if (denies.length === 0) return granted; // additive only — no materialization needed
  return subtractDenies(granted, denies);
}

/** Expand `*` / `<module>:*` in `granted` to concrete keys, then remove the denied keys. */
function subtractDenies(granted: Set<string>, denies: readonly string[]): Set<string> {
  const concrete = materializePermissionSet(granted);
  for (const d of denies) {
    if (d === WILDCARD) {
      concrete.clear();
      break;
    }
    if (d.endsWith(":*")) {
      for (const k of MODULE_ACTION_KEYS.get(d.slice(0, -2)) ?? []) concrete.delete(k);
    } else {
      concrete.delete(d);
    }
  }
  return concrete;
}

/**
 * Expand every `*` / `<module>:*` in a permission set to its concrete
 * `<module>:<action>` keys. Exported so a caller comparing two effective sets by
 * membership (e.g. the overlay workflow's de-escalation check) can do it on a
 * like-for-like concrete basis, not wildcard-vs-concrete.
 */
export function materializePermissionSet(granted: Set<string>): Set<string> {
  if (granted.has(WILDCARD)) return new Set(ALL_PERMISSION_KEYS);
  const out = new Set<string>();
  for (const key of granted) {
    if (key.endsWith(":*")) {
      for (const k of MODULE_ACTION_KEYS.get(key.slice(0, -2)) ?? []) out.add(k);
    } else {
      out.add(key);
    }
  }
  return out;
}

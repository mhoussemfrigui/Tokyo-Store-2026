import "server-only";

import { headers } from "next/headers";

import { getAuth } from "./server";
import { authService } from "@/modules/auth/service";
import { toAuthUser, type AuthUser } from "@/modules/auth/types";
import { canAccessAdminArea, permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import type { PermissionAction, PermissionModuleId } from "@/lib/rbac/registry";
import { bus } from "@/events/bus";

/**
 * Record a high-signal RBAC denial for the security trail: an AUTHENTICATED staff
 * member (holds at least one grant) hitting a module/action they lack — i.e. real
 * privilege-probing, the OWASP A09 "access-control failure" worth logging. We
 * deliberately do NOT log anonymous / zero-permission denials (random customers
 * or bots hitting an admin URL) — that would be pure noise. Best-effort: must run
 * BEFORE the notFound() throw and never change the deny outcome.
 */
async function emitPermissionDenied(
  userId: string,
  module: string,
  action: string,
  perms: ReadonlySet<string>,
): Promise<void> {
  if (perms.size === 0) return;
  await bus
    .emit("rbac.permission_denied", { actorUserId: userId, module, action }, { actorUserId: userId })
    .catch(() => {});
}

/**
 * Server-side session helpers.
 *
 * Use `getSession()` for optional auth (returns null if not signed in).
 * Use `requireSession()` to gate a Server Component / Server Action —
 * redirects to /login with a `from` query.
 * Every admin page / server action MUST call `requirePermission(module, action)`
 * (or `requirePermissionAny([...])`) for its own module — 404s on deny, so the
 * existence of admin routes never leaks. The /admin layout only checks
 * admin-AREA access (`resolveAdminShellAccess`, any grant) and does NOT isolate
 * modules; `requireAdminArea()` is that same area check, for the few data-free
 * or per-block-gated pages (route-invariants.test.ts holds the allow-list).
 * Store-wide destructive operations add the `*` step-up on top of their module
 * grant via `requireSuperAdmin` / `checkSuperAdmin` (src/lib/auth/super-admin.ts).
 *
 * Authorization is resolved LIVE per request via the RBAC engine
 * (`src/lib/rbac/authorize.ts`): one indexed DB lookup (plus, for non-admins,
 * one grants join), so revoking a role / disabling a user takes effect on the
 * next request with no token regeneration. Access is ROLE-ONLY — full access
 * (`'*'`) comes solely from a role grant (the `super_admin` role); the legacy
 * `users.role` enum + its `admin → '*'` bridge were retired.
 */

export async function getSession() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  return session;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const session = await getSession();
  if (!session?.user) return null;
  // Better Auth's user type omits `role` + `disabledAt`; re-fetch from DB
  // to get the full picture (and to honour a soft-disable immediately).
  const row = await authService.findById(session.user.id);
  if (!row || row.disabledAt) return null;
  return toAuthUser(row);
}

export async function requireSession(opts: { from?: string } = {}) {
  const session = await getSession();
  if (!session?.user) {
    const search = opts.from ? `?from=${encodeURIComponent(opts.from)}` : "";
    // Lazy import (like notFound below) so this server module doesn't eagerly
    // pull next/navigation — which drags in the client app-router-context at
    // module load and breaks react-server test imports.
    const { redirect } = await import("next/navigation");
    redirect(`/login${search}`);
  }
  const live = session as NonNullable<typeof session>;
  // Security: deny soft-disabled (or deleted) accounts even if they still
  // hold a valid session cookie. Disabling revokes sessions, but this is the
  // backstop against a surviving or re-issued cookie — mirrors getCurrentUser
  // (and the RBAC gates, where a disabled account resolves to no permissions).
  // One indexed PK lookup per gated request; same trade-off the RBAC gates make.
  const row = await authService.findById(live.user.id);
  if (!row || row.disabledAt) {
    const prefix = opts.from ? `?from=${encodeURIComponent(opts.from)}&` : "?";
    const { redirect } = await import("next/navigation");
    redirect(`/login${prefix}disabled=1`);
  }
  return live;
}

/**
 * Admin-AREA gate — pass iff the live user may enter `/admin` at all (holds ANY
 * permission: the wildcard, or any granular grant). NOT a module guard: it is
 * only for pages that load no module data (the Système index) or gate every
 * block by its own grant (the dashboard) — route-invariants.test.ts keeps that
 * allow-list. Everything else calls `requirePermission`. 404s (never
 * redirects) so admin routes stay undiscoverable.
 */
export async function requireAdminArea() {
  const session = await getSession();
  if (!session?.user) {
    const { notFound } = await import("next/navigation");
    notFound();
  }
  const live = session as NonNullable<typeof session>;
  if (!(await canAccessAdminArea(live.user.id))) {
    const { notFound } = await import("next/navigation");
    notFound();
  }
  return live;
}

/**
 * Fine-grained RBAC gate — pass iff the live user is allowed `<module>:<action>`
 * (super_admin's '*' and a role's '<module>:*' both satisfy it). 404s on deny
 * (no leak) and records a staff member's denial on the security trail. Returns
 * the live session so call sites keep the `const session = await
 * requirePermission(...)` shape.
 */
export async function requirePermission(module: PermissionModuleId, action: PermissionAction) {
  const session = await getSession();
  if (!session?.user) {
    const { notFound } = await import("next/navigation");
    notFound();
  }
  const live = session as NonNullable<typeof session>;
  const perms = await resolveUserPermissions(live.user.id);
  if (!permissionSetAllows(perms, module, action)) {
    await emitPermissionDenied(live.user.id, module, action, perms);
    const { notFound } = await import("next/navigation");
    notFound();
  }
  return live;
}

/**
 * Like {@link requirePermission} but passes when the actor holds ANY of the
 * listed `<module>:<action>` grants (OR). For a surface reachable by more than
 * one role — e.g. « Nouvelle commande » (orders_new:create) OR full order
 * management (orders:manage). Denial is attributed to the FIRST grant.
 */
export async function requirePermissionAny(
  grants: ReadonlyArray<{ module: PermissionModuleId; action: PermissionAction }>,
) {
  const session = await getSession();
  if (!session?.user) {
    const { notFound } = await import("next/navigation");
    notFound();
  }
  const live = session as NonNullable<typeof session>;
  const perms = await resolveUserPermissions(live.user.id);
  if (!grants.some((g) => permissionSetAllows(perms, g.module, g.action))) {
    const first = grants[0];
    if (first) await emitPermissionDenied(live.user.id, first.module, first.action, perms);
    const { notFound } = await import("next/navigation");
    notFound();
  }
  return live;
}

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { countEffectiveWildcardAdmins } from "@/lib/rbac/guards";
import {
  claimAdminBootstrap,
  closeAdminBootstrap,
  isAdminBootstrapClosed,
  releaseAdminBootstrapClaim,
} from "@/lib/bootstrap/default-admin";
import { bus } from "@/events/bus";

/**
 * One-shot admin bootstrap.
 *
 *   POST /api/admin/bootstrap
 *   { token: "...", email: "..." }
 *
 * Grants the user matching `email` the super_admin RBAC role and marks their
 * email verified, so they can sign in immediately as a full admin. Gated by
 * ADMIN_BOOTSTRAP_TOKEN (env). Returns 404 if the token isn't configured —
 * there's no signal that this endpoint even exists when bootstrap is closed.
 *
 * Workflow:
 *   1. Register at /register (Better Auth creates user + sends verify email).
 *   2. `curl -X POST https://<host>/api/admin/bootstrap \
 *        -d '{"token":"<TOKEN>","email":"you@gz.tn"}'`
 *   3. Sign in.
 *
 * TRULY one-shot: a successful promotion (or the default-admin creation, or any
 * boot that finds an active admin — see `ensureDefaultAdmin`) BURNS the door —
 * the persisted token is deleted and `ADMIN_BOOTSTRAP_CLOSED` recorded, so this
 * route 404s from then on and init-secrets stops re-exporting the token. It
 * also 404s whenever any ACTIVE effective admin exists (an RBAC `*` holder).
 * Re-open only on purpose (see default-admin.ts).
 */

const bodySchema = z.object({
  token: z.string().min(8),
  email: z.string().email(),
});

export async function POST(request: Request) {
  const token = process.env.ADMIN_BOOTSTRAP_TOKEN;
  if (!token || token.length < 8) {
    // The endpoint deliberately 404s (no signal it exists when bootstrap is
    // closed), but a misconfigured token is an OPERATOR mistake, not an attack —
    // log WHY so a deploy that set a too-short/empty token isn't a silent
    // mystery. The token value itself is never logged.
    console.warn(
      `[bootstrap] refused: ADMIN_BOOTSTRAP_TOKEN ${
        !token ? "is not set" : "is too short (< 8 chars)"
      } — set it to a high-entropy value (e.g. \`openssl rand -hex 12\`) to enable first-admin promotion.`,
    );
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Rate limit per IP — 5 attempts / 5 minutes. Combined with a high-entropy
  // token + the constant-time compare below, brute force is infeasible.
  const ip =
    getClientIp(request.headers) ||
    "anon";
  const rl = await checkRateLimit({
    bucket: `bootstrap:ip:${ip}`,
    max: 5,
    windowSeconds: 300,
  });
  if (!rl.ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // Constant-time compare — `===` can leak the token byte-by-byte over
  // millions of attempts via response timing. timingSafeEqual returns false
  // for length mismatches without comparing bytes.
  const provided = Buffer.from(parsed.data.token, "utf8");
  const expected = Buffer.from(token, "utf8");
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // One-shot semantics: the door is closed (404) once it has been burned, and
  // whenever the store has an ACTIVE effective admin — an RBAC `*` holder
  // (`countEffectiveWildcardAdmins`, which excludes disabled accounts). It
  // exists only to mint the FIRST admin when none can be reached (e.g.
  // DISABLE_DEFAULT_ADMIN) — with a working admin, role changes belong in the
  // panel.
  if (await isAdminBootstrapClosed()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if ((await countEffectiveWildcardAdmins()) > 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const user = await authService.findByEmail(parsed.data.email);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Atomically claim the door BEFORE promoting, so two concurrent valid
  // requests can't both mint an admin; released if the promotion fails.
  if (!(await claimAdminBootstrap())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Mint the first admin by granting the super_admin RBAC role — the SOLE
  // source of full access now that the legacy enum→'*' bridge is gone. The
  // seeded role must exist (migration 0033); its absence is an operator
  // misconfiguration, not an attack, so fail loudly rather than mint a
  // powerless "admin".
  const superAdminRole = await rbacService.findRoleByKey("super_admin");
  if (!superAdminRole) {
    await releaseAdminBootstrapClaim().catch(() => {});
    console.error(
      "[bootstrap] the seeded super_admin role is missing — cannot mint the first admin (check migration 0033 ran)",
    );
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  try {
    await authService.update(user.id, {
      emailVerified: true,
      disabledAt: null,
    });
    await rbacService.assignRoleToUser(user.id, superAdminRole.id);
  } catch (err) {
    await releaseAdminBootstrapClaim().catch(() => {});
    throw err;
  }
  // Burn the persisted token (the claim above already set the closed marker).
  await closeAdminBootstrap().catch((err) =>
    console.error("[bootstrap] could not delete the persisted bootstrap token", err),
  );

  // Audit the promotion — a privileged grant must leave a trail (the only
  // actor we have is the promoted user itself; the token stands in for the
  // operator). Lands in audit_log via the audit-trail subscriber.
  await bus.emit(
    "user.roles_changed",
    { userId: user.id, roleIds: [superAdminRole.id], actorUserId: user.id },
    { actorUserId: user.id, actorIp: ip },
  );

  // Ensure a customer profile + link exists so /account works.
  const link = await customerUserLink.findByUserId(user.id);
  if (!link) {
    const [first, ...rest] = (user.name ?? "Admin").split(/\s+/);
    const last = rest.join(" ") || "Admin";
    const profile = await customerService.insertProfile({
      first_name: first ?? "Admin",
      last_name: last,
    });
    await customerUserLink.create({
      user_id: user.id,
      customer_profile_id: profile.id,
    });
  }

  return NextResponse.json({ ok: true, userId: user.id });
}

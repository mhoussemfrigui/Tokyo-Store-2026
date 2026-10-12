import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { requirePermission } from "@/lib/auth/session";
import { checkSuperAdmin } from "@/lib/auth/super-admin";
import { assertSameOrigin } from "@/lib/auth/origin";
import { workflows } from "@/workflows";
import { bustStorefrontCache as bustStorefrontTags } from "@/lib/cache/bust-storefront";
import { isPurgeInProgress } from "@/lib/demo/purge-lock";
import { importJobService } from "@/modules/import";

/**
 * Admin-only demo import / clear endpoint.
 *
 *   POST /api/admin/system/demo                    → run import workflow
 *   POST /api/admin/system/demo?op=clear           → run clear workflow
 *
 * Import: `requirePermission("system_demo", "manage")` (→ 404 on anonymous /
 * unauthorized; returned 404s never leak the endpoint's existence). Answers
 * 409 while an import/clean job or a purge is running (same single-flight bar
 * as the admin data-jobs).
 *
 * Clear: ⚠ NOT scoped to demo rows — it wipes the WHOLE catalogue (every
 * product with its reviews/wishlists, attributes, banners, brands, FAQs,
 * navigation), ARCHIVES every customer profile and resets the seeded demo
 * settings (see `clearDemoWorkflow`). So on top of system_demo:manage it requires
 * the RBAC `*` wildcard (super-admin, like the purge) → 403 otherwise, and the
 * workflow answers 409 while an import/clean job or a purge is running.
 *
 * Headless counterpart of the admin UI (the import segments on
 * /admin/system/import-demo; « Tout nettoyer » in CMS → Réglages). Both call the
 * same segment functions. This route exists for curl-based ops (CI smoke tests,
 * post-deploy verification, headless tools) since Server Actions are awkward to
 * invoke without a browser; send an `Origin` header matching the site
 * (`assertSameOrigin` rejects a POST carrying neither Origin nor Referer).
 */

/** Same presumed-dead window as the data-job actions' stale-job janitor. */
const STALE_RUNNING_MINUTES = 15;

export async function POST(request: Request) {
  // CSRF defense — Better Auth's trustedOrigins protection only fires on
  // /api/auth/*. Without this check a malicious tab could trigger demo
  // wipes / imports while the admin is logged in (SameSite=Lax allows
  // credentialed XHR/fetch across sites in many browsers).
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const session = await requirePermission("system_demo", "manage");
  const url = new URL(request.url);
  const opRaw = url.searchParams.get("op") ?? "import";
  // Reject unknown operations explicitly — `?op=garbage` must not fall
  // through to the import workflow.
  if (opRaw !== "import" && opRaw !== "clear") {
    return NextResponse.json(
      { error: { code: "invalid_input", message: "Unknown op" } },
      { status: 400 },
    );
  }

  if (opRaw === "clear") {
    // Whole-store wipe + customer archive → super-admin only (same bar as the
    // purge). The caller already proved system_demo:manage, so a 403 leaks
    // nothing; the probe is recorded on the security trail.
    if (!(await checkSuperAdmin(session.user.id))) {
      return NextResponse.json(
        { error: { code: "forbidden", message: "Accès super-admin requis." } },
        { status: 403 },
      );
    }
    const result = await workflows.demo.clear({ actorUserId: session.user.id });
    if (!result.ok) {
      return NextResponse.json(
        { error: { code: result.error, message: result.message } },
        { status: result.error === "busy" ? 409 : 400 },
      );
    }
    bustStorefrontCache();
    return NextResponse.json({ ok: true, counts: result.data });
  }

  // Import: same single-flight bar as the admin UI's data-jobs — never seed
  // while an import/clean job runs or during a super-admin purge's lockless
  // destructive window (the checks live here, not in the workflow, because the
  // purge's own relaunch calls the workflow while holding the purge marker).
  await importJobService.failStaleRunning(STALE_RUNNING_MINUTES);
  if (await importJobService.hasActive()) {
    return NextResponse.json(
      {
        error: {
          code: "busy",
          message: "Une opération d'import/nettoyage est déjà en cours. Réessayez quand elle est terminée.",
        },
      },
      { status: 409 },
    );
  }
  if (await isPurgeInProgress()) {
    return NextResponse.json(
      {
        error: {
          code: "busy",
          message: "Une réinitialisation des données est en cours. Réessayez quand elle est terminée.",
        },
      },
      { status: 409 },
    );
  }

  const result = await workflows.demo.import({ actorUserId: session.user.id });
  if (!result.ok) {
    return NextResponse.json(
      { error: { code: result.error, message: result.message } },
      { status: 400 },
    );
  }
  bustStorefrontCache();
  return NextResponse.json({ ok: true, counts: result.data });
}

/**
 * Demo import/clear touches almost every storefront surface (banners,
 * products, categories, FAQs, settings, navigation). Rather than chase individual
 * cache tags, blast the cached storefront layout — re-rendering on next hit
 * is cheap and the operator is doing one-shot setup, not a hot path. The tag
 * list is the shared bulk-path one (`STOREFRONT_BULK_TAGS`); this route runs
 * in a live request, so the bust applies when it responds. (The catalogue feed
 * import the workflow detaches is busted by the job poller when it finishes.)
 */
function bustStorefrontCache() {
  revalidatePath("/", "layout");
  bustStorefrontTags(); // expire:0 → actually discard, not just mark stale
}

"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { bus } from "@/events/bus";
import { promotionService } from "@/modules/promotion";
import { isFlowEnabled } from "@/modules/mailing";
import { marketingSendBlocked, marketingGateSummary } from "@/lib/mailing/automation-gate";
import type { RuleNode } from "@/lib/promotions/rule-tree";
import { requirePermission, getSession } from "@/lib/auth/session";
import { readCart } from "@/lib/cart/session";
import { couponLinesOf, priceCartLinesLive } from "@/lib/cart/live-lines";
import { cartService } from "@/modules/cart/service";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { type ActionState } from "@/lib/actions/types";
import { dinarsToMinor } from "@/lib/price";

const COUPON_COOKIE = "gz.coupon";
const COUPON_COOKIE_TTL = 60 * 60 * 24; // 24h — long enough to survive a
// tab close, short enough that expired coupons don't linger forever.

/**
 * Server actions for the admin promotion forms. Each one:
 *   1. Re-checks admin auth — defence in depth.
 *   2. Translates `FormData` → typed workflow input.
 *   3. Calls the matching workflow.
 *   4. Revalidates the storefront surfaces that could now show / hide a promo
 *      (product page, /panier, /checkout, home).
 */

// ─────────────────────────── helpers ────────────────────────────
function optional(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  if (v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

function optionalNullable(form: FormData, key: string): string | null | undefined {
  if (!form.has(key)) return undefined;
  const v = form.get(key);
  if (v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function optionalInt(form: FormData, key: string): number | undefined {
  const v = optional(form, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * Reads a money field the admin enters in DINARS (major units) and returns
 * integer minor units (millimes). Accepts "," or "." as the decimal
 * separator. Returns undefined for blank/invalid so the caller can fall back
 * to its default.
 */
function optionalDinarsToMinor(form: FormData, key: string): number | undefined {
  const v = optional(form, key);
  if (v === undefined) return undefined;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? dinarsToMinor(n) : undefined;
}

function optionalIntNullable(form: FormData, key: string): number | null | undefined {
  if (!form.has(key)) return undefined;
  const v = form.get(key);
  if (v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function bool(form: FormData, key: string): boolean {
  const v = form.get(key);
  return v === "on" || v === "true" || v === "1";
}

/** All string values submitted under a repeated checkbox-group name. */
function getAllStrings(form: FormData, key: string): string[] {
  return form.getAll(key).map((v) => String(v)).filter((s) => s.length > 0);
}

/**
 * Parse the free-text "target customers" textarea: split on whitespace /
 * commas / semicolons, lower-case, keep only things that look like an email
 * (contain "@"), and de-duplicate. The workflow resolves each to a profile.
 */
function parseEmails(form: FormData, key: string): string[] {
  const raw = String(form.get(key) ?? "");
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const e = part.trim().toLowerCase();
    if (e.includes("@")) seen.add(e);
  }
  return [...seen];
}

/**
 * Shared FormData → workflow-input translation for create + update. Reads the
 * targeting + new behaviour fields once so both actions stay in lock-step.
 */
function readPromotionForm(formData: FormData) {
  const discountType =
    (formData.get("discountType") as "percent" | "fixed") ?? "percent";
  return {
    name: String(formData.get("name") ?? ""),
    targetSegmentIds: getAllStrings(formData, "targetSegment"),
    targetCustomerEmails: parseEmails(formData, "targetCustomerEmails"),
    triggerKind: (formData.get("triggerKind") as "auto" | "code" | "url") ?? "auto",
    code: optionalNullable(formData, "code"),
    urlSlug: optionalNullable(formData, "urlSlug"),
    scope:
      (formData.get("scope") as "product" | "category" | "brand" | "cart" | "targeted") ?? "cart",
    scopeId: optionalNullable(formData, "scopeId"),
    // MULTI-target set (scope='targeted'): checkbox groups (product / category /
    // brand) plus an optional per-variant picker. Assembled into one list; category
    // targets cascade by default (the workflow defaults includeDescendants=true).
    // Ignored for the single-scope kinds.
    //
    // Variant precedence (migration 0173): a `scopeTargetProductVariant` value is
    // "<productId>:<variantId>" and narrows the promo to that ONE variant. If a
    // product has ANY variant target, its whole-product checkbox is dropped — the
    // operator narrowed to specific variants, so covering all of them would defeat
    // that. Products without a variant target keep their whole-product target.
    scopeTargets: (() => {
      const variantPairs = getAllStrings(formData, "scopeTargetProductVariant")
        .map((s) => {
          const [productId, variantId] = s.split(":");
          return { productId, variantId };
        })
        .filter((p) => p.productId && p.variantId);
      const pidsWithVariant = new Set(variantPairs.map((p) => p.productId));
      return [
        ...getAllStrings(formData, "scopeTargetProduct")
          .filter((id) => !pidsWithVariant.has(id))
          .map((id) => ({ targetType: "product" as const, targetId: id })),
        ...variantPairs.map((p) => ({
          targetType: "product" as const,
          targetId: p.productId,
          variantId: p.variantId,
        })),
        ...getAllStrings(formData, "scopeTargetCategory").map((id) => ({
          targetType: "category" as const,
          targetId: id,
        })),
        ...getAllStrings(formData, "scopeTargetBrand").map((id) => ({
          targetType: "brand" as const,
          targetId: id,
        })),
      ];
    })(),
    discountType,
    // Percent: raw 1-100. Fixed: admin enters DINARS → store millimes.
    discountValue:
      (discountType === "fixed"
        ? optionalDinarsToMinor(formData, "discountValue")
        : optionalInt(formData, "discountValue")) ?? 0,
    // Percent-only cap, admin enters DINARS → millimes; blank OR 0 = uncapped
    // (a 0 cap is meaningless — coerce to null so it doesn't fail Zod's min(1)).
    maxDiscountCents: ((c) => (c != null && c >= 1 ? c : null))(
      optionalDinarsToMinor(formData, "maxDiscountTnd"),
    ),
    minCartCents: optionalDinarsToMinor(formData, "minCartCents") ?? 0,
    // Optional upper cart bound, admin enters DINARS → millimes; blank OR 0 = none.
    maxCartCents: ((c) => (c != null && c >= 1 ? c : null))(
      optionalDinarsToMinor(formData, "maxCartTnd"),
    ),
    excludeDiscountedItems: bool(formData, "excludeDiscountedItems"),
    maxUses: optionalIntNullable(formData, "maxUses"),
    maxUsesPerUser: optionalIntNullable(formData, "maxUsesPerUser"),
    startsAt: optionalNullable(formData, "startsAt"),
    endsAt: optionalNullable(formData, "endsAt"),
    announceAt: optionalNullable(formData, "announceAt"),
    isActive: bool(formData, "isActive"),
    isStackable: bool(formData, "isStackable"),
    grantsFreeShipping: bool(formData, "grantsFreeShipping"),
    firstOrderOnly: bool(formData, "firstOrderOnly"),
    // Inline audience rule — the builder posts the RuleNode as a JSON blob (empty
    // when none). An EMPTY blob is a genuine "no audience" → public coupon (intended).
    // A NON-EMPTY but UNPARSEABLE blob must FAIL CLOSED: coercing it to `null` would
    // silently drop the intended audience restriction and publish the coupon. Return
    // an empty group — a valid RuleNode shape that the workflow's isValidRuleTree
    // rejects (empty group, MIN_GROUP_CHILDREN) — so the save is refused, not opened up.
    audienceRuleTree: ((raw): RuleNode | null => {
      const s = String(raw ?? "").trim();
      if (!s) return null;
      try {
        return JSON.parse(s) as RuleNode;
      } catch {
        return { op: "and", children: [] };
      }
    })(formData.get("audienceRuleTree")),
    displayPriority: optionalInt(formData, "displayPriority") ?? 0,
    // Announce by email on CREATE (the workflow only emits on create; update ignores it).
    announceByEmail: bool(formData, "announceByEmail"),
  };
}

/** Append the workflow's non-blocking targeting notices (dropped emails, kept
 *  orphan targets…) to the success message so nothing is discarded silently. */
function withWarnings(message: string, warnings: string[]): string {
  return warnings.length > 0 ? `${message} ${warnings.join(" ")}` : message;
}

function revalidateStorefrontPromos() {
  // No promotion read is cross-request cached: live promos are resolved per
  // request (the cached PDP DTO is the BASE product, promos applied after), so
  // there's no cache tag to bust — refreshing the rendered routes is enough.
  revalidatePath("/", "layout");
  revalidatePath("/panier");
  revalidatePath("/checkout");
}

// ─────────────────────────── create ────────────────────────────
export async function createPromotionAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("promotions", "create");

  const input = readPromotionForm(formData);

  const result = await workflows.promotion.create(input, { actorUserId: session.user.id });
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      message: result.message,
      fieldErrors: result.fieldErrors,
    };
  }
  revalidatePath("/admin/promotions");
  revalidateStorefrontPromos();
  return {
    ok: true,
    message: withWarnings("Promotion créée.", result.data.warnings),
    id: result.data.promotionId,
  };
}

// ─────────────────────────── update ────────────────────────────
export async function updatePromotionAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("promotions", "update");
  const promotionId = optional(formData, "promotionId");
  if (!promotionId) {
    return { ok: false, error: "validation", message: "promotionId requis." };
  }

  const input = { promotionId, ...readPromotionForm(formData) };

  const result = await workflows.promotion.update(input, { actorUserId: session.user.id });
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      message: result.message,
      fieldErrors: result.fieldErrors,
    };
  }
  revalidatePath("/admin/promotions");
  revalidatePath(`/admin/promotions/${promotionId}`);
  revalidateStorefrontPromos();
  return {
    ok: true,
    message: withWarnings("Promotion mise à jour.", result.data.warnings),
    id: promotionId,
  };
}

// ─────────────────────────── delete + toggle ───────────────────
export async function deletePromotionAction(promotionId: string): Promise<ActionState> {
  const session = await requirePermission("promotions", "delete");
  const result = await workflows.promotion.delete(
    { promotionId },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/promotions");
  revalidateStorefrontPromos();
  return { ok: true };
}

/**
 * Manual « Annoncer maintenant » — fire the email announcement of a promotion on
 * demand (a promo created without announcing, or to reach customers who opted in
 * since a previous announce). Reuses the same blast path as the create-time /
 * scheduled announce, so the per-recipient `mailing_sends` dedup means a customer
 * already emailed for THIS promo is never re-contacted (no spam). The promo must be
 * LIVE (active + in window), like the immediate create-time announce.
 */
export async function announcePromotionNowAction(promotionId: string): Promise<ActionState> {
  const session = await requirePermission("promotions", "update");
  const promo = await promotionService.findById(promotionId);
  if (!promo) return { ok: false, error: "not_found", message: "Promotion introuvable." };
  const now = Date.now();
  const live =
    promo.is_active &&
    !promo.deleted_at &&
    !(promo.starts_at && new Date(promo.starts_at).getTime() > now) &&
    !(promo.ends_at && new Date(promo.ends_at).getTime() <= now);
  if (!live) {
    return {
      ok: false,
      error: "conflict",
      message: "La promotion doit être active et dans sa fenêtre pour être annoncée.",
    };
  }
  // The announcement won't go out if marketing / this flow is off. Check the SAME
  // gate the blast + sweep use BEFORE stamping — stamping announced_at when nothing is
  // sent would falsely report success AND permanently suppress a pending scheduled
  // announce (the sweep's `announced_at IS NULL` gate). Refuse instead.
  const flow = "promotion_announcement";
  if (!(await isFlowEnabled(flow))) {
    return {
      ok: false,
      error: "conflict",
      message: "Les annonces de promotions par email sont désactivées (Réglages → Automatisations e-mail).",
    };
  }
  const blocked = await marketingSendBlocked(flow);
  if (blocked) {
    return { ok: false, error: "conflict", message: marketingGateSummary(blocked, flow) };
  }
  // Fire the blast (detached subscriber) + stamp announced_at for display / so the
  // scheduled sweep never double-announces it.
  await bus.emit("promotion.announce_requested", { promotionId }, { actorUserId: session.user.id });
  await promotionService.markAnnounced(promotionId).catch(() => {});
  revalidatePath(`/admin/promotions/${promotionId}`);
  return {
    ok: true,
    message: "Annonce lancée — les clients concernés (non déjà notifiés) recevront l'email.",
  };
}

export async function togglePromotionActiveAction(
  promotionId: string,
  isActive: boolean,
): Promise<ActionState> {
  const session = await requirePermission("promotions", "update");
  const result = await workflows.promotion.toggleActive(
    { promotionId, isActive },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/promotions");
  revalidateStorefrontPromos();
  return { ok: true };
}

// ─────────────────────────── clone ──────────────────────────────
/**
 * Duplicate a promotion (and its targeting) as a fresh INACTIVE draft via the
 * duplicate workflow: a code/URL promo clones with a generated placeholder
 * code/slug (`<CODE>-COPIE-XXXX`) the admin replaces on the edit screen, so the
 * trigger-surface CHECK and the unique indexes always hold; emits
 * `promotion.created` (audit + webhooks) like a regular create.
 */
export async function clonePromotionAction(promotionId: string): Promise<ActionState> {
  const session = await requirePermission("promotions", "create");

  const result = await workflows.promotion.duplicate(
    { promotionId },
    { actorUserId: session.user.id },
  );
  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message };
  }

  revalidatePath("/admin/promotions");
  revalidateStorefrontPromos();
  const { code, urlSlug } = result.data;
  return {
    ok: true,
    message: code
      ? `Promotion dupliquée (inactive) avec le code provisoire « ${code} » — remplacez-le avant de l'activer.`
      : urlSlug
        ? `Promotion dupliquée (inactive) avec le slug provisoire « ${urlSlug} » — remplacez-le avant de l'activer.`
        : "Promotion dupliquée (inactive).",
    id: result.data.promotionId,
  };
}

// ─────────────────────────── shopper-facing ─────────────────────────────
/**
 * Apply a coupon code to the current cart. Validates against the live
 * promotion window + per-user / global caps, then stores the result in a
 * short-lived cookie that the cart/checkout pages re-read on render.
 *
 * Returns a structured success/failure so the cart UI can surface the
 * error inline ("expired", "minimum 250 TND not met", etc.).
 */
export async function applyCouponAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { ok: false, error: "validation", message: "Code requis." };

  const [cart, session, h] = await Promise.all([
    readCart().catch(() => null),
    getSession().catch(() => null),
    headers(),
  ]);

  // Anti-enumeration throttle. The response distinguishes a valid code
  // ("Code « X » appliqué") from an invalid one, so without a cap an attacker
  // could brute-force the promo-code space. Per-IP is the primary guard (works
  // for anonymous carts too); a tighter per-user bucket stops one signed-in
  // account hammering. Mirrors submitReviewAction's dual-bucket pattern.
  const ip = getClientIp(h);
  const [ipRl, userRl] = await Promise.all([
    checkRateLimit({ bucket: `coupon:ip:${ip ?? "anon"}`, max: 15, windowSeconds: 60 }),
    session?.user?.id
      ? checkRateLimit({ bucket: `coupon:user:${session.user.id}`, max: 10, windowSeconds: 60 })
      : Promise.resolve({ ok: true } as const),
  ]);
  if (!ipRl.ok || !userRl.ok) {
    return {
      ok: false,
      error: "rate_limited",
      message: "Trop de tentatives. Réessayez dans un instant.",
    };
  }
  // LIVE re-priced subtotal + per-line context — the same basis /panier and
  // /checkout apply the coupon on — so the min/max-cart gate and a SCOPED
  // coupon's matching-lines check (incl. exclude-already-on-sale) agree with
  // what the cart displays, instead of the stale add-time `cart_items` prices.
  const live = cart
    ? await cartService
        .listItems(cart.id)
        .then((items) => priceCartLinesLive(items))
        .catch(() => null)
    : null;

  // A cart exists but LIVE re-pricing threw (a transient DB/pricing hiccup —
  // an empty cart resolves to a subtotal-0 object, never null). Don't fall
  // through with subtotal 0 / no lines: that would misreport a min-cart or a
  // scoped coupon as "ineligible" ("requires X TND" / "no matching items").
  // Surface a retryable error instead so the shopper can try again.
  if (cart && live === null) {
    return {
      ok: false,
      error: "pricing",
      message: "Impossible de vérifier votre panier pour le moment — réessayez.",
    };
  }

  const result = await workflows.promotion.evaluate({
    code,
    cartSubtotalCents: live?.subtotalCents ?? 0,
    userId: session?.user?.id ?? null,
    lines: live ? couponLinesOf(live) : [],
  });
  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message };
  }

  const jar = await cookies();
  jar.set(COUPON_COOKIE, result.data.promotionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COUPON_COOKIE_TTL,
  });

  revalidatePath("/panier");
  revalidatePath("/checkout");
  return {
    ok: true,
    message: `Code « ${code} » appliqué : ${result.data.name}.`,
  };
}

/**
 * Remove the currently-applied coupon. Doesn't revoke past redemptions —
 * just clears the cookie so the cart stops showing the discount.
 */
export async function clearCouponAction(): Promise<ActionState> {
  const jar = await cookies();
  jar.delete(COUPON_COOKIE);
  revalidatePath("/panier");
  revalidatePath("/checkout");
  return { ok: true, message: "Code retiré." };
}

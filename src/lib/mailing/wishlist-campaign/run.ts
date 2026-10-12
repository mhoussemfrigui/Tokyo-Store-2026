import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  customer_profiles,
  customer_segments,
  customer_segment_members,
} from "@/modules/customer/schema";
import { customer_user_links } from "@/associations/customer-user";
import { users } from "@/modules/auth/schema";
import { products } from "@/modules/catalog/product/schema";
import { legacyRuleToTree } from "@/lib/promotions/rule-tree";
import { buildSegmentSqlCtx, segmentMemberIdsSql } from "@/lib/promotions/rule-tree-sql";
import { dispatchEmail, isFlowEnabled, mailingSendsService } from "@/modules/mailing";
import { promotionService } from "@/modules/promotion";
import { wishlistService } from "@/modules/wishlist";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { marketingGateSummary, marketingSendBlocked } from "@/lib/mailing/automation-gate";
import { describePromoDiscount } from "@/lib/mailing/promo-describe";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { storeYear, storeMonth } from "@/lib/promotions/segments";

/**
 * « Campagne personnalisée — liste d'envies » (the owner's cross-data auto-campaign:
 * e.g. a promo on the items in a customer's WISHLIST as their anniversary approaches).
 *
 * Emails every marketing-opted-in member of a configured AUDIENCE SEGMENT (dynamic
 * rule_tree — the admin builds it to include an anniversary / birthday / tier / spend
 * condition — or manual) WHO has a non-empty wishlist, a promo code personalized with
 * THEIR wishlist products. This rides the existing buyer-aware coupon layer: the
 * featured code can itself carry an audience rule / targets, so the discount is only
 * honored for a matching buyer at checkout — pricing stays public/cache-safe.
 *
 * Idempotent per customer per calendar MONTH via `mailing_sends` (a member matching an
 * anniversary window for ~a week gets at most one email; a standing segment gets at
 * most one per month). The marketing kill-switch + flow toggle are checked BEFORE any
 * claim (a run while marketing is off doesn't burn the month). Enqueues bulk.
 */
const FLOW = "wishlist_campaign";
const SEGMENT_SETTING = "mail.wishlist_campaign_segment_id";
const CODE_SETTING = "mail.wishlist_campaign_code";
const MEMBER_CAP = 5000;
const MAX_WISHLIST_ITEMS = 4;

export type WishlistCampaignRunResult = { ok: boolean; summary: string; status?: "skipped" };

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export async function runWishlistCampaignEmails(): Promise<WishlistCampaignRunResult> {
  if (!(await isFlowEnabled(FLOW))) {
    return { ok: true, summary: "campagne liste d'envies désactivée", status: "skipped" };
  }
  const blocked = await marketingSendBlocked(FLOW);
  if (blocked) return { ok: true, summary: marketingGateSummary(blocked, FLOW), status: "skipped" };

  const settings = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
  const segmentId = settings[SEGMENT_SETTING]?.trim();
  if (!segmentId) return { ok: true, summary: `aucun segment configuré (${SEGMENT_SETTING})`, status: "skipped" };
  const code = settings[CODE_SETTING]?.trim();
  if (!code) return { ok: true, summary: `aucun code configuré (${CODE_SETTING})`, status: "skipped" };

  const promo = await promotionService.findLiveByCode(code);
  if (!promo || !promo.code) {
    return { ok: true, summary: `code « ${code} » introuvable / inactif`, status: "skipped" };
  }
  const discount = describePromoDiscount(promo);

  // Load the audience segment (enabled, non-deleted).
  const [seg] = await db
    .select({ kind: customer_segments.kind, rule: customer_segments.rule, rule_tree: customer_segments.rule_tree, name: customer_segments.name })
    .from(customer_segments)
    .where(and(eq(customer_segments.id, segmentId), eq(customer_segments.enabled, true), isNull(customer_segments.deleted_at)))
    .limit(1);
  if (!seg) return { ok: true, summary: "segment introuvable / désactivé", status: "skipped" };

  // Resolve marketing-opted-in member profile ids (dynamic rule vs manual roster).
  let memberIds: string[];
  if (seg.kind === "dynamic") {
    const ctx = await buildSegmentSqlCtx();
    memberIds = await segmentMemberIdsSql(seg.rule_tree ?? legacyRuleToTree(seg.rule), ctx, {
      cap: MEMBER_CAP,
      marketingOptInOnly: true,
    });
  } else {
    const rows = await db
      .select({ pid: customer_segment_members.customer_profile_id })
      .from(customer_segment_members)
      .innerJoin(
        customer_profiles,
        and(
          eq(customer_profiles.id, customer_segment_members.customer_profile_id),
          eq(customer_profiles.marketing_opt_in, true),
          isNull(customer_profiles.deleted_at),
        ),
      )
      .where(eq(customer_segment_members.segment_id, segmentId))
      .orderBy(desc(customer_segment_members.created_at))
      .limit(MEMBER_CAP);
    memberIds = rows.map((r) => r.pid);
  }
  if (memberIds.length === 0) return { ok: true, summary: "aucun membre opt-in dans le segment", status: "skipped" };

  // Resolve (profile, user, email, first_name) for the members — the user_id is
  // needed for the per-recipient wishlist lookup.
  const recipients = await db
    .select({ pid: customer_profiles.id, uid: customer_user_links.user_id, email: users.email, fn: customer_profiles.first_name })
    .from(customer_profiles)
    .innerJoin(customer_user_links, eq(customer_user_links.customer_profile_id, customer_profiles.id))
    .innerJoin(users, eq(users.id, customer_user_links.user_id))
    .where(inArray(customer_profiles.id, memberIds));

  const origin = await resolvePublicOrigin();
  const now = new Date();
  const monthKey = `${storeYear(now)}-${pad(storeMonth(now))}`;
  let sent = 0;

  for (const r of recipients) {
    // Per-recipient wishlist (own products, newest first). Empty → skip: this
    // campaign is ABOUT the customer's wishlist.
    const wl = await wishlistService.findByUserId(r.uid).catch(() => null);
    const productIds = wl ? await wishlistService.listProductIds(wl.id).catch(() => []) : [];
    if (productIds.length === 0) continue;

    // Names + slugs for the featured items (published only, capped).
    const items = await db
      .select({ name: products.name, slug: products.slug })
      .from(products)
      .where(and(inArray(products.id, productIds.slice(0, MAX_WISHLIST_ITEMS * 2)), eq(products.is_published, true), isNull(products.deleted_at)))
      .limit(MAX_WISHLIST_ITEMS);
    if (items.length === 0) continue;

    const wishlistHtml = items
      .map(
        (it) =>
          `<li style="margin:4px 0;"><a href="${origin}/${it.slug}" style="color:#d40530;text-decoration:none;">${escapeHtml(it.name)}</a></li>`,
      )
      .join("");

    // One email per member per calendar month (bounds an anniversary-window match
    // to a single send; a standing segment to monthly).
    const dedupKey = `${r.pid}:${monthKey}`;
    const first = await mailingSendsService.claimOnce(FLOW, dedupKey).catch(() => false);
    if (!first) continue;

    const res = await dispatchEmail({
      key: FLOW,
      to: r.email,
      flowKey: FLOW,
      bulk: true,
      variables: {
        first_name: r.fn ?? "",
        code: promo.code.toUpperCase(),
        discount,
        shop_url: origin,
      },
      // The list is pre-built HTML (<ul><li><a>…) — pass it via htmlVariables so dispatch
      // does NOT re-escape it (the template declares wishlist_items as isHtml). In
      // `variables` it rendered as literal "&lt;ul&gt;…" text in the inbox.
      htmlVariables: {
        wishlist_items: `<ul style="padding-left:18px;margin:8px 0;">${wishlistHtml}</ul>`,
      },
    }).catch(() => null);
    if (res?.queued) sent++;
    else await mailingSendsService.release(FLOW, dedupKey).catch(() => {});
  }

  return { ok: true, summary: `campagne liste d'envies (« ${seg.name} »): ${sent} email(s) mis en file` };
}

/** Minimal HTML escape for product names injected into the email body. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

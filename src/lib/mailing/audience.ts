import "server-only";

import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { users } from "@/modules/auth/schema";
import { customer_profiles, customer_segments, customer_segment_members } from "@/modules/customer/schema";
import { customer_user_links } from "@/associations/customer-user";
import { newsletter_subscriptions } from "@/modules/newsletter/schema";
import { promotionService } from "@/modules/promotion";
import type { PromotionRow, PromotionTargetRow } from "@/modules/promotion/schema";
import { userIdsWithPlacedOrders } from "@/modules/order/queries";
import { orders } from "@/modules/order/schema";
import type { RuleNode } from "@/lib/promotions/rule-tree";
import { legacyRuleToTree } from "@/lib/promotions/rule-tree";
import { buildSegmentSqlCtx, segmentMemberIdsSql } from "@/lib/promotions/rule-tree-sql";

export type AudienceKind = "marketing_optin" | "newsletter" | "segment" | "addresses" | "rule";
/** Module-local — consumers receive it structurally via the resolver return types. */
type Recipient = { email: string; firstName: string };
/** A promotion-audience candidate WITH ids, so the inline audience-rule + first-order
 *  filters can narrow it before it's mapped to bare {email, firstName} recipients. */
type BaseRow = { pid: string; userId: string; email: string; firstName: string };

/** Safety cap per blast (a single resolve + a bounded enqueue). */
export const AUDIENCE_CAP = 5000;

// All the campaign-kind resolvers below fetch AUDIENCE_CAP + 1 rows: the probe
// row lets resolveCampaignAudience DETECT truncation (via capRows) instead of
// assuming a full-cap result was cut short — so an audience of EXACTLY the cap
// is not falsely reported as "tronquée".

/** All marketing-opted-in customers with a resolvable email. (The public-PROMO
 *  audience has its own, narrower query — see `publicPromoAudience`.) */
async function optinCustomers(): Promise<Recipient[]> {
  const conds = [eq(customer_profiles.marketing_opt_in, true), isNull(customer_profiles.deleted_at)];
  const rows = await db
    .select({ email: users.email, fn: customer_profiles.first_name })
    .from(customer_profiles)
    .innerJoin(customer_user_links, eq(customer_user_links.customer_profile_id, customer_profiles.id))
    .innerJoin(users, eq(users.id, customer_user_links.user_id))
    .where(and(...conds))
    .limit(AUDIENCE_CAP + 1);
  return rows.map((r) => ({ email: r.email, firstName: r.fn ?? "" }));
}

/**
 * Consent-gated email resolution for a set of profile ids: keep only those still
 * marketing-opted-in and not soft-deleted, resolve each to {email, firstName}.
 * Shared by the saved-segment resolver AND the inline-rule resolver so both apply
 * the identical opt-in gate (the drain re-checks at send time for the opt-out race).
 */
async function optinEmailsForProfiles(pids: string[]): Promise<Recipient[]> {
  if (pids.length === 0) return [];
  const rows = await db
    .select({ email: users.email, fn: customer_profiles.first_name })
    .from(customer_profiles)
    .innerJoin(customer_user_links, eq(customer_user_links.customer_profile_id, customer_profiles.id))
    .innerJoin(users, eq(users.id, customer_user_links.user_id))
    .where(
      and(
        inArray(customer_profiles.id, pids),
        eq(customer_profiles.marketing_opt_in, true),
        isNull(customer_profiles.deleted_at),
      ),
    )
    .limit(AUDIENCE_CAP + 1);
  return rows.map((r) => ({ email: r.email, firstName: r.fn ?? "" }));
}

/**
 * Recipients matching an INLINE compound rule tree (audience_kind='rule') — the
 * ad-hoc twin of a dynamic segment: resolve the tree through the SHARED SQL engine
 * (the same `segmentMemberIdsSql` that decides checkout eligibility + dynamic-segment
 * audiences), opt-in gated before the cap so the newest AUDIENCE_CAP+1 are SENDABLE.
 * So a blast rule ⇔ a dynamic segment with the same rule ⇔ promotion eligibility.
 */
async function ruleMembers(tree: RuleNode): Promise<Recipient[]> {
  const ctx = await buildSegmentSqlCtx();
  const pids = await segmentMemberIdsSql(tree, ctx, { cap: AUDIENCE_CAP + 1, marketingOptInOnly: true });
  return optinEmailsForProfiles(pids);
}

/** Active newsletter subscribers (consent basis = newsletter, not profile opt-in). */
async function newsletterActive(): Promise<Recipient[]> {
  const rows = await db
    .select({ email: newsletter_subscriptions.email })
    .from(newsletter_subscriptions)
    .where(eq(newsletter_subscriptions.is_active, true))
    .limit(AUDIENCE_CAP + 1);
  return rows.map((r) => ({ email: r.email, firstName: "" }));
}

/**
 * Recipients of a segment who are still marketing-opted-in. A MANUAL segment reads
 * its explicit member rows; a DYNAMIC segment resolves its rule tree through the
 * SHARED SQL compiler (the same engine that decides checkout eligibility — a
 * dynamic segment now means the same audience whether it targets a promo or a
 * blast), falling back to legacyRuleToTree for a legacy single-rule segment. A
 * disabled or soft-deleted segment resolves to nobody (matches checkout).
 */
async function segmentMembers(segmentId: string): Promise<Recipient[]> {
  const [seg] = await db
    .select({
      kind: customer_segments.kind,
      rule: customer_segments.rule,
      rule_tree: customer_segments.rule_tree,
      enabled: customer_segments.enabled,
      deletedAt: customer_segments.deleted_at,
    })
    .from(customer_segments)
    .where(eq(customer_segments.id, segmentId));
  if (!seg || !seg.enabled || seg.deletedAt) return [];

  if (seg.kind === "dynamic") {
    const ctx = await buildSegmentSqlCtx();
    // Gate opt-in BEFORE the cap so the newest AUDIENCE_CAP+1 are SENDABLE members (a
    // huge segment whose opt-in members skew older isn't silently cut) and the +1
    // probe detects true truncation.
    const pids = await segmentMemberIdsSql(seg.rule_tree ?? legacyRuleToTree(seg.rule), ctx, {
      cap: AUDIENCE_CAP + 1,
      marketingOptInOnly: true,
    });
    return optinEmailsForProfiles(pids);
  }

  // Manual: opt-in gate joined in BEFORE the cap (same reason as the dynamic branch),
  // newest membership first so the cut is deterministic.
  const memberRows = await db
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
    .limit(AUDIENCE_CAP + 1);
  return optinEmailsForProfiles(memberRows.map((r) => r.pid));
}

/** Pasted addresses — parsed + de-duped only. Consent filtering is applied ONCE
 *  by the caller (resolveSendableAudience) for every audience kind, so this no
 *  longer runs its own `filterMarketableEmails` pass (that was a second, identical
 *  3-query round-trip on the same set). */
async function pastedAddresses(raw: string): Promise<Recipient[]> {
  const candidates = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s))
    .slice(0, AUDIENCE_CAP + 1);
  return candidates.map((email) => ({ email, firstName: "" }));
}

/**
 * Resolve a campaign audience to a DE-DUPED recipient list plus whether the
 * scan was TRUNCATED at AUDIENCE_CAP (some eligible recipients excluded).
 * Consent filtering is the caller's job (resolveSendableAudience gates every
 * kind). The five kinds: every marketing-opted-in customer, active newsletter
 * subscribers, a saved segment's members (manual or dynamic), an inline compound
 * RULE (ad-hoc, same engine as dynamic segments), or a pasted address list.
 */
export async function resolveCampaignAudience(
  kind: AudienceKind,
  opts: { segmentId?: string; addresses?: string; ruleTree?: RuleNode },
): Promise<PromotionAudience> {
  let list: Recipient[];
  if (kind === "marketing_optin") list = await optinCustomers();
  else if (kind === "newsletter") list = await newsletterActive();
  else if (kind === "segment") list = opts.segmentId ? await segmentMembers(opts.segmentId) : [];
  else if (kind === "rule") list = opts.ruleTree ? await ruleMembers(opts.ruleTree) : [];
  else list = await pastedAddresses(opts.addresses ?? "");

  const seen = new Set<string>();
  const deduped: Recipient[] = [];
  for (const r of list) {
    const e = r.email.trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    deduped.push({ email: e, firstName: r.firstName });
  }
  const { rows, truncated } = capRows(deduped);
  return { recipients: rows, truncated };
}

/** A promotion audience + whether the AUDIENCE_CAP cut the scan short (so the
 *  caller can REPORT a partial blast instead of silently mailing a subset). */
export type PromotionAudience = { recipients: Recipient[]; truncated: boolean };

/** Scans fetch AUDIENCE_CAP + 1 rows to DETECT truncation; this drops the probe row. */
function capRows<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  return rows.length > AUDIENCE_CAP
    ? { rows: rows.slice(0, AUDIENCE_CAP), truncated: true }
    : { rows, truncated: false };
}

/**
 * PUBLIC-promo audience — the same opt-out coupon eligibility applies to a
 * public promo (coupon-eligibility.ts): every opt-in customer, minus those who
 * opted out of public promos. Stable order (oldest customers first) so a capped
 * blast cuts deterministically.
 */
/** SQL predicate: the joined `users.id` has NO non-cancelled order — the first_order_only
 *  gate pushed INTO the base scan (before the AUDIENCE_CAP), so a welcome coupon's real
 *  cohort (order-less customers) isn't hidden by the oldest-first cap at scale. Same
 *  non-cancelled predicate as order.countPriorPlacedOrders / userIdsWithPlacedOrders. */
function noPlacedOrderSql(): SQL {
  return sql`not exists (
    select 1 from ${orders} o
    where o.${sql.raw("user_id")} = ${users.id} and o.${sql.raw("status")} <> 'cancelled'
  )`;
}

async function publicBaseRows(
  firstOrderOnly: boolean,
): Promise<{ rows: BaseRow[]; truncated: boolean }> {
  const conds: SQL[] = [
    eq(customer_profiles.marketing_opt_in, true),
    isNull(customer_profiles.deleted_at),
    eq(customer_profiles.promo_opt_out, false),
  ];
  if (firstOrderOnly) conds.push(noPlacedOrderSql());
  const scanned = await db
    .select({ pid: customer_profiles.id, userId: users.id, email: users.email, fn: customer_profiles.first_name })
    .from(customer_profiles)
    .innerJoin(customer_user_links, eq(customer_user_links.customer_profile_id, customer_profiles.id))
    .innerJoin(users, eq(users.id, customer_user_links.user_id))
    .where(and(...conds))
    .orderBy(asc(customer_profiles.created_at), asc(customer_profiles.id))
    .limit(AUDIENCE_CAP + 1);
  const { rows, truncated } = capRows(scanned);
  return { rows: rows.map((r) => ({ pid: r.pid, userId: r.userId, email: r.email, firstName: r.fn ?? "" })), truncated };
}

/**
 * Base for an audience-RULED promo with NO explicit targets: the opt-in customers who
 * MATCH the inline rule, resolved via the SHARED SQL engine (segmentMemberIdsSql), so
 * the RULE is applied IN SQL and the cap slices the MATCHED set (newest-first) — not
 * "matches among the oldest 5000 opt-ins" (the cap-before-filter scale trap). Like a
 * dynamic-segment target, the public opt-out doesn't apply (matching checkout eligibility).
 *
 * LIMITATION (rare, non-silent): when the promo ALSO carries first_order_only, that gate
 * is applied to the ALREADY-RULE-CAPPED set below (segmentMemberIdsSql has no order
 * predicate, and reaching into it would couple the segment engine — which has a rule
 * parity contract — to the orders table). So a promo with BOTH a rule AND first_order_only
 * whose rule matches > AUDIENCE_CAP customers narrows only the newest 5000 rule-matchers to
 * the order-less subset — order-less matchers beyond that are missed. It is strictly better
 * than the old cap-then-filter (newest-first biases toward order-less / newly-registered
 * buyers) and `truncated` is flagged, so it's surfaced, not silent. A rule+welcome combo at
 * that scale is an unusual corner; the common welcome coupon (first_order_only, no rule)
 * takes the fully-correct publicBaseRows path (first-order in SQL before the cap).
 */
async function ruleMatchedBaseRows(
  tree: RuleNode,
  firstOrderOnly: boolean,
): Promise<{ rows: BaseRow[]; truncated: boolean }> {
  const ctx = await buildSegmentSqlCtx();
  const pids = await segmentMemberIdsSql(tree, ctx, { cap: AUDIENCE_CAP + 1, marketingOptInOnly: true });
  const truncated = pids.length > AUDIENCE_CAP;
  const capped = pids.slice(0, AUDIENCE_CAP);
  if (capped.length === 0) return { rows: [], truncated };
  const conds: SQL[] = [inArray(customer_profiles.id, capped), isNull(customer_profiles.deleted_at)];
  // first_order over the rule-capped set (see LIMITATION above).
  if (firstOrderOnly) conds.push(noPlacedOrderSql());
  const scanned = await db
    .select({ pid: customer_profiles.id, userId: users.id, email: users.email, fn: customer_profiles.first_name })
    .from(customer_profiles)
    .innerJoin(customer_user_links, eq(customer_user_links.customer_profile_id, customer_profiles.id))
    .innerJoin(users, eq(users.id, customer_user_links.user_id))
    .where(and(...conds));
  return { rows: scanned.map((r) => ({ pid: r.pid, userId: r.userId, email: r.email, firstName: r.fn ?? "" })), truncated };
}

/**
 * The marketing audience for a PROMOTION announcement — kept in step with
 * coupon ELIGIBILITY (coupon-eligibility.ts) so nobody is mailed a code they'd be
 * refused. Public (no targets) → `publicPromoAudience`. Targeted → the opt-in
 * customers who match ANY of the promo's target arms (customer id, or segment —
 * manual OR dynamic), reusing the same resolvers as coupon eligibility.
 * Bounded by the opt-in set + AUDIENCE_CAP; `truncated` reports a capped scan.
 */
export async function resolvePromotionAudience(promotionId: string): Promise<PromotionAudience> {
  // Load the promo (for the inline audience rule + first-order gate) alongside its
  // explicit targets. NO catch on the targets read: failing it open ("no targets" ⇒
  // PUBLIC) would blast a targeted promo to every opt-in customer.
  const [promo, targets] = await Promise.all([
    promotionService.findById(promotionId),
    promotionService.listTargets(promotionId),
  ]);
  if (!promo) return { recipients: [], truncated: false };
  const hasAudienceRule = promo.audience_rule_tree != null;
  const firstOrderOnly = promo.first_order_only;

  // ── Base audience (with ids). For NO-targets promos the inline rule + first-order
  //    gate are pushed INTO the base SQL (before the AUDIENCE_CAP), so the cap never
  //    hides the real cohort at scale. TARGETED promos post-filter below (their base
  //    is the bounded target arms). ──
  const base = await resolvePromotionBaseRows(promo, targets, hasAudienceRule, firstOrderOnly);
  let rows = base.rows;

  // TARGETED promos only: apply the inline rule + first-order over the (small, bounded)
  // target-arm set here. The no-targets paths already applied both in SQL — don't
  // double-filter (harmless but wasteful).
  if (targets.length > 0) {
    // ── Inline audience rule (E2): the buyer must ALSO satisfy the compound rule_tree,
    //    via the SHARED SQL engine (the same that decides checkout eligibility), so the
    //    announce audience ⇔ who can actually redeem. ──
    if (hasAudienceRule && rows.length > 0) {
      const ctx = await buildSegmentSqlCtx();
      const matched = new Set(
        await segmentMemberIdsSql(promo.audience_rule_tree!, ctx, { profileIds: rows.map((r) => r.pid) }),
      );
      rows = rows.filter((r) => matched.has(r.pid));
    }
    // ── First-order welcome coupon (E1): mail ONLY first-time buyers (a returning
    //    customer is refused the code at checkout — not_first_order). ──
    if (firstOrderOnly && rows.length > 0) {
      const placed = await userIdsWithPlacedOrders(rows.map((r) => r.userId));
      rows = rows.filter((r) => !placed.has(r.userId));
    }
  }

  return {
    recipients: rows.map((r) => ({ email: r.email, firstName: r.firstName })),
    truncated: base.truncated,
  };
}

/**
 * The BASE promotion audience:
 *   - NO targets + inline rule → the opt-in customers MATCHING the rule (rule applied
 *     IN SQL via segmentMemberIdsSql, so the cap slices the matched set — TARGETED, so
 *     the public opt-out doesn't apply);
 *   - NO targets, no rule → the PUBLIC audience (opt-in minus promo opt-outs);
 *   - explicit targets → the opt-in customers matching ANY target arm (customer /
 *     segment manual+dynamic); the rule + first-order are post-filtered by the caller
 *     over this bounded set.
 * For the NO-targets paths, `firstOrderOnly` is folded into the SQL too (before the cap).
 * Returns rows WITH ids so the caller can post-filter the targeted case.
 */
async function resolvePromotionBaseRows(
  promo: PromotionRow,
  targets: PromotionTargetRow[],
  hasAudienceRule: boolean,
  firstOrderOnly: boolean,
): Promise<{ rows: BaseRow[]; truncated: boolean }> {
  // Public-vs-targeted keys on whether the promo carries ANY target ROW (or an
  // inline rule).
  if (targets.length === 0) {
    // Rule / first-order pushed INTO the base SQL (before the AUDIENCE_CAP) so scale
    // never hides the real cohort. An inline rule makes the promo TARGETED (public
    // opt-out skipped); otherwise it's PUBLIC.
    return hasAudienceRule
      ? ruleMatchedBaseRows(promo.audience_rule_tree!, firstOrderOnly)
      : publicBaseRows(firstOrderOnly);
  }

  const customerIds = new Set(targets.filter((t) => t.target_type === "customer").map((t) => t.target_id));
  const segmentIds = new Set(targets.filter((t) => t.target_type === "segment").map((t) => t.target_id));

  // Customer-only targeting (the common "send to these N people" case): look the
  // targeted profiles up directly — no full opt-in scan, no per-row segment
  // resolution. Still consent-gated (opt-in + not soft-deleted).
  if (segmentIds.size === 0) {
    if (customerIds.size === 0) return { rows: [], truncated: false };
    const scanned = await db
      .select({ pid: customer_profiles.id, userId: users.id, email: users.email, fn: customer_profiles.first_name })
      .from(customer_profiles)
      .innerJoin(customer_user_links, eq(customer_user_links.customer_profile_id, customer_profiles.id))
      .innerJoin(users, eq(users.id, customer_user_links.user_id))
      .where(
        and(
          inArray(customer_profiles.id, [...customerIds]),
          eq(customer_profiles.marketing_opt_in, true),
          isNull(customer_profiles.deleted_at),
        ),
      )
      .orderBy(asc(customer_profiles.created_at), asc(customer_profiles.id))
      .limit(AUDIENCE_CAP + 1);
    const { rows, truncated } = capRows(scanned);
    return {
      rows: rows.map((r) => ({ pid: r.pid, userId: r.userId, email: r.email, firstName: r.fn ?? "" })),
      truncated,
    };
  }

  // Segment arm present: the sendable set is the opt-in customers, so scan that
  // (bounded, stably-ordered) set ONCE, then resolve every arm SET-WISE (no
  // per-profile round-trips). Past AUDIENCE_CAP opt-ins the scan is cut →
  // reported via `truncated`.
  const scanned = await db
    .select({
      pid: customer_profiles.id,
      userId: users.id,
      email: users.email,
      fn: customer_profiles.first_name,
    })
    .from(customer_profiles)
    .innerJoin(customer_user_links, eq(customer_user_links.customer_profile_id, customer_profiles.id))
    .innerJoin(users, eq(users.id, customer_user_links.user_id))
    .where(and(eq(customer_profiles.marketing_opt_in, true), isNull(customer_profiles.deleted_at)))
    .orderBy(asc(customer_profiles.created_at), asc(customer_profiles.id))
    .limit(AUDIENCE_CAP + 1);
  const { rows: profiles, truncated } = capRows(scanned);

  if (profiles.length === 0) return { rows: [], truncated: false };
  const pids = profiles.map((p) => p.pid);

  // ── Segment arms (manual + dynamic), resolved against the targeted, ENABLED
  //    segments only — a DISABLED / soft-deleted target segment can't match. Both
  //    kinds resolve to profile ids WITHIN the scanned opt-in set (`pids`): manual
  //    via member rows, dynamic via the SHARED SQL compiler (the same engine as
  //    checkout eligibility), so a compound rule_tree target is honoured — the gap
  //    the old rule-string-only path silently dropped.
  const segMatchPids = new Set<string>();
  if (segmentIds.size > 0) {
    const targetSegs = await db
      .select({
        id: customer_segments.id,
        kind: customer_segments.kind,
        rule: customer_segments.rule,
        rule_tree: customer_segments.rule_tree,
      })
      .from(customer_segments)
      .where(
        and(
          inArray(customer_segments.id, [...segmentIds]),
          eq(customer_segments.enabled, true),
          isNull(customer_segments.deleted_at),
        ),
      );
    const manualTargetIds = targetSegs.filter((s) => s.kind === "manual").map((s) => s.id);
    const dynamicTargets = targetSegs.filter((s) => s.kind === "dynamic");

    if (manualTargetIds.length > 0) {
      const rows = await db
        .select({ pid: customer_segment_members.customer_profile_id })
        .from(customer_segment_members)
        .where(
          and(
            inArray(customer_segment_members.segment_id, manualTargetIds),
            inArray(customer_segment_members.customer_profile_id, pids),
          ),
        );
      for (const r of rows) segMatchPids.add(r.pid);
    }

    if (dynamicTargets.length > 0) {
      // One shared ctx (store-TZ ref); resolve each dynamic target SET-WISE, scoped
      // to the scanned opt-in candidates so the work stays bounded.
      const ctx = await buildSegmentSqlCtx();
      for (const s of dynamicTargets) {
        const matched = await segmentMemberIdsSql(s.rule_tree ?? legacyRuleToTree(s.rule), ctx, {
          profileIds: pids,
        });
        for (const id of matched) segMatchPids.add(id);
      }
    }
  }

  const out: BaseRow[] = [];
  for (const p of profiles) {
    if (customerIds.has(p.pid) || segMatchPids.has(p.pid)) {
      out.push({ pid: p.pid, userId: p.userId, email: p.email, firstName: p.fn ?? "" });
    }
  }
  return { rows: out, truncated };
}


/**
 * PURE row-shapers for the long-tail wildcard audit subscriber — NO
 * "server-only", NO DB/service import, so the load-bearing TARGET_ID_KEYS
 * priority + the summary/target-type derivation are unit-testable. Imported by
 * audit-everything.ts (which keeps the DB write + bus registration).
 */

/**
 * Priority list for resolving a long-tail row's target id — the FIRST present
 * string key wins, so a payload's primary subject is chosen (e.g. userId over
 * orderId on a user event). Extend when a new domain adds an id-bearing event.
 */
export const TARGET_ID_KEYS = [
  "userId",
  "customerProfileId",
  "addressId",
  // transferId before orderId: a stock.transfer.* event's subject is the
  // TRANSFER, but the order-driven ones also carry orderId — without this the
  // audit row is filed under the order (or null for a manual transfer, which
  // carries no id at all). Only stock.transfer.* payloads have transferId, so
  // ordering it ahead of orderId never mis-files another domain's event.
  "transferId",
  "orderId",
  "currencyId",
  "redirectId",
  "segmentId",
  "levelId",
  "ruleId",
  "agentId",
  "locationId",
  "badgeId",
  "keyId",
  "reviewId",
  "returnId",
  "claimId",
  "productId",
  "categoryId",
  "brandId",
  "attributeId",
  "valueId",
  "bannerId",
  "pageId",
  "menuId",
  "itemId",
  "roleId",
  "promotionId",
  "mediaId",
  // Long-tail entity ids that never co-occur with a higher-priority key above
  // (blog posts/tags/authors, outbound endpoints, FAQs, import jobs,
  // delivery zones, search aliases).
  // commentId before postId: a blog.comment.* payload carries BOTH, and the
  // comment (not the post) is the moderated entity.
  "commentId",
  "postId",
  "tagId",
  "authorId",
  "endpointId",
  "faqId",
  "jobId",
  "zoneId",
  "aliasId",
] as const;

/** Generic "domain → action" summary for the long-tail rows. */
export function summarizeEvent(name: string): string {
  const [domain, action] = name.split(".");
  return `${domain} → ${action}`;
}

/** target_type = the event's domain (first dotted segment). */
export function targetTypeForEvent(name: string): string {
  return name.split(".")[0];
}

/** Best-effort target id from the payload via the priority key list. */
export function targetIdForPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  for (const k of TARGET_ID_KEYS) {
    const v = p[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

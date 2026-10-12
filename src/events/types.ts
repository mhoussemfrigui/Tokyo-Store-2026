/**
 * Typed event registry.
 *
 * Every event the system can emit declares its payload shape here. Adding
 * a new event = a new key in `EventMap`. Subscribers and emitters both
 * pick from this single source of truth — no string-typo bugs.
 *
 * NEVER include secrets (passwords, tokens, raw card data) in payloads —
 * subscribers may serialise these into audit logs / external systems.
 */

/**
 * One transfer line as carried on stock.transfer.* events. `sku`/`externalRef`
 * are the STABLE keys an external ERP resolves on (the UUIDs are meaningless to
 * it); null when the product/variant has none set. `sku` is the variant's when a
 * variant line, else the product's.
 */
export type TransferEventItem = {
  productId: string;
  variantId: string | null;
  sku: string | null;
  externalRef: string | null;
  qty: number;
};

export type EventMap = {
  // ── auth
  "user.created": {
    userId: string;
    email: string;
    name: string;
    ip?: string | null;
  };
  "user.email_verified": { userId: string; email: string };
  /**
   * An admin flipped the `email_verified` flag WITHOUT the user proving mailbox
   * ownership (the out-of-band override path). Higher-signal than the normal
   * verify event because it's an account-takeover-enabling action when combined
   * with a password reset — audited prominently (warn) and always.
   */
  "user.email_verified_admin_override": {
    userId: string;
    email: string;
    verified: boolean;
    actorUserId: string;
  };
  "user.password_reset_requested": { userId: string; email: string; ip?: string | null };
  "user.password_reset_completed": { userId: string; email: string; ip?: string | null };
  "user.signed_in": { userId: string; email: string; ip?: string | null };
  "user.signed_out": { userId: string };
  "user.disabled": { userId: string; actorUserId?: string | null };
  "user.enabled": { userId: string; actorUserId?: string | null };
  /** Admin cleared a user's 2FA enrolment (lockout recovery — secret/codes
   *  deleted, the user must re-enrol). Audited. */
  "user.two_factor_disabled_by_admin": { userId: string; actorUserId: string };
  "user.sessions_revoked": {
    userId: string;
    revokedCount: number;
    actorUserId?: string | null;
  };
  /** Admin invited a user — account created, invite link emailed. */
  "user.invited": { userId: string; email: string; internal: boolean };
  /** Admin created a user directly with a chosen password (no invite email). */
  "user.created_by_admin": { userId: string; email: string; internal: boolean; actorUserId?: string | null };
  /** Admin set a user's password directly (value NEVER in the payload). */
  "user.password_set": { userId: string; actorUserId?: string | null };
  /** A user's RBAC role assignments changed (full new set of role ids). */
  "user.roles_changed": { userId: string; roleIds: string[]; actorUserId?: string | null };
  /** A user's per-user permission overlay changed (allow/deny deltas over roles). */
  "user.permissions_changed": { userId: string; allowCount: number; denyCount: number; actorUserId?: string | null };
  /** A user enrolled their OWN TOTP 2FA (self-service, from /account). */
  "user.two_factor_enabled": { userId: string };
  /** A user disabled their OWN TOTP 2FA (self-service, from /account). */
  "user.two_factor_disabled": { userId: string };
  /** A credential sign-in attempt FAILED. The email is masked (never the raw
   *  value) and the password is NEVER included. `reason` distinguishes the cause
   *  without being an enumeration oracle to the user (the user-facing message
   *  stays neutral). Drives the Sécurité "recent failed logins" signal. */
  "user.sign_in_failed": {
    emailMasked: string;
    reason: "invalid_credentials" | "email_not_verified" | "account_disabled";
    ip?: string | null;
  };
  /** A 2FA second-factor verification FAILED (wrong/expired TOTP or backup code). */
  "user.two_factor_failed": { mode: "totp" | "backup"; ip?: string | null };
  /** A user changed their OWN password (self-service, from /account — the
   *  current password was re-verified). The value is NEVER in the payload. */
  "user.password_changed": { userId: string };
  /** A user's sign-in email changed — either the self-service verified change-email
   *  flow (auth/server.ts) or an admin direct set (workflows/auth/set-email.ts,
   *  which marks the new address unverified). Both addresses are MASKED — the raw
   *  values never enter the payload. */
  "user.email_changed": { userId: string; oldEmailMasked: string; newEmailMasked: string };
  /** OAuth (social sign-in) client credentials saved for a provider. Carries the
   *  NAMES of the changed fields only — never a client id / secret value. */
  "auth.oauth_settings_updated": { provider: string; changedFields: string[] };
  /** An auth rate-limit bucket was exhausted (a request was throttled). `kind`
   *  names which limiter tripped so the Sécurité view can show what is under
   *  pressure. No PII beyond the masked subject. */
  "auth.rate_limited": {
    kind: "signin_ip" | "signin_account" | "signup_ip" | "signup_email" | "two_factor" | "password_reset";
    subjectMasked?: string | null;
    ip?: string | null;
  };

  // ── rbac (roles + permission grants)
  "rbac.role_created": { roleId: string; key: string; name: string; actorUserId?: string | null };
  "rbac.role_updated": { roleId: string; key: string; actorUserId?: string | null };
  "rbac.role_deleted": { roleId: string; key: string; actorUserId?: string | null };
  /** An authenticated actor was DENIED a gated admin module/action (the deny
   *  branch of requirePermission/requirePermissionAny, or the `*` step-up of
   *  checkSuperAdmin with module "*"). Only emitted for a signed-in user
   *  who already holds at least one admin-area permission (the high-signal "real
   *  staff probing a module they lack" case) — anonymous 404s are not logged.
   *  Drives the Sécurité "permission denials" signal. */
  "rbac.permission_denied": {
    actorUserId: string;
    module: string;
    action: string;
  };
  /** A role's permission grant set was replaced. */
  "rbac.role_permissions_set": {
    roleId: string;
    key: string;
    permissions: string[];
    actorUserId?: string | null;
  };

  // ── customer
  "customer.profile_updated": {
    /** The linked auth user, or null for an unlinked/guest profile (the admin
     *  edit path can target a guest profile that has no account). */
    userId: string | null;
    customerProfileId: string;
    changedFields: string[];
  };
  /** Admin archived (soft-deleted) a customer profile; the linked auth
   *  account — if any and role "customer" — is disabled at the same time. */
  "customer.deleted": { customerProfileId: string; userId: string | null };
  "address.created": { customerProfileId: string; addressId: string };
  "address.updated": { customerProfileId: string; addressId: string; changedFields: string[] };
  "address.deleted": { customerProfileId: string; addressId: string };

  // ── media
  "media.uploaded": { mediaId: string; storageKey: string; sizeBytes: number };
  "media.deleted": { mediaId: string; storageKey: string; storageKeys: string[] };
  "media.updated": { mediaId: string; changedFields: string[] };
  "media.settings_updated": { changedFields: string[] };
  /** Operator bulk-deleted N media rows in a single action. */
  "media.bulk_deleted": { mediaIds: string[]; deletedCount: number; storageKeys: string[] };

  // ── catalog
  "brand.created": { brandId: string; slug: string };
  "brand.updated": { brandId: string; changedFields: string[] };
  "brand.deleted": { brandId: string };

  "category.created": { categoryId: string; slug: string; parentId: string | null };
  "category.updated": { categoryId: string; changedFields: string[] };
  "category.deleted": { categoryId: string };

  "care.plan.created": { planId: string; slug: string };
  "care.plan.updated": { planId: string; changedFields: string[] };
  "care.plan.deleted": { planId: string };
  /** A plan's category scope (planId set) OR a product's override (productId set)
   *  changed. The storefront offer is a bundled snapshot regenerated by
   *  tokyo-export-catalog, so this is an audit/ERP signal — not a live cache bust. */
  "care.assignment.changed": { planId: string | null; productId: string | null };
  /** A Tokyo Care plan was sold on an order (snapshot carries the charged price). */
  "care.purchased": { orderId: string; planId: string; productId: string; priceCents: number };

  // The `sku` / `gtin` / `externalRef` merchant identifiers are included (OPTIONAL,
  // additive) so an ERP consuming these outbound webhooks can correlate the event to
  // its OWN product record WITHOUT a GET /api/products callback. Any may be null when
  // the product doesn't carry that identifier; absent entirely on a legacy/foreign
  // emitter that predates the enrichment (existing consumers keep working).
  "product.created": {
    productId: string;
    slug: string;
    sku?: string | null;
    gtin?: string | null;
    externalRef?: string | null;
  };
  "product.updated": {
    productId: string;
    slug: string;
    changedFields: string[];
    sku?: string | null;
    gtin?: string | null;
    externalRef?: string | null;
    /** On a STOCK-driven update, the new authoritative sellable TOTAL (cached
     *  Σ active-location levels), so an ERP mirrors the value from the webhook
     *  without a GET /api/stock callback. null = untracked (unlimited). Absent on
     *  non-stock product edits. */
    stockQty?: number | null;
    /** On a PER-LOCATION stock write (api/stock `?location=`), the location's ERP
     *  code so the ERP knows WHICH store/depot level moved. Absent on total writes. */
    locationCode?: string | null;
  };
  /** Product price changed (carries old + new millimes) — drives wishlist price-drop email. */
  "product.price_changed": {
    productId: string;
    variantId: string | null;
    oldCents: number;
    newCents: number;
  };
  /** Product stock went from 0 (or less) to positive — drives the back-in-stock email. */
  "product.restocked": { productId: string };
  /** A sale just took a TRACKED product/variant's stock to or below the configured
   *  low-stock threshold (crossing edge) — drives the operator low-stock alert. */
  "product.stock_low": {
    productId: string;
    variantId: string | null;
    sku: string | null;
    name: string;
    variantLabel: string | null;
    currentQty: number;
    threshold: number;
  };
  /** A sale just took a TRACKED product/variant's stock to 0 — drives the
   *  operator out-of-stock alert (distinct from the broader low-stock warning). */
  "product.stock_depleted": {
    productId: string;
    variantId: string | null;
    sku: string | null;
    name: string;
    variantLabel: string | null;
  };
  "product.published": { productId: string };
  "product.unpublished": { productId: string };
  /** The merchant identifiers (see product.created) ride along so an ERP can
   *  tombstone its OWN linked record from the webhook alone. */
  "product.deleted": {
    productId: string;
    sku?: string | null;
    gtin?: string | null;
    externalRef?: string | null;
  };

  // ── Stock transfers (inter-location moves) — ERP push + notifications
  /** A store→depot (or any inter-location) transfer was requested. */
  "stock.transfer.requested": {
    transferId: string;
    ref: number;
    fromLocationId: string;
    toLocationId: string;
    /** ERP location codes (stock_locations.code) — how an ERP keys the endpoints. */
    fromCode: string | null;
    toCode: string | null;
    orderId: string | null;
    source: string;
    itemCount: number;
    totalQty: number;
    /** Line keys an external ERP can resolve (sku / external_ref), not just UUIDs. */
    items: TransferEventItem[];
  };
  /** A transfer was received — stock has moved (source −, destination +). */
  "stock.transfer.completed": {
    transferId: string;
    ref: number;
    fromLocationId: string;
    toLocationId: string;
    fromCode: string | null;
    toCode: string | null;
    orderId: string | null;
    productIds: string[];
    items: TransferEventItem[];
  };
  /** The source store accepted the transfer request (goods being prepared; no
   *  stock has moved yet). Lets an ERP reflect the acknowledgement. */
  "stock.transfer.accepted": {
    transferId: string;
    ref: number;
    fromLocationId: string;
    toLocationId: string;
    fromCode: string | null;
    toCode: string | null;
    orderId: string | null;
  };
  /** The transfer was DISPATCHED from the source (in_transit) — goods have left
   *  the source but not yet arrived. Carries the moving lines so an ERP can record
   *  the IN-TRANSIT leg (reserved/outgoing at source, incoming at destination)
   *  before the completion that actually relocates the stock_levels. */
  "stock.transfer.dispatched": {
    transferId: string;
    ref: number;
    fromLocationId: string;
    toLocationId: string;
    fromCode: string | null;
    toCode: string | null;
    orderId: string | null;
    items: TransferEventItem[];
  };
  /** A transfer was cancelled before completion (no stock moved). */
  "stock.transfer.cancelled": { transferId: string; ref: number; orderId: string | null };

  // ── product attributes / filters (storefront cache surface)
  "attribute.created": { attributeId: string; slug: string };
  "attribute.updated": { attributeId: string; changedFields?: string[] };
  "attribute.deleted": { attributeId: string };
  "attribute_value.created": { attributeId: string; valueId: string; slug: string };
  "attribute_value.updated": { attributeId: string; valueId: string };
  "attribute_value.deleted": { attributeId: string; valueId: string };
  "category.filter_attributes.updated": {
    categoryId: string;
    attributeIds: string[];
  };

  // ── orders
  "order.created": { orderId: string; orderNumber: string; totalCents: number };
  "order.paid": {
    orderId: string;
    orderNumber: string;
    totalCents: number;
    /** How the payment settled: an online gateway confirmation, cash collected
     *  at delivery (COD — paid_at stamped by the delivered transition), or an
     *  operator marking the order paid by hand. Absent on legacy emitters. */
    settledAt?: "gateway" | "delivery" | "manual";
  };
  /** Explicit confirmation: an operator accepted a COD order (or an online
   *  order settled). Drives the "Commande confirmée" email. */
  "order.confirmed": { orderId: string; orderNumber: string };
  "order.status_changed": {
    orderId: string;
    orderNumber: string;
    fromStatus: string;
    toStatus: string;
  };
  "order.refunded": {
    orderId: string;
    refundId: string;
    amountCents: number;
    totalRefundedCents: number;
  };
  /** Backfilled payment reference (wire transfer, manual receipt, etc.). */
  "order.payment_reference_updated": {
    orderId: string;
    orderNumber: string;
    paymentMethod?: string | null;
  };
  /** Admin linked a guest order (user_id was NULL) to an existing account. */
  "order.linked_to_user": {
    orderId: string;
    orderNumber: string;
    userId: string;
    actorUserId?: string | null;
  };
  /** Operator edited an order's lines (add/remove/qty) — totals recomputed. */
  "order.edited": {
    orderId: string;
    orderNumber: string;
    changedFields?: string[];
    actorUserId?: string | null;
  };
  /** A partial-shipment bon de livraison was created for the order. */
  "order.shipment_created": {
    orderId: string;
    orderNumber: string;
    shipmentId: string;
    deliveryNoteNumber: string;
    trackingRef?: string | null;
  };

  // ── returns / SAV (Commandes › Retours)
  "order.return.created": {
    orderId: string;
    orderNumber: string;
    returnId: string;
    actorUserId?: string | null;
  };
  /** Return received back into stock (restocks inventory). */
  "order.return.received": {
    orderId: string;
    orderNumber: string;
    returnId: string;
    restockedItems: number;
    actorUserId?: string | null;
  };
  "order.return.rejected": {
    orderId: string;
    orderNumber: string;
    returnId: string;
    actorUserId?: string | null;
  };

  // ── warranty / SAV claims (Commandes › Garanties). Delivered to every registered
  //    webhook subscribed to them (by name or `*`) whenever outbound webhooks are on
  //    — for two-way SAV sync. NOTE: the ERP `pushWarranty` toggle is a Phase-2 posture
  //    and does NOT yet gate delivery (subscribe/unsubscribe the endpoint to control it).
  "warranty.claim.created": {
    orderId: string;
    orderNumber: string;
    claimId: string;
    productId?: string | null;
    actorUserId?: string | null;
  };
  "warranty.claim.updated": {
    orderId: string;
    orderNumber: string;
    claimId: string;
    changedFields?: string[];
    actorUserId?: string | null;
  };
  "warranty.claim.resolved": {
    orderId: string;
    orderNumber: string;
    claimId: string;
    resolution: "repaired" | "replaced" | "refunded" | "rejected";
    actorUserId?: string | null;
  };

  // ── fiscal documents (gapless numbering stamped on the order)
  "order.invoice_issued": {
    orderId: string;
    orderNumber: string;
    invoiceNumber: string;
    actorUserId?: string | null;
  };
  "order.credit_note_issued": {
    orderId: string;
    orderNumber: string;
    creditNoteNumber: string;
    actorUserId?: string | null;
  };
  "order.delivery_note_issued": {
    orderId: string;
    orderNumber: string;
    deliveryNoteNumber: string;
    actorUserId?: string | null;
  };

  // ── blog
  "blog.category.created": { categoryId: string; slug: string };
  "blog.category.updated": { categoryId: string; changedFields: string[] };
  "blog.category.deleted": { categoryId: string };
  "blog.tag.created": { tagId: string; slug: string };
  "blog.tag.updated": { tagId: string; slug: string };
  "blog.tag.deleted": { tagId: string };
  "blog.post.created": { postId: string; slug: string };
  "blog.post.updated": { postId: string; slug: string };
  "blog.post.published": { postId: string; slug: string };
  "blog.post.unpublished": { postId: string; slug: string };
  "blog.post.deleted": { postId: string };

  // ── authors (editorial profiles)
  "author.created": { authorId: string; slug: string };
  "author.updated": { authorId: string; changedFields: string[] };
  "author.deleted": { authorId: string };

  // ── blog comments / ratings
  "blog.comment.submitted": { commentId: string; postId: string; status: string };
  "blog.comment.moderated": { commentId: string; postId: string; status: string };
  "blog.comment.deleted": { commentId: string; postId: string };


  // ── newsletter
  "newsletter.subscribed": {
    email: string;
    /** Where the opt-in came from: a storefront form key ("footer", "popup", …),
     *  "admin" (staff re-activation) or "account" (the customer's own
     *  marketing-consent toggle, mirrored onto the newsletter row). */
    source: string;
    /** true when an existing (unsubscribed) row was re-activated. Absent ⇒
     *  treated as a first subscription. */
    reactivated?: boolean;
  };

  // ── CMS (storefront-cache-invalidation surface)
  "banner.created": { bannerId: string; placement: string };
  "banner.updated": { bannerId: string; placement: string; changedFields?: string[] };
  "banner.deleted": { bannerId: string; placement: string };

  "faq.updated": { faqId: string; scope: string };

  /** `from` / `to` (the previous / new value) are attached ONLY for the
   *  security-relevant keys of lib/cms/sensitive-settings (never a secret) so the
   *  audit row shows what changed; absent for every other key. */
  "setting.upserted": {
    key: string;
    groupKey: string;
    from?: string | null;
    to?: string | null;
  };

  "page.created": { pageId: string; slug: string };
  /** A page's own fields (title / slug / SEO meta / visibility) were edited —
   *  section edits emit `page.section.changed` instead. */
  "page.updated": { pageId: string; slug: string; changedFields: string[] };
  "page.published": { pageId: string; slug: string };
  "page.unpublished": { pageId: string; slug: string };
  "page.deleted": { pageId: string };
  "page.section.changed": { pageId: string; sectionId: string };

  "nav.menu.created": { menuId: string; key: string };
  "nav.menu.updated": { menuId: string; key: string };
  "nav.item.created": { itemId: string; menuId: string };
  "nav.item.updated": { itemId: string; menuId: string };
  "nav.item.deleted": { itemId: string };

  // ── audit (operator-triggered purge)
  "audit.purged": { olderThanDays: number; deletedCount: number };

  // ── search telemetry (operator-triggered retention sweep)
  "search_log.purged": { olderThanDays: number; deletedCount: number };

  // ── bulk data export (RGPD / exfiltration trail)
  /** An operator downloaded a bulk CSV export. Row count only — never the data
   *  itself; the actor rides in the emit meta. */
  "data.exported": {
    resource: "customers" | "guests" | "orders" | "audit" | "newsletter" | "favorites";
    count: number;
  };

  // ── favorites moderation (public shareable lists)
  /** An operator locked (« Rendre privé ») or unlocked a customer's public favorites
   *  list. Accountability trail for a customer-affecting moderation decision. */
  "favorites.moderated": {
    wishlistId: string;
    action: "locked" | "unlocked";
  };

  // ── promotions (admin CRUD + storefront redemption)
  "promotion.created": {
    promotionId: string;
    scope: "product" | "category" | "brand" | "cart" | "targeted";
    scopeId: string | null;
  };
  "promotion.updated": {
    promotionId: string;
    scope: "product" | "category" | "brand" | "cart" | "targeted";
    scopeId: string | null;
  };
  "promotion.deleted": {
    promotionId: string;
    scope: "product" | "category" | "brand" | "cart" | "targeted";
    scopeId: string | null;
  };
  "promotion.activated": {
    promotionId: string;
    scope: "product" | "category" | "brand" | "cart" | "targeted";
    scopeId: string | null;
  };
  "promotion.deactivated": {
    promotionId: string;
    scope: "product" | "category" | "brand" | "cart" | "targeted";
    scopeId: string | null;
  };
  "promotion.redeemed": {
    promotionId: string;
    orderId: string;
    discountCents: number;
  };
  /** Admin asked to announce a promotion by email (create checkbox / button). */
  "promotion.announce_requested": {
    promotionId: string;
  };
  // ── payment gateway
  /** A gateway checkout session was created and the customer redirected to pay. */
  "order.payment_initiated": {
    orderId: string;
    provider: "flouci" | "clictopay";
    reference: string;
  };
  /** Webhook/return matched but no order has the given payment reference yet. */
  "webhook.payment.unmatched": {
    provider: "flouci" | "clictopay";
    paymentReference: string;
    event: string;
  };
  /** Gateway amount/currency does not match the order — refused to credit. */
  "webhook.payment.amount_mismatch": {
    provider: "flouci" | "clictopay";
    orderId: string;
    expectedCents: number;
    receivedCents: number;
    currency: string | null;
  };

  // ── tax (Commandes › Taxes — filter rules + per-entity overrides)
  "tax.rule.upserted": { ruleId: string; scope?: string | null; actorUserId?: string | null };
  "tax.rule.deleted": { ruleId: string; actorUserId?: string | null };
  /** Per-brand or per-category tax-rate overrides saved in bulk (direct table UPDATE). */
  "tax.entity_rate_updated": {
    entityType: "brand" | "category";
    count: number;
    actorUserId?: string | null;
  };

  // ── delivery (Commandes › Livraison — agents + pickup locations, carry fees)
  "delivery.agent.created": { agentId: string; name: string; actorUserId?: string | null };
  "delivery.agent.updated": { agentId: string; changedFields?: string[]; actorUserId?: string | null };
  "delivery.agent.deleted": { agentId: string; actorUserId?: string | null };
  "delivery.location.created": { locationId: string; name: string; actorUserId?: string | null };
  "delivery.location.updated": {
    locationId: string;
    changedFields?: string[];
    actorUserId?: string | null;
  };
  "delivery.location.deleted": { locationId: string; actorUserId?: string | null };
  /** Region-pricing zones (governorate groups + per-courier rates). Money-
   *  affecting config — the actor rides in the emit meta. */
  "delivery.zone.created": { zoneId: string; name: string };
  "delivery.zone.updated": { zoneId: string; name: string; changedFields?: string[] };
  "delivery.zone.deleted": { zoneId: string; name: string };

  // ── stock locations (Stock › Emplacements — opt-in multi-location inventory)
  "stock_location.created": { locationId: string; name: string; isActive?: boolean };
  "stock_location.updated": {
    locationId: string;
    name: string;
    isActive?: boolean;
    changedFields?: string[];
  };
  "stock_location.deleted": { locationId: string; name: string; isActive?: boolean };

  // ── currency registry (Commandes › Devises)
  "currency.created": { currencyId: string; code: string; actorUserId?: string | null };
  "currency.updated": {
    currencyId: string;
    code: string;
    changedFields?: string[];
    actorUserId?: string | null;
  };
  "currency.deleted": { currencyId: string; code: string; actorUserId?: string | null };
  /** A new active currency was selected (relabels every price storefront-wide). */
  "currency.activated": { currencyId: string; code: string; actorUserId?: string | null };

  // ── payment provider credentials (Commandes › Paiement)
  "payment.provider_settings_updated": {
    provider: string;
    changedFields?: string[];
    actorUserId?: string | null;
  };

  // ── AI provider credentials (Système › IA)
  "ai.provider_settings_updated": {
    provider: string;
    changedFields?: string[];
    actorUserId?: string | null;
  };
  /** Admin prompt overrides for an AI generation feature/task were saved. */
  "ai.feature_prompts_updated": { feature: string; task?: string | null; changedFields: string[] };

  // ── search aliases / synonyms (Système › Recherche › Alias)
  "search_alias.created": { aliasId: string; term: string; expansion?: string };
  "search_alias.updated": {
    aliasId: string;
    term?: string;
    isActive?: boolean;
    changedFields?: string[];
  };
  "search_alias.deleted": { aliasId: string; term?: string };
  /** The catalogue-derived default rules were seeded (`count` rows inserted). */
  "search_alias.seeded": { count: number };

  // ── product reviews (Catalogue › Avis — moderation)
  // The `sku` / `gtin` / `externalRef` product identifiers are included so an ERP
  // consuming these webhooks can correlate the event to its own product without a
  // second call (any may be null when the product doesn't carry that identifier).
  "catalog.review.created": {
    reviewId: string;
    productId: string;
    rating: number;
    /** "pending" (awaiting moderation) or "approved" (auto-published). */
    status: string;
    sku?: string | null;
    gtin?: string | null;
    externalRef?: string | null;
  };
  "catalog.review.status_changed": {
    reviewId: string;
    productId: string;
    status: string;
    sku?: string | null;
    gtin?: string | null;
    externalRef?: string | null;
    actorUserId?: string | null;
  };
  "catalog.review.deleted": {
    reviewId: string;
    productId: string;
    sku?: string | null;
    gtin?: string | null;
    externalRef?: string | null;
    actorUserId?: string | null;
  };
  "catalog.review.created_manual": {
    reviewId: string;
    productId: string;
    rating: number;
    status: string;
    sku?: string | null;
    gtin?: string | null;
    externalRef?: string | null;
    actorUserId?: string | null;
  };
  "catalog.review.bulk_deleted": {
    source: string;
    deletedCount: number;
    actorUserId?: string | null;
  };

  // ── product import (Catalogue › Import)
  "import.products_started": {
    jobId?: string | null;
    source?: string | null;
    actorUserId?: string | null;
  };
  "import.products_completed": {
    jobId?: string | null;
    created: number;
    updated: number;
    failed: number;
  };
  /** A product import run failed before completing (parse error / abort). */
  "import.products_failed": {
    jobId?: string | null;
    message?: string | null;
  };

  // ── redirects (Système › Redirections & 404)
  "redirect.created": {
    redirectId: string;
    source: string;
    /** Target the source now redirects to (audit: where the traffic goes). */
    destination?: string;
    actorUserId?: string | null;
  };
  "redirect.updated": {
    redirectId: string;
    source: string;
    changedFields?: string[];
    /** Current target + the one it replaced (when the destination changed). */
    destination?: string;
    previousDestination?: string | null;
    actorUserId?: string | null;
  };
  "redirect.deleted": { redirectId: string; actorUserId?: string | null };
  "redirect.bulk_imported": {
    created: number;
    updated: number;
    skipped: number;
    actorUserId?: string | null;
  };

  // ── scheduled tasks (Système › Tâches planifiées)
  "job.enabled_changed": { jobKey: string; enabled: boolean; actorUserId?: string | null };
  "job.run_triggered": { jobKey: string; actorUserId?: string | null };

  // ── API & webhooks (Système › API)
  /** The API / webhook master switches or the public-route set changed. Only
   *  the settings that ACTUALLY changed are present (before → after), so the
   *  audit row shows e.g. that the API kill-switch was turned off or which read
   *  routes were opened to the public. */
  "api.access_settings_updated": {
    changedFields?: string[];
    apiEnabled?: { from: boolean; to: boolean };
    webhooksEnabled?: { from: boolean; to: boolean };
    outboundEnabled?: { from: boolean; to: boolean };
    publicRoutesAdded?: string[];
    publicRoutesRemoved?: string[];
    actorUserId?: string | null;
  };
  "api_key.created": {
    keyId: string;
    label?: string | null;
    scopes?: string[];
    actorUserId?: string | null;
  };
  "api_key.revoked": { keyId: string; actorUserId?: string | null };
  /** Outbound-webhook endpoint (ERP push subscription) lifecycle — audit trail. */
  "webhook_endpoint.created": {
    endpointId: string;
    name: string;
    eventTypes: string[];
    /** Destination host (hostname[:port]) — where the data goes. Never the full
     *  URL: a path/query/userinfo may embed a receiver-side token. */
    host?: string | null;
    actorUserId?: string | null;
  };
  "webhook_endpoint.updated": { endpointId: string; active?: boolean; actorUserId?: string | null };
  "webhook_endpoint.revoked": { endpointId: string; actorUserId?: string | null };
  /** An external API request FAILED authentication/authorization at requireApiKey
   *  (no/invalid/expired key, missing scope, or rate-limited). No key value is
   *  ever included. Drives the Sécurité "API-key auth failures" signal. */
  "api_key.auth_failed": {
    reason: "missing" | "invalid" | "expired" | "scope" | "rate_limited";
    scope?: string | null;
    ip?: string | null;
  };

  // ── storefront showcase pins (Contenu › Catalogues)
  "showcase.pins_set": { collection: string; count: number; actorUserId?: string | null };

  // ── CMS trust badges (Contenu)
  "cms.trust_badge.created": { badgeId: string; actorUserId?: string | null };
  "cms.trust_badge.updated": { badgeId: string; actorUserId?: string | null };
  // label/kind snapshotted at delete so the audit log shows WHAT was removed
  // (the row is hard-deleted, so they can't be looked up afterward).
  "cms.trust_badge.deleted": {
    badgeId: string;
    label?: string;
    kind?: string | null;
    actorUserId?: string | null;
  };

  // ── customer segments (Clients › Segments — promo/mailing targeting)
  "segment.created": { segmentId: string; name: string; actorUserId?: string | null };
  "segment.updated": { segmentId: string; changedFields?: string[]; actorUserId?: string | null };
  "segment.deleted": { segmentId: string; actorUserId?: string | null };
  "segment.members_changed": {
    segmentId: string;
    change: "added" | "removed";
    count?: number;
    actorUserId?: string | null;
  };

  // ── mailing (Clients › Mailing — campaigns, automations, templates, settings)
  "mailing.campaign_sent": {
    campaignId?: string | null;
    audienceCount: number;
    subject?: string | null;
    actorUserId?: string | null;
  };
  "mailing.flow_toggled": { flowKey: string; enabled: boolean; actorUserId?: string | null };
  "mailing.template_updated": { templateKey: string; actorUserId?: string | null };
  "mailing.template_toggled": {
    templateKey: string;
    enabled: boolean;
    actorUserId?: string | null;
  };
  /** Master marketing kill-switch / promo-code globals (bypasses upsertSetting). */
  "mailing.global_settings_updated": { changedFields?: string[]; actorUserId?: string | null };

  // ── newsletter consent withdrawal (the RGPD-relevant half)
  "newsletter.unsubscribed": { email: string; source?: string | null };

  // ── demo content (operator-triggered seed)
  "demo.imported": {
    brandsCreated: number;
    productsCreated: number;
    bannersCreated: number;
    faqsCreated: number;
    mediaCreated: number;
  };
  "demo.cleared": {
    brandsDeleted: number;
    productsDeleted: number;
    bannersDeleted: number;
    faqsDeleted: number;
    mediaDeleted: number;
  };
  /** Super-admin PURGE-and-relaunch: all content + all orders + all customer
   *  profiles wiped, then the demo re-seeded. Confirmed by an emailed code. */
  "demo.purged": {
    ordersDeleted: number;
    actorUserId: string;
  };

  // ── runtime performance monitoring (Infrastructure › Performance)
  /** A live resource metric breached its admin-configured warn threshold for
   *  the required number of consecutive samples (RAM/CPU/event-loop/DB). The
   *  wildcard audit subscriber persists it; perf-alert.ts may also email. */
  "perf.alert.raised": {
    metric: string;
    value: number | null;
    threshold: number | null;
    instanceId: string;
  };
  /** A previously-alerting metric returned below its threshold (recovery). */
  "perf.alert.recovered": {
    metric: string;
    instanceId: string;
  };
};

export type EventName = keyof EventMap;
export type EventPayload<T extends EventName> = EventMap[T];

export type EventEnvelope<T extends EventName = EventName> = {
  name: T;
  payload: EventPayload<T>;
  occurredAt: Date;
  actorUserId?: string | null;
  actorIp?: string | null;
};

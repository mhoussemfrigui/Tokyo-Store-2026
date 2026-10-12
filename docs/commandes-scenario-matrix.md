# Commandes — exhaustive scenario matrix (2026-09-30 re-audit)

A per-tab scenario catalogue for the whole admin **Commandes** section (12 tabs). Each
scenario names the expected behaviour and where it is covered — an automated suite
(`src/lib/db/tests/*.test.ts`), a browser check, code review, or a **GAP**. Money is
integer millimes (`*_cents`); store TZ Africa/Tunis (+01:00). This complements
`commandes-overhaul-test-coverage.md` (the per-feature build coverage) with an
operator/user scenario view + edge cases + cross-tab links + RBAC + DB/perf.

Legend: ✅ automated test · 🌐 browser-verified · 🔎 code-verified · ⚠️ known gap/deferred.

---

## 1. Commandes — LIST (`/admin/orders`)

| Scenario | Expected | Coverage |
|---|---|---|
| Default list, no filter | newest-first, 50/keyset page, spam excluded, KPIs (Total/À traiter/Payées/CA net) exclude spam | ✅ orders-admin · 🔎 |
| Status chip + count | filters in SQL; count = whole-store under the guest/search base | ✅ orders-admin |
| « À traiter » queue | actionable = paid/preparing + pending-non-online; mutually exclusive with status/spam | ✅ orders-admin, order-status (isActionable ⟺ actionableOrderSql) |
| Channel chips (Origine/Canal) | shown only on a channel MIX; partitions the total; storefront/operator/express/erp | ✅ order-sales-channel · 🔎 |
| « Retours » quick-filter | orders with ≥1 return; combines with any scope | ✅ orders-admin |
| « Spam » scope | flagged-only; hidden unless spam exists | ✅ order-spam-triage |
| « Invités » toggle | user_id IS NULL | ✅ orders-admin |
| Search number/email/phone | one server OR-group + live client narrow; malformed cursor → page 1 (no 22007) | ✅ orders-admin (keyset), 🔎 |
| Keyset next/prev preserves filters | µs-faithful cursor `<ts>|<id>` | ✅ orders-admin |
| Row badges: channel, guest, fulfilment (partial), refund (partial/full), invoice/return/claim icons | derived from batched aggregates | ✅ order-badges · 🔎 |
| **Pickup order at `delivered` reads « Retirée » on the list** (not « Livrée ») | delivery-method-aware `adminStatusLabel` | 🌐 **[fixed V13]** |
| Bulk status transition (preparing/shipped/delivered) | `orders:manage`; concurrency 8; index-aligned partial-failure report; `cancelled` rejected | 🔎 (⚠️ no dedicated bulk-action test) |
| Bulk spam flag/unflag | `orders:manage`; flag in normal view, restore in spam view | ✅ order-spam-triage (workflow) · 🔎 (UI) |
| Bulk CSV export (selection) | `orders:view`; ?ids= | 🔎 (⚠️ export route untested) |
| RBAC: view-only sees no bulk write controls; no « Nouvelle commande » without ORDER_NEW_VIEW_GRANTS | server + UI gated | ✅ admin-nav-access |
| Cross-page selection | selection persists across keyset pages but bulk/export act only on the loaded page | 🔎 (⚠️ hidden cross-page selection — cosmetic) |
| Perf: stats()/listFilterCounts whole-table scans | fine at scale for a watch store; documented ceiling (151ms/20k in EXPLAIN) | 🔎 EXPLAIN |

**Links out**: row → `/admin/orders/[id]`; « Nouvelle commande » → `/admin/orders/new`; ERP → `/admin/system/api?tab=erp`; bulk CSV → `/admin/orders/export`.
**Links in**: dashboard « Ouvrir la file » → `?actionable=1`; customer 360 / guests → `?q=<email>`.

---

## 2. Commandes — DETAIL (`/admin/orders/[id]`)

| Scenario | Expected | Coverage |
|---|---|---|
| Status transitions honour payment + delivery method | COD skips upfront paid; pickup skips shipped (preparing→delivered) | ✅ order-status (124), order-lifecycle-guards |
| Pickup collected reads « Retirée » | `orderStatusLabelFor(status, delivery_method)` | 🔎 (detail already correct) |
| → refunded requires a FULL refund | partial refund → rejected server-side (not just the client gate) | ✅ **refund-restock-remainder S5/S6 [fixed V1]** |
| Cancel a PAID order | restocks + reverses fidélité/promo/crédit but NO refund; **warning** « Annuler sans rembourser » | 🌐 **[fixed V2]** · ✅ order-lifecycle-guards |
| Cancel blocked once shipped | a shipped order → manage via return | ✅ order-status |
| Refund → cash | ledger row; ceiling = total − credit_applied | ✅ refund-restock-remainder, return-refund-advisory |
| Refund → store credit | wallet += amount, credit ledger `refund`; no_account / credit_disabled guards | ✅ credit-checkout-settlement · ⚠️ (destination='credit' path thin — see gaps) |
| Documents bar (facture / avoir / bon de livraison) | issue → number stamped; print routes | 🔎 (numFromMsg optimistic parse — server fallback) |
| Money breakdown (subtotal/discount/credit/shipping/TVA/total) | credit SETTLES (not discount); « Reste à encaisser » = net-to-pay | ✅ credit-checkout-settlement · 🔎 |
| Applied-promotions breakdown | reversal-netted; free-ship-only survives | 🔎 (⚠️ page-level netting untested) |
| Issued gift cards on the order | listed | 🔎 |
| Customer history insight card | order count / spend (net of gift-card face) | 🔎 (⚠️ orderCount includes cancelled — overstates « fidèle ») |
| Sales channel « Origine / Canal » line | operator/express/erp/storefront | 🌐 (« Origine : Saisie opérateur ») · ✅ order-sales-channel |
| Spam flag / unflag from detail | triage | ✅ order-spam-triage |
| Switch stuck online payment → COD | re-opens fulfilment | ✅ switch-to-cod |
| RBAC: SAV card on detail | ⚠️ gated on `orders:manage`, not `warranty:*` — a warranty-only role can't see it | 🔎 (deferred) |

---

## 3. Order MUTATION workflows (money/stock/credit/fidélité core)

| Scenario | Expected | Coverage |
|---|---|---|
| place-order: stock claim + snapshots + coins/credit + gift-card issue atomic | one insertOrder; rollback on failure | ✅ order-placement-guards, checkout-correctness (40) |
| place-quick-order (express) | channel=express | ✅ order-sales-channel |
| manual-order (operator) | channel=operator; **duplicate lines merged**; **confirmed_at stamped** | ✅ manual-order · 🌐 (dup-line state) · **[fixed V3, V6]** |
| create-from-lines (ERP) | channel=erp; external_ref | ✅ (workflow) · ⚠️ settlement-fail leaves it pending (documented, external_ref-owned) |
| Refund idempotency | row lock serializes; full-refund double-submit safe | ✅ (full) · ⚠️ **partial double-submit double-records — no idempotency key (deferred, ceiling-bounded)** |
| Refunded ⟺ fully refunded | status flip requires full refund; revenue via netRevenueCentsSql | ✅ refund-restock-remainder [V1] |
| Abandoned-orders sweep | cancels pending unconfirmed online checkouts after 48h; **NEVER** operator-confirmed / ERP / point-less counter sales | ✅ (workflow) · **[V6 closed the manual-order hole]** |
| Loyalty/promo/credit reversal on full undo | cancel or full refund reverses; partial does not | ✅ reconcile-loyalty-promos |
| Gift-card void on undo | only on full undo; blocked if already redeemed | ✅ gift-card-lifecycle |

---

## 4. Nouvelle commande (`/admin/orders/new`)

| Scenario | Expected | Coverage |
|---|---|---|
| Search/scan a product, add line | resolveProductByCode / searchProducts | 🌐 |
| **Add the SAME product twice (scan 2 identical)** | lines merged (qty summed) → ONE order, no unique-violation | ✅ (action merge) · 🌐 (2-line state) · **[fixed V3]** |
| Variable product: pick variant | variant required before add | 🔎 (⚠️ empty-variants product disables Add silently) |
| Apply a promo via the picker | live code-coupons dropdown | 🌐 (« Aucun code promo actif ») · ✅ (Phase D P2) |
| Exhausted / capped coupon picked | ⚠️ hard-abort with a misleading message (deferred) | 🔎 |
| Coupon soft-drops (min_cart, scope) | ⚠️ order at full price, no indication (deferred) | 🔎 |
| Choose channel (cash/virement/COD) + delivery | cash/virement → paid now; COD stays pending | ✅ manual-order |
| →paid step fails (cash) | ok+warning; **confirmed_at stamped → NOT swept** | ✅ **[fixed V6]** |
| attachByEmail | matches an account → attributes loyalty | 🔎 (⚠️ typo/collision credits wrong account — default ON) |
| Point-less pickup | 0-fee counter sale | 🔎 |

---

## 5. Paniers (`/admin/cart`)

| Scenario | Expected | Coverage |
|---|---|---|
| List active/abandoned carts | non-qb, non-empty; keyset | ✅ cart-lifecycle (service) |
| **Cart row → customer 360** | links to `/admin/customers/[profileId]` when the cart has an account | 🌐 **[added]** |
| **Customer 360 « Panier actuel » → cart detail** | links to `/admin/cart/[id]` | 🌐 **[added]** |
| Anonymous cart | « Anonyme », no link | 🔎 |
| Cart detail: soft-deleted product | « produit supprimé » | 🔎 |
| carts_user_unique idempotency | one cart per user; concurrent create catches 23505 | ✅ cart-lifecycle · **[V9 declared in schema.ts]** |
| Relance tooling | ⚠️ none exists — static viewer only (documented) | — |

---

## 6. Retours (`/admin/orders/returns`)

| Scenario | Expected | Coverage |
|---|---|---|
| Create a return (per line) | reasonCode + comment; capped by SHIPPED qty | ✅ return-refund-advisory, refund-restock-remainder |
| Over-return | rejected; already-returned (non-rejected) qty subtracted; duplicate lines collapsed | ✅ (S3) · ⚠️ (over-return-ceiling under-covered) |
| Receive a return | restocks exactly the received units; idempotent (already_received) | ✅ refund-restock-remainder |
| Reject a return | under-lock re-check (no flip received→rejected) | 🔎 (⚠️ race untested) |
| Never-shipped order return | REFUSED (nothing shipped) | ✅ refund-restock-remainder S6 |
| Return + refund→credit linkage | refund destination credit | ⚠️ (destination='credit' return path untested) |
| Dashboard KPIs (acceptance / reasons / top products) | 5 aggregates | ✅ returns-stats · 🔎 (⚠️ « Taux de réintégration » mislabels acceptance; 5 queries sequential) |
| Restock under multi-store | restocks aggregate pool only (all restock paths) | 🔎 (documented) |

---

## 7. Garanties (SAV / RMA) (`/admin/orders/warranty`)

| Scenario | Expected | Coverage |
|---|---|---|
| Open a claim on a delivered line | snapshot coverage (was_covered/covered_until) | ✅ warranty-claims (T1) |
| Duplicate open claim (qty 1) | refused (conflict) | ✅ warranty-claims (T2) |
| **qty>1 line: one open claim PER unit** | 1st + 2nd ok, 3rd refused | ✅ **warranty-claims T10 [fixed V11]** |
| Claim lifecycle open→in_repair→awaiting_parts→resolved/rejected | transitions; terminal locked | ✅ warranty-claims (T3–T5, T8) |
| Re-claim after resolved | allowed (later fault) | ✅ warranty-claims (T6) |
| **Open work counted/listed UNWINDOWED** | an 800-day-old open claim still in KPI/badge + list | ✅ **warranty-claims T11 [fixed V12]** |
| ERP GET/POST/PATCH /api/warranty-claims | reachable; fail-codes mapped; scope matrix | ✅ erp-api, external-api-contract, route-invariants · ⚠️ (no HTTP-level warranty route test) |
| ERP push/pull warranty toggles | ⚠️ Phase-2 posture (inert); copy now honest | 🔎 **[V10 copy fixed]** |
| Coverage clock during preparation/transit | paid/preparing/shipped counted as covered | 🔎 (documented edge) |
| RBAC lookup=view / console=manage | gated | ✅ admin-nav-access |
| reason/comment/resolution_note write-only in UI | ⚠️ captured but not displayed (deferred) | 🔎 |

---

## 8. Promotions & codes (`/admin/promotions`)

| Scenario | Expected | Coverage |
|---|---|---|
| Auto / code / URL trigger | resolved on the right layer | ✅ promo-security, promotion-targeting |
| Scope cart/product/category/brand/targeted | uniform effectiveScopeTargets + legacy synth | ✅ promotion-scope-targets (A–I) |
| **Per-variant targeting (auto)** | variant A discounted, B not; card=PDP=charge | ✅ promotion-scope-targets J, promo-card-charge-parity |
| **Variant pin on a code/URL coupon** | REJECTED at authoring (auto-only) | ✅ **promotion-scope-targets K [fixed §7#1]** |
| **Product panel « Promotions sur ce produit »** | includes targeted promos covering the product | ✅ **promotion-scope-targets L [fixed §7#2]** |
| Card ↔ PDP ↔ cart ↔ place-order parity | equal to the millime | ✅ promo-card-charge-parity, checkout-correctness |
| Member-discount stacking | hasProductPromo variant-aware; per-promo override | ✅ member-discount, checkout-correctness · **[G6 fixed the variant hasProductPromo]** |
| first_order_only | new customers only | ✅ coupon-eligibility |
| Inline audience_rule_tree | checkout ⟺ announce parity | ✅ coupon-eligibility, mailing-promotion-audience, segment-rule-tree-sql |
| Scheduled announce + « Annoncer maintenant » | claim-before-fire; gate-before-claim; re-arm | ✅ mailing-flows (announce sweep) |
| Wishlist auto-campaign | segment × wishlist-scoped promo × email | ✅ wishlist-campaign, mailing-flows |
| Coupon caps (max_uses / per_user) + rate-limit | race-safe; account_required | ✅ coupon-race, coupon-eligibility |
| Redemption ledger + refund reversal | negative balancing row; free-ship consumed | ✅ reconcile-loyalty-promos |
| Delete guard (category/brand) | live promo (legacy OR scope_target) blocks delete | ✅ promotion-scope-targets E, catalog-deletion-fanout |
| Duplicate | inactive clone, placeholder code/slug, targets copied | ✅ promo-security · ⚠️ (copies past ends_at → silent-inactive clone) |
| Non-stackable pick = highest priority (not best price) | consistent across surfaces | 🔎 (by-design) |
| RBAC view/create/update/delete | server-gated | ✅ promotions-admin |

---

## 9. Commerce settings (Paiement / Express / Livraison / Taxes / Devises / Réglages)

| Scenario | Expected | Coverage |
|---|---|---|
| Payment methods (COD/gateway) toggle + read on checkout | COD default ON | ✅ (settings) · 🔎 (⚠️ gateway-only save materializes cod_enabled) |
| Achat express config | read on quick-buy | ✅ checkout-parse |
| Delivery fee / free threshold | read on place-order | 🔎 (⚠️ same keys editable on 2 pages with different unset display) |
| min_order_cents | compared vs subtotal (pre-discount) | 🔎 (⚠️ semantics vs post-discount — confirm) |
| Taxes per brand/category | applied on order | ✅ (tax) · 🔎 (⚠️ unpaginated editor) |
| Currency | display precision from price.decimals | 🔎 (⚠️ currencies.decimals column inert) |
| Réglages commande (checkout copy, handling/transit days) | read on PDP JSON-LD | 🔎 (⚠️ min>max not cross-validated → invalid schema.org) |

---

## Cross-cutting

### Linking (into/out of Commandes)
- All Commandes→other-route targets resolve (orders/export, catalog/gift-cards, catalog/stock, customers/[id], system/api, system/payments). 🌐
- Dashboard → orders (`?actionable=1`, recent-order rows). 🔎
- Customer 360 ↔ orders (`?q=email`), ↔ **carts (both directions now linked)**. 🌐
- Product admin → its promotions (**now incl. targeted**). ✅
- Category/brand delete guards ↔ promotions. ✅
- Redemption row → order; order → order (self). 🔎

### RBAC
- `orders:view` (list/detail/export), `orders:manage` (mutations/bulk), `orders_new:*` (Nouvelle commande), `warranty:view/manage`, `promotions:view/create/update/delete`, `returns:manage`. Nav ⟺ page parity via one grant list. ✅ admin-nav-access.

### DB & performance (Docker EXPLAIN @ 20k orders)
- FKs all `ON DELETE CASCADE` (user→SET NULL); zero orphans; enums + CHECKs comprehensive; 174 migrations applied. 🔎/Docker.
- List pagination: index-backward + incremental-sort + keyset seek → sub-ms. ✅ EXPLAIN.
- `stats()` header KPIs: whole-table scan + correlated subqueries, ~151ms/20k, linear — documented ceiling. ⚠️
- Indexes back every filter (channel/status/spam/trgm-search); `promotion_scope_targets_uniq` variant-aware. 🔎.
- `carts_user_unique` / `carts_merged_from_idx` now declared in schema.ts (was baseline-raw-only). **[V9]**

### Money / data invariants (must stay green)
- credit SETTLES (never discounts total/revenue/TVA); paid ≤ total.
- card ↔ PDP ↔ cart ↔ charge parity to the millime; fail-closed variant promos.
- refunded ⟺ fully refunded (revenue via netRevenueCentsSql).
- spam excluded from list/queue/KPIs consistently.
- one active claim per sold UNIT; one cart per user.

---

## Deferred / documented (not defects, or owner-decision)
- Refund partial double-submit idempotency key (ceiling-bounded, ERP-retry vector).
- SAV card RBAC on order detail (`orders:manage` vs `warranty:*`).
- Coupon soft-drop / hard-abort operator feedback in Nouvelle commande.
- Warranty ERP push/pull toggles → live gating (Phase 2).
- Returns « Taux de réintégration » label; dashboard 5 sequential aggregates.
- currencies.decimals inert column; checkout copy keys with no admin writer.
- Duplicate promo copies past ends_at; min>max day windows → schema.org.
- Paniers relance tooling (none); customer-history orderCount includes cancelled.

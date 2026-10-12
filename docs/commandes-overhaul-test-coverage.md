# Commandes overhaul — comprehensive scenario coverage

A scenario-by-scenario map of every functionality built in the Commandes overhaul
(Phase D — orders; Phase B′ — Garanties ERP-heavy; Phase E — promotions), each
paired with the automated test(s) that exercise it. « ✓ live » marks paths also
verified end-to-end in the browser against the dev DB.

Run the whole suite: `pnpm test` (DB batches need `DATABASE_URL` pointed at the
dev DB `:5446` first — see `docs/…` / the dev-DB note).

---

## Phase D — Commandes / Nouvelle commande

### D0. Delivery-method-aware order status  — `order-status.test.ts` (124), `refund-restock-remainder.test.ts`
| Scenario | Expected | Covered |
|---|---|---|
| Home-delivery order: preparing → | offers `shipped` | order-status pickup+home cases |
| Pickup (in_store / drive_by_pickup): preparing → | offers `delivered` (« Retirée »), NEVER `shipped` | order-status remap + dedupe cases |
| Pickup `delivered` badge / action label | « Retirée » / « Marquer retirée » | orderStatusLabelFor / orderStatusActionLabelFor cases |
| Home `delivered` badge | « Livrée » | order-status |
| `orderTransitionsFor` unknown status / null method | `[]` / COD graph, never throws | order-status |
| Pickup order refunded after collection | `goodsLeftWarehouse` true (status + history) → no wrong auto-restock | refund-restock S4/S5 + fulfilment-state |
| Server guard (transition-status) threads delivery_method | pickup can't be marked shipped | order-status + transition workflow (tsc) ✓ live (pickup order shows « Passer en préparation ») |

### D1. Bulk-action RBAC + double-submit guard — (UI, tsc + server-enforced)
| Scenario | Expected | Covered |
|---|---|---|
| View-only agent (no orders:manage) | bulk status toolbar hidden; export + selection stay | page RBAC (permissionSetAllows) |
| Bulk status on a pickup order | rejected per-order server-side (delivery-aware graph) | transition workflow |
| Double-click a status transition | second click ignored (useRefreshAction re-entrancy) | hook + no « delivered → delivered » |

### D2. Refund → store credit — `credit-checkout-settlement.test.ts` (38)
| Scenario | Expected | Covered |
|---|---|---|
| Refund destination = credit, linked account, wallet on | wallet credited + `refund` ledger row + `order_refunds` row | « refund→credit accepted / wallet +15 000 / ledger row / order_refunds recorded » ✓ live (toggle on detail) |
| Full refund-to-credit of a credit-settled order | cash-as-credit (refund) AND applied credit (spend_reverse) both returned | credit-settlement full-undo + refund cases |
| Refund → credit on a GUEST order (no account) | `no_account`, tx ROLLED BACK (no orphan order_refunds row) | « guest refund→credit refused / wrote no order_refunds row » |
| Refund → cash on the same guest order | accepted (destination cash) | « refund→cash on a guest order still works » |
| Wallet disabled (mode off) + destination credit | `credit_disabled` (before tx) | eligibility gate (workflow) |
| ERP POST /api/orders/[id]/refunds hitting these | credit_disabled→409, no_account→422 (never 500 retry-storm) | erp-api static fail-code guard |

### D3. Switch stuck payment → COD — `switch-to-cod.test.ts` (11)
| Scenario | Expected | Covered |
|---|---|---|
| Pending online order, no gateway session | switch OK: method→cod, reference cleared, stays pending | T1 |
| Re-switch a now-COD order | refused (conflict, not online) | T2 |
| Genuine COD order | refused (nothing to switch) | T3 |
| Non-pending (paid) online order | refused (status guard, no gateway call) | T4 |
| Pending online w/ unverifiable gateway | refused `payment_unverified` (fail-closed, method unchanged) | T5 |
| Captured / live session (fail-closed) | refused (already_paid 409 / payment_in_progress 503) | assertPendingOnlineOrderNotCaptured (shared w/ cancel) |

### D4. Order spam-triage — `order-spam-triage.test.ts` (18), `dashboard-kpis.test.ts` (50)
| Scenario | Expected | Covered |
|---|---|---|
| Flag / unflag | flagged_spam_at + actor set / cleared; emits order.edited{flagged_spam} | T1 ✓ live (badge + banner) |
| Default list vs Spam filter | flagged HIDDEN from default, SHOWN under spam | T2 ✓ live (Tous 97→96, Spam(1) chip) |
| Flagged actionable order | dropped from « À traiter » count + queue + byStatus | T3 ✓ live (À traiter 39→38) |
| SQL/JS actionable parity on a flagged row | both say NOT actionable | dashboard-kpis + T3 |
| stats() KPIs (total/paid/revenue) | exclude spam (KPI == « Tous » chip; paid ≤ total) | dashboard-kpis ✓ live |

### D6. Sales-channel capture + promo picker (Phase D P2) — `order-sales-channel.test.ts` (13)
| Scenario | Expected | Covered |
|---|---|---|
| Storefront self-checkout (context `{actorUserId}`) | channel `storefront` | per-path capture ✓ live (« Boutique en ligne (39) ») |
| Express / quick-buy | channel `express` (explicit context) | per-path capture |
| Operator manual order (`operatorUserId`) | channel `operator` (derivation) | per-path capture |
| ERP push (`deliveryChannel:'operator'`) | channel `erp` | per-path capture ✓ live (« ERP (5) » + backfill) |
| Explicit context.channel vs derivation | explicit wins | per-path capture |
| Direct insert (tests / seed omit channel) | DB default `storefront` | default |
| `list({channel})` filter | only that channel | list filter ✓ live (ERP-only list + row badge) |
| `listFilterCounts().byChannel` | per-channel counts partition the total | counts |
| Channel is CONTEXT not schema | a storefront request can't forge `erp` | (security — context-only threading) |
| Detail « Origine » line + CSV + ERP serializer | channel + external_ref surfaced | ✓ live (detail Origine line) + tsc |
| Manual-order « Code promo » picker | live code-coupons listed with discount/min-cart label; backend unchanged | ✓ live (BIENVENUE15 option) |

### D5. Order-detail / list P1-P2 (read-only surfaces)
| Surface | Covered |
|---|---|
| Issued gift cards on the detail | listForOrder (gift-card-issue.test) + tsc, .catch-safe |
| Product summary on list rows | productSummaryByOrder (orders-admin) ✓ live |
| « Historique client » card | getUserOrderSummary ✓ live |
| « Promotions appliquées » breakdown | listRedemptionsForOrder netting (reconcile-loyalty-promos) |

---

## Phase B′ — Garanties (SAV / RMA), ERP-heavy — `warranty-claims.test.ts` (26), `warranty.test.ts` (42)

| Scenario | Expected | Covered |
|---|---|---|
| Create claim | snapshots coverage (was_covered/covered_until/months) from the order line; status open; emits created | T1 ✓ live (« battery » claim) |
| Duplicate OPEN claim on the same unit | refused (conflict) | T2 |
| Update: open → in_repair + comment | ok; emits updated{changedFields} | T3 |
| Resolve (repaired) | status resolved, resolution + processed_at set; emits resolved | T4 ✓ live |
| Re-resolve / update a terminal claim | refused (conflict, idempotency) | T5 |
| Re-claim after resolution | allowed (a later fault) | T6 ✓ live (line re-offers « Ouvrir ») |
| Out-of-warranty line (0 months) | was_covered = false | T7 ✓ live (HORS GARANTIE badge) |
| Reject resolution | closes as `rejected` | T8 |
| Service reads (listForOrder / orderIdsWithClaims / hasOpenClaim) | correct | T9 |
| Warranty coverage engine (cascade, expiry, store-TZ, not_covered) | unchanged, still correct | warranty.test (42) |
| ERP: GET/POST /api/warranty-claims, GET/PATCH /[id] | reachable, fail-codes mapped, scope matrix | erp-api (107), external-api-contract (64), route-invariants (97) |
| Per-line warranty on GET /api/orders/[id] | warrantyMonths/Label + order-aware verdict | external-api-contract, tsc |
| ERP config axes (push/pull warranty, mode-independent) | own-key, case-sensitive | erp-config.test (17) |
| Events warranty.claim.* registered | catalogued + severity + audit | event-catalog (8), audit-severity (57), audit-target (43) |
| Admin console: open/advance/resolve; list flag; detail card | works | ✓ live (full lifecycle in browser) |
| RBAC: view-only vs manage | lookup=view, console=manage | admin-nav-access (23), route-invariants |

---

## Phase E — Promotions upgrade

### E1. First-order « welcome » coupon — `coupon-eligibility.test.ts` (39), `promotions-admin.test.ts` (26)
| Scenario | Expected | Covered |
|---|---|---|
| Guest + first_order_only | account_required (soft drop) | FO guest |
| Signed-in first-timer | eligible | FO first-timer |
| Returning customer (prior non-cancelled order) | not_first_order (soft drop) | FO returning |
| Only a cancelled prior order | still eligible | FO cancelled-only |
| first_order_only on an AUTO promo | rejected at save | promotions-admin schema |

### E2. Inline audience-rule targeting — `coupon-eligibility.test.ts` (39), `promotions-admin.test.ts` (26), `segment-rule-tree-sql.test.ts` (84)
| Scenario | Expected | Covered |
|---|---|---|
| Buyer matches the audience rule | eligible | AUD matching |
| Buyer doesn't match / guest | not_targeted (soft drop) | AUD non-match / guest |
| Audience-ruled promo is treated as targeted (public opt-out skipped) | matching buyer not suppressed | AUD targeted |
| Both explicit targets AND an audience rule | buyer must satisfy BOTH (each narrows) | eligibility restructure (tsc + targeting 51) |
| Valid audience rule on a code coupon | accepted + persisted as jsonb | promotions-admin schema + persistence |
| Audience rule on an AUTO promo | rejected | promotions-admin |
| Empty audience group (would match everybody) | rejected fail-closed (isValidRuleTree) | promotions-admin empty-group |
| Dual resolver parity (ruleTreeMatches ↔ SQL) | in lockstep | segment-rule-tree-sql (84) |

### E3. Wishlist personalized auto-campaign — `wishlist-campaign.test.ts` (8), `mailing-flows.test.ts` (52), `wiring-matrix.test.ts` (30)
| Scenario | Expected | Covered |
|---|---|---|
| Flow off / no segment / no code / code not live | skipped (clean, no burn) | skip guards ×4 |
| Segment member WITH a wishlist | 1 personalized email (products+code), mailing_sends claim | happy |
| Segment member with NO wishlist | skipped, no claim | happy |
| Re-run within the same month | 0 more (monthly dedup) | dedup |
| Cron route catalogued + one-job/route + guardCron-first | yes | wiring-matrix |
| Flow has a template + flow def | yes | mailing-flows |

### E5. MULTI-target scope (`promotion_scope_targets`, GZ parity G1) — `promotion-scope-targets.test.ts` (36)
| Scenario | Expected | Covered |
|---|---|---|
| Targeted auto promo (product + category + brand) — batch charge path | matches each target dimension; unrelated product matches nothing; matched = −20% | A ✓ live (« Ciblage multiple · 3 cibles ») |
| Same promo — per-product PDP path (`getActiveDiscountForProduct`) | identical matches + price (uniform contract) | B |
| Same promo — card/feed map (`enrichProductSearchHits`) | card price == charge; category cascade now reaches subtree (was direct-only) | C |
| Multi-target scoped COUPON (`productsMatchingPromoScope` + eligibility) | matches all targeted lines; unrelated → `no_matching_items`; discounts only matching base | D |
| Delete guard (`countLivePromotionsForScopeTarget`) | a targeted promo blocks its category/brand deletion | E |
| Legacy synth fallback (scope_id, no scope_targets rows) | still matches via the synthesised target | F |
| manage: create targeted (persists rows, scope_id NULL) / 0 targets rejected / scopeId rejected / single-scope writes 1 uniform row / de-duped count / duplicate copies rows | all | G ✓ live (create + edit round-trip pre-checks boxes, « PRODUITS (2) ») |
| `include_descendants=false` | direct-only category target does NOT cascade to a leaf-only product | H |
| Non-discountable guard on a targeted promo | flagged product excluded (auto + coupon) | I |

### E6. Scheduled announce (GZ parity G4) — `mailing-flows.test.ts` (65, +13 sweep), `wiring-matrix.test.ts` (30)
| Scenario | Expected | Covered |
|---|---|---|
| Schedule an announce (`announce_at`) on create/edit | persists; store-TZ parsed (09:30 Tunis → 08:30 UTC) | ✓ live (form field + edit pre-fill) |
| Immediate announce vs scheduled | mutually exclusive (refine + form disables the other) | ✓ live (checkbox auto-disabled) |
| Sweep: due (`announce_at ≤ now`) + live | fired once; `announced_at` stamped; email queued | sweep due/stamp/queued |
| Sweep: future / already-announced | not fired (excluded from `listDueForAnnounce`) | sweep future + re-run skipped |
| Sweep: inactive/ended promo at due time | `claimAnnounce` refuses (live re-check) | sweep inactive |
| `claimAnnounce` race (two ticks / manual + cron) | exactly one wins | sweep race-safe |
| Marketing kill-switch OFF | sweep skips, `announced_at` NOT burned | sweep marketing-off no-burn |
| Manual « Annoncer maintenant » (live promo, `promotions:update`) | fires the blast; dedup skips already-notified | ✓ live (button on detail) + reuses tested blast path |
| Cron wiring (interval ~5min, guardCron-first, one job, catalogued) | all | wiring-matrix + route-invariants |
| **Marketing/flow OFF + immediate create-announce** (review fix) | `announced_at` NOT stamped (no false « Annoncée le »), warns | create-gate no-stamp+warning |
| **Marketing/flow OFF + « Annoncer maintenant »** (review fix) | refused with a clear message; no stamp → pending schedule survives | gated action (same gate as sweep/create) |
| **Re-schedule an already-announced promo** (review fix) | new/changed `announce_at` clears `announced_at` (re-arm → due again); routine edit keeps it; clearing keeps the marker | re-arm cleared+due-again + routine-edit-keeps |
| **first_order / rule filter at scale >AUDIENCE_CAP** (review fix) | pushed INTO base SQL before the cap (NOT EXISTS orders / segmentMemberIdsSql), so the real cohort isn't hidden | small-set parity (audience 25) + SQL-push code |

### E7. Per-VARIANT promo targeting (`promotion_scope_targets.variant_id`, migration 0173, GZ parity G6) — `promotion-scope-targets.test.ts` (54, +18), `promo-card-charge-parity.test.ts` (11, +4)
Design: a `target_type='product'` scope-target may pin ONE `variant_id`. FAIL-CLOSED — a variant-constrained promo lives in a SEPARATE `rowsByVariant` bucket on `LivePromoEntry`, NEVER the default `rows`; a pure `rowsForLineVariant(entry, variantId)` gate merges them; `resolveProductDiscount` is byte-unchanged; any caller that omits the line's variant UNDER-applies (never over-discounts).
| Scenario | Expected | Covered |
|---|---|---|
| Persist a variant-pinned target (`setScopeTargets` + `listScopeTargets`) | round-trips `variant_id`; NULLS-NOT-DISTINCT uniqueness | J (scope-targets) ✓ live (create → 1 row, variant_id set, no whole-product row) |
| Resolver split | variant-constrained promo → empty default `rows`, sits in `rowsByVariant[A]`; none for B | J |
| `rowsForLineVariant(A/B/null)` gate | A → the promo; B → none; null → only (empty) unconstrained | J |
| Priced per variant | A −30% = 70000; B stays 100000 | J |
| Per-product PDP path (`getActiveDiscountForProduct`) | no variantId → null (fail-closed); variantId=A → 70000; B → null | J |
| Card/feed map (`buildLivePromotionDiscountMap`) | EXCLUDES variant-constrained target (product-keyed → safe UNDER-display; card stays base) | J |
| Scoped coupon without variant facts | does NOT match by product id (safe under-apply) | J |
| Whole-product OVERRIDE (variant + unconstrained target, same promo/product) | unconstrained wins → both variants discounted; promo leaves `rowsByVariant` | J |
| manage workflow create with `variantId` | persists `variant_id` (Zod + `scopeTargetRowsFor` dedupe key incl. variant) | J ✓ live (create via form) |
| **PDP variable-product gate** (review fix HIGH→med) | variable branch gated on the resolver entry (`rows` OR `rowsByVariant`), NOT `getActiveDiscountForProduct` (null for variant-only) → a variant-pinned promo is VISIBLE on the PDP | `withLivePromoPricing` variant case ✓ live (PDP: Or 210 / Argent 300, parent « à partir de » 210) |
| **Member-discount `hasProductPromo`** (review fix HIGH) | checkout + panier detect variant promos via live `unitPrice < base` (mirrors place-order), so a stacking-off member's previewed total == charge (no under-preview → overcharge) | mirrors place-order (checkout-correctness 40) + code |
| **Edit form pre-check** (review fix, med) | a variant-only target does NOT pre-check the whole-product box (`&& !t.variantId`); re-save keeps only the variant row (no silent all-variants expansion) | ✓ live (edit: Or checked, product box unchecked; re-save = 1 variant row) |

### E4. Server-paginated / searchable admin — `promotions-admin.test.ts` (26), `route-invariants.test.ts` (24)
| Scenario | Expected | Covered |
|---|---|---|
| >page-size promotions | paginated (no silent >500 drop) | listPaged (service) ✓ live (search box + pager) |
| Search q (name/code/url) + trigger filter | server-side | listPaged |
| View-only user | create button + row write controls hidden | page RBAC |

---

## Cross-cutting invariants (regression guards that must stay green)
- `event-catalog.test` — every EventMap key catalogued + labeled (warranty.claim.* added; favorites label fixed).
- `internal-api-catalog.test` — every server action catalogued (spam / switch-to-COD / warranty actions added → 380).
- `route-invariants.test` — every API route ↔ catalog (warranty-claims + wishlist-campaign cron added → 97).
- `wiring-matrix.test` — every cron route catalogued + one job each.
- `erp-api.test` — every externally-reachable workflow fail-code maps to a non-500.
- `external-api-contract.test` — WRITABLE_RESOURCES ⇔ write routes (warranty added).
- `segment-rule-tree-sql.test` — the load-bearing dual-resolver parity (used by E2 + E3).
- `test-chain-integrity.test` — every test file is in a `pnpm test` chain.

## Full-suite result

`pnpm test` (272 files, dev DB): **268 files fully green, 4 with failures — all 4 PRE-EXISTING**, proven by re-running them at the pre-overhaul base commit `3690c96` where each fails with the identical count. None of their source files were touched by this overhaul, and the overhaul modified none of the four test files. **The overhaul introduced zero regressions.**

| Pre-existing red | Failing assertion | Subsystem (untouched here) | Base `3690c96` |
|---|---|---|---|
| `promo-security.test` | business-exclusive product hidden from public (fail closed) | business-flag / auto-promo product cache | 37 pass, 1 fail |
| `admin-caps.test` | « guests table states its cap » (missing `GUESTS_SHOWN` copy) | `admin/customers/guests/page.tsx` | 38 pass, 1 fail |
| `reserved-routes.test` | reserved list missing `parrainage` (+ /parrainage/x classification) | storefront reserved-slug registry (Cercle referral) | 18 pass, 2 fail |
| `identity-low.test` | moderation: force-private removes it from the searched count | wishlist **moderation** (distinct from the campaign's read-only wishlist use) | 31 pass, 1 fail |

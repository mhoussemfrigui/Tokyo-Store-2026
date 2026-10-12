-- 0147 — CARTES CADEAUX (Phase C.1, digital-first): the gift-card product flag +
-- the bearer-card ledger. Schema + crypto foundation only; behaviour (buy / redeem /
-- gift) lands in later phases. Ported from Game Zone's 0210/0211/0213/0232 as the
-- DIGITAL subset — the physical pre-printed pool (batches, `printed` status, pool
-- index) and the scheduled-send half (scheduled_send_at / code_enc) are DROPPED, and
-- GZ's 0310 exclusivity CHECK is NOT ported (it references products.is_digital /
-- requires_serial, columns Tokyo never had).
--
-- THE CARD IS MONEY. A gift-card code is bearer value — whoever holds the string can
-- spend it — so the plaintext is NEVER stored: what lands here is a keyed HMAC-SHA256
-- (`code_hash`, the only thing that redeems, unique) plus `code_last4` (support
-- confirmation, deliberately NOT unique) and a staff-facing `reference`. The plaintext
-- is returned once, at issuance. Redeeming a card grants store CREDIT into the buyer's
-- wallet (`giftcard_redeem`) — the card SETTLES nothing itself; it funds the « avance ».

ALTER TABLE "products" ADD COLUMN "is_gift_card" boolean NOT NULL DEFAULT false;--> statement-breakpoint
-- Only a handful of catalog rows are gift cards, but the admin tab, the issuance
-- branch and the availability resolver all filter on it — partial index.
CREATE INDEX "products_gift_card_idx" ON "products" ("id") WHERE "is_gift_card" = true;--> statement-breakpoint

CREATE TABLE "gift_cards" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  -- Printed / staff-facing identity, safe to show; CANNOT redeem.
  "reference" text NOT NULL,
  -- Keyed HMAC-SHA256 of the code (see lib/gift-card/code.ts). The ONLY thing that redeems.
  "code_hash" text NOT NULL,
  -- Last 4 chars for support confirmation. NOT a secret, NOT unique (collides by design).
  "code_last4" text NOT NULL,
  -- Face value in millimes, FROZEN at issuance — a later price change never moves a sold card.
  "denomination_cents" integer NOT NULL,
  -- v1 is always 'digital'; kept for forward-compat with a physical pool.
  "origin" text NOT NULL DEFAULT 'digital',
  -- active → redeemed, or void at any point. No 'printed' (that is the dropped physical pool).
  "status" text NOT NULL DEFAULT 'active',
  -- Soft links (NO FK): the frozen value must outlive a later product/variant edit.
  "product_id" uuid,
  "variant_id" uuid,
  -- The sale that issued it (real FK, SET NULL on a hard order delete).
  "order_id" uuid,
  "order_item_id" uuid,
  -- 1-based position within its order line (a line of quantity N mints N cards).
  "line_seq" integer,
  "redeemed_by_profile_id" uuid,
  "redeemed_at" timestamp with time zone,
  -- = created_at for a digital mint; an audit reads « when did this become money ».
  "activated_at" timestamp with time zone,
  -- NULL = never expires (the owner's default). Stamped once at issuance, grandfathered.
  "expires_at" timestamp with time zone,
  "voided_at" timestamp with time zone,
  "voided_by" text,
  "void_reason" text,
  "replaced_by_gift_card_id" uuid,
  -- Gifting (Phase C.5): the buyer sends the card to someone else. sent_at = the gift
  -- email went out (drives « Envoyée »); v1 sends immediately at mint.
  "recipient_email" text,
  "recipient_name" text,
  "gift_message" text,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "gift_cards_status_chk" CHECK ("status" IN ('active','redeemed','void')),
  CONSTRAINT "gift_cards_origin_chk" CHECK ("origin" IN ('digital','physical')),
  CONSTRAINT "gift_cards_denomination_pos_chk" CHECK ("denomination_cents" > 0)
);--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_order_fk" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_redeemed_by_fk" FOREIGN KEY ("redeemed_by_profile_id") REFERENCES "customer_profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
-- Staff lookup by the printed identity.
CREATE UNIQUE INDEX "gift_cards_reference_uniq" ON "gift_cards" ("reference");--> statement-breakpoint
-- Redemption lookup — a collision here would let one code open two cards; NEVER relax.
CREATE UNIQUE INDEX "gift_cards_code_hash_uniq" ON "gift_cards" ("code_hash");--> statement-breakpoint
-- « the card ending 4821 » — narrows a support search without identifying one card.
CREATE INDEX "gift_cards_code_last4_idx" ON "gift_cards" ("code_last4");--> statement-breakpoint
CREATE INDEX "gift_cards_order_idx" ON "gift_cards" ("order_id") WHERE "order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "gift_cards_product_idx" ON "gift_cards" ("product_id") WHERE "product_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "gift_cards_redeemed_by_idx" ON "gift_cards" ("redeemed_by_profile_id") WHERE "redeemed_by_profile_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "gift_cards_replaced_by_idx" ON "gift_cards" ("replaced_by_gift_card_id") WHERE "replaced_by_gift_card_id" IS NOT NULL;--> statement-breakpoint
-- ONE CARD PER UNIT SOLD — the DB's own guarantee against a double-mint, under the
-- per-order advisory lock the issuance path (Phase C.3) takes. A duplicate here is
-- live bearer value the shop never sold.
CREATE UNIQUE INDEX "gift_cards_line_seq_uniq" ON "gift_cards" ("order_item_id","line_seq") WHERE "order_item_id" IS NOT NULL;--> statement-breakpoint
-- Admin register list — newest first, id tiebreaker (created_at is the tx timestamp,
-- shared exactly across a batch mint).
CREATE INDEX "gift_cards_created_idx" ON "gift_cards" ("created_at" DESC, "id" DESC);--> statement-breakpoint

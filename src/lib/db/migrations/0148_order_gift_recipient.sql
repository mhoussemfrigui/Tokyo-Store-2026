-- 0148 — CARTES CADEAUX (Phase C.5, gifting): the recipient of an order's gift cards.
--
-- ONE recipient per order (the Game Zone model): when a buyer offers the gift card(s)
-- they are buying, they enter the recipient's email + name + a short message at checkout.
-- Every gift-card line the order mints is then stamped with this recipient, and the
-- delivery email is addressed to them (« … vous offre une carte cadeau »). NULL email =
-- the buyer keeps the card(s) — the delivery goes to the buyer's contact email, as before.
-- Nothing here applies to a non-gift order; these columns simply stay NULL.
ALTER TABLE "orders" ADD COLUMN "gift_recipient_email" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "gift_recipient_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "gift_message" text;--> statement-breakpoint

-- 0060 — Contenu & Design epic foundations.
--
-- Schema surface for: admin-protected "system" CMS pages, a per-chip urgency
-- animation, an admin-managed buy-box trust/notice strip, and a site-wide
-- announcement bar. Purely additive; idempotent + safe to re-run. No data loss.

-- ── 1. pages.is_system — protect seeded help/legal pages from deletion ──────
ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "is_system" boolean NOT NULL DEFAULT false;

-- ── 2. promo_links.flash_mode — optional urgency animation per chip ─────────
ALTER TABLE "promo_links" ADD COLUMN IF NOT EXISTS "flash_mode" text NOT NULL DEFAULT 'none';
DO $$ BEGIN
  ALTER TABLE "promo_links" ADD CONSTRAINT "promo_links_flash_mode_chk"
    CHECK ("flash_mode" IN ('none','pulse','glow','shake'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. trust_badges — admin-managed buy-box reassurance strip ───────────────
-- The buy-box badges ("Paiement sécurisé", "Retours sous conditions", …) were
-- hardcoded. This makes them a CRUD list: icon + label + a visibility condition
-- (always | in_stock | preorder). `kind` lets the renderer special-case the
-- built-ins (dynamic delivery ETA, etc.) vs a free-form notice (kind NULL).
CREATE TABLE IF NOT EXISTS "trust_badges" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "kind" text,
  "label" text NOT NULL,
  "icon" text NOT NULL DEFAULT 'ShieldCheck',
  "visibility" text NOT NULL DEFAULT 'always',
  "is_active" boolean NOT NULL DEFAULT true,
  "display_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE "trust_badges" ADD CONSTRAINT "trust_badges_visibility_chk"
    CHECK ("visibility" IN ('always','in_stock','preorder'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "trust_badges_order_idx" ON "trust_badges" ("display_order");
CREATE INDEX IF NOT EXISTS "trust_badges_active_idx" ON "trust_badges" ("is_active");

-- Seed the four current buy-box badges ONCE (only when the table is empty), so
-- the storefront strip is unchanged the moment the renderer switches to it.
INSERT INTO "trust_badges" ("kind","label","icon","visibility","display_order")
SELECT seed.kind, seed.label, seed.icon, seed.visibility, seed.display_order
FROM (VALUES
  ('security','Paiement sécurisé','Lock','always',0),
  ('delivery','Livraison rapide','Truck','in_stock',1),
  ('returns','Retours sous conditions','RotateCcw','always',2),
  ('warranty','Garantie constructeur','ShieldCheck','always',3)
) AS seed(kind,label,icon,visibility,display_order)
WHERE NOT EXISTS (SELECT 1 FROM "trust_badges");

-- ── 4. announcements — site-wide schedulable notification bar ───────────────
-- One active bar at a time in practice; `display_order` breaks ties when more
-- than one is live. Off by default (is_active=false) so enabling is deliberate.
CREATE TABLE IF NOT EXISTS "announcements" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "message" text NOT NULL,
  "href" text,
  "link_label" text,
  "bg_color" text,
  "text_color" text,
  "is_dismissible" boolean NOT NULL DEFAULT true,
  "is_active" boolean NOT NULL DEFAULT false,
  "display_order" integer NOT NULL DEFAULT 0,
  "starts_at" timestamptz,
  "ends_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "announcements_order_idx" ON "announcements" ("display_order");
CREATE INDEX IF NOT EXISTS "announcements_active_idx" ON "announcements" ("is_active");
CREATE INDEX IF NOT EXISTS "announcements_schedule_idx" ON "announcements" ("starts_at","ends_at");

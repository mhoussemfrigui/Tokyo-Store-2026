-- Mega-menu featured-image banners: a dedicated, admin-editable image (+ eyebrow,
-- title, CTA href) per top-level nav dropdown, replacing the old hardcoded
-- "first category / first brand hero" logic in (shop)/layout.tsx. One placement
-- per root (Boutique / Marques / Fidélité / Maison) so each dropdown's featured
-- panel is set independently in CMS → Bannières and resolved through the
-- médiathèque.
--
-- PostgreSQL 12+ (we run 16.14) permits ALTER TYPE ... ADD VALUE inside a
-- transaction block; the new labels are only USED by later, separate
-- transactions (the storefront read + the demo seed), so this is safe here.
-- IF NOT EXISTS keeps it idempotent on re-apply.
ALTER TYPE "banner_placement" ADD VALUE IF NOT EXISTS 'nav_boutique';--> statement-breakpoint
ALTER TYPE "banner_placement" ADD VALUE IF NOT EXISTS 'nav_marques';--> statement-breakpoint
ALTER TYPE "banner_placement" ADD VALUE IF NOT EXISTS 'nav_fidelite';--> statement-breakpoint
ALTER TYPE "banner_placement" ADD VALUE IF NOT EXISTS 'nav_maison';

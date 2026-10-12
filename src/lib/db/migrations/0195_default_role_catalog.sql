-- 0195 — Default role CATALOG: organized starter profiles beyond super_admin.
--
-- Until now the store shipped with a SINGLE role (super_admin, migr 0033), so an
-- operator had to hand-build every scoped role. This seeds four editable business
-- roles — each a curated set of keys from the EXISTING registry
-- (src/lib/rbac/registry.ts). All are is_system=false (editable / deletable /
-- delegable) and NONE carries the global wildcard `*` (that would inflate the
-- last-admin floor and become non-delegable — `super_admin` stays the sole `*`).
--
--   administrateur — every module in `<module>:*` (near-complete). Still NOT `*`,
--                    so store-wide super-admin step-ups (demo purge, data scrub)
--                    stay reserved for super_admin.
--   manager        — operations: catalogue, commandes, rendez-vous, promos, and
--                    the client-engagement tools — HORS Système/Infra, users,
--                    connexion sociale, contenu/design & blog.
--   web_master     — contenu/design + catalogue + SEO: products, media, CMS, blog,
--                    SEO/redirects. No orders, clients, caisse or Système.
--   support        — service client: clients, commandes, retours, garanties,
--                    crédit, fidélité (lecture), rendez-vous, avis — sans export
--                    PII en masse, sans catalogue/contenu/Système.
--
-- Idempotent: WHERE NOT EXISTS on the role key + on each (role_id, permission).

INSERT INTO "roles" ("key","name","description","is_system")
  SELECT 'administrateur', 'Administrateur',
         'Accès quasi-complet au back-office (toutes les sections). N''inclut PAS le super-pouvoir « * » : les opérations destructrices (réinitialisation des données, import de démo) restent réservées au super-administrateur. Rôle de départ, modifiable.',
         false
  WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "key" = 'administrateur');
--> statement-breakpoint

INSERT INTO "roles" ("key","name","description","is_system")
  SELECT 'manager', 'Manager / Opérations',
         'Pilotage des opérations : catalogue, stock, commandes, rendez-vous, retours, garanties, promotions, clients, fidélité, crédit et newsletter — hors Système/Infrastructure, gestion des utilisateurs, connexion & comptes, contenu/design et blog. Rôle de départ, modifiable.',
         false
  WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "key" = 'manager');
--> statement-breakpoint

INSERT INTO "roles" ("key","name","description","is_system")
  SELECT 'web_master', 'Web master',
         'Contenu du site : produits & catalogue, médiathèque, CMS (accueil, pages, bannières, navigation, thème, identité), blog, et SEO/redirections. Sans commandes, clients ni Système. Rôle de départ, modifiable.',
         false
  WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "key" = 'web_master');
--> statement-breakpoint

INSERT INTO "roles" ("key","name","description","is_system")
  SELECT 'support', 'Service client',
         'Relation client : fiches clients, commandes, retours, garanties (SAV), crédit, rendez-vous et modération des avis — consultation de la fidélité et des invités. Sans export PII en masse, sans catalogue, contenu ni Système. Rôle de départ, modifiable.',
         false
  WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "key" = 'support');
--> statement-breakpoint

-- administrateur : every registry module as `<module>:*` (NEVER the global `*`).
INSERT INTO "role_permissions" ("role_id","permission")
  SELECT r."id", g.perm
  FROM "roles" r
  CROSS JOIN (VALUES
    ('dashboard:*'),('analytics:*'),('products:*'),('stock:*'),('categories:*'),('brands:*'),
    ('collections:*'),('attributes:*'),('reviews:*'),('media:*'),('system_media:*'),('orders:*'),
    ('appointments:*'),('orders_new:*'),('cart:*'),('returns:*'),('warranty:*'),('promotions:*'),
    ('system_payments:*'),('system_express:*'),('system_delivery:*'),('system_tax:*'),
    ('system_currency:*'),('checkout:*'),('customers:*'),('invites:*'),('favorites:*'),
    ('businesses:*'),('loyalty:*'),('credit:*'),('newsletter:*'),('system_auth:*'),('home:*'),
    ('pages:*'),('banners:*'),('showcase:*'),('trust_badges:*'),('navigation:*'),
    ('settings_theme:*'),('settings_site:*'),('blog_posts:*'),('blog_cats:*'),('blog_tags:*'),
    ('blog_authors:*'),('blog_comments:*'),('users:*'),('system_ai:*'),('system_mail:*'),
    ('system_jobs:*'),('system_seo:*'),('system_redirects:*'),('system_cookies:*'),
    ('system_analytics:*'),('system_search:*'),('system_audit:*'),('system_import:*'),
    ('system_demo:*'),('system_api:*'),('system_database:*'),('system_resources:*'),
    ('system_performance:*'),('system_security:*')
  ) AS g(perm)
  WHERE r."key" = 'administrateur'
    AND NOT EXISTS (SELECT 1 FROM "role_permissions" rp WHERE rp."role_id" = r."id" AND rp."permission" = g.perm);
--> statement-breakpoint

-- manager : operations (hors Système/Infra/users/system_auth/CMS/blog).
INSERT INTO "role_permissions" ("role_id","permission")
  SELECT r."id", g.perm
  FROM "roles" r
  CROSS JOIN (VALUES
    ('dashboard:view'),('analytics:view'),('products:*'),('stock:*'),('categories:*'),('brands:*'),
    ('collections:*'),('attributes:*'),('reviews:*'),('media:*'),('system_media:*'),('orders:*'),
    ('orders_new:*'),('cart:view'),('returns:*'),('warranty:*'),('promotions:*'),('appointments:*'),
    ('system_payments:*'),('system_express:*'),('system_delivery:*'),('system_tax:*'),
    ('system_currency:*'),('checkout:*'),('customers:*'),('invites:*'),('favorites:*'),
    ('businesses:*'),('loyalty:*'),('credit:*'),('newsletter:*')
  ) AS g(perm)
  WHERE r."key" = 'manager'
    AND NOT EXISTS (SELECT 1 FROM "role_permissions" rp WHERE rp."role_id" = r."id" AND rp."permission" = g.perm);
--> statement-breakpoint

-- web_master : produits + médiathèque + CMS + blog + SEO (aucune commande/client/Système).
INSERT INTO "role_permissions" ("role_id","permission")
  SELECT r."id", g.perm
  FROM "roles" r
  CROSS JOIN (VALUES
    ('dashboard:view'),('analytics:view'),('products:*'),('categories:*'),('brands:*'),
    ('collections:*'),('attributes:*'),('reviews:*'),('media:*'),('system_media:*'),('stock:view'),
    ('home:*'),('pages:*'),('banners:*'),('showcase:*'),('trust_badges:*'),('navigation:*'),
    ('settings_theme:*'),('settings_site:*'),('blog_posts:*'),('blog_cats:*'),('blog_tags:*'),
    ('blog_authors:*'),('blog_comments:*'),('system_seo:*'),('system_redirects:*')
  ) AS g(perm)
  WHERE r."key" = 'web_master'
    AND NOT EXISTS (SELECT 1 FROM "role_permissions" rp WHERE rp."role_id" = r."id" AND rp."permission" = g.perm);
--> statement-breakpoint

-- support : service client (consultation + SAV), sans export PII ni Système.
INSERT INTO "role_permissions" ("role_id","permission")
  SELECT r."id", g.perm
  FROM "roles" r
  CROSS JOIN (VALUES
    ('dashboard:view'),('customers:view'),('customers:update'),('customers:manage'),('invites:view'),
    ('favorites:view'),('orders:view'),('orders:update'),('orders:manage'),('returns:*'),('warranty:*'),
    ('credit:*'),('loyalty:view'),('appointments:view'),('appointments:manage'),('reviews:view'),
    ('reviews:manage'),('newsletter:view'),('businesses:view')
  ) AS g(perm)
  WHERE r."key" = 'support'
    AND NOT EXISTS (SELECT 1 FROM "role_permissions" rp WHERE rp."role_id" = r."id" AND rp."permission" = g.perm);

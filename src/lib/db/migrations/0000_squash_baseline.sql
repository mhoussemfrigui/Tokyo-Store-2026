-- ════════════════════════════════════════════════════════════════════════════
-- Extensions, functions + text-search config (migration-defined; not in schema.ts)
--   pgcrypto → gen_random_bytes for uuid_generate_v7; pg_trgm/btree_gin → search
--   indexes; unaccent → accent-insensitive search (provides the `unaccent` dict).
-- ════════════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "btree_gin";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "unaccent";--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.uuid_generate_v7()
 RETURNS uuid
 LANGUAGE plpgsql
 PARALLEL SAFE
AS $function$
DECLARE
  v_time_millis bigint;
  v_uuid_bytes bytea;
BEGIN
  v_time_millis := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_uuid_bytes := set_byte(gen_random_bytes(16), 6,
                           (b'0111' || get_byte(gen_random_bytes(1), 0)::bit(4))::bit(8)::int);
  v_uuid_bytes := set_byte(v_uuid_bytes, 0, ((v_time_millis >> 40) & 255)::int);
  v_uuid_bytes := set_byte(v_uuid_bytes, 1, ((v_time_millis >> 32) & 255)::int);
  v_uuid_bytes := set_byte(v_uuid_bytes, 2, ((v_time_millis >> 24) & 255)::int);
  v_uuid_bytes := set_byte(v_uuid_bytes, 3, ((v_time_millis >> 16) & 255)::int);
  v_uuid_bytes := set_byte(v_uuid_bytes, 4, ((v_time_millis >> 8)  & 255)::int);
  v_uuid_bytes := set_byte(v_uuid_bytes, 5, ((v_time_millis)       & 255)::int);
  v_uuid_bytes := set_byte(v_uuid_bytes, 8,
                           (b'10' || get_byte(v_uuid_bytes, 8)::bit(6))::bit(8)::int);
  RETURN encode(v_uuid_bytes, 'hex')::uuid;
END
$function$;--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION public.fr_unaccent (PARSER = pg_catalog."default");
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR asciiword WITH french_stem;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR word WITH public.unaccent, french_stem;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR numword WITH simple;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR email WITH simple;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR url WITH simple;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR host WITH simple;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR sfloat WITH simple;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR version WITH simple;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR hword_numpart WITH simple;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR hword_part WITH public.unaccent, french_stem;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR hword_asciipart WITH french_stem;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR numhword WITH simple;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR asciihword WITH french_stem;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR hword WITH public.unaccent, french_stem;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR url_path WITH simple;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR file WITH simple;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR "float" WITH simple;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR "int" WITH simple;
ALTER TEXT SEARCH CONFIGURATION public.fr_unaccent ADD MAPPING FOR uint WITH simple;
--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('customer', 'staff', 'admin');--> statement-breakpoint
CREATE TYPE "public"."address_type" AS ENUM('shipping', 'billing', 'both');--> statement-breakpoint
CREATE TYPE "public"."product_badge" AS ENUM('NEW', 'HOT', 'PROMO', 'PRECO');--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('simple', 'variable');--> statement-breakpoint
CREATE TYPE "public"."attribute_kind" AS ENUM('select', 'multiselect');--> statement-breakpoint
CREATE TYPE "public"."setting_type" AS ENUM('text', 'number', 'boolean', 'media');--> statement-breakpoint
CREATE TYPE "public"."banner_placement" AS ENUM('home_hero', 'header_strip', 'category_grid', 'footer', 'checkout');--> statement-breakpoint
CREATE TYPE "public"."page_section_type" AS ENUM('hero', 'text', 'cta', 'stats', 'timeline', 'product_list', 'banner_grid');--> statement-breakpoint
CREATE TYPE "public"."delivery_method" AS ENUM('home_delivery', 'drive_by_pickup', 'in_store');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'paid', 'preparing', 'shipped', 'delivered', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('konnect', 'flouci', 'clictopay', 'cod', 'card_stripe');--> statement-breakpoint
CREATE TYPE "public"."digital_asset_type" AS ENUM('key', 'download', 'guide');--> statement-breakpoint
CREATE TYPE "public"."aid_difficulty" AS ENUM('easy', 'medium', 'hard');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('image', 'video', 'document', 'other');--> statement-breakpoint
CREATE TYPE "public"."promotion_discount_type" AS ENUM('percent', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."promotion_scope" AS ENUM('product', 'category', 'brand', 'cart');--> statement-breakpoint
CREATE TYPE "public"."promotion_trigger" AS ENUM('auto', 'code', 'url');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" "user_role" DEFAULT 'customer' NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"type" "address_type" DEFAULT 'both' NOT NULL,
	"label" text,
	"full_name" text NOT NULL,
	"company" text,
	"street_line1" text NOT NULL,
	"street_line2" text,
	"city" text NOT NULL,
	"region" text,
	"postal_code" text,
	"country" char(2) DEFAULT 'TN' NOT NULL,
	"phone" text,
	"is_default_shipping" boolean DEFAULT false NOT NULL,
	"is_default_billing" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_profiles" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"phone" text,
	"date_of_birth" text,
	"loyalty_points" integer DEFAULT 0 NOT NULL,
	"lifetime_coins_earned" integer DEFAULT 0 NOT NULL,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"admin_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"logo_media_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"hero_media_id" text,
	"tagline" text,
	"editorial_eyebrow" text,
	"editorial_title" text,
	"editorial_body" text,
	"value_props" jsonb,
	"meta_title" text,
	"meta_description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text,
	"description" text,
	"parent_id" uuid,
	"display_order" integer DEFAULT 0 NOT NULL,
	"meta_title" text,
	"meta_description" text,
	"warranty_months" integer,
	"warranty_label" text,
	"tax_rate_bps" integer,
	"hero_media_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_discountable" boolean DEFAULT true NOT NULL,
	"editorial_eyebrow" text,
	"editorial_title" text,
	"editorial_body" text,
	"value_props" jsonb,
	"filter_config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_highlights" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"product_id" uuid NOT NULL,
	"text" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variant_values" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"variant_id" uuid NOT NULL,
	"attribute_value_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text,
	"gtin" text,
	"mpn" text,
	"label" text DEFAULT '' NOT NULL,
	"price_cents" integer NOT NULL,
	"old_price_cents" integer,
	"stock_qty" integer,
	"in_stock" boolean DEFAULT true NOT NULL,
	"image_media_id" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"platform" text,
	"sku" text,
	"gtin" text,
	"mpn" text,
	"product_type" "product_type" DEFAULT 'simple' NOT NULL,
	"is_digital" boolean DEFAULT false NOT NULL,
	"requires_serial" boolean DEFAULT false NOT NULL,
	"warranty_months" integer,
	"warranty_label" text,
	"tax_rate_bps" integer,
	"short_desc" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"highlights_title" text,
	"price_cents" integer NOT NULL,
	"old_price_cents" integer,
	"currency" text DEFAULT 'TND' NOT NULL,
	"badge" "product_badge",
	"rating" numeric(3, 2) DEFAULT '0' NOT NULL,
	"reviews_count" integer DEFAULT 0 NOT NULL,
	"in_stock" boolean DEFAULT true NOT NULL,
	"stock_qty" integer,
	"video_url" text,
	"video_poster_media_id" text,
	"video_title" text,
	"video_description" text,
	"meta_title" text,
	"meta_description" text,
	"canonical_url" text,
	"noindex" boolean DEFAULT false NOT NULL,
	"og_image_media_id" text,
	"is_preorder" boolean DEFAULT false NOT NULL,
	"preorder_releases_at" timestamp with time zone,
	"preorder_message" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"is_discountable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "category_attribute_filters" (
	"category_id" uuid NOT NULL,
	"attribute_id" uuid NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_attribute_filters_category_id_attribute_id_pk" PRIMARY KEY("category_id","attribute_id")
);
--> statement-breakpoint
CREATE TABLE "product_attribute_assignments" (
	"product_id" uuid NOT NULL,
	"attribute_value_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_attribute_assignments_product_id_attribute_value_id_pk" PRIMARY KEY("product_id","attribute_value_id")
);
--> statement-breakpoint
CREATE TABLE "product_attribute_values" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"attribute_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_attributes" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" "attribute_kind" DEFAULT 'multiselect' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_reviews" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"product_id" uuid NOT NULL,
	"user_id" text,
	"author_name" text NOT NULL,
	"rating" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_purchase" boolean DEFAULT false NOT NULL,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_settings" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"key" text NOT NULL,
	"value" text,
	"type" "setting_type" DEFAULT 'text' NOT NULL,
	"group_key" text DEFAULT 'general' NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promo_links" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"label" text NOT NULL,
	"href" text,
	"internal_kind" text,
	"internal_ref" text,
	"icon" text DEFAULT 'Tag' NOT NULL,
	"color" text DEFAULT 'lime' NOT NULL,
	"bg_color" text,
	"bg_hover_color" text,
	"text_color" text,
	"text_hover_color" text,
	"icon_bg_color" text,
	"icon_color" text,
	"border_color" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "faq_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "faqs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"faq_category_id" uuid,
	"product_id" uuid,
	"category_id" uuid,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"scope" text DEFAULT 'help' NOT NULL,
	"is_published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "banners" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"placement" "banner_placement" NOT NULL,
	"name" text NOT NULL,
	"eyebrow" text,
	"title" text NOT NULL,
	"subtitle" text,
	"description" text,
	"cta_label" text,
	"cta_href" text,
	"secondary_cta_label" text,
	"secondary_cta_href" text,
	"image_media_id" text,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "nav_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"menu_id" uuid NOT NULL,
	"parent_id" uuid,
	"label" text NOT NULL,
	"href" text,
	"internal_kind" text,
	"internal_ref" text,
	"icon" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"open_in_new_tab" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nav_menus" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cta_sections" (
	"page_section_id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"primary_cta_label" text NOT NULL,
	"primary_cta_href" text NOT NULL,
	"background_image_media_id" text,
	"style" text DEFAULT 'dark' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hero_sections" (
	"page_section_id" uuid PRIMARY KEY NOT NULL,
	"eyebrow" text,
	"title" text NOT NULL,
	"subtitle" text,
	"description" text,
	"image_media_id" text,
	"primary_cta_label" text,
	"primary_cta_href" text,
	"secondary_cta_label" text,
	"secondary_cta_href" text
);
--> statement-breakpoint
CREATE TABLE "page_sections" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"page_id" uuid NOT NULL,
	"type" "page_section_type" NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"meta_title" text,
	"meta_description" text,
	"og_image_media_id" text,
	"is_published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stats_section_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"stats_section_id" uuid NOT NULL,
	"label" text NOT NULL,
	"value" text NOT NULL,
	"caption" text,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stats_sections" (
	"page_section_id" uuid PRIMARY KEY NOT NULL,
	"heading" text,
	"layout" text DEFAULT 'grid' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "text_sections" (
	"page_section_id" uuid PRIMARY KEY NOT NULL,
	"heading" text,
	"body" text NOT NULL,
	"alignment" text DEFAULT 'left' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_section_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"timeline_section_id" uuid NOT NULL,
	"year" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_sections" (
	"page_section_id" uuid PRIMARY KEY NOT NULL,
	"heading" text
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"cart_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" text DEFAULT '' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"user_id" text,
	"token" text,
	"currency" text DEFAULT 'TND' NOT NULL,
	"merged_from_cart_id" text,
	"merged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"product_slug" text NOT NULL,
	"product_sku" text,
	"product_image_url" text,
	"variant_id" text,
	"variant_sku" text,
	"variant_label" text,
	"warranty_months" integer,
	"warranty_label" text,
	"unit_price_cents" integer NOT NULL,
	"quantity" integer NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"tax_rate_bps" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_refunds" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_status_history" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status" NOT NULL,
	"actor_user_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"order_number" text NOT NULL,
	"user_id" text,
	"contact_email" text NOT NULL,
	"contact_phone" text,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"currency" text DEFAULT 'TND' NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"shipping_cents" integer DEFAULT 0 NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"coins_points_spent" integer DEFAULT 0 NOT NULL,
	"coins_discount_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"tax_manual_cents" integer,
	"total_cents" integer NOT NULL,
	"ship_full_name" text NOT NULL,
	"ship_street_line1" text NOT NULL,
	"ship_street_line2" text,
	"ship_city" text NOT NULL,
	"ship_region" text,
	"ship_postal_code" text,
	"ship_country" text DEFAULT 'TN' NOT NULL,
	"ship_phone" text,
	"delivery_method" "delivery_method" DEFAULT 'home_delivery' NOT NULL,
	"delivery_agent_id" uuid,
	"pickup_location_id" uuid,
	"delivery_agent_name" text,
	"pickup_location_name" text,
	"pickup_location_address" text,
	"payment_method" "payment_method",
	"payment_reference" text,
	"paid_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"provider" text NOT NULL,
	"event_ref" text NOT NULL,
	"target_status" text NOT NULL,
	"order_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digital_assets" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" text DEFAULT '' NOT NULL,
	"asset_type" "digital_asset_type" DEFAULT 'key' NOT NULL,
	"value" text NOT NULL,
	"label" text,
	"is_allocated" boolean DEFAULT false NOT NULL,
	"order_item_id" text,
	"allocated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "order_item_serials" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"order_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"product_id" text NOT NULL,
	"serial" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"attribute_value_id" uuid NOT NULL,
	"rate_bps" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_agents" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"name" text NOT NULL,
	"fee_cents" integer,
	"free_threshold_cents" integer,
	"phone" text,
	"zone_label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pickup_locations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"address_line" text,
	"city" text,
	"region" text,
	"phone" text,
	"hours_label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_template_overrides" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"template_key" text NOT NULL,
	"subject" text,
	"html" text,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blog_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blog_post_tags" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"post_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blog_posts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"excerpt" text,
	"body" text DEFAULT '' NOT NULL,
	"category_id" uuid,
	"author_user_id" text,
	"featured_image_media_id" text,
	"reading_minutes" integer,
	"is_published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"meta_title" text,
	"meta_description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "blog_tags" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aid_article_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"article_id" text NOT NULL,
	"step_number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"image_media_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aid_articles" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"intro" text DEFAULT '' NOT NULL,
	"outro" text,
	"category_id" uuid,
	"difficulty" "aid_difficulty" DEFAULT 'easy' NOT NULL,
	"platform" text,
	"estimated_minutes" integer,
	"author_user_id" text,
	"featured_image_media_id" text,
	"is_published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"meta_title" text,
	"meta_description" text,
	"view_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "aid_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text DEFAULT 'LifeBuoy' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"kind" "media_kind" DEFAULT 'image' NOT NULL,
	"storage_key" text NOT NULL,
	"url" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"alt_text" text,
	"uploaded_by" text,
	"webp_url" text,
	"webp_size_bytes" bigint,
	"avif_url" text,
	"avif_size_bytes" bigint,
	"original_url" text,
	"original_size_bytes" bigint,
	"original_mime_type" text,
	"url_override" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "media_settings" (
	"id" uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL,
	"generate_webp" boolean DEFAULT true NOT NULL,
	"generate_avif" boolean DEFAULT true NOT NULL,
	"keep_original" boolean DEFAULT false NOT NULL,
	"max_width_px" integer DEFAULT 2400 NOT NULL,
	"max_height_px" integer DEFAULT 2400 NOT NULL,
	"webp_quality" integer DEFAULT 82 NOT NULL,
	"avif_quality" integer DEFAULT 60 NOT NULL,
	"jpeg_quality" integer DEFAULT 85 NOT NULL,
	"strip_exif" boolean DEFAULT true NOT NULL,
	"max_upload_mb" integer DEFAULT 8 NOT NULL,
	"default_alt_text" text,
	"cdn_base_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"event_name" text NOT NULL,
	"actor_user_id" text,
	"actor_ip" text,
	"target_type" text,
	"target_id" text,
	"summary" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "newsletter_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"email" text NOT NULL,
	"source" text DEFAULT 'footer' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"confirmed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promotion_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"promotion_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"user_id" text,
	"discount_cents" integer NOT NULL,
	"code_used" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger_kind" "promotion_trigger" DEFAULT 'auto' NOT NULL,
	"code" text,
	"url_slug" text,
	"scope" "promotion_scope" NOT NULL,
	"scope_id" uuid,
	"discount_type" "promotion_discount_type" NOT NULL,
	"discount_value" integer NOT NULL,
	"min_cart_cents" integer DEFAULT 0 NOT NULL,
	"max_uses" integer,
	"max_uses_per_user" integer,
	"uses_count" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_stackable" boolean DEFAULT false NOT NULL,
	"display_priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "promotions_discount_bounds_chk" CHECK (("promotions"."discount_type" = 'percent' AND "promotions"."discount_value" BETWEEN 1 AND 100) OR ("promotions"."discount_type" = 'fixed' AND "promotions"."discount_value" >= 1)),
	CONSTRAINT "promotions_scope_id_match_chk" CHECK (("promotions"."scope" = 'cart' AND "promotions"."scope_id" IS NULL) OR ("promotions"."scope" <> 'cart' AND "promotions"."scope_id" IS NOT NULL)),
	CONSTRAINT "promotions_trigger_surface_chk" CHECK (("promotions"."trigger_kind" = 'auto' AND "promotions"."code" IS NULL AND "promotions"."url_slug" IS NULL) OR ("promotions"."trigger_kind" = 'code' AND "promotions"."code" IS NOT NULL) OR ("promotions"."trigger_kind" = 'url' AND "promotions"."url_slug" IS NOT NULL)),
	CONSTRAINT "promotions_schedule_order_chk" CHECK ("promotions"."ends_at" IS NULL OR "promotions"."starts_at" IS NULL OR "promotions"."ends_at" > "promotions"."starts_at"),
	CONSTRAINT "promotions_uses_count_nonneg_chk" CHECK ("promotions"."uses_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "coin_levels" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"name" text NOT NULL,
	"threshold_coins" integer DEFAULT 0 NOT NULL,
	"earn_multiplier_bps" integer,
	"max_redeem_pct" integer,
	"flat_discount_pct" integer,
	"free_shipping_threshold_cents" integer,
	"badge_color" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coin_transactions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"user_id" text,
	"order_id" uuid,
	"kind" text NOT NULL,
	"points" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_provider_settings" (
	"provider" text PRIMARY KEY NOT NULL,
	"test_mode" boolean DEFAULT true NOT NULL,
	"api_key_enc" text,
	"wallet_id_enc" text,
	"username_enc" text,
	"password_enc" text,
	"app_token_enc" text,
	"app_secret_enc" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "showcase_pins" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"slug" text NOT NULL,
	"product_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wishlist_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"wishlist_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wishlists" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"user_id" text,
	"token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"query" text NOT NULL,
	"normalized_query" text NOT NULL,
	"result_count" integer DEFAULT 0 NOT NULL,
	"user_id" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_user_links" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"user_id" text NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"product_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_brands" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"product_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_media" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"product_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"alt_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account_unique" ON "accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_unique" ON "sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verifications_expires_idx" ON "verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "addresses_customer_idx" ON "addresses" USING btree ("customer_profile_id");--> statement-breakpoint
CREATE INDEX "customer_profiles_created_at_idx" ON "customer_profiles" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_slug_unique" ON "brands" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_slug_idx" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "categories_display_order_idx" ON "categories" USING btree ("display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_root_slug_unique" ON "categories" USING btree ("slug") WHERE "categories"."parent_id" is null;--> statement-breakpoint
CREATE INDEX "product_highlights_product_idx" ON "product_highlights" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_variant_values_variant_idx" ON "product_variant_values" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "product_variant_values_value_idx" ON "product_variant_values" USING btree ("attribute_value_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variant_values_unique" ON "product_variant_values" USING btree ("variant_id","attribute_value_id");--> statement-breakpoint
CREATE INDEX "product_variants_product_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_variants_sku_idx" ON "product_variants" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "product_variants_order_idx" ON "product_variants" USING btree ("product_id","display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_one_default_per_product" ON "product_variants" USING btree ("product_id") WHERE "product_variants"."is_default" and "product_variants"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_unique" ON "products" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "products_published_idx" ON "products" USING btree ("is_published","published_at");--> statement-breakpoint
CREATE INDEX "products_in_stock_idx" ON "products" USING btree ("in_stock");--> statement-breakpoint
CREATE INDEX "products_badge_idx" ON "products" USING btree ("badge");--> statement-breakpoint
CREATE INDEX "products_created_at_idx" ON "products" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "products_preorder_idx" ON "products" USING btree ("preorder_releases_at") WHERE is_preorder = true;--> statement-breakpoint
CREATE INDEX "category_attribute_filters_category_idx" ON "category_attribute_filters" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "product_attribute_assignments_product_idx" ON "product_attribute_assignments" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_attribute_assignments_value_idx" ON "product_attribute_assignments" USING btree ("attribute_value_id");--> statement-breakpoint
CREATE INDEX "product_attribute_values_attribute_order_idx" ON "product_attribute_values" USING btree ("attribute_id","display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "product_attribute_values_attribute_slug_unique" ON "product_attribute_values" USING btree ("attribute_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "product_attributes_slug_unique" ON "product_attributes" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "product_attributes_display_order_idx" ON "product_attributes" USING btree ("display_order");--> statement-breakpoint
CREATE INDEX "product_reviews_product_status_idx" ON "product_reviews" USING btree ("product_id","status");--> statement-breakpoint
CREATE INDEX "product_reviews_user_idx" ON "product_reviews" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_reviews_user_product_unique" ON "product_reviews" USING btree ("user_id","product_id") WHERE "product_reviews"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "settings_key_unique" ON "site_settings" USING btree ("key");--> statement-breakpoint
CREATE INDEX "settings_group_idx" ON "site_settings" USING btree ("group_key");--> statement-breakpoint
CREATE INDEX "promo_links_order_idx" ON "promo_links" USING btree ("display_order");--> statement-breakpoint
CREATE INDEX "promo_links_active_idx" ON "promo_links" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "promo_links_schedule_idx" ON "promo_links" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "faq_categories_slug_unique" ON "faq_categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "faqs_scope_idx" ON "faqs" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "faqs_cat_idx" ON "faqs" USING btree ("faq_category_id");--> statement-breakpoint
CREATE INDEX "faqs_order_idx" ON "faqs" USING btree ("display_order");--> statement-breakpoint
CREATE INDEX "faqs_product_idx" ON "faqs" USING btree ("product_id") WHERE "faqs"."product_id" is not null;--> statement-breakpoint
CREATE INDEX "faqs_category_idx" ON "faqs" USING btree ("category_id") WHERE "faqs"."category_id" is not null;--> statement-breakpoint
CREATE INDEX "banners_placement_idx" ON "banners" USING btree ("placement");--> statement-breakpoint
CREATE INDEX "banners_active_idx" ON "banners" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "banners_order_idx" ON "banners" USING btree ("display_order");--> statement-breakpoint
CREATE INDEX "nav_items_menu_idx" ON "nav_items" USING btree ("menu_id");--> statement-breakpoint
CREATE INDEX "nav_items_parent_idx" ON "nav_items" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "nav_items_order_idx" ON "nav_items" USING btree ("display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "nav_menus_key_unique" ON "nav_menus" USING btree ("key");--> statement-breakpoint
CREATE INDEX "page_sections_page_idx" ON "page_sections" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "page_sections_order_idx" ON "page_sections" USING btree ("display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_slug_unique" ON "pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "pages_published_idx" ON "pages" USING btree ("is_published");--> statement-breakpoint
CREATE INDEX "stats_items_parent_idx" ON "stats_section_items" USING btree ("stats_section_id");--> statement-breakpoint
CREATE INDEX "timeline_items_parent_idx" ON "timeline_section_items" USING btree ("timeline_section_id");--> statement-breakpoint
CREATE INDEX "cart_items_cart_idx" ON "cart_items" USING btree ("cart_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_cart_product_unique" ON "cart_items" USING btree ("cart_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "carts_user_idx" ON "carts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carts_token_unique" ON "carts" USING btree ("token");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_refunds_order_idx" ON "order_refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_refunds_created_at_idx" ON "order_refunds" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "osh_order_idx" ON "order_status_history" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_order_number_unique" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "orders_user_created_idx" ON "orders" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_ref_status_uniq" ON "webhook_events" USING btree ("provider","event_ref","target_status");--> statement-breakpoint
CREATE INDEX "digital_assets_product_idx" ON "digital_assets" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "digital_assets_pool_idx" ON "digital_assets" USING btree ("product_id","asset_type","is_allocated");--> statement-breakpoint
CREATE INDEX "digital_assets_order_item_idx" ON "digital_assets" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "order_item_serials_order_idx" ON "order_item_serials" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_item_serials_item_idx" ON "order_item_serials" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "order_item_serials_serial_idx" ON "order_item_serials" USING btree ("serial");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rules_attribute_value_uq" ON "tax_rules" USING btree ("attribute_value_id");--> statement-breakpoint
CREATE INDEX "delivery_agents_enabled_idx" ON "delivery_agents" USING btree ("enabled","display_order");--> statement-breakpoint
CREATE INDEX "pickup_locations_enabled_idx" ON "pickup_locations" USING btree ("enabled","display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "email_template_overrides_key_uniq" ON "email_template_overrides" USING btree ("template_key");--> statement-breakpoint
CREATE UNIQUE INDEX "blog_categories_slug_unique" ON "blog_categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "blog_categories_order_idx" ON "blog_categories" USING btree ("display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "blog_post_tags_pair_unique" ON "blog_post_tags" USING btree ("post_id","tag_id");--> statement-breakpoint
CREATE INDEX "blog_post_tags_post_idx" ON "blog_post_tags" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "blog_post_tags_tag_idx" ON "blog_post_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "blog_posts_slug_unique" ON "blog_posts" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "blog_posts_category_idx" ON "blog_posts" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "blog_posts_author_idx" ON "blog_posts" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "blog_posts_published_idx" ON "blog_posts" USING btree ("is_published","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "blog_tags_slug_unique" ON "blog_tags" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "aid_steps_article_idx" ON "aid_article_steps" USING btree ("article_id");--> statement-breakpoint
CREATE UNIQUE INDEX "aid_steps_order_unique" ON "aid_article_steps" USING btree ("article_id","step_number");--> statement-breakpoint
CREATE UNIQUE INDEX "aid_articles_slug_unique" ON "aid_articles" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "aid_articles_category_idx" ON "aid_articles" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "aid_articles_platform_idx" ON "aid_articles" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "aid_articles_published_idx" ON "aid_articles" USING btree ("is_published","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "aid_categories_slug_unique" ON "aid_categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "aid_categories_order_idx" ON "aid_categories" USING btree ("display_order");--> statement-breakpoint
CREATE INDEX "media_uploader_idx" ON "media" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "media_created_at_idx" ON "media" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "media_kind_idx" ON "media" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "audit_event_idx" ON "audit_log" USING btree ("event_name");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_created_at_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "newsletter_email_unique" ON "newsletter_subscriptions" USING btree ("email");--> statement-breakpoint
CREATE INDEX "newsletter_active_idx" ON "newsletter_subscriptions" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "promotion_redemptions_promo_idx" ON "promotion_redemptions" USING btree ("promotion_id");--> statement-breakpoint
CREATE INDEX "promotion_redemptions_user_idx" ON "promotion_redemptions" USING btree ("promotion_id","user_id");--> statement-breakpoint
CREATE INDEX "promotion_redemptions_order_idx" ON "promotion_redemptions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "promotions_scope_idx" ON "promotions" USING btree ("scope","scope_id");--> statement-breakpoint
CREATE INDEX "promotions_active_schedule_idx" ON "promotions" USING btree ("is_active","starts_at","ends_at") WHERE "promotions"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "promotions_code_lower_unique" ON "promotions" USING btree (lower("code")) WHERE "promotions"."code" IS NOT NULL AND "promotions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "promotions_url_slug_unique" ON "promotions" USING btree ("url_slug") WHERE "promotions"."url_slug" IS NOT NULL AND "promotions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "coin_levels_threshold_idx" ON "coin_levels" USING btree ("threshold_coins");--> statement-breakpoint
CREATE INDEX "coin_levels_display_order_idx" ON "coin_levels" USING btree ("display_order");--> statement-breakpoint
CREATE INDEX "coin_tx_user_created_idx" ON "coin_transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "coin_tx_order_idx" ON "coin_transactions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "coin_tx_order_kind_idx" ON "coin_transactions" USING btree ("order_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "coin_tx_earn_per_order_uq" ON "coin_transactions" USING btree ("order_id") WHERE "coin_transactions"."kind" = 'earn' AND "coin_transactions"."order_id" is not null;--> statement-breakpoint
CREATE INDEX "showcase_pins_slug_position_idx" ON "showcase_pins" USING btree ("slug","position");--> statement-breakpoint
CREATE UNIQUE INDEX "showcase_pins_slug_product_uniq" ON "showcase_pins" USING btree ("slug","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wishlist_items_unique" ON "wishlist_items" USING btree ("wishlist_id","product_id");--> statement-breakpoint
CREATE INDEX "wishlist_items_product_idx" ON "wishlist_items" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wishlists_user_unique" ON "wishlists" USING btree ("user_id") WHERE "wishlists"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wishlists_token_unique" ON "wishlists" USING btree ("token") WHERE "wishlists"."token" is not null;--> statement-breakpoint
CREATE INDEX "search_log_normalized_idx" ON "search_log" USING btree ("normalized_query","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "cul_user_unique" ON "customer_user_links" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cul_profile_unique" ON "customer_user_links" USING btree ("customer_profile_id");--> statement-breakpoint
CREATE INDEX "cul_user_idx" ON "customer_user_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cul_profile_idx" ON "customer_user_links" USING btree ("customer_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pc_pair_unique" ON "product_categories" USING btree ("product_id","category_id");--> statement-breakpoint
CREATE INDEX "pc_product_idx" ON "product_categories" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "pc_category_idx" ON "product_categories" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pb_product_unique" ON "product_brands" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "pb_brand_idx" ON "product_brands" USING btree ("brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pm_pair_unique" ON "product_media" USING btree ("product_id","media_id");--> statement-breakpoint
CREATE INDEX "pm_product_idx" ON "product_media" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "pm_media_idx" ON "product_media" USING btree ("media_id");
--> statement-breakpoint
-- ════════════════════════════════════════════════════════════════════════════
-- Migration-managed objects outside the drizzle schema graph (the established
-- convention in this codebase): raw-SQL tables accessed via db.execute, plus
-- every FOREIGN KEY / CHECK and the migration-only indexes (functional, BRIN,
-- partial, trigram-GIN). All constraints are VALID from the start — this is a
-- clean baseline with no legacy rows to scan.
-- ════════════════════════════════════════════════════════════════════════════

-- Raw-SQL tables (app_secrets ← 0006, rate_limit_buckets ← 0010)

CREATE TABLE public.app_secrets (
    key text NOT NULL,
    value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.rate_limit_buckets (
    bucket_key text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.app_secrets
    ADD CONSTRAINT app_secrets_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.rate_limit_buckets
    ADD CONSTRAINT rate_limit_buckets_pkey PRIMARY KEY (bucket_key);

CREATE INDEX rate_limit_buckets_expires_idx ON public.rate_limit_buckets USING btree (expires_at);


-- Generated tsvector FTS columns (search_vector; reference fr_unaccent)
ALTER TABLE aid_articles ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (((((((setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(summary, ''::text)), 'B'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(intro, ''::text)), 'C'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(outro, ''::text)), 'C'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(platform, ''::text)), 'D'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(meta_title, ''::text)), 'D'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(meta_description, ''::text)), 'D'::"char"))) STORED;
ALTER TABLE blog_posts ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (((((setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(excerpt, ''::text)), 'B'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(body, ''::text)), 'C'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(meta_title, ''::text)), 'D'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(meta_description, ''::text)), 'D'::"char"))) STORED;
ALTER TABLE brands ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (((((((setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(name, ''::text)), 'A'::"char") || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(tagline, ''::text)), 'B'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(description, ''::text)), 'C'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(editorial_title, ''::text)), 'B'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(editorial_body, ''::text)), 'C'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(meta_title, ''::text)), 'D'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(meta_description, ''::text)), 'D'::"char"))) STORED;
ALTER TABLE categories ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (((((((setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(name, ''::text)), 'A'::"char") || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(tagline, ''::text)), 'B'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(description, ''::text)), 'C'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(editorial_title, ''::text)), 'B'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(editorial_body, ''::text)), 'C'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(meta_title, ''::text)), 'D'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(meta_description, ''::text)), 'D'::"char"))) STORED;
ALTER TABLE pages ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (((setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(meta_title, ''::text)), 'B'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(meta_description, ''::text)), 'C'::"char"))) STORED;
ALTER TABLE products ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (((((setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(name, ''::text)), 'A'::"char") || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(sku, ''::text)), 'A'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(short_desc, ''::text)), 'B'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(description, ''::text)), 'C'::"char")) || setweight(to_tsvector('fr_unaccent'::regconfig, COALESCE(platform, ''::text)), 'D'::"char"))) STORED;

-- Migration-only indexes (functional / partial / BRIN / trigram-GIN)
CREATE INDEX faq_categories_order_idx ON public.faq_categories USING btree (display_order);
CREATE INDEX banners_live_placement_order_idx ON public.banners USING btree (placement, display_order) WHERE ((is_active = true) AND (deleted_at IS NULL));
CREATE INDEX banners_scheduled_idx ON public.banners USING btree (start_at, end_at) WHERE ((is_active = true) AND (deleted_at IS NULL));
CREATE INDEX banners_image_media_id_idx ON public.banners USING btree (image_media_id) WHERE (image_media_id IS NOT NULL);
CREATE INDEX aid_article_steps_image_media_id_idx ON public.aid_article_steps USING btree (image_media_id) WHERE (image_media_id IS NOT NULL);
CREATE INDEX newsletter_active_recent_idx ON public.newsletter_subscriptions USING btree (created_at DESC) WHERE (is_active = true);
CREATE INDEX newsletter_email_trgm ON public.newsletter_subscriptions USING gin (email gin_trgm_ops);
CREATE UNIQUE INDEX newsletter_email_lower_unique ON public.newsletter_subscriptions USING btree (lower(email));
CREATE INDEX sessions_user_expires_idx ON public.sessions USING btree (user_id, expires_at DESC);
CREATE INDEX site_settings_group_order_idx ON public.site_settings USING btree (group_key, display_order, key);
CREATE INDEX audit_created_at_brin ON public.audit_log USING brin (created_at) WITH (pages_per_range='32');
CREATE INDEX audit_metadata_gin ON public.audit_log USING gin (metadata jsonb_path_ops);
CREATE INDEX audit_created_at_desc_idx ON public.audit_log USING btree (created_at DESC);
CREATE INDEX audit_event_recent_idx ON public.audit_log USING btree (event_name, created_at DESC);
CREATE INDEX search_log_zero_result_idx ON public.search_log USING btree (created_at DESC) WHERE (result_count = 0);
CREATE INDEX search_log_created_at_brin ON public.search_log USING brin (created_at) WITH (pages_per_range='32');
CREATE INDEX faqs_published_scope_order_idx ON public.faqs USING btree (scope, faq_category_id, display_order) WHERE ((is_published = true) AND (deleted_at IS NULL));
CREATE INDEX faqs_category_order_idx ON public.faqs USING btree (faq_category_id, display_order) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX promotion_redemptions_promotion_order_uniq ON public.promotion_redemptions USING btree (promotion_id, order_id) WHERE ((order_id IS NOT NULL) AND (discount_cents > 0));
CREATE INDEX order_item_serials_serial_lower_idx ON public.order_item_serials USING btree (lower(serial));
CREATE INDEX webhook_events_order_idx ON public.webhook_events USING btree (order_id);
CREATE INDEX webhook_events_created_at_brin ON public.webhook_events USING brin (created_at) WITH (pages_per_range='32');
CREATE INDEX promo_links_live_order_idx ON public.promo_links USING btree (display_order) WHERE (is_active = true);
CREATE INDEX aid_articles_active_recent_idx ON public.aid_articles USING btree (is_published, published_at DESC NULLS LAST) WHERE (deleted_at IS NULL);
CREATE INDEX aid_articles_platform_active_idx ON public.aid_articles USING btree (platform, is_published) WHERE ((deleted_at IS NULL) AND (platform IS NOT NULL));
CREATE INDEX aid_articles_search_gin ON public.aid_articles USING gin (search_vector) WHERE ((deleted_at IS NULL) AND (is_published = true));
CREATE INDEX aid_articles_title_trgm ON public.aid_articles USING gin (title gin_trgm_ops) WHERE (deleted_at IS NULL);
CREATE INDEX aid_articles_featured_image_media_id_idx ON public.aid_articles USING btree (featured_image_media_id) WHERE (featured_image_media_id IS NOT NULL);
CREATE INDEX aid_articles_category_recent_idx ON public.aid_articles USING btree (category_id, is_published, published_at DESC NULLS LAST) WHERE (deleted_at IS NULL);
CREATE INDEX product_attributes_active_idx ON public.product_attributes USING btree (is_active) WHERE (deleted_at IS NULL);
CREATE INDEX category_attribute_filters_attribute_idx ON public.category_attribute_filters USING btree (attribute_id);
CREATE INDEX orders_user_recent_idx ON public.orders USING btree (user_id, created_at DESC) WHERE (user_id IS NOT NULL);
CREATE INDEX orders_status_recent_idx ON public.orders USING btree (status, created_at DESC);
CREATE INDEX orders_contact_email_lower_idx ON public.orders USING btree (lower(contact_email));
CREATE INDEX orders_contact_phone_idx ON public.orders USING btree (contact_phone);
CREATE INDEX orders_order_number_upper_idx ON public.orders USING btree (upper(order_number));
CREATE INDEX orders_contact_phone_digits_idx ON public.orders USING btree (regexp_replace(contact_phone, '\D'::text, ''::text, 'g'::text));
CREATE INDEX orders_delivery_agent_id_idx ON public.orders USING btree (delivery_agent_id) WHERE (delivery_agent_id IS NOT NULL);
CREATE INDEX orders_pickup_location_id_idx ON public.orders USING btree (pickup_location_id) WHERE (pickup_location_id IS NOT NULL);
CREATE INDEX products_published_recent_idx ON public.products USING btree (is_published, published_at DESC NULLS LAST) WHERE (deleted_at IS NULL);
CREATE INDEX products_active_slug_idx ON public.products USING btree (slug) WHERE (deleted_at IS NULL);
CREATE INDEX products_active_price_idx ON public.products USING btree (price_cents) WHERE ((deleted_at IS NULL) AND (is_published = true));
CREATE INDEX products_in_stock_active_idx ON public.products USING btree (in_stock, published_at DESC NULLS LAST) WHERE ((deleted_at IS NULL) AND (is_published = true));
CREATE INDEX products_name_trgm ON public.products USING gin (name gin_trgm_ops) WHERE (deleted_at IS NULL);
CREATE INDEX products_search_gin ON public.products USING gin (search_vector) WHERE ((deleted_at IS NULL) AND (is_published = true));
CREATE INDEX products_video_poster_media_id_idx ON public.products USING btree (video_poster_media_id) WHERE (video_poster_media_id IS NOT NULL);
CREATE INDEX products_og_image_media_id_idx ON public.products USING btree (og_image_media_id) WHERE (og_image_media_id IS NOT NULL);
CREATE INDEX coin_tx_created_at_brin ON public.coin_transactions USING brin (created_at) WITH (pages_per_range='32');
CREATE INDEX product_variants_image_media_id_idx ON public.product_variants USING btree (image_media_id) WHERE (image_media_id IS NOT NULL);
CREATE INDEX product_variants_live_order_idx ON public.product_variants USING btree (product_id, display_order) WHERE (deleted_at IS NULL);
CREATE INDEX order_items_product_idx ON public.order_items USING btree (product_id);
CREATE INDEX osh_created_at_brin ON public.order_status_history USING brin (created_at) WITH (pages_per_range='32');
CREATE INDEX osh_order_recent_idx ON public.order_status_history USING btree (order_id, created_at DESC);
CREATE INDEX order_refunds_order_recent_idx ON public.order_refunds USING btree (order_id, created_at DESC);
CREATE INDEX carts_merged_from_idx ON public.carts USING btree (merged_from_cart_id) WHERE (merged_from_cart_id IS NOT NULL);
CREATE INDEX carts_active_recent_idx ON public.carts USING btree (updated_at DESC) WHERE (merged_at IS NULL);
CREATE UNIQUE INDEX carts_user_unique ON public.carts USING btree (user_id) WHERE (user_id IS NOT NULL);
CREATE INDEX cart_items_product_idx ON public.cart_items USING btree (product_id);
CREATE INDEX blog_posts_active_recent_idx ON public.blog_posts USING btree (is_published, published_at DESC NULLS LAST) WHERE (deleted_at IS NULL);
CREATE INDEX blog_posts_search_gin ON public.blog_posts USING gin (search_vector) WHERE ((deleted_at IS NULL) AND (is_published = true));
CREATE INDEX blog_posts_title_trgm ON public.blog_posts USING gin (title gin_trgm_ops) WHERE (deleted_at IS NULL);
CREATE INDEX blog_posts_featured_image_media_id_idx ON public.blog_posts USING btree (featured_image_media_id) WHERE (featured_image_media_id IS NOT NULL);
CREATE INDEX blog_posts_category_recent_idx ON public.blog_posts USING btree (category_id, is_published, published_at DESC NULLS LAST) WHERE (deleted_at IS NULL);
CREATE INDEX nav_items_menu_visible_order_idx ON public.nav_items USING btree (menu_id, display_order) WHERE (is_visible = true);
CREATE INDEX nav_items_parent_order_idx ON public.nav_items USING btree (parent_id, display_order);
CREATE INDEX brands_search_gin ON public.brands USING gin (search_vector) WHERE ((deleted_at IS NULL) AND (is_active = true));
CREATE INDEX brands_name_trgm ON public.brands USING gin (name gin_trgm_ops) WHERE (deleted_at IS NULL);
CREATE INDEX brands_logo_media_id_idx ON public.brands USING btree (logo_media_id) WHERE (logo_media_id IS NOT NULL);
CREATE INDEX brands_hero_media_id_idx ON public.brands USING btree (hero_media_id) WHERE (hero_media_id IS NOT NULL);
CREATE INDEX pm_product_primary_idx ON public.product_media USING btree (product_id, is_primary DESC, display_order);
CREATE INDEX pages_published_slug_idx ON public.pages USING btree (slug) WHERE ((is_published = true) AND (deleted_at IS NULL));
CREATE INDEX pages_recent_idx ON public.pages USING btree (updated_at DESC) WHERE (deleted_at IS NULL);
CREATE INDEX pages_search_gin ON public.pages USING gin (search_vector) WHERE ((deleted_at IS NULL) AND (is_published = true));
CREATE INDEX pages_title_trgm ON public.pages USING gin (title gin_trgm_ops) WHERE (deleted_at IS NULL);
CREATE INDEX pages_og_image_media_id_idx ON public.pages USING btree (og_image_media_id) WHERE (og_image_media_id IS NOT NULL);
CREATE INDEX page_sections_page_visible_order_idx ON public.page_sections USING btree (page_id, display_order) WHERE (is_visible = true);
CREATE INDEX hero_sections_image_media_id_idx ON public.hero_sections USING btree (image_media_id) WHERE (image_media_id IS NOT NULL);
CREATE INDEX cta_sections_background_image_media_id_idx ON public.cta_sections USING btree (background_image_media_id) WHERE (background_image_media_id IS NOT NULL);
CREATE INDEX categories_search_gin ON public.categories USING gin (search_vector) WHERE ((deleted_at IS NULL) AND (is_active = true));
CREATE INDEX categories_name_trgm ON public.categories USING gin (name gin_trgm_ops) WHERE (deleted_at IS NULL);
CREATE INDEX categories_hero_media_id_idx ON public.categories USING btree (hero_media_id) WHERE (hero_media_id IS NOT NULL);
CREATE INDEX categories_active_parent_order_idx ON public.categories USING btree (parent_id, display_order, name) WHERE ((deleted_at IS NULL) AND (is_active = true));
CREATE UNIQUE INDEX addresses_one_default_shipping ON public.addresses USING btree (customer_profile_id) WHERE (is_default_shipping AND (deleted_at IS NULL));
CREATE UNIQUE INDEX addresses_one_default_billing ON public.addresses USING btree (customer_profile_id) WHERE (is_default_billing AND (deleted_at IS NULL));
CREATE UNIQUE INDEX digital_assets_key_uniq ON public.digital_assets USING btree (product_id, value) WHERE ((asset_type = 'key'::digital_asset_type) AND (deleted_at IS NULL));

-- CHECK + UNIQUE constraints (enforced)
ALTER TABLE categories ADD CONSTRAINT categories_tax_rate_bps_range CHECK (((tax_rate_bps >= 0) AND (tax_rate_bps <= 10000)));
ALTER TABLE coin_levels ADD CONSTRAINT coin_levels_earn_multiplier_bps_chk CHECK (((earn_multiplier_bps IS NULL) OR ((earn_multiplier_bps > 0) AND (earn_multiplier_bps <= 50000))));
ALTER TABLE coin_levels ADD CONSTRAINT coin_levels_flat_discount_pct_chk CHECK (((flat_discount_pct IS NULL) OR ((flat_discount_pct >= 0) AND (flat_discount_pct <= 100))));
ALTER TABLE coin_levels ADD CONSTRAINT coin_levels_free_shipping_threshold_cents_chk CHECK (((free_shipping_threshold_cents IS NULL) OR (free_shipping_threshold_cents >= 0)));
ALTER TABLE coin_levels ADD CONSTRAINT coin_levels_max_redeem_pct_chk CHECK (((max_redeem_pct IS NULL) OR ((max_redeem_pct > 0) AND (max_redeem_pct <= 100))));
ALTER TABLE coin_levels ADD CONSTRAINT coin_levels_threshold_coins_nonneg_chk CHECK ((threshold_coins >= 0));
ALTER TABLE coin_transactions ADD CONSTRAINT coin_transactions_balance_after_nonneg CHECK ((balance_after >= 0));
ALTER TABLE coin_transactions ADD CONSTRAINT coin_transactions_kind_chk CHECK ((kind = ANY (ARRAY['earn'::text, 'redeem'::text, 'adjust'::text, 'revert'::text])));
ALTER TABLE coin_transactions ADD CONSTRAINT coin_transactions_points_sign_chk CHECK ((((kind <> 'earn'::text) OR (points >= 0)) AND ((kind <> 'redeem'::text) OR (points <= 0))));
ALTER TABLE customer_profiles ADD CONSTRAINT customer_profiles_loyalty_points_nonneg CHECK ((loyalty_points >= 0));
ALTER TABLE faqs ADD CONSTRAINT faqs_scope_target_chk CHECK ((((product_id IS NOT NULL) AND (category_id IS NULL)) OR ((category_id IS NOT NULL) AND (product_id IS NULL)) OR ((product_id IS NULL) AND (category_id IS NULL))));
ALTER TABLE media_settings ADD CONSTRAINT media_settings_singleton CHECK ((id = '00000000-0000-0000-0000-000000000001'::uuid));
ALTER TABLE orders ADD CONSTRAINT orders_coins_discount_cents_nonneg_chk CHECK ((coins_discount_cents >= 0));
ALTER TABLE orders ADD CONSTRAINT orders_coins_points_spent_nonneg_chk CHECK ((coins_points_spent >= 0));
ALTER TABLE product_attributes ADD CONSTRAINT product_attributes_slug_key UNIQUE (slug);
ALTER TABLE product_reviews ADD CONSTRAINT product_reviews_rating_range CHECK (((rating >= 1) AND (rating <= 5)));
ALTER TABLE product_reviews ADD CONSTRAINT product_reviews_status_valid CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE product_variants ADD CONSTRAINT product_variants_old_price_cents_nonneg CHECK ((old_price_cents >= 0));
ALTER TABLE product_variants ADD CONSTRAINT product_variants_price_cents_nonneg CHECK ((price_cents >= 0));
ALTER TABLE product_variants ADD CONSTRAINT product_variants_stock_qty_nonneg CHECK ((stock_qty >= 0));
ALTER TABLE products ADD CONSTRAINT products_old_price_cents_nonneg CHECK ((old_price_cents >= 0));
ALTER TABLE products ADD CONSTRAINT products_price_cents_nonneg CHECK ((price_cents >= 0));
ALTER TABLE products ADD CONSTRAINT products_stock_qty_nonneg CHECK ((stock_qty >= 0));
ALTER TABLE products ADD CONSTRAINT products_tax_rate_bps_range CHECK (((tax_rate_bps >= 0) AND (tax_rate_bps <= 10000)));
ALTER TABLE tax_rules ADD CONSTRAINT tax_rules_rate_bps_range CHECK (((rate_bps >= 0) AND (rate_bps <= 100000)));

-- FOREIGN KEYs (enforced; CASCADE / SET NULL per module)
ALTER TABLE addresses ADD CONSTRAINT addresses_customer_profile_id_fkey FOREIGN KEY (customer_profile_id) REFERENCES customer_profiles(id) ON DELETE CASCADE;
ALTER TABLE blog_post_tags ADD CONSTRAINT blog_post_tags_post_id_fkey FOREIGN KEY (post_id) REFERENCES blog_posts(id) ON DELETE CASCADE;
ALTER TABLE blog_post_tags ADD CONSTRAINT blog_post_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES blog_tags(id) ON DELETE CASCADE;
ALTER TABLE cart_items ADD CONSTRAINT cart_items_cart_id_fkey FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE CASCADE;
ALTER TABLE categories ADD CONSTRAINT categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE category_attribute_filters ADD CONSTRAINT category_attribute_filters_attribute_id_fkey FOREIGN KEY (attribute_id) REFERENCES product_attributes(id) ON DELETE CASCADE;
ALTER TABLE category_attribute_filters ADD CONSTRAINT category_attribute_filters_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE;
ALTER TABLE coin_transactions ADD CONSTRAINT coin_transactions_order_id_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE coin_transactions ADD CONSTRAINT coin_transactions_user_id_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE cta_sections ADD CONSTRAINT cta_sections_page_section_id_fkey FOREIGN KEY (page_section_id) REFERENCES page_sections(id) ON DELETE CASCADE;
ALTER TABLE digital_assets ADD CONSTRAINT digital_assets_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE hero_sections ADD CONSTRAINT hero_sections_page_section_id_fkey FOREIGN KEY (page_section_id) REFERENCES page_sections(id) ON DELETE CASCADE;
ALTER TABLE nav_items ADD CONSTRAINT nav_items_menu_id_fkey FOREIGN KEY (menu_id) REFERENCES nav_menus(id) ON DELETE CASCADE;
ALTER TABLE nav_items ADD CONSTRAINT nav_items_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES nav_items(id) ON DELETE SET NULL;
ALTER TABLE order_items ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
ALTER TABLE order_refunds ADD CONSTRAINT order_refunds_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
ALTER TABLE order_status_history ADD CONSTRAINT order_status_history_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
ALTER TABLE orders ADD CONSTRAINT orders_delivery_agent_id_fkey FOREIGN KEY (delivery_agent_id) REFERENCES delivery_agents(id) ON DELETE SET NULL;
ALTER TABLE orders ADD CONSTRAINT orders_pickup_location_id_fkey FOREIGN KEY (pickup_location_id) REFERENCES pickup_locations(id) ON DELETE SET NULL;
ALTER TABLE page_sections ADD CONSTRAINT page_sections_page_id_fkey FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE;
ALTER TABLE product_attribute_assignments ADD CONSTRAINT product_attribute_assignments_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE product_attribute_assignments ADD CONSTRAINT product_attribute_assignments_value_id_fkey FOREIGN KEY (attribute_value_id) REFERENCES product_attribute_values(id) ON DELETE CASCADE;
ALTER TABLE product_attribute_values ADD CONSTRAINT product_attribute_values_attribute_id_fkey FOREIGN KEY (attribute_id) REFERENCES product_attributes(id) ON DELETE CASCADE;
ALTER TABLE product_brands ADD CONSTRAINT product_brands_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE;
ALTER TABLE product_brands ADD CONSTRAINT product_brands_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE product_categories ADD CONSTRAINT product_categories_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE;
ALTER TABLE product_categories ADD CONSTRAINT product_categories_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE product_highlights ADD CONSTRAINT product_highlights_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE product_media ADD CONSTRAINT product_media_media_id_fkey FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE;
ALTER TABLE product_media ADD CONSTRAINT product_media_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE product_reviews ADD CONSTRAINT product_reviews_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE product_variant_values ADD CONSTRAINT product_variant_values_attribute_value_id_fkey FOREIGN KEY (attribute_value_id) REFERENCES product_attribute_values(id) ON DELETE CASCADE;
ALTER TABLE product_variant_values ADD CONSTRAINT product_variant_values_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE;
ALTER TABLE product_variants ADD CONSTRAINT product_variants_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE promotion_redemptions ADD CONSTRAINT promotion_redemptions_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
ALTER TABLE promotion_redemptions ADD CONSTRAINT promotion_redemptions_promotion_fk FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE CASCADE;
ALTER TABLE promotion_redemptions ADD CONSTRAINT promotion_redemptions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE showcase_pins ADD CONSTRAINT showcase_pins_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE stats_section_items ADD CONSTRAINT stats_section_items_parent_fkey FOREIGN KEY (stats_section_id) REFERENCES stats_sections(page_section_id) ON DELETE CASCADE;
ALTER TABLE stats_sections ADD CONSTRAINT stats_sections_page_section_id_fkey FOREIGN KEY (page_section_id) REFERENCES page_sections(id) ON DELETE CASCADE;
ALTER TABLE tax_rules ADD CONSTRAINT tax_rules_attribute_value_id_fkey FOREIGN KEY (attribute_value_id) REFERENCES product_attribute_values(id) ON DELETE CASCADE;
ALTER TABLE text_sections ADD CONSTRAINT text_sections_page_section_id_fkey FOREIGN KEY (page_section_id) REFERENCES page_sections(id) ON DELETE CASCADE;
ALTER TABLE timeline_section_items ADD CONSTRAINT timeline_section_items_parent_fkey FOREIGN KEY (timeline_section_id) REFERENCES timeline_sections(page_section_id) ON DELETE CASCADE;
ALTER TABLE timeline_sections ADD CONSTRAINT timeline_sections_page_section_id_fkey FOREIGN KEY (page_section_id) REFERENCES page_sections(id) ON DELETE CASCADE;
ALTER TABLE wishlist_items ADD CONSTRAINT wishlist_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE wishlist_items ADD CONSTRAINT wishlist_items_wishlist_id_fkey FOREIGN KEY (wishlist_id) REFERENCES wishlists(id) ON DELETE CASCADE;

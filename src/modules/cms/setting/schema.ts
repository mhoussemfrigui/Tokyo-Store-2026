import { integer, pgEnum, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Site settings — typed key/value store.
 *
 * The `type` column tells the admin form how to render the editor and the
 * server how to parse the value:
 *   - text  : free-form string
 *   - number: integer parsed at read time
 *   - boolean: "true"/"false"
 *   - media : a media row id (foreign-key-soft to media.id)
 *
 * Grouped by `group_key` so the admin panel can render related settings
 * together (e.g. "shipping", "contact", "social", "checkout").
 */

export const settingTypeEnum = pgEnum("setting_type", ["text", "number", "boolean", "media"]);

export const site_settings = pgTable(
  "site_settings",
  {
    id: id(),
    key: text("key").notNull(),
    value: text("value"),
    type: settingTypeEnum("type").notNull().default("text"),
    group_key: text("group_key").notNull().default("general"),
    label: text("label").notNull(),
    description: text("description"),
    display_order: integer("display_order").notNull().default(0),
    ...timestamps(),
  },
  (table) => ({
    keyUnique: uniqueIndex("settings_key_unique").on(table.key),
    // (group_key is not queried — getSettingsMap reads the whole table and panels
    //  narrow by key prefix — so no group index; see migration 0181.)
  }),
);

export type SiteSettingRow = typeof site_settings.$inferSelect;
export type NewSiteSettingRow = typeof site_settings.$inferInsert;
export type SettingType = (typeof settingTypeEnum.enumValues)[number];

/**
 * CMS parent barrel.
 *
 * The CMS domain covers six independent surfaces — banner, faq,
 * navigation, page, setting, trust_badge — each shaped per the
 * canonical pattern in `docs/modules.md`. Re-exporting them here means
 * consumers can do:
 *
 *   import {
 *     bannerQueries,
 *     pageQueries,
 *     settingQueries,
 *   } from "@/modules/cms";
 *
 * Or reach for a single sub-module directly:
 *
 *   import { bannerQueries } from "@/modules/cms/banner";
 *
 * Both work; pick whichever keeps the importing file's intent clearest.
 *
 * Sub-module services are intentionally NOT re-exported — services stay
 * internal per the "workflows orchestrate; services hide" rule.
 */

export * from "./banner";
export * from "./faq";
export * from "./navigation";
export * from "./page";
export * from "./setting";
export * from "./trust_badge";

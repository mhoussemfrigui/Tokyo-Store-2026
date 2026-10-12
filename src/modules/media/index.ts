/**
 * Media module — public surface.
 *
 * Per the module-boundary pattern (see docs/modules.md), `index.ts` is the
 * ONLY file other modules / app code may import from. Workflows are still
 * allowed to reach for `service.ts` and `settings.service.ts` because they
 * own the orchestration layer; nothing else should bypass this barrel.
 *
 * Public reads        → mediaQueries.*
 * Settings (read-only consumers, e.g. storefront `<picture>` resolver):
 *                       mediaSettingsService.get()
 * Public DTOs         → MediaRow, MediaSettingsRow
 */

// Read-side helpers
export * as mediaQueries from "./queries";
export {
  resolveMediaUrl,
  resolveMediaThumbUrl,
  resolveMediaSocialUrl,
  resolveMediaAlt,
} from "./url-resolver";
export type { ResolvedMedia } from "./queries";

// Singleton settings service — read access for storefront resolvers,
// write access is mediated by workflows.media.updateSettings only.
export { mediaSettingsService } from "./settings.service";

// Public DTOs
export type { MediaRow } from "./schema";
export type { MediaSettingsRow } from "./settings.schema";

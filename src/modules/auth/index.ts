/**
 * Auth module — public surface.
 *
 * Other modules MUST NOT import service.ts or schema.ts directly.
 * Use queries (reads) or call workflows (writes).
 */

export * as authQueries from "./queries";
export type { AuthUser } from "./types";
export { toAuthUser } from "./types";

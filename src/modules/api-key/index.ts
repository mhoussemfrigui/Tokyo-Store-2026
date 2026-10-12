/**
 * API access keys — public surface.
 *
 *   Reads/Writes → apiKeyService.* (create / list / revoke / auth lookup)
 *   Request guard → src/lib/api-auth/require-api-key.ts
 *   Scope model   → src/lib/api-auth/scopes.ts
 */
export { apiKeyService } from "./service";
export { api_keys, type ApiKeyRow } from "./schema";

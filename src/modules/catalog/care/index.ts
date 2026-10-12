// Barrel surface: the select-row types. Consumers of the service import it
// directly from "./service"; active plans are read via careService.list (the
// storefront renders from the exported JSON snapshot, not a live query).
export type { CarePlanRow, CarePlanScopeTargetRow } from "./schema";

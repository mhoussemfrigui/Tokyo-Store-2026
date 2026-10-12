import { CUSTOMER_EXPORT_FIELDS } from "./customer-fields";

/**
 * Client-safe column catalog for the per-segment member CSV export. A segment member
 * IS a customer, so the exportable columns are the customer catalog — aliased under a
 * segment-scoped name so the per-segment export UI + route reference their own symbol
 * (and can diverge later, e.g. a manual-segment « membre depuis » column, without
 * touching the Clients export).
 */
export const SEGMENT_MEMBER_FIELDS = CUSTOMER_EXPORT_FIELDS;
export type SegmentMemberFieldKey = (typeof SEGMENT_MEMBER_FIELDS)[number]["key"];

export { searchService } from "./service";
export type { SearchOpts, SearchResultPage, SearchKind } from "./service";
export type {
  SearchHit,
  SearchHitKind,
  ProductSearchHit,
  SearchAnalyticsRow,
  SearchOverviewStats,
} from "./queries";
export type { SearchLogRow, NewSearchLogRow, SearchAliasRow, NewSearchAliasRow } from "./schema";
export { expandSearchQuery, MAX_QUERY_EXPANSIONS, type SearchAlias } from "./aliases";
export { DEFAULT_SEARCH_ALIASES } from "./default-aliases";

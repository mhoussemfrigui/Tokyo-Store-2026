/**
 * Safety ceiling for the CMS admin list queries (banners, trust-badges,
 * pages). These surfaces hold hand-curated content —
 * realistically dozens of rows — but the admin pages load the whole list with
 * no pagination, so an unbounded `SELECT` would pull the entire table into
 * memory on every view if the count ever ran away. This is a guard rail, NOT
 * pagination: set generously above any plausible real count. If a surface ever
 * legitimately approaches it, that's the signal to add real keyset pagination
 * (the pattern blog/aid posts already use).
 */
export const CMS_LIST_CAP = 1000;

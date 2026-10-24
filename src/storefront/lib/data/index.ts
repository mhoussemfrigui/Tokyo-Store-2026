import type { CatalogSource } from "./source";
import { liveSource } from "./live-source";

export type { CatalogSource } from "./source";

/**
 * The active catalog source. Reads the live backend DB (`liveSource`) so the
 * storefront catalogue — category listings, search-hit resolution, PDP cards,
 * cart resolution, the default home and the vitrines — reflects admin edits with
 * no `tokyo-export-catalog` re-export. (The former bundled `products.json`
 * snapshot behind this seam was retired: it froze the catalogue at export time
 * and its product ids drifted from a re-imported DB, breaking search.)
 */
export const catalogSource: CatalogSource = liveSource;

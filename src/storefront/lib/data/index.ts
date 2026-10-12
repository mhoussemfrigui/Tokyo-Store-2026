import { createHttpSource } from "./http-source";
import type { CatalogSource } from "./source";
import { staticSource } from "./static-source";

export type { CatalogSource } from "./source";

/**
 * The active catalog source. Defaults to the bundled static JSON so the app runs
 * and deploys with zero backend. Set `NEXT_PUBLIC_DATA_SOURCE=http` (+
 * `NEXT_PUBLIC_API_URL`) to switch to the real backend once `http-source` is
 * implemented — a redeploy-time flip, no code change.
 */
const useHttp =
  process.env.NEXT_PUBLIC_DATA_SOURCE === "http" && !!process.env.NEXT_PUBLIC_API_URL;

export const catalogSource: CatalogSource = useHttp
  ? createHttpSource(process.env.NEXT_PUBLIC_API_URL as string)
  : staticSource;

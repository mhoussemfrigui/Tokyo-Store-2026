import { redirect } from "next/navigation";

/**
 * The Emplacements (stock locations) settings + CRUD moved INTO the Stock page
 * as its "Emplacements" sub-tab — locations are a stock parameter, not a
 * separate page. This route is kept only to redirect any old bookmark/link
 * straight onto that tab (StockTabs opens the tab named by `?tab=`).
 */
export default function StockLocationsRedirect() {
  redirect("/admin/catalog/stock?tab=emplacements");
}

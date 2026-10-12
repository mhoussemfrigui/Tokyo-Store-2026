import type { PermissionAction, PermissionModuleId } from "./registry";

/**
 * Which blocks of the admin dashboard (`/admin`) a user may see — PURE (no DB,
 * no session), so the gating matrix is unit-testable. The page resolves the
 * user's permission set once and passes `permissionSetAllows` bound to it.
 *
 * `/admin` itself stays reachable by ANY staff user (`requireAdminArea` — it is
 * the post-login landing, the logo target and the error-page « Retour »), so it
 * must never 404 a scoped delegate. What it SHOWS is gated here:
 *   - `dashboard:view` is the master switch — without it only a neutral welcome
 *     card renders (unticking « Tableau de bord » in the role editor now hides
 *     the data, not just the nav link);
 *   - each block additionally needs the `view` grant of the module whose data it
 *     summarises, exactly as that module's own page does — so the dashboard can
 *     never show a delegate data they're denied elsewhere:
 *       revenue / panier moyen KPIs + chart → `analytics:view`
 *       orders KPI, recent orders (customer emails), « À traiter », status
 *         breakdown, CSV export                → `orders:view`
 *       new-customer KPI                       → `customers:view`
 *       low-stock card                         → `stock:view` OR `products:view`
 *   - the header « Nouveau produit » button follows `products:create` (its page's
 *     own gate) and is independent of the master switch (an action, not data).
 * The page skips the QUERIES of a hidden block, not just its markup.
 */
export type DashboardAccess = {
  revenue: boolean;
  orders: boolean;
  customers: boolean;
  stock: boolean;
  /** « Tout voir » → /admin/catalog/stock?filter=low (that page needs stock:view). */
  stockPage: boolean;
  /** Low-stock rows link to the product editor (needs products:view). */
  productPages: boolean;
  createProduct: boolean;
  /** Pending-reviews moderation tile → /admin/catalog/reviews (needs reviews:view). */
  reviews: boolean;
  /** At least one data block is visible (else: the welcome card only). */
  any: boolean;
};

export function resolveDashboardAccess(
  allows: (module: PermissionModuleId, action: PermissionAction) => boolean,
): DashboardAccess {
  const dash = allows("dashboard", "view");
  const productsView = allows("products", "view");
  const stockView = allows("stock", "view");
  const revenue = dash && allows("analytics", "view");
  const orders = dash && allows("orders", "view");
  const customers = dash && allows("customers", "view");
  const stock = dash && (stockView || productsView);
  const reviews = dash && allows("reviews", "view");
  return {
    revenue,
    orders,
    customers,
    stock,
    stockPage: stock && stockView,
    productPages: stock && productsView,
    createProduct: allows("products", "create"),
    reviews,
    any: revenue || orders || customers || stock || reviews,
  };
}

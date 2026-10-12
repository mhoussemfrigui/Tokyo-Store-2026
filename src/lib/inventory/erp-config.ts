/**
 * ERP linkage config — PURE module (no server-only deps) so the client ERP panel
 * imports the keys and a server page resolves the values. Decides the STOCK sync
 * posture between the platform (website) and an external ERP:
 *
 *   - off       — no ERP. The platform owns everything (default).
 *   - platform  — the PLATFORM is authoritative; stock changes are PUSHED to the
 *                 ERP (outbound webhooks), the ERP just mirrors.
 *   - erp       — the ERP is authoritative ("ERP takes over"); the platform PULLS
 *                 (ERP writes via /api/stock win), the platform's own edits defer.
 *   - mixed     — the operator sets the axes independently (push and/or pull),
 *                 e.g. ERP owns levels but the platform still pushes its transfers.
 *
 * The `push`/`pull` axes are DERIVED from the mode for the three presets and read
 * from their own keys only in `mixed`, so a preset can't silently disagree with
 * itself. Enforcement of authority (who overwrites whom) is applied by the order
 * / sync paths (Phase 2); this module is the single source the tab + those paths
 * read.
 */

export const ERP_MODE_KEY = "erp.sync_mode";
export const ERP_PUSH_STOCK_KEY = "erp.push_stock";
export const ERP_PULL_STOCK_KEY = "erp.pull_stock";
export const ERP_PUSH_TRANSFERS_KEY = "erp.push_transfers";
// Warranty/SAV axes are MODE-INDEPENDENT own-key booleans (like transfers): the
// stock sync mode fixes only the STOCK push/pull, so coupling claim authority to it
// would overload the presets. A claims console pushes/pulls independently.
export const ERP_PUSH_WARRANTY_KEY = "erp.push_warranty";
export const ERP_PULL_WARRANTY_KEY = "erp.pull_warranty";

export type ErpMode = "off" | "platform" | "erp" | "mixed";

export const ERP_MODES: readonly ErpMode[] = ["off", "platform", "erp", "mixed"];

export type ErpConfig = {
  mode: ErpMode;
  /** Push platform stock changes OUT to the ERP (outbound webhooks). */
  pushStock: boolean;
  /** Accept the ERP as authoritative for stock (its /api/stock writes win). */
  pullStock: boolean;
  /** Emit an outbound webhook when a transfer completes. */
  pushTransfers: boolean;
  /** Emit an outbound webhook on a warranty-claim create / update / resolve. */
  pushWarranty: boolean;
  /** Accept the ERP as authoritative for claim status (its PATCH writes win). */
  pullWarranty: boolean;
};

function asMode(raw: string | null | undefined): ErpMode {
  return (ERP_MODES as readonly string[]).includes(raw ?? "") ? (raw as ErpMode) : "off";
}

/** Resolve the ERP config from a settings map, with safe defaults. */
export function resolveErpConfig(settings: Record<string, string | null>): ErpConfig {
  const mode = asMode(settings[ERP_MODE_KEY]);
  // push/pull are fixed by the three presets; only `mixed` reads its own keys.
  const preset: Record<Exclude<ErpMode, "mixed">, { push: boolean; pull: boolean }> = {
    off: { push: false, pull: false },
    platform: { push: true, pull: false },
    erp: { push: false, pull: true },
  };
  const axes =
    mode === "mixed"
      ? {
          push: settings[ERP_PUSH_STOCK_KEY] === "true",
          pull: settings[ERP_PULL_STOCK_KEY] === "true",
        }
      : preset[mode];
  return {
    mode,
    pushStock: axes.push,
    pullStock: axes.pull,
    pushTransfers: settings[ERP_PUSH_TRANSFERS_KEY] === "true",
    pushWarranty: settings[ERP_PUSH_WARRANTY_KEY] === "true",
    pullWarranty: settings[ERP_PULL_WARRANTY_KEY] === "true",
  };
}

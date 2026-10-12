/**
 * Payment-gateway completeness invariant — NO database, NO network.
 *
 * Guards the class of bug that strands paid orders: a gateway listed in
 * `ONLINE_METHODS` (src/lib/payments/shared.ts) MUST have, end to end:
 *   1. a provider CLIENT module (src/lib/payments/providers/<method>.ts) that
 *      exports BOTH `initiatePayment` and `verifyPayment` — without verify, a
 *      paid order can never be confirmed;
 *   2. a WEBHOOK route on disk (src/app/api/webhooks/<method>/route.ts) with
 *      GET + POST handlers — without it, settlement falls back to the slow cron
 *      reconcile (the ClicToPay regression this whole hardening pass fixed);
 *   3. that webhook registered in the route catalog (route-catalog.ts) as BOTH
 *      `webhooks.<method>` (POST) and `webhooks.<method>.get` (GET), so the
 *      route-inventory invariant covers it and it never silently drifts.
 *
 * Also pins the admin « Paiement » save rules (`@/lib/payments/settings-plan`):
 * merchant credentials + the ClicToPay sandbox flag are super-admin only (a
 * delegate could otherwise divert payments to their own merchant account), and
 * a gateway is enabled only when EVERY credential resolves — an unreadable row
 * keeps the stored enable flag instead of switching the gateway off.
 *
 * Pure file/text scan + catalog lookup, so it runs anywhere (no DB).
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/payment-gateway-completeness.test.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { ONLINE_METHODS, providerSupportsTestMode } from "@/lib/payments/shared";
import {
  PAYMENT_CREDENTIAL_PROVIDERS,
  PAYMENT_OWNER_ONLY_MESSAGE,
  decideGatewayEnable,
  planPaymentSettingsSave,
  snapshotStoredProvider,
} from "@/lib/payments/settings-plan";
import { routeById } from "@/lib/api-auth/route-catalog";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const ROOT = process.cwd();
const PROVIDERS_DIR = join(ROOT, "src", "lib", "payments", "providers");
const WEBHOOKS_DIR = join(ROOT, "src", "app", "api", "webhooks");
// `export async function initiatePayment`, `export const verifyPayment = …`, etc.
const exportRe = (name: string) =>
  new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`);
const methodRe = (m: string) =>
  new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${m}\\b`);

check("ONLINE_METHODS is non-empty", ONLINE_METHODS.length > 0);

for (const method of ONLINE_METHODS) {
  // 1) provider client with both lifecycle exports.
  const providerFile = join(PROVIDERS_DIR, `${method}.ts`);
  const hasProviderFile = existsSync(providerFile);
  check(`[${method}] provider client exists (providers/${method}.ts)`, hasProviderFile);
  if (hasProviderFile) {
    const src = readFileSync(providerFile, "utf8");
    check(`[${method}] provider exports initiatePayment`, exportRe("initiatePayment").test(src));
    check(`[${method}] provider exports verifyPayment`, exportRe("verifyPayment").test(src));

    // test_mode capability MUST match reality: a provider that declares it
    // supports a sandbox toggle (providerSupportsTestMode) has to actually read
    // `testMode` in its client; one that doesn't must NOT — else the admin UI
    // shows a sandbox toggle/pill that charges real cards (the Flouci bug), or
    // hides one that really does switch environments. `\btestMode\b` matches the
    // resolved-config field (`c.testMode`); comments are stripped first so a
    // mere mention doesn't count.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const usesTestMode = /\btestMode\b/.test(code);
    check(
      `[${method}] providerSupportsTestMode (${providerSupportsTestMode(method)}) matches client use of testMode (${usesTestMode})`,
      providerSupportsTestMode(method) === usesTestMode,
    );
  }

  // 2) webhook route on disk with GET + POST.
  const webhookFile = join(WEBHOOKS_DIR, method, "route.ts");
  const hasWebhookFile = existsSync(webhookFile);
  check(`[${method}] webhook route exists (api/webhooks/${method}/route.ts)`, hasWebhookFile);
  if (hasWebhookFile) {
    const src = readFileSync(webhookFile, "utf8");
    check(`[${method}] webhook handler exports POST`, methodRe("POST").test(src));
    check(`[${method}] webhook handler exports GET`, methodRe("GET").test(src));
  }

  // 3) webhook registered in the route catalog (POST + GET ids).
  check(`[${method}] catalog has webhooks.${method} (POST)`, !!routeById(`webhooks.${method}`));
  check(`[${method}] catalog has webhooks.${method}.get (GET)`, !!routeById(`webhooks.${method}.get`));
}

// ── Admin « Paiement » save rules (lib/payments/settings-plan) ──────────────
// 4) every online gateway has a credentials definition on the admin page.
for (const method of ONLINE_METHODS) {
  const def = PAYMENT_CREDENTIAL_PROVIDERS.find((p) => p.provider === method);
  check(`[${method}] admin credential definition exists`, !!def && def.fields.length > 0);
}

const CTP = PAYMENT_CREDENTIAL_PROVIDERS.find((p) => p.provider === "clictopay")!;
const noEnv = () => false;
const form = (entries: Record<string, string>) => (name: string) => entries[name] ?? null;
const storedCtp = (testMode: boolean, has: Record<string, boolean>) => ({ testMode, hasField: has });
const basePlanOpts = {
  envLocked: noEnv,
  supportsTestMode: providerSupportsTestMode,
  stored: {
    clictopay: storedCtp(true, { username: true, password: true }),
    flouci: storedCtp(true, { app_token: false, app_secret: false }),
  },
};

// 5) Owner gate: credentials + sandbox are super-admin only.
{
  const typed = form({ "secret.clictopay.username": "attacker-merchant" });
  const owner = planPaymentSettingsSave(typed, { ...basePlanOpts, canEditCredentials: true });
  check(
    "owner: a typed ClicToPay userName is planned for encryption",
    owner.ok && owner.providers.find((p) => p.def.provider === "clictopay")?.secrets.username === "attacker-merchant",
  );
  const delegate = planPaymentSettingsSave(typed, { ...basePlanOpts, canEditCredentials: false });
  check(
    "non-owner: a typed merchant credential is refused whole (forbidden, owner-only message)",
    !delegate.ok && delegate.error === "forbidden" && delegate.message === PAYMENT_OWNER_ONLY_MESSAGE,
  );
  const flouciSecret = planPaymentSettingsSave(form({ "secret.flouci.app_secret": "x" }), {
    ...basePlanOpts,
    canEditCredentials: false,
  });
  check("non-owner: a typed Flouci secret is refused too", !flouciSecret.ok);

  // Sandbox: a delegate's toggle is disabled (posts nothing) → keep the stored value.
  const routine = planPaymentSettingsSave(
    form({ "checkout.payment.clictopay_enabled": "on", "checkout.quick.cod_label": "Espèces" }),
    { ...basePlanOpts, canEditCredentials: false },
  );
  const routineCtp = routine.ok ? routine.providers.find((p) => p.def.provider === "clictopay") : undefined;
  check(
    "non-owner routine save (enable flag only) is allowed, keeps sandbox + secrets",
    routine.ok && !!routineCtp && routineCtp.testMode === undefined &&
      Object.keys(routineCtp.secrets).length === 0 && routineCtp.enableRequested === true,
  );
  const flipToSandbox = planPaymentSettingsSave(form({ "test_mode.clictopay": "on" }), {
    ...basePlanOpts,
    stored: { ...basePlanOpts.stored, clictopay: storedCtp(false, { username: true, password: true }) },
    canEditCredentials: false,
  });
  check("non-owner: flipping ClicToPay production → sandbox is refused", !flipToSandbox.ok);
  const sameSandbox = planPaymentSettingsSave(form({ "test_mode.clictopay": "on" }), {
    ...basePlanOpts,
    canEditCredentials: false,
  });
  check(
    "non-owner: a posted sandbox value EQUAL to the stored one is a no-op (kept)",
    sameSandbox.ok && sameSandbox.providers.find((p) => p.def.provider === "clictopay")?.testMode === undefined,
  );
  const unreadable = planPaymentSettingsSave(form({ "test_mode.clictopay": "on" }), {
    ...basePlanOpts,
    stored: { ...basePlanOpts.stored, clictopay: null },
    canEditCredentials: false,
  });
  check("non-owner: a posted sandbox value is refused when the stored row is unreadable", !unreadable.ok);

  // Owner: unticked box = production; env-locked sandbox = untouched.
  const ownerProd = planPaymentSettingsSave(form({}), { ...basePlanOpts, canEditCredentials: true });
  check(
    "owner: an unticked sandbox box plans test_mode=false",
    ownerProd.ok && ownerProd.providers.find((p) => p.def.provider === "clictopay")?.testMode === false,
  );
  const envLockedSandbox = planPaymentSettingsSave(form({}), {
    ...basePlanOpts,
    envLocked: (v: string) => v === "CLICTOPAY_TEST_MODE",
    canEditCredentials: true,
  });
  check(
    "owner: an env-locked sandbox flag is never written",
    envLockedSandbox.ok &&
      envLockedSandbox.providers.find((p) => p.def.provider === "clictopay")?.testMode === undefined,
  );
}

// 6) Enable guard: EVERY required credential must resolve (.every, not .some).
{
  const onlyUser = decideGatewayEnable({
    def: CTP,
    requested: true,
    envLocked: noEnv,
    saved: { username: "u" },
    stored: storedCtp(true, { username: false, password: false }),
  });
  check(
    "enable with only ClicToPay userName → NOT enabled + explicit error (no silent false)",
    onlyUser.write && onlyUser.value === false && /incomplets/.test(onlyUser.error ?? ""),
  );
  const savedPlusStored = decideGatewayEnable({
    def: CTP,
    requested: true,
    envLocked: noEnv,
    saved: { username: "u" },
    stored: storedCtp(true, { username: false, password: true }),
  });
  check("typed userName + stored password → enabled", savedPlusStored.write && savedPlusStored.value === true);
  const envBoth = decideGatewayEnable({
    def: CTP,
    requested: true,
    envLocked: (v) => v === "CLICTOPAY_USERNAME" || v === "CLICTOPAY_PASSWORD",
    saved: {},
    stored: null,
  });
  check("both credentials env-locked → enabled even if the row is unreadable", envBoth.write && envBoth.value === true);
  const unreadableRow = decideGatewayEnable({
    def: CTP,
    requested: true,
    envLocked: noEnv,
    saved: {},
    stored: null,
  });
  check(
    "unreadable credentials row → stored enable flag KEPT (no write) + error",
    !unreadableRow.write && unreadableRow.error.length > 0,
  );
  const disable = decideGatewayEnable({ def: CTP, requested: false, envLocked: noEnv, saved: {}, stored: null });
  check("disabling never needs credentials (written false, no error)", disable.write && disable.value === false && !disable.error);
  check(
    "snapshotStoredProvider: no row → sandbox default ON, nothing stored",
    (() => {
      const s = snapshotStoredProvider(CTP, null);
      return s.testMode === true && !s.hasField.username && !s.hasField.password;
    })(),
  );
  check(
    "snapshotStoredProvider: reads *_enc presence + test_mode",
    (() => {
      const s = snapshotStoredProvider(CTP, { test_mode: false, username_enc: "c1", password_enc: null });
      return s.testMode === false && s.hasField.username === true && s.hasField.password === false;
    })(),
  );
}

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);

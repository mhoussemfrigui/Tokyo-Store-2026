import "server-only";

/**
 * Gateway payment hardening (A–Z 09-23, checkout-06/07/10/11/19). Two parts:
 *
 *   RULES — the PURE rules in src/lib/payments/gateway-rules.ts: the live-session
 *           window behind the cancel guard, the ClicToPay ≤ 32-char orderNumber,
 *           the gateway-return purchase-tracking predicate, the fetch-timeout
 *           error mapping (incl. the runtime's real AbortSignal.timeout reason).
 *   FLOW  — the real workflows against inserted orders, with `fetch` stubbed for
 *           the Flouci API (NO network; the env creds are fakes):
 *     GUARD  — a gateway `pending` on a session re-initiated < 30 min ago REFUSES
 *              a cancel (`payment_in_progress`); an expired session / a definitive
 *              decline allows it; an unreadable / timed-out verify fails closed.
 *     RESUME — re-init verifies the EXISTING session first: paid → settled +
 *              `already_paid` (reference NOT overwritten); a mismatch / an
 *              unreachable gateway refuses (reference kept); pending re-inits;
 *              the first init (no reference) never verifies.
 *     LATE   — a capture landing on a CANCELLED order is detected (webhook +
 *              direct probe); an order settled before its cancel is skipped.
 *     SIGNAL — every provider fetch carries an AbortSignal (the 10 s timeout).
 * Self-cleaning (`__payhard…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/payments-hardening.test.ts
 */
import {
  CLICTOPAY_ORDER_NUMBER_MAX,
  GATEWAY_HTTP_TIMEOUT_MS,
  GATEWAY_SESSION_WINDOW_MS,
  clictopayOrderNumber,
  gatewayFetchErrorMessage,
  isGatewaySessionPossiblyLive,
  shouldTrackGatewayReturnPurchase,
} from "@/lib/payments/gateway-rules";

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

const TAG = "__payhard";
const MIN = 60_000;

// ── Flouci API stub ───────────────────────────────────────────────────────────
type VerifyState = { status: string; amount?: number } | "http502" | "timeout";
let verifyState: VerifyState = { status: "PENDING" };
let verifyCalls = 0;
let initCalls = 0;
let unsignedCalls = 0;
let seq = 0;
const realFetch = globalThis.fetch;

function installGatewayStub() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://developers.flouci.com/")) return realFetch(input, init);
    if (!(init?.signal instanceof AbortSignal)) unsignedCalls++;
    if (url.includes("/verify_payment/")) {
      verifyCalls++;
      if (verifyState === "http502") return new Response("bad gateway", { status: 502 });
      if (verifyState === "timeout") {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return Response.json({
        success: true,
        result: { status: verifyState.status, amount: verifyState.amount },
      });
    }
    if (url.endsWith("/generate_payment")) {
      initCalls++;
      const id = `${TAG}-pay-${++seq}-${Date.now()}`;
      return Response.json({ result: { success: true, link: `https://pay.example.test/${id}`, payment_id: id } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function rules() {
  const now = Date.parse("2026-09-23T12:00:00Z");

  // Timeout constant + error mapping.
  check("timeout: 10 s ceiling", GATEWAY_HTTP_TIMEOUT_MS === 10_000);
  const t = new DOMException("x", "TimeoutError");
  check(
    "timeout: a TimeoutError reads as a French timeout message",
    gatewayFetchErrorMessage("Flouci", t, "fb").includes("délai de réponse dépassé"),
  );
  check("timeout: other errors keep their message", gatewayFetchErrorMessage("Flouci", new Error("boom"), "fb") === "boom");
  check("timeout: non-Error → fallback", gatewayFetchErrorMessage("Flouci", "??", "fb") === "fb");

  // Live-session window (checkout-06).
  check("session: window is 30 min", GATEWAY_SESSION_WINDOW_MS === 30 * MIN);
  check("session: unknown timestamp → assumed live (fail closed)", isGatewaySessionPossiblyLive(null, now) === true);
  check("session: unparseable timestamp → assumed live", isGatewaySessionPossiblyLive("not-a-date", now) === true);
  check("session: re-initiated 5 min ago → live", isGatewaySessionPossiblyLive(new Date(now - 5 * MIN), now) === true);
  check("session: 29 min ago → still live", isGatewaySessionPossiblyLive(new Date(now - 29 * MIN), now) === true);
  check("session: 31 min ago → expired", isGatewaySessionPossiblyLive(new Date(now - 31 * MIN), now) === false);
  check(
    "session: ISO string input honoured",
    isGatewaySessionPossiblyLive(new Date(now - 2 * 60 * MIN).toISOString(), now) === false,
  );

  // ClicToPay orderNumber (checkout-11). Inputs here use the LEGACY long order
  // format (PREFIX-YYYYMMDD-XXXXXX) on purpose: those orders still exist and must
  // settle, and that 18-char form + a 13-digit ts lands exactly on the 32-char cap
  // — the tightest readable case. (New orders are the shorter CMD-XXXXXX form,
  // covered below, which stays comfortably under the cap.)
  const ts = 1_790_000_000_000; // 13 digits
  const tk = clictopayOrderNumber("TK-20260923-AB12CD", ts);
  check("ctp: an 18-char order number keeps its readable value", tk === `TK-20260923-AB12CD-${ts}`);
  check("ctp: that readable value is exactly 32", tk.length === 32);
  const shortNum = clictopayOrderNumber("CMD-7K9P2X", ts);
  check("ctp: new short CMD- order number stays readable", shortNum === `CMD-7K9P2X-${ts}`);
  const one = clictopayOrderNumber("T-20260923-AB12CD", ts);
  check("ctp: 1-char prefix unchanged (31)", one === `T-20260923-AB12CD-${ts}`);
  for (const prefix of ["TKO", "TOKY", "TOKYO"]) {
    const v = clictopayOrderNumber(`${prefix}-20260923-AB12CD`, ts);
    check(
      `ctp: ${prefix.length}-char prefix compacted to ≤ ${CLICTOPAY_ORDER_NUMBER_MAX}, alnum, ends with base36 ts`,
      v.length <= CLICTOPAY_ORDER_NUMBER_MAX && /^[A-Za-z0-9]+$/.test(v) && v.endsWith(ts.toString(36)),
    );
  }
  check(
    "ctp: re-init 1 ms later yields a different orderNumber (unique per init)",
    clictopayOrderNumber("TOKYO-20260923-AB12CD", ts) !== clictopayOrderNumber("TOKYO-20260923-AB12CD", ts + 1),
  );
  const long = clictopayOrderNumber("X".repeat(40), ts);
  check("ctp: pathological long number clamped to 32, unique tail kept", long.length === 32 && long.endsWith(ts.toString(36)));

  // Purchase tracking on the gateway return (checkout-10).
  const base = { orderStatus: "paid", paidAt: new Date(now - 2 * MIN), nowMs: now };
  check("track: this return settled it (`paid`) → fire", shouldTrackGatewayReturnPurchase({ ...base, settleStatus: "paid" }));
  check(
    "track: webhook settled it moments ago (`already`) → fire",
    shouldTrackGatewayReturnPurchase({ ...base, settleStatus: "already" }),
  );
  check(
    "track: `already` on an OLD settlement (replayed return URL) → no",
    !shouldTrackGatewayReturnPurchase({ ...base, settleStatus: "already", paidAt: new Date(now - 3 * 60 * MIN) }),
  );
  check(
    "track: `already` on a cancelled order → no",
    !shouldTrackGatewayReturnPurchase({ ...base, settleStatus: "already", orderStatus: "cancelled" }),
  );
  check(
    "track: `already` with no paid_at → no",
    !shouldTrackGatewayReturnPurchase({ ...base, settleStatus: "already", paidAt: null }),
  );
  check(
    "track: paid_at slightly ahead of the app clock still counts",
    shouldTrackGatewayReturnPurchase({ ...base, settleStatus: "already", paidAt: new Date(now + 1500) }),
  );
  for (const s of ["pending", "failed", "cancelled", null]) {
    check(`track: settle ${String(s)} → no`, !shouldTrackGatewayReturnPurchase({ ...base, settleStatus: s }));
  }
}

async function realTimeoutReason() {
  // The detection must match what THIS runtime's AbortSignal.timeout throws.
  const s = AbortSignal.timeout(1);
  await new Promise((r) => setTimeout(r, 25));
  check(
    "timeout: runtime AbortSignal.timeout reason maps to the timeout message",
    s.aborted && gatewayFetchErrorMessage("ClicToPay", s.reason, "fb").includes("délai de réponse dépassé"),
  );
}

async function flow() {
  // Fake creds + a public origin BEFORE the app modules load (serverEnv is parsed
  // lazily once); fetch is stubbed, so nothing ever leaves the process.
  process.env.FLOUCI_APP_TOKEN = `${TAG}-token`;
  process.env.FLOUCI_APP_SECRET = `${TAG}-secret`;
  if (!process.env.NEXT_PUBLIC_SITE_URL) process.env.NEXT_PUBLIC_SITE_URL = "https://shop.example.test";
  installGatewayStub();

  const { eq, sql } = await import("drizzle-orm");
  const { db } = await import("@/lib/db/client");
  const { orders } = await import("@/modules/order/schema");
  const { orderService } = await import("@/modules/order/service");
  const { invalidatePaymentConfigCache } = await import("@/lib/payments/config");
  const { resolvePublicOrigin } = await import("@/lib/url/public-origin");
  const gp = await import("@/workflows/order/gateway-payment");
  const { workflows } = await import("@/workflows");
  const { handleGatewayWebhook } = await import("@/lib/payments/webhook-handler");
  invalidatePaymentConfigCache();

  async function cleanup() {
    const mine = sql`(select id::text from orders where order_number like ${TAG + "%"})`;
    await db.execute(sql`delete from webhook_events where order_id in ${mine}`);
    await db.execute(sql`delete from rate_limit_buckets where bucket_key like ${"late-capture:%"} and substring(bucket_key from 14) in ${mine}`);
    await db.execute(sql`delete from order_status_history where order_id::text in ${mine}`);
    await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
  }

  async function mkOrder(tag: string, extra: Record<string, unknown> = {}) {
    const [o] = await db
      .insert(orders)
      .values({
        order_number: `${TAG}-${tag}-${Date.now()}`,
        contact_email: "ph@example.com",
        status: "pending",
        payment_method: "flouci",
        subtotal_cents: 10_000,
        total_cents: 10_000,
        ship_full_name: "Pay Hard",
        ship_street_line1: "1 rue",
        ship_city: "Tunis",
        ...extra,
      } as never)
      .returning({ id: orders.id });
    return o.id;
  }
  const load = async (id: string) => (await orderService.findById(id))!;
  const ago = (ms: number) => new Date(Date.now() - ms);

  await cleanup();
  try {
    // ── GUARD (checkout-06) ────────────────────────────────────────────────────
    {
      verifyState = { status: "PENDING" };
      const o = await mkOrder("guard", { payment_reference: `${TAG}-ref-guard` });
      const live = await gp.assertPendingOnlineOrderNotCaptured(await load(o), { actorUserId: null });
      check("guard: gateway pending on a fresh session → refused (payment_in_progress)", !live.ok && live.error === "payment_in_progress");
      const resumeOk = await gp.assertPendingOnlineOrderNotCaptured(await load(o), { actorUserId: null }, { allowLiveSession: true });
      check("guard: allowLiveSession (re-init) → allowed", resumeOk.ok === true);

      const t = await workflows.order.transitionStatus({ orderId: o, toStatus: "cancelled" }, { actorUserId: null });
      check("guard: the cancel workflow refuses it too (order stays pending)", !t.ok && (await load(o)).status === "pending");

      await db.update(orders).set({ updated_at: ago(45 * MIN) } as never).where(eq(orders.id, o));
      const expired = await gp.assertPendingOnlineOrderNotCaptured(await load(o), { actorUserId: null });
      check("guard: pending on a session re-initiated 45 min ago → allowed", expired.ok === true);

      await db.update(orders).set({ updated_at: new Date() } as never).where(eq(orders.id, o));
      verifyState = { status: "EXPIRED" };
      const declined = await gp.assertPendingOnlineOrderNotCaptured(await load(o), { actorUserId: null });
      check("guard: definitive decline on a fresh session → allowed", declined.ok === true);

      verifyState = "http502";
      const down = await gp.assertPendingOnlineOrderNotCaptured(await load(o), { actorUserId: null });
      check("guard: HTTP 502 verify → fail closed (payment_unverified)", !down.ok && down.error === "payment_unverified");
      verifyState = "timeout";
      const slow = await gp.assertPendingOnlineOrderNotCaptured(await load(o), { actorUserId: null });
      check("guard: timed-out verify → fail closed (payment_unverified)", !slow.ok && slow.error === "payment_unverified");
    }

    // ── RESUME (checkout-07) ───────────────────────────────────────────────────
    const origin = await resolvePublicOrigin();
    const originUsable = !/\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(origin);
    {
      const ref = `${TAG}-ref-paid`;
      const o = await mkOrder("resume-paid", { payment_reference: ref });
      verifyState = { status: "SUCCESS", amount: 10_000 };
      const inits = initCalls;
      const r = await workflows.order.initiatePayment({ orderId: o }, { actorUserId: null });
      const after = await load(o);
      check("resume: previous session PAID → already_paid (no re-init)", !r.ok && r.error === "already_paid" && initCalls === inits);
      check("resume: …and the order is settled to paid, reference kept", after.status === "paid" && after.payment_reference === ref);
    }
    {
      const ref = `${TAG}-ref-mismatch`;
      const o = await mkOrder("resume-mismatch", { payment_reference: ref });
      verifyState = { status: "SUCCESS", amount: 9_999 };
      const r = await workflows.order.initiatePayment({ orderId: o }, { actorUserId: null });
      check("resume: paid with a wrong amount → refused (payment_detected), ref kept", !r.ok && r.error === "payment_detected" && (await load(o)).payment_reference === ref);
    }
    {
      const ref = `${TAG}-ref-down`;
      const o = await mkOrder("resume-down", { payment_reference: ref });
      verifyState = "http502";
      const inits = initCalls;
      const r = await workflows.order.initiatePayment({ orderId: o }, { actorUserId: null });
      check("resume: unverifiable previous session → fail closed, no re-init, ref kept", !r.ok && r.error === "payment_unverified" && initCalls === inits && (await load(o)).payment_reference === ref);
    }
    if (!originUsable) {
      console.log(`  – resume: public origin is ${origin} (localhost) — re-init cases skipped`);
    } else {
      {
        const ref = `${TAG}-ref-pending`;
        const o = await mkOrder("resume-pending", { payment_reference: ref });
        verifyState = { status: "PENDING" };
        const r = await workflows.order.initiatePayment({ orderId: o }, { actorUserId: null });
        const after = await load(o);
        check("resume: previous session still pending → re-initiated (new reference)", r.ok && after.payment_reference === r.data.reference && after.payment_reference !== ref);
      }
      {
        const o = await mkOrder("first-init");
        const verifies = verifyCalls;
        const r = await workflows.order.initiatePayment({ orderId: o }, { actorUserId: null });
        check("resume: first init (no reference) never verifies", r.ok && verifyCalls === verifies);
      }
    }

    // ── LATE capture on a cancelled order (checkout-06) ───────────────────────
    {
      const ref = `${TAG}-ref-late`;
      const o = await mkOrder("late", { status: "cancelled", payment_reference: ref });
      verifyState = { status: "SUCCESS", amount: 10_000 };
      check("late: cancelled order the gateway reports PAID → detected", (await gp.detectLateCaptureOnCancelledOrder(await load(o), "return")) === true);
      const verifies = verifyCalls;
      const res = await handleGatewayWebhook(
        new Request(`https://shop.example.test/api/webhooks/flouci?payment_id=${encodeURIComponent(ref)}`),
        "flouci",
      );
      if (res.status === 503) {
        console.log("  – late: inbound webhooks are disabled on this DB — webhook case skipped");
      } else {
        const body = (await res.json().catch(() => null)) as { status?: string } | null;
        check("late: webhook on the cancelled order still acks 200 'already'", res.status === 200 && body?.status === "already");
        check("late: …after probing the gateway", verifyCalls === verifies + 1);
      }
      check("late: the cancelled order is left untouched", (await load(o)).status === "cancelled");

      verifyState = { status: "PENDING" };
      const o2 = await mkOrder("late-pending", { status: "cancelled", payment_reference: `${TAG}-ref-late2` });
      check("late: gateway not paid → nothing flagged", (await gp.detectLateCaptureOnCancelledOrder(await load(o2), "webhook")) === false);

      verifyState = { status: "SUCCESS", amount: 10_000 };
      const o3 = await mkOrder("late-settled", { status: "cancelled", payment_reference: `${TAG}-ref-late3`, paid_at: ago(60 * MIN) });
      const v3 = verifyCalls;
      check("late: order settled BEFORE its cancel is skipped (no probe)", (await gp.detectLateCaptureOnCancelledOrder(await load(o3), "webhook")) === false && verifyCalls === v3);
    }

    // ── SIGNAL (checkout-19) ───────────────────────────────────────────────────
    check("signal: every stubbed provider fetch carried an AbortSignal", unsignedCalls === 0 && verifyCalls > 0);
  } finally {
    globalThis.fetch = realFetch;
    await cleanup().catch((e) => console.error("cleanup failed", e));
  }
}

async function main() {
  rules();
  await realTimeoutReason();
  await flow();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

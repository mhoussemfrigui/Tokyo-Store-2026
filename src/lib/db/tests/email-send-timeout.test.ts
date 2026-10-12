/**
 * PURE test (no DB, no network) for the mail-provider send bound
 * (`withSendTimeout`, src/lib/email/providers/send-timeout.ts). The inline
 * transactional sends run inside awaited `bus.emit` subscribers, so an unbounded
 * provider call used to hold checkout / signup / status changes for minutes
 * behind a stalled mail host. Asserts: a hung send rejects at the bound, a fast
 * send / a provider error pass through unchanged, and a settled send doesn't
 * leave its timer pending.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/email-send-timeout.test.ts
 */
import { PROVIDER_SEND_TIMEOUT_MS, withSendTimeout } from "@/lib/email/providers/send-timeout";

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

async function main() {
  check(
    "default bound is finite and well under nodemailer's 2-min connect default",
    PROVIDER_SEND_TIMEOUT_MS > 0 && PROVIDER_SEND_TIMEOUT_MS <= 60_000,
  );

  // A send that never settles (black-holed host) → rejects at the bound.
  const started = Date.now();
  let hungError = "";
  await withSendTimeout(new Promise<never>(() => {}), "SMTP", 50).catch((err: unknown) => {
    hungError = err instanceof Error ? err.message : String(err);
  });
  const elapsed = Date.now() - started;
  check("hung send rejects with a timeout error", /SMTP send timed out/.test(hungError));
  check("hung send rejects at (about) the bound", elapsed >= 40 && elapsed < 2_000);

  // A fast send passes its value through.
  const value = await withSendTimeout(Promise.resolve({ id: "msg-1" }), "Resend", 1_000);
  check("fast send resolves with the provider's value", value.id === "msg-1");

  // A provider error propagates unchanged (not masked as a timeout).
  let providerError = "";
  await withSendTimeout(Promise.reject(new Error("auth failed")), "SMTP", 1_000).catch((err: unknown) => {
    providerError = err instanceof Error ? err.message : String(err);
  });
  check("provider error propagates unchanged", providerError === "auth failed");

  // A late rejection AFTER the bound fired must not surface as unhandled.
  let unhandled = false;
  const onUnhandled = () => {
    unhandled = true;
  };
  process.on("unhandledRejection", onUnhandled);
  await withSendTimeout(
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late")), 80)),
    "sendmail",
    20,
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  process.off("unhandledRejection", onUnhandled);
  check("late rejection after the timeout is handled (no unhandledRejection)", !unhandled);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

// No explicit exit on success: the process must exit on its own, proving a
// settled send cleared its (30 s default) timer instead of keeping Node alive.
main().catch((err) => {
  console.error(err);
  process.exit(1);
});

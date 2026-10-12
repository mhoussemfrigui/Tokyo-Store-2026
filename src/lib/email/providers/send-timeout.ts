import "server-only";

/**
 * Hard wall-clock bound on ONE provider send.
 *
 * `bus.emit` awaits its subscribers, and the transactional email subscribers
 * (order receipt / status, welcome…) send INLINE — so a black-holed or stalled
 * mail host used to hold checkout, signup and admin status changes for minutes
 * (nodemailer defaults: 2 min connect / 10 min socket; undici: 300 s to the
 * response headers; a hung local sendmail: forever). Every provider now races
 * its send against this bound.
 *
 * A timed-out send REJECTS, so the dispatch chokepoint logs it `failed` (and
 * the queue drain retries queued rows with backoff). The underlying request may
 * still complete in the background, so a mail logged as failed can
 * occasionally be delivered anyway — acceptable for best-effort email.
 */
export const PROVIDER_SEND_TIMEOUT_MS = 30_000;

export function withSendTimeout<T>(
  send: Promise<T>,
  provider: string,
  ms: number = PROVIDER_SEND_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${provider} send timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  // Promise.race subscribes to `send`, so a late rejection after the timeout
  // fired is still handled (no unhandledRejection).
  return Promise.race([send, timeout]).finally(() => clearTimeout(timer));
}

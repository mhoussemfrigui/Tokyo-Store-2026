"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";

/**
 * Run a server action with a SELF-MANAGED pending flag, then refresh the route
 * WITHOUT the React-19 `useTransition` + `router.refresh()` hang.
 *
 * ⚠️ STUCK-BUTTON CLASS. `useTransition(() => { await action(); router.refresh() })`
 * ties `isPending` to the router REFETCH committing, and a confirmed Next 15/16 +
 * React 19 reconciler race leaves `isPending` stuck `true` — the button spins
 * "loading forever until refresh" even though the action already committed. It is
 * INTERMITTENT (~30% of clicks), worse when the action is FAST and the refreshed
 * page is HEAVY. Refs: vercel/next.js issues #86055, discussions #82289 / #88767.
 * The recommended fix (used here): own the loading state and call `router.refresh()`
 * OUTSIDE any transition (fire-and-forget).
 *
 * Usage — `run(fn)` sets `pending`, awaits `fn`, resets `pending` in `finally`,
 * then fires `router.refresh()` unless `fn` returned `false` (skip refresh, e.g.
 * on a validation error):
 *
 *   const { pending, run } = useRefreshAction();
 *   const save = () => run(async () => {
 *     const res = await saveAction(data);
 *     if (!res.ok) { setError(res.message); return false; } // no refresh
 *     // success → route refreshes
 *   });
 *
 * Re-entrancy is guarded (a second call while pending is ignored) so a double
 * click can't fire the action twice. The spinner tracks ONLY the action, so it
 * can never outlive the (fast, bus/email-capped) server round-trip.
 */
export function useRefreshAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const run = useCallback(
    (fn: () => Promise<unknown>) => {
      if (busy.current) return;
      busy.current = true;
      setPending(true);
      void (async () => {
        try {
          const result = await fn();
          if (result !== false) router.refresh();
        } catch (err) {
          // A throwing action must not become an unhandled rejection nor leave the
          // button spinning — `finally` still resets. Components that want to show
          // the error handle it inside `fn` (try/catch → setError) and `return false`.
          console.error("[useRefreshAction] action threw", err);
        } finally {
          busy.current = false;
          setPending(false);
        }
      })();
    },
    [router],
  );

  return { pending, run, router };
}

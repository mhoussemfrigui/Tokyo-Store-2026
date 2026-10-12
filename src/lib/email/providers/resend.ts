import "server-only";

import { Resend, type CreateEmailRequestOptions } from "resend";

import { serverEnv } from "@/lib/env";
import type { EmailProvider } from "../types";
import { PROVIDER_SEND_TIMEOUT_MS, withSendTimeout } from "./send-timeout";

/** Abort the HTTP call a little before the overall race gives up, so the SDK
 *  resolves with its own error (and the socket is torn down) in the common case. */
const RESEND_FETCH_TIMEOUT_MS = PROVIDER_SEND_TIMEOUT_MS - 5_000;

export const resendProvider: EmailProvider = {
  name: "resend",
  async send(payload, { from, resendApiKey }) {
    // Key resolved by lib/email/config.ts (env wins → encrypted DB); fall back
    // to env directly for any legacy caller.
    const key = resendApiKey || serverEnv.RESEND_API_KEY;
    if (!key) {
      throw new Error("RESEND_API_KEY is missing (set it in env or the admin Mailing tab)");
    }
    // The SDK calls a bare `fetch` with no signal (undici would wait up to
    // 300 s for the headers). Its request options are spread into that fetch
    // at runtime, so an AbortSignal rides along — but it isn't part of the
    // SDK's typed options (hence the widened type); withSendTimeout is the
    // version-proof backstop if a future SDK stops forwarding it.
    const requestOptions: CreateEmailRequestOptions & { signal: AbortSignal } = {
      signal: AbortSignal.timeout(RESEND_FETCH_TIMEOUT_MS),
    };
    const result = await withSendTimeout(
      new Resend(key).emails.send(
        {
          from,
          to: payload.to,
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
          replyTo: payload.replyTo,
          headers: payload.headers,
        },
        requestOptions,
      ),
      "Resend",
    );
    if (result.error) {
      throw new Error(`Resend send failed: ${result.error.message}`);
    }
    return { id: result.data?.id ?? "" };
  },
};

import "server-only";

import * as clictopay from "./providers/clictopay";
import * as flouci from "./providers/flouci";
import type { GatewayMethod, InitiateInput, InitiateResult, VerifyResult } from "./shared";

/**
 * Payment gateway dispatcher — the single entry point workflows use to talk to
 * a provider, so callers never branch on the method themselves.
 */

export {
  ONLINE_METHODS,
  isOnlineMethod,
  toGatewayMinor,
  fromGatewayMinor,
} from "./shared";
export type {
  GatewayMethod,
  InitiateInput,
  InitiateResult,
  VerifyResult,
  VerifyStatus,
} from "./shared";

const PROVIDERS = { clictopay, flouci } as const;

export function initiateGatewayPayment(
  method: GatewayMethod,
  input: InitiateInput,
): Promise<InitiateResult> {
  return PROVIDERS[method].initiatePayment(input);
}

export function verifyGatewayPayment(
  method: GatewayMethod,
  reference: string,
): Promise<VerifyResult> {
  return PROVIDERS[method].verifyPayment(reference);
}

// Turns a PAYMENT-SIGNATURE header into a stable identity for replay protection.
// For EIP-3009, (token, authorizer, nonce) is exactly what the USDC contract itself treats as unique,
// so a replay is caught here no matter how the header is re-encoded.

import { createHash } from "node:crypto";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";

export interface PaymentIdentity {
  /** Primary key in the replay store. */
  key: string;
  payer: string | null;
  nonce: string | null;
  network: string | null;
}

export const PAYMENT_HEADERS = ["payment-signature", "x-payment"] as const;

export function readPaymentHeader(get: (name: string) => string | undefined): string | undefined {
  for (const name of PAYMENT_HEADERS) {
    const value = get(name);
    if (value) return value;
  }
  return undefined;
}

export function paymentIdentity(header: string): PaymentIdentity | null {
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    return null; // not decodable: the x402 middleware will reject it with a proper 402
  }
  const inner = (payload.payload ?? {}) as Record<string, unknown>;
  const network = payload.accepted?.network ?? null;
  const asset = payload.accepted?.asset?.toLowerCase() ?? "";

  const authorization = asRecord(inner.authorization) ?? asRecord(inner.permit2Authorization);
  const payer = str(authorization?.from);
  const nonce = str(authorization?.nonce);
  if (payer && nonce) {
    return { key: `${network}|${asset}|${payer.toLowerCase()}|${nonce.toLowerCase()}`, payer, nonce, network };
  }

  // Unknown scheme shape: fall back to the signature itself (identical replays have identical bytes).
  const signature = str(inner.signature) ?? JSON.stringify(inner);
  return { key: `sig|${createHash("sha256").update(signature).digest("hex")}`, payer, nonce, network };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Helpers for live tests against running sellers on Base Sepolia. They use only stock x402 SDK pieces
// (x402Client + x402HTTPClient + registerExactEvmScheme), exactly what an outside buyer would use.

import type { Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { fromUnits, loadEnv, requireEnv, txUrl, type Address } from "@dron/shared";
import { assertTestnet, usdcBalance } from "@dron/x402-kit";

export interface Buyer {
  account: PrivateKeyAccount;
  client: x402Client;
  http: x402HTTPClient;
}

export async function setupBuyer(minUnits = 1n): Promise<Buyer> {
  loadEnv();
  await assertTestnet();
  const account = privateKeyToAccount(requireEnv("BUYER_PRIVATE_KEY") as Hex);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  const balance = await usdcBalance(account.address);
  console.log(`buyer ${account.address} holds ${fromUnits(balance)} USDC`);
  if (balance < minUnits) {
    console.error(`\nThe buyer needs at least ${fromUnits(minUnits)} testnet USDC. Fund it at https://faucet.circle.com (Base Sepolia).`);
    process.exit(2);
  }
  return { account, client, http: new x402HTTPClient(client) };
}

/** Gets the 402 for a request and signs one payment for it. Does not send the payment. */
export async function signPaymentFor(buyer: Buyer, url: string, init: RequestInit = {}) {
  const res = await fetch(url, init);
  if (res.status !== 402) throw new Error(`expected 402 from ${url}, got ${res.status}: ${await res.text()}`);
  const body = await res.json().catch(() => undefined);
  const paymentRequired: PaymentRequired = buyer.http.getPaymentRequiredResponse((n) => res.headers.get(n), body);
  const payload: PaymentPayload = await buyer.client.createPaymentPayload(paymentRequired);
  const headers = buyer.http.encodePaymentSignatureHeader(payload);
  const auth = (payload.payload as { authorization?: { from: Address; nonce: Hex } }).authorization;
  if (!auth) throw new Error("expected an EIP-3009 authorization in the payload");
  return { paymentRequired, payload, headers, from: auth.from, nonce: auth.nonce };
}

export interface Sent {
  status: number;
  body: unknown;
  settle: { success: boolean; transaction: string } | null;
}

export async function send(url: string, init: RequestInit, paymentHeaders: Record<string, string>): Promise<Sent> {
  const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), ...paymentHeaders } });
  const raw = res.headers.get("PAYMENT-RESPONSE");
  let settle: Sent["settle"] = null;
  if (raw) {
    try {
      const s = decodePaymentResponseHeader(raw);
      settle = { success: s.success, transaction: s.transaction };
    } catch {
      settle = null;
    }
  }
  return { status: res.status, body: await res.json().catch(() => null), settle };
}

let failures = 0;
export function check(ok: boolean, label: string, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail === undefined ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
export function finish(): never {
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

export const link = (hash: string) => txUrl(hash);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

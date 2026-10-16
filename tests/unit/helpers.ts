import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { NETWORK, ledgerMessage, txUrl, type LedgerRow, type Listing } from "@dron/shared";

/** In-process facilitator: accepts every payment and records each settle call. */
export class MockFacilitator implements FacilitatorClient {
  verifyCalls: PaymentPayload[] = [];
  settleCalls: PaymentPayload[] = [];
  verifyResult: Partial<VerifyResponse> = {};

  async verify(payload: PaymentPayload): Promise<VerifyResponse> {
    this.verifyCalls.push(payload);
    const from = (payload.payload as { authorization?: { from?: string } }).authorization?.from;
    return { isValid: true, payer: from, ...this.verifyResult };
  }
  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls.push(payload);
    const n = this.settleCalls.length.toString(16).padStart(64, "0");
    const from = (payload.payload as { authorization?: { from?: string } }).authorization?.from;
    return { success: true, transaction: `0x${n}`, network: req.network, payer: from };
  }
  async getSupported(): Promise<SupportedResponse> {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} } as SupportedResponse;
  }
}

export function testBuyer() {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  return { account, client, http: new x402HTTPClient(client) };
}

export async function listen(app: { listen: (port: number, cb: () => void) => Server }): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

export async function signFor(buyer: ReturnType<typeof testBuyer>, url: string, init: RequestInit = {}) {
  const res = await fetch(url, init);
  if (res.status !== 402) throw new Error(`expected 402, got ${res.status}`);
  const body = await res.json().catch(() => undefined);
  const required = buyer.http.getPaymentRequiredResponse((n) => res.headers.get(n), body);
  const payload = await buyer.client.createPaymentPayload(required);
  return { required, payload, headers: buyer.http.encodePaymentSignatureHeader(payload) };
}

export const randomPayTo = () => privateKeyToAccount(generatePrivateKey()).address;

/** Parsed JSON body, typed loosely for assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const body = (res: Response): Promise<any> => res.json();

/** A complete, consistent ledger row for `listing`, paid by default. */
export function makeRow(buyer: string, listing: Listing, over: Partial<LedgerRow> = {}): LedgerRow {
  const now = new Date().toISOString();
  const tx = `0x${randomBytes(32).toString("hex")}`;
  return {
    id: randomUUID(),
    time: now,
    updatedAt: now,
    sessionId: "ses_test",
    taskId: "task_test",
    buyer,
    sellerId: listing.sellerId,
    serviceId: listing.id,
    endpoint: listing.endpoint,
    payTo: listing.payTo,
    listedUnits: listing.priceUnits,
    askedUnits: listing.priceUnits,
    paidUnits: listing.priceUnits,
    status: "paid",
    reasonCode: "ok",
    reason: null,
    txHash: tx,
    explorerUrl: txUrl(tx),
    nonce: `0x${randomBytes(32).toString("hex")}`,
    validBefore: Math.floor(Date.now() / 1000) + 60,
    httpStatus: 200,
    latencyMs: 120,
    onchainConfirmed: null,
    ...over,
  };
}

export async function postRow(base: string, account: LocalAccount, row: LedgerRow, signRow: LedgerRow = row) {
  const signature = await account.signMessage({ message: ledgerMessage(signRow) });
  return fetch(`${base}/api/ledger`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ row, signature }) });
}

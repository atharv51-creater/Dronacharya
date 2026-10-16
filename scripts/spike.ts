// Build step 1: one real paid call on Base Sepolia, made by an UNMODIFIED x402 v2 client
// (@x402/fetch's wrapFetchWithPayment). Proves our seller interoperates with the standard SDK and
// that the settlement moved exactly the listed amount from the buyer to the seller's payTo.
//
//   npm run spike                                   # pays fx-rates GBP->INR (0.001 USDC)
//   npm run spike -- http://localhost:4101/scrape?page=1

import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { fromUnits, loadEnv, requireEnv, txUrl, type Address } from "@dron/shared";
import { assertTestnet, confirmTransfer, usdcBalance } from "@dron/x402-kit";

loadEnv();
await assertTestnet();
const url = process.argv[2] ?? "http://localhost:4102/rate?from=GBP&to=INR";
const account = privateKeyToAccount(requireEnv("BUYER_PRIVATE_KEY") as Hex);

console.log(`\n1. Unpaid request: GET ${url}`);
const unpaid = await fetch(url);
const header = unpaid.headers.get("PAYMENT-REQUIRED");
console.log(`   status ${unpaid.status}`);
if (unpaid.status !== 402 || !header) {
  console.error("   expected 402 with a PAYMENT-REQUIRED header; is the seller running? (npm start)");
  process.exit(1);
}
const required = decodePaymentRequiredHeader(header);
console.log("   PAYMENT-REQUIRED (decoded):");
console.log(JSON.stringify(required, null, 2).replace(/^/gm, "     "));
const accept = required.accepts[0]!;

const before = await usdcBalance(account.address);
console.log(`\n2. Buyer ${account.address} holds ${fromUnits(before)} USDC; the seller asks ${fromUnits(BigInt(accept.amount))} USDC`);
if (before < BigInt(accept.amount)) {
  console.error("   not enough testnet USDC: fund the buyer at https://faucet.circle.com (Base Sepolia), then re-run");
  process.exit(2);
}

console.log("\n3. Paying with the stock @x402/fetch client (sign EIP-3009, retry with PAYMENT-SIGNATURE)");
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const payFetch = wrapFetchWithPayment(fetch, client);
const started = performance.now();
const paid = await payFetch(url);
const ms = Math.round(performance.now() - started);
const body = await paid.json().catch(() => null);
console.log(`   status ${paid.status} in ${ms} ms`);
console.log(JSON.stringify(body, null, 2).slice(0, 1200).replace(/^/gm, "     "));

const responseHeader = paid.headers.get("PAYMENT-RESPONSE");
if (paid.status !== 200 || !responseHeader) {
  console.error("   the paid request did not succeed (see body above)");
  process.exit(1);
}
const settle = decodePaymentResponseHeader(responseHeader);
console.log(`\n4. PAYMENT-RESPONSE: success=${settle.success} tx=${settle.transaction}`);
console.log(`   ${txUrl(settle.transaction)}`);

console.log("\n5. Checking the chain");
const check = await confirmTransfer(
  settle.transaction as Hex,
  { from: account.address, to: accept.payTo as Address, amount: BigInt(accept.amount) },
  { wait: true },
);
console.log(`   receipt ${check.status}, USDC transfers in tx: ${check.transfers.map((t) => `${t.from} -> ${t.to}: ${t.value}`).join("; ")}`);
const after = await usdcBalance(account.address);
console.log(`   buyer balance ${fromUnits(before)} -> ${fromUnits(after)} USDC (moved ${fromUnits(before - after)})`);
console.log(check.confirmed ? "\nSPIKE PASSED: exactly the listed amount moved buyer -> payTo in one transaction." : "\nSPIKE FAILED: transfer not confirmed as expected.");
process.exit(check.confirmed ? 0 : 1);

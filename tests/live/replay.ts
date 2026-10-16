// Judged test "Replay", live on Base Sepolia:
//   A. one signed payment sent twice in a row    -> 1 result (200), then 409; one transfer
//   B. one signed payment sent 5 times at once   -> exactly 1 result, four 409s; one transfer
// Each signature must map to exactly one on-chain USDC transfer.
//
//   npm run test:replay [-- <paid url>]          default: fx-rates (0.001 USDC per signature)

import type { Hex } from "viem";
import { authorizationUsed, confirmTransfer } from "@dron/x402-kit";
import type { Address } from "@dron/shared";
import { check, finish, link, send, setupBuyer, signPaymentFor } from "./lib.ts";

const url = process.argv[2] ?? "http://localhost:4102/rate?from=GBP&to=INR";
const buyer = await setupBuyer(2000n);

async function verifyOnChain(label: string, sig: Awaited<ReturnType<typeof signPaymentFor>>, tx: string | undefined) {
  const accept = sig.payload.accepted;
  check(Boolean(tx), `${label}: a transaction hash was returned`, tx ? link(tx) : undefined);
  if (!tx) return;
  const result = await confirmTransfer(tx as Hex, { from: sig.from, to: accept.payTo as Address, amount: BigInt(accept.amount) }, { wait: true });
  check(result.confirmed, `${label}: exactly ${accept.amount} units moved buyer -> payTo in that tx`, result.transfers.map((t) => `${t.value}`));
  check(await authorizationUsed(sig.from, sig.nonce as Hex), `${label}: the authorisation is marked used on-chain`);
}

console.log(`\nA. Same payment twice, sequentially -> ${url}`);
const a = await signPaymentFor(buyer, url);
const a1 = await send(url, {}, a.headers);
const a2 = await send(url, {}, a.headers);
check(a1.status === 200 && a1.settle?.success === true, "first request returns the paid result", a1.status);
check(a2.status === 409 && !a2.settle?.success, "second request is refused and not settled", a2.status);
await verifyOnChain("A", a, a1.settle?.transaction);

console.log(`\nB. Same payment five times in parallel -> ${url}`);
const b = await signPaymentFor(buyer, url);
const results = await Promise.all(Array.from({ length: 5 }, () => send(url, {}, b.headers)));
const ok = results.filter((r) => r.status === 200 && r.settle?.success);
check(ok.length === 1, "exactly one of five returns the paid result", results.map((r) => r.status));
check(results.filter((r) => r.status === 409).length === 4, "the other four get 409 payment_already_used");
await verifyOnChain("B", b, ok[0]?.settle?.transaction);

finish();

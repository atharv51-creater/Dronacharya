// Judged test "Seller failure", live: send real signed payments for requests our sellers cannot
// fulfil. Each must come back as an error and the authorisation must stay UNUSED on-chain (no transfer).
//
//   npm run test:failure

import type { Hex } from "viem";
import { authorizationUsed } from "@dron/x402-kit";
import { check, finish, send, setupBuyer, signPaymentFor, sleep } from "./lib.ts";

const buyer = await setupBuyer(20_000n);

const cases = [
  { label: "scraper: catalogue page 999 does not exist", url: "http://localhost:4101/scrape?page=999", expect: 404 },
  { label: "scraper: unknown category", url: "http://localhost:4101/scrape?page=1&category=Underwater%20Basket%20Weaving", expect: 404 },
  { label: "fx-rates: unsupported currency", url: "http://localhost:4102/rate?from=GBP&to=XYZ", expect: 422 },
  { label: "chaos: seller outage after payment is verified", url: "http://localhost:4199/fail/scrape?page=1", expect: 503 },
];

const signed: { label: string; from: `0x${string}`; nonce: Hex }[] = [];
for (const c of cases) {
  console.log(`\n${c.label}\n  GET ${c.url}`);
  const sig = await signPaymentFor(buyer, c.url);
  const res = await send(c.url, {}, sig.headers);
  check(res.status === c.expect, `error ${c.expect} returned`, { status: res.status, body: res.body });
  check(!res.settle?.success, "no successful PAYMENT-RESPONSE");
  signed.push({ label: c.label, from: sig.from, nonce: sig.nonce as Hex });
}

console.log("\nWaiting 5 s, then checking that no authorisation was used on-chain");
await sleep(5000);
for (const s of signed) check(!(await authorizationUsed(s.from, s.nonce)), `${s.label}: nothing transferred`);

finish();

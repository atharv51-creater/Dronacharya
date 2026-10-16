import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { NETWORK, USDC_ADDRESS, type Listing } from "@dron/shared";
import { checkPaymentRequired } from "@dron/x402-kit";

const payTo = "0x1111111111111111111111111111111111111111" as const;
const other = "0x2222222222222222222222222222222222222222";

const listing: Listing = {
  id: "svc",
  sellerId: "seller",
  name: "svc",
  category: "data",
  description: "d",
  endpoint: "https://x.example/r",
  method: "GET",
  priceUnits: "1000",
  network: NETWORK,
  asset: USDC_ADDRESS,
  payTo,
  inputSchema: {},
  outputSchema: {},
};

const accept = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: NETWORK,
  asset: USDC_ADDRESS,
  amount: "1000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
  ...over,
});
const required = (accepts: PaymentRequirements[], x402Version = 2): PaymentRequired => ({
  x402Version,
  resource: { url: "https://x.example/r", description: "", mimeType: "application/json" },
  accepts,
});

describe("price check", () => {
  it("accepts an option that matches the listing exactly, with case-insensitive addresses", () => {
    const r = checkPaymentRequired(required([accept({ payTo: payTo.toUpperCase().replace("0X", "0x"), asset: USDC_ADDRESS.toLowerCase() })]), listing);
    assert.ok(r.ok);
  });

  it("accepts a price below the listing", () => {
    const r = checkPaymentRequired(required([accept({ amount: "500" })]), listing);
    assert.ok(r.ok && r.chosen.amount === "500");
  });

  const refusals: [string, Partial<PaymentRequirements>, string][] = [
    ["10x the listed price (the judges' test)", { amount: "10000" }, "price_above_listing"],
    ["one unit over the listed price", { amount: "1001" }, "price_above_listing"],
    ["a different payTo (the judges' test)", { payTo: other }, "payto_mismatch"],
    ["another network (Base mainnet)", { network: "eip155:8453" }, "network_mismatch"],
    ["another token", { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, "asset_mismatch"],
    ["an unsupported scheme", { scheme: "upto" }, "scheme_unsupported"],
    ["a zero amount", { amount: "0" }, "bad_402"],
    ["a non-integer amount", { amount: "1e3" }, "bad_402"],
    ["a week-long authorisation window", { maxTimeoutSeconds: 604_800 }, "unreasonable_timeout"],
  ];
  for (const [label, patch, code] of refusals) {
    it(`refuses ${label}`, () => {
      const r = checkPaymentRequired(required([accept(patch)]), listing);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, code, r.reason);
    });
  }

  it("reports what was asked, and explains the refusal", () => {
    const r = checkPaymentRequired(required([accept({ amount: "10000" })]), listing);
    assert.ok(!r.ok);
    assert.equal(r.askedUnits, "10000");
    assert.match(r.reason, /10x the listed 1000/);
  });

  it("filters a multi-option 402 instead of refusing it outright, and picks the cheapest valid option", () => {
    const r = checkPaymentRequired(
      required([
        accept({ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", payTo: "So1ana" }),
        accept({ amount: "900" }),
        accept({ amount: "800", payTo: other }),
        accept({ amount: "950" }),
      ]),
      listing,
    );
    assert.ok(r.ok);
    assert.equal(r.chosen.amount, "900");
  });

  it("refuses when none of several options match, naming the most important problem", () => {
    const r = checkPaymentRequired(required([accept({ amount: "5000" }), accept({ payTo: other, amount: "5000" })]), listing);
    assert.ok(!r.ok);
    assert.equal(r.code, "price_above_listing");
    assert.match(r.reason, /none of the 2 offered options/);
  });

  it("refuses x402 v1 and empty 402s", () => {
    const v1 = checkPaymentRequired(required([accept()], 1), listing);
    assert.ok(!v1.ok && v1.code === "version_unsupported");
    const empty = checkPaymentRequired(required([]), listing);
    assert.ok(!empty.ok && empty.code === "bad_402");
  });
});

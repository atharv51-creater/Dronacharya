// The buyer's payment core against real HTTP sellers: our seller kit (honest and misbehaving routes),
// an UNMODIFIED @x402/express seller, and hand-written edge-case sellers. Real EIP-3009 signatures,
// an in-process facilitator, a fake chain and a fake clock (so expiry waits take no time).

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HttpError, NETWORK, USDC_ADDRESS, type Address, type JsonSchema, type Listing } from "@dron/shared";
import { Budget, Buyer, MemoryLedger, createSeller, type ChainOps, type Clock, type PaidRoute } from "@dron/x402-kit";
import { MockFacilitator, listen, randomPayTo } from "./helpers.ts";

const output: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["square"],
  properties: { square: { type: "integer" } },
};
const input: JsonSchema = { type: "object", required: ["n"], properties: { n: { type: "integer" } } };
const silent = { debug() {}, info() {}, warn() {}, error() {} };

class FakeChain implements ChainOps {
  usedNow: (nonce: string) => boolean = () => false;
  checks = 0;
  async authorizationUsed(_from: Address, nonce: Hex) {
    this.checks++;
    return this.usedNow(nonce);
  }
  async findAuthorizationTx() {
    return `0x${"ee".repeat(32)}` as Hex;
  }
  async confirmTransfer() {
    return { confirmed: true };
  }
}

class FakeClock implements Clock {
  private t = Date.now();
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
    await new Promise((r) => setImmediate(r));
  }
}

const facilitator = new MockFacilitator();
const chain = new FakeChain();
const sellerPayTo = randomPayTo();
const servers: Server[] = [];
const listings = new Map<string, Listing>();
let freeBase = "";
let noReceiptBase = "";

function makeBuyer(ledger = new MemoryLedger()) {
  const buyer = new Buyer({
    account: privateKeyToAccount(generatePrivateKey()),
    ledger: [ledger],
    chain,
    clock: new FakeClock(),
    log: silent,
    pollIntervalMs: 1000,
  });
  return { buyer, ledger };
}

const route = (over: Partial<PaidRoute>): PaidRoute => ({
  id: "square",
  name: "square",
  category: "data",
  description: "squares n",
  method: "GET",
  path: "/square",
  priceUnits: 1000n,
  inputSchema: input,
  outputSchema: output,
  handler: async ({ n }: { n: number }) => ({ square: n * n }),
  ...over,
});

before(async () => {
  // 1. Our seller kit with honest and misbehaving routes.
  const seller = createSeller({
    sellerId: "kit",
    publicUrl: "http://127.0.0.1:0",
    payTo: sellerPayTo,
    facilitator,
    replayDbPath: ":memory:",
    log: silent,
    routes: [
      route({}),
      route({ id: "junk", path: "/junk", handler: async () => ({ nonsense: true }), misbehave: { skipSelfValidation: true } }),
      route({ id: "missing", path: "/missing", handler: async () => { throw new HttpError(404, "page_not_found"); } }),
      route({ id: "greedy", path: "/greedy", misbehave: { advertisedPriceUnits: 10_000n } }),
      route({ id: "redirect", path: "/redirect", misbehave: { advertisedPayTo: randomPayTo() } }),
      route({ id: "slow", path: "/slow", timeoutMs: 20_000, handler: () => new Promise((r) => setTimeout(() => r({ square: 1 }), 1500)) }),
    ],
  });
  const kit = await listen(seller.app);
  servers.push(kit.server);
  for (const l of seller.listings) listings.set(l.id, { ...l, endpoint: l.endpoint.replace("http://127.0.0.1:0", kit.base) });

  // 2. An unmodified x402 v2 seller, exactly as the SDK quickstart writes it.
  const stock = express();
  const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());
  stock.use(paymentMiddleware({ "GET /weather": { accepts: [{ scheme: "exact", price: "$0.0015", network: NETWORK, payTo: sellerPayTo }], description: "weather" } }, resourceServer));
  stock.get("/weather", (_req, res) => {
    res.json({ square: 4 });
  });
  const st = await listen(stock);
  servers.push(st.server);
  listings.set("stock", { ...listings.get("square")!, id: "stock", sellerId: "stock", endpoint: `${st.base}/weather`, priceUnits: "1500" });

  // 3. A seller that never asks for payment.
  const free = express();
  free.get("/free", (_req, res) => {
    res.json({ square: 9 });
  });
  const fr = await listen(free);
  servers.push(fr.server);
  freeBase = fr.base;

  // 4. A seller that takes the payment header and answers 200 WITHOUT a PAYMENT-RESPONSE receipt.
  const noReceipt = express();
  noReceipt.get("/nr", (req, res) => {
    if (!req.get("payment-signature")) {
      const required = {
        x402Version: 2,
        resource: { url: `${noReceiptBase}/nr`, description: "", mimeType: "application/json" },
        accepts: [{ scheme: "exact", network: NETWORK, asset: USDC_ADDRESS, amount: "1000", payTo: sellerPayTo, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }],
      };
      res.status(402).set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(required)).json({});
      return;
    }
    res.json({ square: 16 });
  });
  const nr = await listen(noReceipt);
  servers.push(nr.server);
  noReceiptBase = nr.base;
});

after(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
});

const L = (id: string) => listings.get(id)!;

describe("buyer: paid calls", () => {
  it("pays, returns validated output, commits the spend and records a confirmed ledger row", async () => {
    const { buyer, ledger } = makeBuyer();
    const budget = new Budget(10_000n);
    const s0 = facilitator.settleCalls.length;
    const out = await buyer.payAndCall({ listing: L("square"), input: { n: 7 }, budget });
    assert.equal(out.row.status, "paid");
    assert.deepEqual(out.output, { square: 49 });
    assert.equal(out.row.paidUnits, "1000");
    assert.match(out.row.txHash!, /^0x[0-9a-f]{64}$/);
    assert.equal(budget.spent, 1000n);
    assert.equal(facilitator.settleCalls.length - s0, 1);
    const final = await out.finalized;
    assert.equal(final.onchainConfirmed, true);
    assert.equal(ledger.get(out.row.id)?.status, "paid");
  });

  it("pays an unmodified @x402/express seller (standard-seller interop)", async () => {
    const { buyer } = makeBuyer();
    const out = await buyer.payAndCall({ listing: L("stock"), budget: new Budget(10_000n) });
    assert.equal(out.row.status, "paid", out.row.reason ?? "");
    assert.equal(out.row.paidUnits, "1500");
    assert.deepEqual(out.output, { square: 4 });
  });

  it("records a free response as paid with 0 units", async () => {
    const { buyer } = makeBuyer();
    const out = await buyer.payAndCall({ listing: { ...L("square"), id: "free", endpoint: `${freeBase}/free` }, budget: new Budget(1n) });
    assert.equal(out.row.status, "paid");
    assert.equal(out.row.reasonCode, "free");
    assert.equal(out.row.paidUnits, "0");
  });
});

describe("buyer: price check (nothing is signed or sent)", () => {
  it("refuses a 402 asking 10x the listed price", async () => {
    const { buyer } = makeBuyer();
    const budget = new Budget(100_000n);
    const v0 = facilitator.verifyCalls.length;
    const out = await buyer.payAndCall({ listing: L("greedy"), input: { n: 1 }, budget });
    assert.equal(out.row.status, "refused");
    assert.equal(out.row.reasonCode, "price_above_listing");
    assert.equal(out.row.askedUnits, "10000");
    assert.equal(out.row.paidUnits, "0");
    assert.equal(budget.spent + budget.reserved, 0n);
    assert.equal(facilitator.verifyCalls.length, v0, "no payment reached the facilitator");
  });

  it("refuses a 402 naming a different payTo", async () => {
    const { buyer } = makeBuyer();
    const v0 = facilitator.verifyCalls.length;
    const out = await buyer.payAndCall({ listing: L("redirect"), input: { n: 1 }, budget: new Budget(100_000n) });
    assert.equal(out.row.status, "refused");
    assert.equal(out.row.reasonCode, "payto_mismatch");
    assert.equal(facilitator.verifyCalls.length, v0);
  });
});

describe("buyer: bad output", () => {
  it("records schema-breaking output as paid_output_rejected and never hands it back", async () => {
    const { buyer } = makeBuyer();
    const budget = new Budget(10_000n);
    const out = await buyer.payAndCall({ listing: L("junk"), input: { n: 1 }, budget });
    assert.equal(out.row.status, "paid_output_rejected");
    assert.equal(out.row.reasonCode, "output_invalid");
    assert.equal(out.output, undefined);
    assert.ok(out.validationErrors && out.validationErrors.length > 0);
    assert.equal(budget.spent, 1000n, "the money did move");
  });
});

describe("buyer: failures are not charged, and proven so", () => {
  it("a seller error after payment holds the reservation until the authorisation expires unused", async () => {
    chain.usedNow = () => false;
    const { buyer } = makeBuyer();
    const budget = new Budget(10_000n);
    const out = await buyer.payAndCall({ listing: L("missing"), input: { n: 1 }, budget });
    assert.equal(out.row.status, "failed_not_charged");
    assert.equal(out.row.reasonCode, "seller_error");
    assert.equal(budget.reserved, 1000n, "held: the seller still holds a valid signature");
    const final = await out.finalized;
    assert.equal(final.status, "failed_not_charged");
    assert.equal(final.onchainConfirmed, true);
    assert.match(final.reason!, /expired unused/);
    assert.equal(budget.reserved, 0n);
    assert.equal(budget.spent, 0n);
  });

  it("catches a seller that reports failure but settles anyway", async () => {
    chain.usedNow = () => true;
    try {
      const { buyer } = makeBuyer();
      const budget = new Budget(10_000n);
      const out = await buyer.payAndCall({ listing: L("missing"), input: { n: 1 }, budget });
      const final = await out.finalized;
      assert.equal(final.status, "paid_output_rejected");
      assert.equal(final.reasonCode, "settled_despite_error");
      assert.equal(final.paidUnits, "1000");
      assert.match(final.txHash!, /^0x(ee){32}$/);
      assert.equal(budget.spent, 1000n, "counted against the budget; it never exceeded it");
    } finally {
      chain.usedNow = () => false;
    }
  });

  it("an unreachable seller is not charged and reserves nothing", async () => {
    const { buyer } = makeBuyer();
    const budget = new Budget(10_000n);
    const out = await buyer.payAndCall({ listing: { ...L("square"), endpoint: "http://127.0.0.1:1/square" }, input: { n: 1 }, budget });
    assert.equal(out.row.status, "failed_not_charged");
    assert.equal(out.row.reasonCode, "seller_unreachable");
    assert.equal(budget.reserved + budget.spent, 0n);
  });
});

describe("buyer: unclear outcomes are decided on-chain", () => {
  it("no answer after paying -> pending, then paid_output_rejected once the chain shows the transfer", async () => {
    chain.usedNow = () => true;
    try {
      const { buyer } = makeBuyer();
      const budget = new Budget(10_000n);
      const out = await buyer.payAndCall({ listing: L("slow"), input: { n: 1 }, budget, timeoutMs: 200 });
      assert.equal(out.row.status, "pending");
      assert.equal(out.row.reasonCode, "no_response");
      assert.equal(budget.reserved, 1000n);
      const final = await out.finalized;
      assert.equal(final.status, "paid_output_rejected");
      assert.equal(final.paidUnits, "1000");
      assert.equal(budget.spent, 1000n);
    } finally {
      chain.usedNow = () => false;
    }
  });

  it("no answer after paying -> failed_not_charged once the authorisation expires unused", async () => {
    const { buyer } = makeBuyer();
    const budget = new Budget(10_000n);
    const out = await buyer.payAndCall({ listing: L("slow"), input: { n: 1 }, budget, timeoutMs: 200 });
    assert.equal(out.row.status, "pending");
    const final = await out.finalized;
    assert.equal(final.status, "failed_not_charged");
    assert.equal(final.onchainConfirmed, true);
    assert.equal(budget.reserved + budget.spent, 0n);
  });

  it("200 without a receipt -> pending; becomes paid (output usable) when the chain confirms", async () => {
    chain.usedNow = () => true;
    try {
      const { buyer } = makeBuyer();
      const budget = new Budget(10_000n);
      const out = await buyer.payAndCall({ listing: { ...L("square"), id: "nr", endpoint: `${noReceiptBase}/nr` }, budget });
      assert.equal(out.row.status, "pending");
      assert.equal(out.row.reasonCode, "no_receipt");
      assert.deepEqual(out.output, { square: 16 });
      const final = await out.finalized;
      assert.equal(final.status, "paid");
      assert.equal(budget.spent, 1000n);
    } finally {
      chain.usedNow = () => false;
    }
  });
});

describe("buyer: budget under concurrency", () => {
  for (const concurrency of [1, 5]) {
    it(`budget 2500 for five 1000-unit calls at concurrency ${concurrency}: two paid, three refused, never over`, async () => {
      const { buyer, ledger } = makeBuyer();
      const budget = new Budget(2500n);
      let peak = 0n;
      budget.onChange((_e, s) => {
        if (s.spent + s.reserved > peak) peak = s.spent + s.reserved;
      });
      const calls = Array.from({ length: 5 }, (_, i) => () => buyer.payAndCall({ listing: L("square"), input: { n: i + 1 }, budget }));
      const outcomes = [];
      for (let i = 0; i < calls.length; i += concurrency) {
        outcomes.push(...(await Promise.all(calls.slice(i, i + concurrency).map((c) => c()))));
      }
      const statuses = outcomes.map((o) => o.row.status).sort();
      assert.deepEqual(statuses, ["paid", "paid", "refused", "refused", "refused"]);
      assert.ok(outcomes.filter((o) => o.row.status === "refused").every((o) => o.row.reasonCode === "budget"));
      assert.ok(peak <= 2500n, `peak ${peak}`);
      assert.equal(budget.spent, 2000n);
      assert.equal(ledger.paidUnits(), 2000n, "ledger total equals spend, to the unit");
    });
  }
});

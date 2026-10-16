// End-to-end tests of the seller kit over real HTTP, with real EIP-3009 signatures from the stock
// x402 client, and an in-process facilitator so no funds or network are needed.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPayment } from "@x402/fetch";
import { HttpError, MAX_TIMEOUT_SECONDS, NETWORK, USDC_ADDRESS, type JsonSchema } from "@dron/shared";
import { createSeller, type PaidRoute } from "@dron/x402-kit";
import { MockFacilitator, body, listen, randomPayTo, signFor, testBuyer } from "./helpers.ts";

const input: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["n"],
  properties: { n: { type: "integer", minimum: 1, maximum: 100 } },
};
const output: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["square"],
  properties: { square: { type: "integer" } },
};

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

const facilitator = new MockFacilitator();
const payTo = randomPayTo();
const altPayTo = randomPayTo();
let base = "";
let close = () => {};
let handlerRuns = 0;

before(async () => {
  const seller = createSeller({
    sellerId: "test-seller",
    publicUrl: "http://127.0.0.1",
    payTo,
    facilitator,
    replayDbPath: ":memory:",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    routes: [
      route({
        handler: async ({ n }: { n: number }) => {
          handlerRuns++;
          return { square: n * n };
        },
      }),
      route({ id: "missing", path: "/missing", handler: async () => { throw new HttpError(404, "page_not_found"); } }),
      route({ id: "slow", path: "/slow", timeoutMs: 150, handler: () => new Promise((r) => setTimeout(() => r({ square: 1 }), 2000)) }),
      route({ id: "broken", path: "/broken", handler: async () => ({ square: "not a number" }) }),
      route({ id: "junk", path: "/junk", handler: async () => ({ junk: true }), misbehave: { skipSelfValidation: true } }),
      route({ id: "greedy", path: "/greedy", misbehave: { advertisedPriceUnits: 10_000n } }),
      route({ id: "redirect", path: "/redirect", misbehave: { advertisedPayTo: altPayTo } }),
      route({
        id: "echo",
        method: "POST",
        path: "/echo",
        inputSchema: { type: "object", required: ["n"], properties: { n: { type: "integer" } } },
      }),
    ],
  });
  const started = await listen(seller.app);
  base = started.base;
  close = () => started.server.close();
});
after(() => close());

const settles = () => facilitator.settleCalls.length;

describe("402 Payment Required", () => {
  it("answers an unpaid request with a standard x402 v2 PAYMENT-REQUIRED header", async () => {
    const res = await fetch(`${base}/square?n=3`);
    assert.equal(res.status, 402);
    const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    assert.equal(required.x402Version, 2);
    assert.equal(required.accepts.length, 1);
    const [accept] = required.accepts;
    assert.equal(accept!.scheme, "exact");
    assert.equal(accept!.network, NETWORK);
    assert.equal(accept!.amount, "1000");
    assert.equal(accept!.asset, USDC_ADDRESS);
    assert.equal(accept!.payTo, payTo);
    assert.equal(accept!.maxTimeoutSeconds, MAX_TIMEOUT_SECONDS);
    assert.equal(accept!.extra.name, "USDC");
    assert.equal(accept!.extra.version, "2");
    assert.equal(accept!.extra.assetTransferMethod, "eip3009");
    assert.ok(required.resource.url.includes("/square"));
  });

  it("rejects invalid input with 400 before asking for payment", async () => {
    const res = await fetch(`${base}/square?n=abc`);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("PAYMENT-REQUIRED"), null);
    assert.equal((await body(res)).error, "invalid_input");
  });

  it("fixtures can advertise a different price or payTo than they list (for buyer price-check tests)", async () => {
    const greedy = decodePaymentRequiredHeader((await fetch(`${base}/greedy?n=1`)).headers.get("PAYMENT-REQUIRED")!);
    assert.equal(greedy.accepts[0]!.amount, "10000");
    const redirect = decodePaymentRequiredHeader((await fetch(`${base}/redirect?n=1`)).headers.get("PAYMENT-REQUIRED")!);
    assert.equal(redirect.accepts[0]!.payTo, altPayTo);
  });
});

describe("paid calls", () => {
  it("returns the result and a PAYMENT-RESPONSE with the transaction, settling once", async () => {
    const buyer = testBuyer();
    const sig = await signFor(buyer, `${base}/square?n=7`);
    const s0 = settles();
    const res = await fetch(`${base}/square?n=7`, { headers: sig.headers });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { square: 49 });
    const settle = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    assert.equal(settle.success, true);
    assert.match(settle.transaction, /^0x[0-9a-f]{64}$/);
    assert.equal(settles() - s0, 1);
  });

  it("works with an unmodified @x402/fetch client", async () => {
    const buyer = testBuyer();
    const payFetch = wrapFetchWithPayment(fetch, buyer.client);
    const res = await payFetch(`${base}/square?n=12`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { square: 144 });
  });

  it("supports POST routes with a JSON body", async () => {
    const buyer = testBuyer();
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: 5 }) };
    const sig = await signFor(buyer, `${base}/echo`, init);
    const res = await fetch(`${base}/echo`, { ...init, headers: { ...init.headers, ...sig.headers } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { square: 25 });
  });
});

describe("replay protection", () => {
  it("one payment sent twice in a row: one result, then 409, one settlement", async () => {
    const buyer = testBuyer();
    const sig = await signFor(buyer, `${base}/square?n=2`);
    const s0 = settles();
    const first = await fetch(`${base}/square?n=2`, { headers: sig.headers });
    const second = await fetch(`${base}/square?n=2`, { headers: sig.headers });
    assert.equal(first.status, 200);
    assert.equal(second.status, 409);
    assert.equal((await body(second)).error, "payment_already_used");
    assert.equal(settles() - s0, 1);
  });

  it("one payment sent 5 times in parallel: exactly one result and one settlement; handler runs once", async () => {
    const buyer = testBuyer();
    const sig = await signFor(buyer, `${base}/square?n=9`);
    const s0 = settles();
    const runs0 = handlerRuns;
    const responses = await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/square?n=9`, { headers: sig.headers })));
    const statuses = responses.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409, 409, 409, 409]);
    assert.equal(settles() - s0, 1);
    assert.equal(handlerRuns - runs0, 1);
  });

  it("a replay on a different route is still refused (the nonce is spent, not the URL)", async () => {
    const buyer = testBuyer();
    const sig = await signFor(buyer, `${base}/square?n=4`);
    assert.equal((await fetch(`${base}/square?n=4`, { headers: sig.headers })).status, 200);
    assert.equal((await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "application/json", ...sig.headers }, body: '{"n":4}' })).status, 409);
  });
});

describe("no service, no charge", () => {
  it("a handler error is returned and never settled", async () => {
    const buyer = testBuyer();
    const sig = await signFor(buyer, `${base}/missing?n=1`);
    const v0 = facilitator.verifyCalls.length;
    const s0 = settles();
    const res = await fetch(`${base}/missing?n=1`, { headers: sig.headers });
    assert.equal(res.status, 404);
    const payload = await body(res);
    assert.equal(payload.error, "page_not_found");
    assert.equal(payload.charged, false);
    assert.equal(facilitator.verifyCalls.length - v0, 1, "payment was verified before the handler ran");
    assert.equal(settles() - s0, 0);
  });

  it("a timeout returns 504 and is never settled", async () => {
    const buyer = testBuyer();
    const sig = await signFor(buyer, `${base}/slow?n=1`);
    const s0 = settles();
    const res = await fetch(`${base}/slow?n=1`, { headers: sig.headers });
    assert.equal(res.status, 504);
    assert.equal(settles() - s0, 0);
  });

  it("output that breaks the seller's own schema returns 500 and is never settled", async () => {
    const buyer = testBuyer();
    const sig = await signFor(buyer, `${base}/broken?n=1`);
    const s0 = settles();
    const res = await fetch(`${base}/broken?n=1`, { headers: sig.headers });
    assert.equal(res.status, 500);
    assert.equal((await body(res)).error, "output_failed_self_check");
    assert.equal(settles() - s0, 0);
  });

  it("a failed verification never reaches the handler or settlement", async () => {
    const buyer = testBuyer();
    const sig = await signFor(buyer, `${base}/square?n=3`);
    facilitator.verifyResult = { isValid: false, invalidReason: "insufficient_funds" };
    const runs0 = handlerRuns;
    const s0 = settles();
    try {
      const res = await fetch(`${base}/square?n=3`, { headers: sig.headers });
      assert.equal(res.status, 402);
      assert.equal(decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!).error, "insufficient_funds");
    } finally {
      facilitator.verifyResult = {};
    }
    assert.equal(handlerRuns - runs0, 0);
    assert.equal(settles() - s0, 0);
  });
});

describe("junk fixture", () => {
  it("settles schema-breaking output on purpose (so buyers can test 'paid, output rejected')", async () => {
    const buyer = testBuyer();
    const sig = await signFor(buyer, `${base}/junk?n=1`);
    const s0 = settles();
    const res = await fetch(`${base}/junk?n=1`, { headers: sig.headers });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { junk: true });
    assert.equal(settles() - s0, 1);
  });
});

// The seller-selection rules R1-R8 and the relaxed fallback, one at a time.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NETWORK, USDC_ADDRESS, type Reputation, type ServiceView } from "@dron/shared";
import { confidentSuccess, selectSellers, type SelectionContext } from "../../apps/buyer/src/selection.ts";
import { scrapeNeed } from "../../apps/buyer/src/needs.ts";
import { randomPayTo } from "./helpers.ts";
import { compileSchema } from "@dron/shared";

const BUYER = randomPayTo();
const OUT = { type: "object", properties: { books: { type: "array", items: { type: "object", properties: { title: {}, priceGbp: {}, rating: {} } } } } };

function seller(id: string, over: Partial<ServiceView> & { rep?: Partial<Reputation> } = {}): ServiceView {
  const { rep, ...rest } = over;
  return {
    id,
    sellerId: id,
    name: id,
    category: "scraping",
    description: "",
    endpoint: `https://${id}.example/scrape`,
    method: "GET",
    priceUnits: "5000",
    network: NETWORK,
    asset: USDC_ADDRESS,
    payTo: randomPayTo(),
    inputSchema: { type: "object", properties: { page: { type: "integer" } } },
    outputSchema: OUT,
    priceUsdc: "0.005",
    reputation: { calls: 0, successes: 0, successRate: 2 / 3, medianLatencyMs: null, failStreak: 0, ...rep },
    costPerSuccessUnits: "7500",
    registeredBy: "admin",
    createdAt: "",
    updatedAt: "",
    ...rest,
  } as ServiceView;
}

const ctx = (over: Partial<SelectionContext> = {}): SelectionContext => ({
  prefer: [],
  only: [],
  excluded: new Map(),
  accepts: (s, input) => compileSchema(s.inputSchema)(structuredClone(input)),
  buyer: BUYER,
  ...over,
});
const need = scrapeNeed(null, 1);
const ids = (sel: ReturnType<typeof selectSellers>) => sel.candidates.map((c) => c.listing.id);
const skippedBy = (sel: ReturnType<typeof selectSellers>, rule: string) => sel.skipped.filter((s) => s.rule === rule).map((s) => s.serviceId);

describe("R1 caller intent", () => {
  it("only_sellers restricts the category; prefer_sellers go first; fixtures only when named", () => {
    const services = [seller("a"), seller("b"), seller("fx", { isFixture: true })];
    assert.deepEqual(ids(selectSellers(need, services, ctx({ only: ["b"] }))), ["b"]);
    assert.deepEqual(ids(selectSellers(need, services, ctx({ prefer: ["b"] })))[0], "b");
    assert.deepEqual(skippedBy(selectSellers(need, services, ctx()), "R1"), ["fx"]);
    assert.ok(ids(selectSellers(need, services, ctx({ prefer: ["fx"] }))).includes("fx"));
  });
});

describe("R2 contract fit", () => {
  it("skips sellers whose input schema rejects the request or whose output does not promise the fields", () => {
    const strictInput = seller("strict", { inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } } } });
    const vagueOutput = seller("vague", { outputSchema: { type: "object" } });
    const sel = selectSellers(need, [strictInput, vagueOutput, seller("good")], ctx());
    assert.deepEqual(ids(sel), ["good"]);
    assert.deepEqual(skippedBy(sel, "R2").sort(), ["strict", "vague"]);
  });
  it("a preferred seller is exempt from the output promise (it is checked on arrival)", () => {
    assert.deepEqual(ids(selectSellers(need, [seller("vague", { outputSchema: { type: "object" } })], ctx({ prefer: ["vague"] }))), ["vague"]);
  });
});

describe("R3 safe listing (never relaxed)", () => {
  const cases: [string, Partial<ServiceView>][] = [
    ["pays the buyer itself", { payTo: BUYER }],
    ["pays the zero address", { payTo: "0x0000000000000000000000000000000000000000" }],
    ["costs over the 0.10 cap", { priceUnits: "100001" }],
    ["is on mainnet", { network: "eip155:8453" as ServiceView["network"] }],
    ["uses another token", { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }],
    ["is plain http off loopback", { endpoint: "http://evil.example/scrape" }],
  ];
  for (const [label, patch] of cases) {
    it(`skips a seller that ${label}, even when it is the only one and even when preferred`, () => {
      const sel = selectSellers(need, [seller("x", patch)], ctx({ prefer: ["x"] }));
      assert.deepEqual(ids(sel), []);
      assert.deepEqual(skippedBy(sel, "R3"), ["x"]);
      assert.deepEqual(sel.relaxed, []);
    });
  }
});

describe("R4 affordability", () => {
  it("skips what can never fit, and ranks 'fits once held money returns' after 'fits now'", () => {
    const cheap = seller("cheap", { priceUnits: "3000" });
    const pricey = seller("pricey", { priceUnits: "6000", rep: { calls: 50, successes: 50, successRate: 52 / 53 } }); // better value, but...
    const huge = seller("huge", { priceUnits: "20000" });
    const sel = selectSellers(need, [cheap, pricey, huge], ctx({ budget: { remaining: 4000n, reserved: 6000n } }));
    assert.deepEqual(skippedBy(sel, "R4"), ["huge"]);
    assert.deepEqual(ids(sel), ["cheap", "pricey"], "pricey must wait for held money, so cheap goes first");
    assert.match(sel.candidates[1]!.why, /R4: fits once/);
  });
});

describe("R5 fair price", () => {
  it("skips a seller over 3x the median when fairly priced ones exist", () => {
    const sel = selectSellers(need, [seller("a", { priceUnits: "2000" }), seller("b", { priceUnits: "2500" }), seller("gouge", { priceUnits: "20000" })], ctx());
    assert.deepEqual(skippedBy(sel, "R5"), ["gouge"]);
  });
  it("keeps an expensive seller when it is the only one", () => {
    assert.deepEqual(ids(selectSellers(need, [seller("only", { priceUnits: "90000" })], ctx())), ["only"]);
  });
});

describe("R6 trust floor", () => {
  it("excludes a seller with enough evidence of failure, but not a new one", () => {
    const bad = seller("bad", { priceUnits: "1000", rep: { calls: 10, successes: 2, successRate: 4 / 13 } });
    const fresh = seller("fresh", { priceUnits: "5000" });
    const sel = selectSellers(need, [bad, fresh], ctx());
    assert.deepEqual(ids(sel), ["fresh"]);
    assert.deepEqual(skippedBy(sel, "R6"), ["bad"]);
  });
  it("puts a seller on cool-down after 3 failures in a row (ranked last, not removed)", () => {
    const streaky = seller("streaky", { priceUnits: "1000", rep: { calls: 30, successes: 25, successRate: 27 / 33, failStreak: 3 } });
    const sel = selectSellers(need, [streaky, seller("steady", { priceUnits: "5000" })], ctx());
    assert.deepEqual(ids(sel), ["steady", "streaky"]);
    assert.match(sel.candidates[1]!.why, /cool-down/);
  });
  it("a strike earlier in this task excludes", () => {
    const sel = selectSellers(need, [seller("a"), seller("b")], ctx({ excluded: new Map([["a", "returned junk"]]) }));
    assert.deepEqual(ids(sel), ["b"]);
    assert.match(sel.skipped[0]!.reason, /struck in this task/);
  });
});

describe("R7 best value", () => {
  it("discounts thin evidence: one success beats no data, fifty beat one", () => {
    assert.ok(confidentSuccess(0, 0, 1) < confidentSuccess(1, 1, 1));
    assert.ok(confidentSuccess(1, 1, 1) < confidentSuccess(50, 50, 1));
    assert.ok(confidentSuccess(5, 10, 1) < 0.5);
  });
  it("a proven seller can beat a cheaper unknown one, and a much cheaper unknown still wins", () => {
    const proven = seller("proven", { priceUnits: "5000", rep: { calls: 60, successes: 60, successRate: 62 / 63, medianLatencyMs: 800 } });
    assert.equal(ids(selectSellers(need, [proven, seller("unknown", { priceUnits: "3000" })], ctx()))[0], "proven");
    assert.equal(ids(selectSellers(need, [proven, seller("bargain", { priceUnits: "1000" })], ctx()))[0], "bargain");
  });
  it("time costs: same price and record, the faster seller wins", () => {
    const rep = { calls: 20, successes: 20, successRate: 22 / 23 };
    const slow = seller("slow", { rep: { ...rep, medianLatencyMs: 9000 } });
    const fast = seller("fast", { rep: { ...rep, medianLatencyMs: 600 } });
    assert.deepEqual(ids(selectSellers(need, [slow, fast], ctx({ config: { spreadTolerance: 0 } }))), ["fast", "slow"]);
  });
});

describe("R8 spread near-ties across parallel steps", () => {
  const twins = [seller("twin-a"), seller("twin-b"), seller("far", { priceUnits: "9000" })];
  it("rotates sellers within 10% of the best by step position", () => {
    const firsts = [1, 2, 3, 4].map((page) => ids(selectSellers(scrapeNeed(null, page), twins, ctx()))[0]);
    assert.deepEqual(firsts, ["twin-b", "twin-a", "twin-b", "twin-a"]);
    assert.match(selectSellers(scrapeNeed(null, 2), twins, ctx()).candidates[0]!.why, /R8/);
  });
  it("never rotates in a seller outside the tolerance, and can be switched off", () => {
    const firsts = [1, 2, 3, 4].map((page) => ids(selectSellers(scrapeNeed(null, page), twins, ctx()))[0]);
    assert.ok(!firsts.includes("far"));
    const off = [1, 2].map((page) => ids(selectSellers(scrapeNeed(null, page), twins, ctx({ config: { spreadTolerance: 0 } })))[0]);
    assert.deepEqual(off, ["twin-a", "twin-a"]);
  });
});

describe("fallback: relax soft rules only when nothing else is left", () => {
  it("when every seller fails a soft rule, the best of them is still offered, with the relaxed rule named", () => {
    const sel = selectSellers(need, [seller("tired", { rep: { calls: 10, successes: 3, successRate: 5 / 13 } })], ctx());
    assert.deepEqual(ids(sel), ["tired"]);
    assert.deepEqual(sel.relaxed, ["R6"]);
    assert.match(sel.candidates[0]!.why, /relaxed R6/);
  });
  it("hard rules are never relaxed", () => {
    const sel = selectSellers(need, [seller("self", { payTo: BUYER }), seller("bad", { rep: { calls: 10, successes: 1, successRate: 3 / 13 } })], ctx());
    assert.deepEqual(ids(sel), ["bad"], "the unsafe one stays out; the untrusted one is offered as a relaxed fallback");
    assert.deepEqual(skippedBy(sel, "R3"), ["self"]);
  });
  it("over budget everywhere: still offers the cheapest, so the refusal is recorded and the shortfall reported", () => {
    const sel = selectSellers(need, [seller("a", { priceUnits: "5000" }), seller("b", { priceUnits: "7000" })], ctx({ budget: { remaining: 1000n, reserved: 0n } }));
    assert.deepEqual(ids(sel)[0], "a");
    assert.deepEqual(sel.relaxed, ["R4"]);
  });
});

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORK, USDC_ADDRESS, type Listing } from "@dron/shared";
import { createRegistryApp } from "../../apps/registry/src/app.ts";
import { openRegistryDb } from "../../apps/registry/src/db.ts";
import { validateListing } from "../../apps/registry/src/validation.ts";
import { body, listen, makeRow, postRow, randomPayTo } from "./helpers.ts";

const valid = () => ({
  id: "my-scraper",
  name: "my scraper",
  category: "scraping",
  description: "scrapes",
  endpoint: "https://scraper.example.com/scrape",
  method: "GET",
  price: "0.002",
  payTo: randomPayTo(),
  inputSchema: { type: "object" },
  outputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
});

describe("listing validation", () => {
  const opts = { admin: false, allowLoopback: false };

  it("accepts a valid listing and normalises price, network and asset", () => {
    const r = validateListing(valid(), opts);
    assert.ok(r.ok);
    assert.equal(r.listing.priceUnits, "2000");
    assert.equal(r.listing.network, NETWORK);
    assert.equal(r.listing.asset, USDC_ADDRESS);
  });

  const rejects: [string, Record<string, unknown>][] = [
    ["price above 0.10 USDC", { price: "0.11" }],
    ["zero price", { priceUnits: "0" }],
    ["too many decimals", { price: "0.0000001" }],
    ["mainnet network", { network: "eip155:8453" }],
    ["another token", { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }],
    ["bad payTo", { payTo: "0x123" }],
    ["plain http endpoint", { endpoint: "http://scraper.example.com/scrape" }],
    ["credentials in URL", { endpoint: "https://user:pw@scraper.example.com/" }],
    ["unknown category", { category: "gambling" }],
    ["schema that does not compile", { inputSchema: { type: "nonsense" } }],
    ["bad id", { id: "My Scraper!" }],
  ];
  for (const [label, patch] of rejects) {
    it(`rejects ${label}`, () => {
      const r = validateListing({ ...valid(), ...patch }, opts);
      assert.equal(r.ok, false);
    });
  }

  it("allows http://localhost only when loopback is enabled", () => {
    const local = { ...valid(), endpoint: "http://localhost:4101/scrape" };
    assert.equal(validateListing(local, opts).ok, false);
    assert.equal(validateListing(local, { ...opts, allowLoopback: true }).ok, true);
  });

  it("only admins can mark a listing as a fixture", () => {
    const r1 = validateListing({ ...valid(), isFixture: true }, opts);
    const r2 = validateListing({ ...valid(), isFixture: true }, { ...opts, admin: true });
    assert.ok(r1.ok && r2.ok);
    assert.equal(r1.listing.isFixture, undefined);
    assert.equal(r2.listing.isFixture, true);
  });
});

describe("registry API", () => {
  let base = "";
  let server: Server;
  const db = openRegistryDb(":memory:");
  const admin = { authorization: "Bearer test-admin-token", "content-type": "application/json" };
  const json = { "content-type": "application/json" };

  before(async () => {
    const app = createRegistryApp({ db, log: { debug() {}, info() {}, warn() {}, error() {} }, adminToken: "test-admin-token", allowLoopback: true });
    ({ server, base } = await listen(app));
  });
  after(() => server.close());

  const post = (body: unknown, headers: Record<string, string> = json) =>
    fetch(`${base}/api/services`, { method: "POST", headers, body: JSON.stringify(body) });

  it("registers, then refuses a public overwrite of the same id (listing hijack)", async () => {
    const first = await post(valid());
    assert.equal(first.status, 201);
    const hijack = await post({ ...valid(), payTo: randomPayTo() });
    assert.equal(hijack.status, 409);
  });

  it("lets the admin token update a listing", async () => {
    const res = await post({ ...valid(), price: "0.003" }, admin);
    assert.equal(res.status, 200);
    assert.equal((await body(res)).priceUnits, "3000");
  });

  it("searches by category and max price, and hides fixtures unless asked", async () => {
    await post({ ...valid(), id: "fx", category: "data", price: "0.001" });
    await post({ ...valid(), id: "llm", category: "inference", price: "0.01" });
    await post({ ...valid(), id: "chaos", price: "0.001", isFixture: true }, admin);

    const data = await body(await fetch(`${base}/api/services?category=data`));
    assert.deepEqual(data.services.map((s: { id: string }) => s.id), ["fx"]);

    const cheap = await body(await fetch(`${base}/api/services?maxPrice=0.003`));
    assert.deepEqual(cheap.services.map((s: { id: string }) => s.id).sort(), ["fx", "my-scraper"]);

    const withFixtures = await body(await fetch(`${base}/api/services?maxPrice=0.001&includeFixtures=true`));
    assert.deepEqual(withFixtures.services.map((s: { id: string }) => s.id).sort(), ["chaos", "fx"]);

    assert.equal((await fetch(`${base}/api/services?category=nope`)).status, 400);
    assert.equal((await fetch(`${base}/api/services?maxPrice=-1`)).status, 400);
  });

  it("starts new sellers at the neutral prior and moves with the ledger", async () => {
    const fresh = await body(await fetch(`${base}/api/services/fx`));
    assert.equal(fresh.reputation.calls, 0);
    assert.ok(Math.abs(fresh.reputation.successRate - 2 / 3) < 1e-9);

    const buyer = privateKeyToAccount(generatePrivateKey());
    const fx = (await body(await fetch(`${base}/api/services/fx`))) as Listing;
    const now = Date.now();
    const rows = [
      makeRow(buyer.address, fx, { status: "paid", latencyMs: 100, time: new Date(now).toISOString() }),
      makeRow(buyer.address, fx, { status: "paid", latencyMs: 300, time: new Date(now + 1).toISOString() }),
      makeRow(buyer.address, fx, { status: "paid_output_rejected", reasonCode: "output_invalid", latencyMs: 200, time: new Date(now + 2).toISOString() }),
      // a refusal caused by the buyer's own budget is not the seller's fault
      makeRow(buyer.address, fx, { status: "refused", reasonCode: "budget", paidUnits: "0", txHash: null, explorerUrl: null, time: new Date(now + 3).toISOString() }),
    ];
    for (const row of rows) {
      const res = await postRow(base, buyer, row);
      assert.equal(res.status, 201, JSON.stringify(await body(res)));
    }

    const rep = await body(await fetch(`${base}/api/sellers/fx/reputation`));
    assert.equal(rep.calls, 3);
    assert.equal(rep.successes, 2);
    assert.ok(Math.abs(rep.successRate - 4 / 6) < 1e-9);
    const svc = await body(await fetch(`${base}/api/services/fx`));
    assert.equal(svc.reputation.medianLatencyMs, 200);
  });

  it("only the admin can delete", async () => {
    assert.equal((await fetch(`${base}/api/services/llm`, { method: "DELETE" })).status, 401);
    assert.equal((await fetch(`${base}/api/services/llm`, { method: "DELETE", headers: admin })).status, 204);
  });
});

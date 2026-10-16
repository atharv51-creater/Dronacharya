import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createSeller, mountAt } from "@dron/x402-kit";
import { createGateway, match, parseRoutes } from "../../apps/gateway/src/proxy.ts";
import { createRegistryApp } from "../../apps/registry/src/app.ts";
import { openRegistryDb } from "../../apps/registry/src/db.ts";
import { createBuyerApp } from "../../apps/buyer/src/app.ts";
import { MockFacilitator, body, listen, randomPayTo, testBuyer } from "./helpers.ts";
import { manager, silent, startMarket, type Market } from "./agent-harness.ts";

const PUBLIC_HOST = "market.example.test";
const servers: Server[] = [];
let gateway = "";
let sellerDirect = "";
let market: Market;

async function serve(app: { listen: (port: number, cb: () => void) => Server }) {
  const s = await listen(app);
  servers.push(s.server);
  return s.base;
}

before(async () => {
  // A seller whose public URL has a path, exactly as deploy:configure sets it.
  const seller = createSeller({
    sellerId: "sq",
    publicUrl: `https://${PUBLIC_HOST}/scraper`,
    payTo: randomPayTo(),
    facilitator: new MockFacilitator(),
    replayDbPath: ":memory:",
    log: silent,
    routes: [
      {
        id: "sq",
        name: "sq",
        category: "data",
        description: "squares",
        method: "GET",
        path: "/scrape",
        priceUnits: 1000n,
        inputSchema: { type: "object", properties: { n: { type: "integer" } } },
        outputSchema: { type: "object", required: ["square"], properties: { square: { type: "integer" } } },
        handler: async ({ n }: { n: number }) => ({ square: n * n }),
      },
    ],
  });
  sellerDirect = await serve(seller.app);
  const registryBase = await serve(mountAt(createRegistryApp({ db: openRegistryDb(":memory:"), log: silent, adminToken: "gw-admin", allowLoopback: true }), "/registry"));

  market = await startMarket();
  const buyerBase = await serve(mountAt(createBuyerApp({ manager: manager(market), log: silent, apiToken: "gw-buyer-token", registryUrl: market.registry, allowLoopback: true }), "/buyer"));

  const routes = parseRoutes(`/scraper=${sellerDirect},/registry=${registryBase},/buyer=${buyerBase},/down=http://127.0.0.1:1`);
  const gw = createGateway(routes);
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", () => r()));
  servers.push(gw);
  gateway = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;
});

after(() => {
  market.close();
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
});

// What a tunnel does: the client's Host and https arrive in headers.
// (fetch cannot set Host, so the public host travels in X-Forwarded-Host, as many tunnels send it)
const viaTunnel = { "x-forwarded-host": PUBLIC_HOST, "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.50" };

describe("gateway + base paths", () => {
  it("a seller behind /scraper answers 402 with its PUBLIC https URL as resource.url", async () => {
    const res = await fetch(`${gateway}/scraper/scrape?n=3`, { headers: viaTunnel });
    assert.equal(res.status, 402);
    const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    assert.equal(required.resource.url, `https://${PUBLIC_HOST}/scraper/scrape?n=3`);
  });

  it("an unmodified @x402/fetch client pays through the gateway", async () => {
    const buyer = testBuyer();
    const tunnelFetch: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      for (const [k, v] of Object.entries(viaTunnel)) request.headers.set(k, v);
      return fetch(request);
    };
    const pay = wrapFetchWithPayment(tunnelFetch, buyer.client);
    const res = await pay(`${gateway}/scraper/scrape?n=12`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { square: 144 });
    assert.ok(res.headers.get("PAYMENT-RESPONSE"));
  });

  it("the same seller still answers locally without the prefix", async () => {
    assert.equal((await fetch(`${sellerDirect}/scrape?n=2`)).status, 402);
    assert.equal((await fetch(`${sellerDirect}/health`)).status, 200);
  });

  it("pages redirect to a trailing slash so relative links work; / goes to the registry", async () => {
    const page = await fetch(`${gateway}/registry`, { redirect: "manual" });
    assert.equal(page.status, 301);
    assert.equal(page.headers.get("location"), "/registry/");
    const home = await fetch(`${gateway}/`, { redirect: "manual" });
    assert.equal(home.headers.get("location"), "/registry/");
    const html = await (await fetch(`${gateway}/registry/ledger`)).text();
    assert.match(html, /Dronacharya Ledger/);
    assert.equal((await fetch(`${gateway}/registry/api/health`)).status, 200);
  });

  it("streams Server-Sent Events through without buffering", async () => {
    const stream = await fetch(`${gateway}/registry/api/ledger/stream`);
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /connected/);
    await reader.cancel();
  });

  it("the buyer API treats gateway traffic as remote: the token is required even though the socket is loopback", async () => {
    const task = { task: "From page 1 of books.toscrape.com, find the cheapest book.", budget: "0.01", dry_run: true };
    const anon = await fetch(`${gateway}/buyer/api/tasks`, { method: "POST", headers: { ...viaTunnel, "content-type": "application/json" }, body: JSON.stringify(task) });
    assert.equal(anon.status, 401);
    const authed = await fetch(`${gateway}/buyer/api/tasks`, { method: "POST", headers: { ...viaTunnel, "content-type": "application/json", authorization: "Bearer gw-buyer-token" }, body: JSON.stringify(task) });
    assert.equal(authed.status, 202);
    assert.equal((await body(await fetch(`${gateway}/buyer/api/meta`, { headers: viaTunnel }))).authRequired, true);
  });

  it("unknown prefixes are 404 and a down service is a clean 502", async () => {
    assert.equal((await fetch(`${gateway}/nope/x`)).status, 404);
    const down = await fetch(`${gateway}/down/x`);
    assert.equal(down.status, 502);
    assert.equal((await body(down)).error, "service_unavailable");
  });

  it("matches the longest prefix and never a mere string prefix", () => {
    const routes = parseRoutes("/buy=http://a:1,/buyer=http://b:2");
    assert.equal(match(routes, "/buyer/api")?.target.host, "b:2");
    assert.equal(match(routes, "/buy/x")?.target.host, "a:1");
    assert.equal(match(routes, "/buyerx/api"), undefined);
  });
});

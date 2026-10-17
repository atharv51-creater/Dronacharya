// GET /api/auth/mode: tells the UI how it may run Scout, using the buyer's own loopback rule.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBuyerApp } from "../../apps/buyer/src/app.ts";
import { createGateway } from "../../apps/gateway/src/proxy.ts";
import { manager, silent, startMarket, type Market } from "./agent-harness.ts";
import { body, listen } from "./helpers.ts";

let market: Market;
const closers: (() => void)[] = [];
before(async () => (market = await startMarket()));
after(() => {
  closers.forEach((c) => c());
  market.close();
});

async function buyer(opts: { allowLoopback: boolean; apiToken?: string }) {
  const m = manager(market, { balanceOf: async () => 20_000_000n, maxBudgetUnits: 500_000n });
  const { server, base } = await listen(createBuyerApp({ manager: m, log: silent, apiToken: opts.apiToken, registryUrl: market.registry, allowLoopback: opts.allowLoopback }));
  closers.push(() => (server.closeAllConnections?.(), server.close()));
  return base;
}

describe("GET /api/auth/mode", () => {
  it("is local for a direct loopback request, with limits and balance", async () => {
    const base = await buyer({ allowLoopback: true, apiToken: "t0ken" });
    const mode = await body(await fetch(`${base}/api/auth/mode`));
    assert.equal(mode.local, true);
    assert.equal(mode.token, true);
    assert.equal(mode.maxBudgetUsdc, "0.5");
    assert.equal(mode.walletBalanceUsdc, "20");
  });

  it("is not local when the request was forwarded, and such a POST without auth is refused", async () => {
    const base = await buyer({ allowLoopback: true });
    const variants: Record<string, string>[] = [{ "x-forwarded-for": "1.2.3.4" }, { forwarded: "for=1.2.3.4" }, { "x-real-ip": "1.2.3.4" }];
    for (const h of variants) {
      assert.equal((await body(await fetch(`${base}/api/auth/mode`, { headers: h }))).local, false, JSON.stringify(h));
    }
    const res = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" }, body: JSON.stringify({ task: "x", budget: "0.01", dry_run: true }) });
    assert.equal(res.status, 401);
  });

  it("a page from another site is never local (no drive-by spending from the operator's browser)", async () => {
    const base = await buyer({ allowLoopback: true });
    assert.equal((await body(await fetch(`${base}/api/auth/mode`, { headers: { origin: "https://evil.example" } }))).local, false);
    assert.equal((await body(await fetch(`${base}/api/auth/mode`, { headers: { origin: "http://localhost:5173" } }))).local, true);
    const res = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ task: "x", budget: "0.01", dry_run: true }) });
    assert.equal(res.status, 401);
  });

  it("is never local through the gateway (the public origin)", async () => {
    const base = await buyer({ allowLoopback: true, apiToken: "t0ken" });
    const gw = await listen(createGateway([], { log: () => {}, api: { registry: new URL(base), buyer: new URL(base), buyerToken: "t0ken", dailyCapUnits: 200_000n } }));
    closers.push(() => gw.server.close());
    const mode = await body(await fetch(`${gw.base}/api/auth/mode`));
    assert.equal(mode.local, false);
    assert.equal(mode.token, true);
  });

  it("does not report local when loopback trust is off", async () => {
    const base = await buyer({ allowLoopback: false });
    assert.equal((await body(await fetch(`${base}/api/auth/mode`))).local, false);
  });
});

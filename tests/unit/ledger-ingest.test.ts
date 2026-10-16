// Registry ledger ingestion: signed rows only, legal transitions only, consistent amounts only.
// Ends with the real path: a Buyer pays a seller and its RegistryLedgerSink reports to the registry.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORK, sessionMessage, type Listing } from "@dron/shared";
import { Budget, Buyer, MemoryLedger, RegistryLedgerSink, createSeller, type ChainOps } from "@dron/x402-kit";
import { createRegistryApp } from "../../apps/registry/src/app.ts";
import { openRegistryDb } from "../../apps/registry/src/db.ts";
import { MockFacilitator, body, listen, makeRow, postRow, randomPayTo } from "./helpers.ts";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const ADMIN = { authorization: "Bearer t0ken-for-tests", "content-type": "application/json" };

let base = "";
let sellerBase = "";
const servers: Server[] = [];
let listing: Listing;
const buyerAccount = privateKeyToAccount(generatePrivateKey());
const mallory = privateKeyToAccount(generatePrivateKey());

before(async () => {
  const registry = createRegistryApp({ db: openRegistryDb(":memory:"), log: silent, adminToken: "t0ken-for-tests", allowLoopback: true });
  const r = await listen(registry);
  servers.push(r.server);
  base = r.base;

  const seller = createSeller({
    sellerId: "sq",
    publicUrl: "http://127.0.0.1:0",
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
        path: "/sq",
        priceUnits: 1000n,
        inputSchema: { type: "object", properties: { n: { type: "integer" } } },
        outputSchema: { type: "object", required: ["square"], properties: { square: { type: "integer" } } },
        handler: async ({ n }: { n: number }) => ({ square: n * n }),
      },
    ],
  });
  const s = await listen(seller.app);
  servers.push(s.server);
  sellerBase = s.base;
  const l = seller.listings[0]!;
  const reg = await fetch(`${base}/api/services`, {
    method: "POST",
    headers: ADMIN,
    body: JSON.stringify({ ...l, endpoint: l.endpoint.replace("http://127.0.0.1:0", sellerBase) }),
  });
  listing = (await body(reg)) as Listing;
});

after(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
});

describe("ledger ingestion", () => {
  it("accepts a row signed by the buyer it names", async () => {
    const row = makeRow(buyerAccount.address, listing);
    const res = await postRow(base, buyerAccount, row);
    assert.equal(res.status, 201);
    const stored = await body(await fetch(`${base}/api/ledger/${row.id}`));
    assert.equal(stored.status, "paid");
    assert.equal(stored.paidUnits, "1000");
  });

  it("rejects a row signed by someone else (no framing sellers in another buyer's name)", async () => {
    const res = await postRow(base, mallory, makeRow(buyerAccount.address, listing));
    assert.equal(res.status, 401);
  });

  it("rejects a row altered after signing", async () => {
    const row = makeRow(buyerAccount.address, listing, { status: "paid_output_rejected", reasonCode: "output_invalid" });
    const res = await postRow(base, buyerAccount, { ...row, status: "paid", reasonCode: "ok" }, row);
    assert.equal(res.status, 401);
  });

  it("rejects rows for services that are not listed", async () => {
    const res = await postRow(base, buyerAccount, makeRow(buyerAccount.address, { ...listing, id: "ghost" }));
    assert.equal(res.status, 404);
  });

  const inconsistent: [string, Parameters<typeof makeRow>[2]][] = [
    ["paying more than the listed price", { askedUnits: "2000", paidUnits: "2000" }],
    ["paid units that differ from the asked amount", { paidUnits: "999" }],
    ["a refused row that claims money moved", { status: "refused", reasonCode: "price_above_listing" }],
    ["a pending row without a nonce", { status: "pending", paidUnits: "0", nonce: null }],
  ];
  for (const [label, patch] of inconsistent) {
    it(`rejects ${label}`, async () => {
      const res = await postRow(base, buyerAccount, makeRow(buyerAccount.address, listing, patch));
      assert.equal(res.status, 400, JSON.stringify(await body(res)));
    });
  }

  it("upserts pending -> final, but never final -> pending or a change of identity", async () => {
    const pending = makeRow(buyerAccount.address, listing, { status: "pending", reasonCode: "no_response", paidUnits: "0", txHash: null, explorerUrl: null });
    assert.equal((await postRow(base, buyerAccount, pending)).status, 201);

    const later = (ms: number) => new Date(Date.now() + ms).toISOString();
    const final = { ...pending, status: "failed_not_charged" as const, onchainConfirmed: true, updatedAt: later(1000) };
    assert.equal((await postRow(base, buyerAccount, final)).status, 200);

    const backwards = { ...final, status: "pending" as const, updatedAt: later(2000) };
    assert.equal((await postRow(base, buyerAccount, backwards)).status, 409);

    const moved = { ...final, serviceId: "other", updatedAt: later(3000) };
    assert.notEqual((await postRow(base, buyerAccount, moved)).status, 200);

    const hijack = { ...final, buyer: mallory.address, updatedAt: later(4000) };
    assert.equal((await postRow(base, mallory, hijack)).status, 403);
  });

  it("records a seller caught settling after claiming failure (failed_not_charged -> paid_output_rejected)", async () => {
    const failed = makeRow(buyerAccount.address, listing, { status: "failed_not_charged", reasonCode: "seller_error", paidUnits: "0", txHash: null, explorerUrl: null });
    assert.equal((await postRow(base, buyerAccount, failed)).status, 201);
    const caught = { ...failed, status: "paid_output_rejected" as const, reasonCode: "settled_despite_error" as const, paidUnits: "1000", updatedAt: new Date(Date.now() + 1000).toISOString() };
    assert.equal((await postRow(base, buyerAccount, caught)).status, 200);
  });

  it("stores signed sessions and reports exact totals", async () => {
    const session = { id: "ses_totals", buyer: buyerAccount.address, startBlock: 123, createdAt: new Date().toISOString() };
    const signature = await buyerAccount.signMessage({ message: sessionMessage(session) });
    const res = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session, signature }) });
    assert.equal(res.status, 201);
    const forged = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: { ...session, id: "ses_forged" }, signature }),
    });
    assert.equal(forged.status, 401);

    for (const paid of ["1000", "1000"]) await postRow(base, buyerAccount, makeRow(buyerAccount.address, listing, { sessionId: "ses_totals", paidUnits: paid }));
    await postRow(base, buyerAccount, makeRow(buyerAccount.address, listing, { sessionId: "ses_totals", status: "refused", reasonCode: "budget", paidUnits: "0" }));
    const s = await body(await fetch(`${base}/api/sessions/ses_totals`));
    assert.equal(s.startBlock, 123);
    assert.equal(s.totals.calls, 3);
    assert.equal(s.totals.paidUnits, "2000");
  });
});

describe("buyer -> registry, end to end", () => {
  it("a real paid call and a budget refusal arrive signed, and move the seller's reputation", async () => {
    const chain: ChainOps = {
      authorizationUsed: async () => false,
      findAuthorizationTx: async () => null,
      confirmTransfer: async () => ({ confirmed: true }),
    };
    const sink = new RegistryLedgerSink(base, buyerAccount, silent);
    const memory = new MemoryLedger();
    const buyer = new Buyer({ account: buyerAccount, sessionId: "ses_e2e", ledger: [memory, sink], chain, log: silent });
    await sink.startSession({ id: "ses_e2e", buyer: buyerAccount.address, startBlock: 1, createdAt: new Date().toISOString() });

    const before = await body(await fetch(`${base}/api/services/${listing.id}`));
    const budget = new Budget(1500n);
    const [a, b] = await Promise.all([
      buyer.payAndCall({ listing, input: { n: 3 }, budget }),
      buyer.payAndCall({ listing, input: { n: 4 }, budget }),
    ]);
    assert.deepEqual([a.row.status, b.row.status].sort(), ["paid", "refused"]);
    await buyer.drain();

    const ledger = await body(await fetch(`${base}/api/ledger?sessionId=ses_e2e`));
    assert.equal(ledger.count, 2);
    const paid = ledger.rows.find((r: { status: string }) => r.status === "paid");
    assert.equal(paid.onchainConfirmed, true, "the confirmation update arrived too");
    const session = await body(await fetch(`${base}/api/sessions/ses_e2e`));
    assert.equal(session.totals.paidUnits, memory.paidUnits().toString(), "registry and buyer agree to the unit");

    const afterRep = await body(await fetch(`${base}/api/services/${listing.id}`));
    assert.equal(afterRep.reputation.calls, before.reputation.calls + 1, "the budget refusal did not count against the seller");
    assert.equal(afterRep.reputation.successes, before.reputation.successes + 1);
    assert.equal(afterRep.network, NETWORK);
  });
});

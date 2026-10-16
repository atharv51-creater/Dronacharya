import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sessionMessage, type Address, type LedgerRow, type Listing } from "@dron/shared";
import { TransferCache, blockWindows, compareLedgerToChain, type ChainSource, type UsdcTransfer } from "@dron/x402-kit";
import { createRegistryApp } from "../../apps/registry/src/app.ts";
import { openRegistryDb } from "../../apps/registry/src/db.ts";
import { body, listen, makeRow, postRow, randomPayTo } from "./helpers.ts";

const buyer = privateKeyToAccount(generatePrivateKey());
const payTo = randomPayTo();
const listing = { id: "svc", sellerId: "svc", priceUnits: "5000", payTo, endpoint: "https://x.example/s" } as Listing;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const transfer = (n: number, value: bigint, to: Address = payTo, block = 100n + BigInt(n)): UsdcTransfer => ({ txHash: hash(n), blockNumber: block, logIndex: 0, from: buyer.address, to, value });
const SINCE = "2026-10-17T00:00:00.000Z";
const rowAt = (n: number, over: Partial<LedgerRow> = {}) => makeRow(buyer.address, listing, { txHash: hash(n), explorerUrl: null, time: "2026-10-17T01:00:00.000Z", ...over });

const compare = (rows: LedgerRow[], transfers: UsdcTransfer[]) =>
  compareLedgerToChain({ buyer: buyer.address, rows, transfers, since: SINCE, fromBlock: 100n, toBlock: 200n, sessionId: "ses_test" });

describe("compareLedgerToChain", () => {
  it("agrees to the unit when every paid row has its transfer and nothing else left the wallet", () => {
    const rows = [rowAt(1), rowAt(2), rowAt(3, { status: "refused", paidUnits: "0", txHash: null, reasonCode: "budget" })];
    const r = compare(rows, [transfer(1, 5000n), transfer(2, 5000n)]);
    assert.equal(r.ok, true, r.summary);
    assert.equal(r.ledger.paidUnits, "10000");
    assert.equal(r.chain.units, "10000");
    assert.equal(r.matched, 2);
    assert.equal(r.session?.paidUnits, "10000");
  });

  it("flags a paid row with no transfer (missing on-chain)", () => {
    const r = compare([rowAt(1), rowAt(2)], [transfer(1, 5000n)]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.issues.map((i) => i.kind), ["missing_on_chain"]);
    assert.equal(r.diffUnits, "-5000");
  });

  it("flags money that left the wallet without a ledger row (missing in ledger)", () => {
    const r = compare([rowAt(1)], [transfer(1, 5000n), transfer(9, 777n, randomPayTo())]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.issues.map((i) => i.kind), ["missing_in_ledger"]);
    assert.equal(r.diffUnits, "777");
  });

  it("flags a wrong amount and a wrong payTo even when the tx hash matches", () => {
    const r = compare([rowAt(1), rowAt(2)], [transfer(1, 4999n), transfer(2, 5000n, randomPayTo())]);
    assert.deepEqual(r.issues.map((i) => i.kind).sort(), ["amount_mismatch", "payto_mismatch"]);
  });

  it("matches a paid row that never learned its tx hash by payTo and amount", () => {
    const r = compare([rowAt(1, { txHash: null })], [transfer(5, 5000n)]);
    assert.equal(r.ok, true, r.summary);
    assert.equal(r.matchedByAmount, 1);
  });

  it("accounts for a row from an earlier session whose transfer landed in range", () => {
    const older = rowAt(4, { time: "2026-10-16T23:59:00.000Z", sessionId: "ses_old" });
    const r = compare([older, rowAt(1)], [transfer(1, 5000n), transfer(4, 5000n)]);
    assert.equal(r.ok, true, r.summary);
    assert.equal(r.ledger.paidUnits, "10000");
    assert.equal(r.session?.paidUnits, "5000", "the session subtotal only counts its own rows");
  });

  it("is not final while rows are pending", () => {
    const r = compare([rowAt(1), rowAt(2, { status: "pending", paidUnits: "0", txHash: null })], [transfer(1, 5000n)]);
    assert.equal(r.ok, true);
    assert.equal(r.final, false);
  });
});

describe("chain scanning", () => {
  it("splits ranges into windows the public RPC accepts (200 blocks)", () => {
    const w = blockWindows(1000n, 1599n, 200n);
    assert.deepEqual(w, [[1000n, 1199n], [1200n, 1399n], [1400n, 1599n]]);
    assert.deepEqual(blockWindows(5n, 5n, 200n), [[5n, 5n]]);
  });

  it("TransferCache scans only new blocks on repeat calls", async () => {
    const scans: [bigint, bigint][] = [];
    let latest = 150n;
    const chain: ChainSource = {
      currentBlock: async () => latest,
      transfersFrom: async (_w, from, to) => {
        scans.push([from, to]);
        return [transfer(Number(from), 1n, payTo, from)];
      },
    };
    const cache = new TransferCache(chain);
    await cache.get(buyer.address, 100n);
    latest = 180n;
    const second = await cache.get(buyer.address, 100n);
    // first call: stable part 100-145, head 146-150; second: new stable 146-175, head 176-180
    assert.deepEqual(scans, [[100n, 145n], [146n, 150n], [146n, 175n], [176n, 180n]]);
    assert.equal(second.transfers.length, 3, "cached stable scans + the new stable scan + the fresh head scan");
    assert.equal(second.toBlock, 180n);
  });
});

describe("registry: reconcile endpoint and live ledger feed", () => {
  let base = "";
  let server: Server;
  const chainTransfers: UsdcTransfer[] = [];
  let head = 500n;
  const ADMIN = { authorization: "Bearer rtoken-123", "content-type": "application/json" };

  before(async () => {
    const app = createRegistryApp({
      db: openRegistryDb(":memory:"),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      adminToken: "rtoken-123",
      allowLoopback: true,
      chain: { currentBlock: async () => head, transfersFrom: async (_w, from, to) => chainTransfers.filter((t) => t.blockNumber >= from && t.blockNumber <= to) },
      balanceOf: async () => 42_000n,
    });
    ({ server, base } = await listen(app));
    const reg = await fetch(`${base}/api/services`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ id: "svc", name: "svc", category: "data", description: "d", endpoint: "https://x.example/s", price: "0.005", payTo, inputSchema: { type: "object" }, outputSchema: { type: "object" } }),
    });
    assert.equal(reg.status, 201);
    const session = { id: "ses_rec", buyer: buyer.address, startBlock: 400, createdAt: new Date(Date.now() - 60_000).toISOString() };
    await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session, signature: await buyer.signMessage({ message: sessionMessage(session) }) }) });
  });
  after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  it("streams accepted rows to dashboard subscribers", async () => {
    const stream = await fetch(`${base}/api/ledger/stream?sessionId=ses_rec`);
    const reader = stream.body!.getReader();
    const row = makeRow(buyer.address, listing, { sessionId: "ses_rec", txHash: hash(41), explorerUrl: null });
    await postRow(base, buyer, row);
    let text = "";
    const deadline = Date.now() + 3000;
    while (!text.includes(row.id) && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.match(text, /event: row/);
    assert.ok(text.includes(row.id));
    chainTransfers.push(transfer(41, 5000n, payTo, 450n));
  });

  it("reconciles the session against the (fake) chain, and reports a mismatch when money leaves unexplained", async () => {
    const ok = await body(await fetch(`${base}/api/ledger/reconcile?sessionId=ses_rec`));
    assert.equal(ok.ok, true, ok.summary);
    assert.equal(ok.chain.units, "5000");
    assert.equal(ok.fromBlock, "400");

    head = 520n; // a later block: money left the wallet with no ledger row
    chainTransfers.push(transfer(77, 123n, randomPayTo(), 510n));
    const bad = await body(await fetch(`${base}/api/ledger/reconcile?sessionId=ses_rec`));
    assert.equal(bad.ok, false);
    assert.equal(bad.issues[0].kind, "missing_in_ledger");
    assert.equal((await fetch(`${base}/api/ledger/reconcile?sessionId=nope`)).status, 404);
  });

  it("lists sessions with totals, and wallets with balances", async () => {
    const { sessions } = await body(await fetch(`${base}/api/sessions`));
    assert.equal(sessions[0].id, "ses_rec");
    assert.equal(sessions[0].totals.paidUnits, "5000");
    const { wallets } = await body(await fetch(`${base}/api/wallets`));
    const roles = wallets.map((w: { roles: string[] }) => w.roles.join(","));
    assert.ok(roles.some((r: string) => r.includes("buyer")));
    assert.ok(roles.some((r: string) => r.includes("payTo of svc")));
    assert.equal(wallets[0].usdc, "0.042");
  });

  it("serves the dashboard page", async () => {
    const res = await fetch(`${base}/ledger`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>Dronacharya Ledger<\/title>/);
  });
});

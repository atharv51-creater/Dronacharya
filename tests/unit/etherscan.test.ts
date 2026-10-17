import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { pad, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ChainSource, UsdcTransfer } from "@dron/x402-kit";
import { EtherscanHistory, RECENT_BLOCKS, etherscanChainSource, etherscanTransfersFrom, type Fetch } from "../../apps/registry/src/etherscan.ts";
import { createRegistryApp } from "../../apps/registry/src/app.ts";
import { openRegistryDb } from "../../apps/registry/src/db.ts";
import { body, listen } from "./helpers.ts";

const KEY = "TESTKEY";
const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const addr = () => privateKeyToAccount(generatePrivateKey()).address;
const hex = (n: number | bigint) => `0x${n.toString(16)}`;
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

function logFor(from: Address, to: Address, block: number, index: number, value: bigint) {
  return { transactionHash: `0x${block.toString(16).padStart(8, "0")}${index.toString(16).padStart(56, "0")}` as Hex, blockNumber: hex(block), logIndex: hex(index), topics: [TOPIC, pad(from.toLowerCase() as Hex, { size: 32 }), pad(to.toLowerCase() as Hex, { size: 32 })], data: hex(value) };
}

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

describe("Etherscan transfer scan", () => {
  it("parses Transfer logs, pages through full pages, and sends the key only to Etherscan", async () => {
    const from = addr();
    const to = addr();
    const urls: URL[] = [];
    const all = Array.from({ length: 1001 }, (_, i) => logFor(from, to, 100 + i, 0, BigInt(i + 1)));
    const fake: Fetch = async (u) => {
      const url = new URL(u);
      urls.push(url);
      const page = Number(url.searchParams.get("page"));
      return json({ status: "1", message: "OK", result: all.slice((page - 1) * 1000, page * 1000) });
    };
    const out = await etherscanTransfersFrom(KEY, from, 100n, 2000n, fake);
    assert.equal(out.length, 1001);
    assert.equal(out[0]!.value, 1n);
    assert.equal(out[0]!.to, to);
    assert.equal(urls.length, 2);
    assert.equal(urls[0]!.origin, "https://api.etherscan.io");
    assert.equal(urls[0]!.searchParams.get("chainid"), "84532");
    assert.equal(urls[0]!.searchParams.get("topic1"), pad(from.toLowerCase() as Hex, { size: 32 }));
    assert.equal(urls[0]!.searchParams.get("apikey"), KEY);
  });

  it('treats "No records found" as empty and other errors as failures (without leaking the key)', async () => {
    assert.deepEqual(await etherscanTransfersFrom(KEY, addr(), 1n, 2n, async () => json({ status: "0", message: "No records found", result: [] })), []);
    await assert.rejects(etherscanTransfersFrom(KEY, addr(), 1n, 2n, async () => json({ status: "0", message: "NOTOK", result: "Invalid API Key" })), (e: Error) => /Invalid API Key/.test(e.message) && !e.message.includes(KEY));
  });

  it("chain source: Etherscan for settled blocks, RPC for the newest ones, RPC for everything if Etherscan fails", async () => {
    const from = addr();
    const head = 10_000n;
    const rpcCalls: [bigint, bigint][] = [];
    const rpc: ChainSource = {
      currentBlock: async () => head,
      transfersFrom: async (_f, a, b) => {
        rpcCalls.push([a, b]);
        return [] as UsdcTransfer[];
      },
    };
    let esRange: [string | null, string | null] = [null, null];
    const ok = etherscanChainSource(KEY, { rpc, fetchImpl: async (u) => {
      const url = new URL(u);
      esRange = [url.searchParams.get("fromBlock"), url.searchParams.get("toBlock")];
      return json({ status: "1", message: "OK", result: [logFor(from, addr(), 500, 1, 7n)] });
    } });
    await ok.currentBlock();
    const got = await ok.transfersFrom(from, 1n, head);
    assert.equal(got.length, 1);
    assert.deepEqual(esRange, ["1", String(head - RECENT_BLOCKS)]);
    assert.deepEqual(rpcCalls, [[head - RECENT_BLOCKS + 1n, head]]);
    assert.equal(ok.lastSource(), "mixed");

    rpcCalls.length = 0;
    const broken = etherscanChainSource(KEY, { rpc, fetchImpl: async () => new Response("bad gateway", { status: 502 }) });
    await broken.currentBlock();
    await broken.transfersFrom(from, 1n, 5000n);
    assert.deepEqual(rpcCalls, [[1n, 5000n]]);
    assert.equal(broken.lastSource(), "rpc");
  });
});

describe("wallet history", () => {
  it("labels direction and amount, and caches briefly", async () => {
    const me = addr();
    const other = addr();
    let calls = 0;
    const h = new EtherscanHistory(KEY, async () => {
      calls++;
      return json({ status: "1", message: "OK", result: [
        { hash: "0xaa", blockNumber: "12", timeStamp: "1760000000", from: me.toLowerCase(), to: other.toLowerCase(), value: "2500" },
        { hash: "0xbb", blockNumber: "11", timeStamp: "1759999000", from: other.toLowerCase(), to: me.toLowerCase(), value: "1000000" },
      ] });
    });
    const rows = await h.recent(me);
    assert.equal(rows[0]!.direction, "out");
    assert.equal(rows[0]!.counterparty, other);
    assert.equal(rows[0]!.usdc, "0.0025");
    assert.equal(rows[1]!.direction, "in");
    await h.recent(me);
    assert.equal(calls, 1);
  });

  it("the registry only serves history for wallets it knows, and says so when no key is set", async () => {
    const silent = { debug() {}, info() {}, warn() {}, error() {} };
    const noKey = await listen(createRegistryApp({ db: openRegistryDb(":memory:"), log: silent, allowLoopback: true }));
    servers.push(noKey.server);
    assert.equal((await fetch(`${noKey.base}/api/wallets/${addr()}/transfers`)).status, 503);

    const withKey = await listen(createRegistryApp({ db: openRegistryDb(":memory:"), log: silent, allowLoopback: true, history: { recent: async () => [] } }));
    servers.push(withKey.server);
    const res = await fetch(`${withKey.base}/api/wallets/${addr()}/transfers`);
    assert.equal(res.status, 404);
    assert.equal((await body(res)).error, "unknown_wallet");
  });
});

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORK, USDC_ADDRESS } from "@dron/shared";
import { createGateway } from "../../apps/gateway/src/proxy.ts";
import { createRegistryApp } from "../../apps/registry/src/app.ts";
import { openRegistryDb } from "../../apps/registry/src/db.ts";
import { body, listen } from "./helpers.ts";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const servers: Server[] = [];
let registry = "";
let gateway = "";
const buyerHits: { path: string; auth?: string; body: unknown }[] = [];
const saved = { ...process.env };

// Fake Google: the "idToken" is just the email; "unverified@..." is not email_verified.
const verifyIdToken = async (idToken: string, audience: string) =>
  audience === "test-client.apps.googleusercontent.com" ? { email: idToken.split("#")[0], email_verified: !idToken.startsWith("unverified"), name: "Test" } : undefined;

const signIn = async (base: string, email: string) => {
  const res = await fetch(`${base}/api/auth/google`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: `${email}#padding-padding-padding` }) });
  return { status: res.status, json: await body(res) };
};
const post = (url: string, token: string | undefined, payload: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });

before(async () => {
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.SCOUT_ALLOWED_EMAILS = "scout@example.com";
  process.env.ADMIN_EMAILS = "";
  const reg = await listen(createRegistryApp({ db: openRegistryDb(":memory:"), log: silent, allowLoopback: true, auth: { verifyIdToken, verifySignature: (address, message, signature) => verifyMessage({ address, message, signature }) } }));
  servers.push(reg.server);
  registry = reg.base;

  const buyer = express();
  buyer.use(express.json());
  buyer.all("/{*rest}", (req, res) => {
    buyerHits.push({ path: req.path, auth: req.get("authorization"), body: req.body });
    res.status(202).json({ ok: true, path: req.path });
  });
  const b = await listen(buyer);
  servers.push(b.server);

  const dist = mkdtempSync(join(tmpdir(), "dron-dist-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>ui</title>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
  const gw = await listen(createGateway([], { staticDir: dist, log: () => {}, api: { registry: new URL(registry), buyer: new URL(b.base), buyerToken: "server-buyer-token", dailyCapUnits: 100_000n } }));
  servers.push(gw.server);
  gateway = gw.base;
});

after(() => {
  for (const s of servers) s.close();
  process.env = saved;
});

describe("Google sign-in sessions", () => {
  it("issues a session for a verified email, with flags from the allow-lists", async () => {
    const { status, json } = await signIn(registry, "Scout@Example.com");
    assert.equal(status, 200);
    assert.equal(json.user.email, "scout@example.com");
    assert.equal(json.user.canRunScout, true);
    assert.equal(json.user.isAdmin, false);
    const s = await body(await fetch(`${registry}/api/auth/session`, { headers: { authorization: `Bearer ${json.token}` } }));
    assert.equal(s.authenticated, true);
    await post(`${registry}/api/auth/logout`, json.token, {});
    const gone = await body(await fetch(`${registry}/api/auth/session`, { headers: { authorization: `Bearer ${json.token}` } }));
    assert.equal(gone.authenticated, false);
  });

  it("refuses unverified emails, and everything when GOOGLE_CLIENT_ID is unset", async () => {
    assert.equal((await signIn(registry, "unverified@example.com")).status, 401);
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      assert.equal((await signIn(registry, "scout@example.com")).status, 503);
    } finally {
      process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    }
  });

  it("has no demo login", async () => {
    assert.equal((await post(`${registry}/api/auth/demo`, undefined, {})).status, 404);
    assert.equal((await post(`${gateway}/api/auth/demo`, undefined, {})).status, 404);
  });
});

describe("wallet-proven seller registration", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const listing = (id: string) => ({
    id,
    name: "Proof seller",
    category: "data",
    method: "GET",
    endpoint: "https://seller.example.com/quote",
    price: "0.001",
    network: NETWORK,
    asset: USDC_ADDRESS,
    payTo: account.address,
    description: "A seller that proves its wallet.",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  });

  it("registers with a signed one-time challenge, then refuses replay and duplicates", async () => {
    const { json: s } = await signIn(registry, "seller@example.com");
    const ch = await body(await post(`${registry}/api/auth/wallet-challenge`, s.token, { serviceId: "proof-seller", payTo: account.address.toLowerCase() }));
    assert.match(ch.message, /Chain: 84532/);
    assert.match(ch.message, new RegExp(`Wallet: ${account.address}`));
    assert.match(ch.message, /Email: seller@example.com/);
    const signature = await account.signMessage({ message: ch.message });

    const ok = await post(`${registry}/api/sellers/register`, s.token, { listing: listing("proof-seller"), message: ch.message, signature });
    assert.equal(ok.status, 201, JSON.stringify(await ok.clone().json()));
    assert.equal((await body(ok)).walletProof.verified, true);

    const replay = await post(`${registry}/api/sellers/register`, s.token, { listing: listing("proof-seller"), message: ch.message, signature });
    assert.equal(replay.status, 401);

    const ch2 = await body(await post(`${registry}/api/auth/wallet-challenge`, s.token, { serviceId: "proof-seller", payTo: account.address }));
    const dup = await post(`${registry}/api/sellers/register`, s.token, { listing: listing("proof-seller"), message: ch2.message, signature: await account.signMessage({ message: ch2.message }) });
    assert.equal(dup.status, 409);
  });

  it("refuses a signature from another wallet, and requests without a session", async () => {
    const { json: s } = await signIn(registry, "seller@example.com");
    const ch = await body(await post(`${registry}/api/auth/wallet-challenge`, s.token, { serviceId: "proof-two", payTo: account.address }));
    const other = privateKeyToAccount(generatePrivateKey());
    const res = await post(`${registry}/api/sellers/register`, s.token, { listing: listing("proof-two"), message: ch.message, signature: await other.signMessage({ message: ch.message }) });
    assert.equal(res.status, 401);
    assert.equal((await post(`${registry}/api/auth/wallet-challenge`, undefined, { serviceId: "x-y", payTo: account.address })).status, 401);
  });
});

describe("gateway: one origin for the UI and the API", () => {
  it("serves the UI with SPA fallback, and /api from the registry", async () => {
    assert.match(await (await fetch(`${gateway}/`)).text(), /<title>ui<\/title>/);
    assert.match(await (await fetch(`${gateway}/console/deep/link`)).text(), /<title>ui<\/title>/);
    assert.equal((await fetch(`${gateway}/assets/app.js`)).headers.get("cache-control")?.includes("immutable"), true);
    const meta = await body(await fetch(`${gateway}/api/meta`));
    assert.equal(meta.chainId, 84532);
  });

  it("buyer POSTs need a session that may run Scout; the buyer only ever sees the server token", async () => {
    assert.equal((await post(`${gateway}/api/tasks`, undefined, { task: "x", budget: "0.01" })).status, 401);
    const { json: plain } = await signIn(gateway, "seller@example.com");
    assert.equal((await post(`${gateway}/api/tasks`, plain.token, { task: "x", budget: "0.01" })).status, 403);

    const { json: scout } = await signIn(gateway, "scout@example.com");
    buyerHits.length = 0;
    const ok = await post(`${gateway}/api/tasks`, scout.token, { task: "x", budget: "0.06" });
    assert.equal(ok.status, 202);
    assert.equal(buyerHits[0]?.auth, "Bearer server-buyer-token");

    // Daily cap is 0.10 USDC: 0.06 used, another 0.06 is refused before reaching the buyer.
    buyerHits.length = 0;
    assert.equal((await post(`${gateway}/api/tasks`, scout.token, { task: "x", budget: "0.06" })).status, 429);
    assert.equal(buyerHits.length, 0);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { NETWORK, USDC_ADDRESS } from "@dron/shared";
import { ReplayStore, paymentIdentity } from "@dron/x402-kit";

const identity = (nonce: string) => ({ key: `k-${nonce}`, payer: "0xabc", nonce, network: NETWORK });

describe("ReplayStore", () => {
  it("lets exactly one claim win per identity", () => {
    const store = new ReplayStore(":memory:");
    const wins = Array.from({ length: 10 }, () => store.claim(identity("n1"), "GET /x")).filter(Boolean);
    assert.equal(wins.length, 1);
    assert.equal(store.claim(identity("n2"), "GET /x"), true);
  });

  it("never releases a claim, even after a failure", () => {
    const store = new ReplayStore(":memory:");
    assert.equal(store.claim(identity("n3"), "GET /x"), true);
    store.finish("k-n3", { state: "failed", status: 404 });
    assert.equal(store.claim(identity("n3"), "GET /x"), false);
    assert.equal(store.get("k-n3")?.state, "failed");
  });

  it("holds across two processes sharing the same file", () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-"));
    try {
      const a = new ReplayStore(join(dir, "nonces.db"));
      const b = new ReplayStore(join(dir, "nonces.db"));
      assert.equal(a.claim(identity("shared"), "GET /x"), true);
      assert.equal(b.claim(identity("shared"), "GET /x"), false);
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("paymentIdentity", () => {
  const payload = (nonce: string, from = "0x1111111111111111111111111111111111111111") => ({
    x402Version: 2,
    accepted: { scheme: "exact", network: NETWORK, asset: USDC_ADDRESS, amount: "1000", payTo: from, maxTimeoutSeconds: 60, extra: {} },
    payload: { signature: "0x" + "ab".repeat(65), authorization: { from, to: from, value: "1000", validAfter: "0", validBefore: "9", nonce } },
  });

  it("keys EIP-3009 payments by network, token, payer and nonce (case-insensitive)", () => {
    const n = "0x" + "cd".repeat(32);
    const a = paymentIdentity(encodePaymentSignatureHeader(payload(n)));
    const b = paymentIdentity(encodePaymentSignatureHeader(payload(n.toUpperCase().replace("0X", "0x"))));
    assert.ok(a && b);
    assert.equal(a.key, b.key);
    assert.equal(a.nonce, n);
  });

  it("gives different nonces different keys", () => {
    const a = paymentIdentity(encodePaymentSignatureHeader(payload("0x" + "01".repeat(32))));
    const b = paymentIdentity(encodePaymentSignatureHeader(payload("0x" + "02".repeat(32))));
    assert.notEqual(a!.key, b!.key);
  });

  it("returns null for garbage so the x402 middleware can reject it", () => {
    assert.equal(paymentIdentity("not-base64-json"), null);
  });
});

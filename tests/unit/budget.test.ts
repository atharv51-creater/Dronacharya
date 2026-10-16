import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Budget, BudgetError } from "@dron/x402-kit";

describe("Budget", () => {
  it("reserves, commits and releases with exact accounting", () => {
    const b = new Budget(10_000n);
    const r1 = b.reserve(4000n, "a")!;
    const r2 = b.reserve(5000n, "b")!;
    assert.equal(b.reserved, 9000n);
    assert.equal(b.remaining, 1000n);
    assert.equal(b.reserve(1001n), null, "cannot over-reserve");
    b.commit(r1);
    b.release(r2);
    assert.deepEqual(b.snapshot(), { total: 10_000n, spent: 4000n, reserved: 0n, remaining: 6000n, held: 0 });
  });

  it("never lets spent + reserved exceed the total, however many callers race", async () => {
    const b = new Budget(12_000n); // the brief's budget test: 0.012 USDC
    let peak = 0n;
    b.onChange((_e, s) => {
      if (s.spent + s.reserved > peak) peak = s.spent + s.reserved;
    });
    // 40 concurrent "calls" at 0.005 each, interleaving at every await point.
    const results = await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        const r = b.reserve(5000n, `call-${i}`);
        if (!r) return "refused";
        await new Promise((r2) => setTimeout(r2, Math.random() * 5));
        if (i % 3 === 0) b.release(r);
        else b.commit(r);
        return "reserved";
      }),
    );
    assert.ok(peak <= 12_000n, `peak ${peak}`);
    assert.ok(b.spent <= 12_000n);
    assert.ok(results.includes("refused"));
  });

  it("commits less than reserved (remainder freed) but never more", () => {
    const b = new Budget(5000n);
    const r = b.reserve(5000n)!;
    assert.throws(() => b.commit(r, 5001n), BudgetError);
    b.commit(r, 3000n);
    assert.equal(b.spent, 3000n);
    assert.equal(b.remaining, 2000n);
  });

  it("rejects double commits and foreign reservations; release is idempotent", () => {
    const a = new Budget(5000n);
    const other = new Budget(5000n);
    const r = a.reserve(1000n)!;
    assert.throws(() => other.commit(r), BudgetError);
    a.commit(r);
    assert.throws(() => a.commit(r), BudgetError);
    a.release(r); // no-op on a committed reservation
    assert.equal(a.spent, 1000n);
    assert.throws(() => a.reserve(0n), BudgetError);
  });

  it("wakes waiters when money is released", async () => {
    const b = new Budget(1000n);
    const r = b.reserve(1000n)!;
    const waiting = b.waitForChange(1000);
    setTimeout(() => b.release(r), 10);
    assert.equal(await waiting, true);
    assert.equal(await b.waitForChange(20), false, "times out when nothing changes");
  });
});

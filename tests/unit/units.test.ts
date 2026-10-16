import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fromUnits, parseUnits, toUnits } from "@dron/shared";

describe("USDC units", () => {
  it("parses decimal strings exactly", () => {
    assert.equal(toUnits("0.050"), 50_000n);
    assert.equal(toUnits("0.001"), 1_000n);
    assert.equal(toUnits("0.000001"), 1n);
    assert.equal(toUnits("12"), 12_000_000n);
    assert.equal(toUnits(" 0.1 "), 100_000n);
  });

  it("rejects anything that is not a plain non-negative decimal with at most 6 places", () => {
    for (const bad of ["", "-1", "1e-3", "0.0000001", "abc", "1.", ".5", "01", "0x10", "1,5"]) {
      assert.throws(() => toUnits(bad), RangeError, bad);
    }
  });

  it("formats units without floating point", () => {
    assert.equal(fromUnits(41_000n), "0.041");
    assert.equal(fromUnits(5_000n), "0.005");
    assert.equal(fromUnits(1_000_000n), "1");
    assert.equal(fromUnits("123456789"), "123.456789");
    assert.equal(fromUnits(0n), "0");
  });

  it("round-trips the brief's example to the last unit", () => {
    const total = [5000n, 5000n, 5000n, 5000n, 1000n, 10000n, 10000n].reduce((a, b) => a + b, 0n);
    assert.equal(total, 41_000n);
    assert.equal(toUnits("0.050") - total, toUnits("0.009"));
  });

  it("parseUnits only accepts integer strings", () => {
    assert.equal(parseUnits("5000"), 5000n);
    assert.throws(() => parseUnits("5000.0"));
    assert.throws(() => parseUnits("-1"));
  });
});

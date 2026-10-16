// Exact USDC arithmetic. Money never touches floating point in this codebase:
// amounts are bigint "units" (6 decimals, so 1000n = 0.001 USDC) and travel as decimal strings in JSON.

import { USDC_DECIMALS } from "./constants.ts";

const SCALE = 10n ** BigInt(USDC_DECIMALS);
const DECIMAL_RE = new RegExp(`^(0|[1-9]\\d*)(?:\\.(\\d{1,${USDC_DECIMALS}}))?$`);
const UNITS_RE = /^(0|[1-9]\d*)$/;

/** "0.050" -> 50000n. Rejects negatives, exponents, more than 6 decimals and anything that is not a plain decimal. */
export function toUnits(usdc: string): bigint {
  const match = DECIMAL_RE.exec(usdc.trim());
  if (!match) throw new RangeError(`not a valid USDC amount: ${JSON.stringify(usdc)}`);
  const whole = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? "").padEnd(USDC_DECIMALS, "0"));
  return whole * SCALE + fraction;
}

/** 50000n -> "0.05". Trailing zeros are trimmed; whole amounts have no decimal point. */
export function fromUnits(units: bigint | string): string {
  const value = typeof units === "bigint" ? units : parseUnits(units);
  if (value < 0n) throw new RangeError("negative amount");
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Strict parse of an integer unit string such as "5000". */
export function parseUnits(units: string): bigint {
  if (!UNITS_RE.test(units)) throw new RangeError(`not a valid unit amount: ${JSON.stringify(units)}`);
  return BigInt(units);
}

export function isUnitString(value: unknown): value is string {
  return typeof value === "string" && UNITS_RE.test(value);
}

/** JSON.stringify replacer that turns bigint into its decimal string. */
export function bigintReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

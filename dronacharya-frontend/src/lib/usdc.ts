// The backend's exact USDC arithmetic (bigint units, 6 decimals), shared so the UI validates amounts the same
// way the buyer will. units.ts depends only on constants.ts, both free of Node APIs.
export { toUnits, fromUnits } from "../../../packages/shared/src/units.ts";

/** What a budget field accepts while typing: digits, one dot, at most 6 decimals ("" and "0." are fine). */
export const USDC_TYPING = /^\d*\.?\d{0,6}$/;

import type { CATEGORIES, NETWORK } from "./constants.ts";

export type Category = (typeof CATEGORIES)[number];
export type HttpMethod = "GET" | "POST";
export type Address = `0x${string}`;
export type JsonSchema = Record<string, unknown>;

/** One service in the registry. Amounts are unit strings ("5000" = 0.005 USDC). */
export interface Listing {
  id: string;
  sellerId: string;
  name: string;
  category: Category;
  description: string;
  endpoint: string;
  method: HttpMethod;
  priceUnits: string;
  network: typeof NETWORK;
  asset: Address;
  payTo: Address;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  /** Deliberately misbehaving test fixture; hidden from default search. */
  isFixture?: boolean;
}

/** The four statuses from the brief. */
export type LedgerStatus = "paid" | "paid_output_rejected" | "refused" | "failed_not_charged";
/** Plus "pending": a payment was delivered but its outcome is not known yet (resolved on-chain). */
export type LedgerState = LedgerStatus | "pending";

export const REASON_CODES = [
  "ok",
  "free",
  // refused before signing (nothing signed, nothing sent)
  "price_above_listing",
  "payto_mismatch",
  "network_mismatch",
  "asset_mismatch",
  "scheme_unsupported",
  "version_unsupported",
  "unreasonable_timeout",
  "bad_402",
  "budget",
  "signing_blocked",
  // failed (not charged)
  "seller_unreachable",
  "seller_error",
  "verify_failed",
  "replay_rejected",
  "settle_failed",
  // paid but unusable
  "output_invalid",
  "no_response",
  "no_receipt",
  "settled_despite_error",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** One attempted call. Amounts are unit strings. */
export interface LedgerRow {
  id: string;
  time: string;
  updatedAt: string;
  sessionId: string;
  taskId: string;
  buyer: string;
  sellerId: string;
  serviceId: string;
  endpoint: string;
  payTo: string;
  listedUnits: string;
  askedUnits: string | null;
  paidUnits: string;
  status: LedgerState;
  reasonCode: ReasonCode;
  reason: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  /** EIP-3009 nonce of the signed authorisation (public once used on-chain). */
  nonce: string | null;
  /** Unix seconds after which the authorisation can no longer be settled. */
  validBefore: number | null;
  httpStatus: number | null;
  latencyMs: number;
  /**
   * Whether the chain agrees with the row: for paid rows, the receipt contains exactly this transfer;
   * for rows that signed but were not charged, the authorisation expired unused. null = not checked yet.
   */
  onchainConfirmed: boolean | null;
}

export interface SessionRecord {
  id: string;
  buyer: string;
  /** Base Sepolia block at session start; reconciliation scans transfers from here. */
  startBlock: number;
  createdAt: string;
}

export interface Reputation {
  /** Calls that count towards reputation (budget refusals are not the seller's fault and are excluded). */
  calls: number;
  successes: number;
  /** Smoothed with a Beta(2,1) prior, so a new seller starts at 0.667 rather than 0 or 1. */
  successRate: number;
  medianLatencyMs: number | null;
  /** Counted calls among the last 10, and how many of those succeeded. */
  recentCalls?: number;
  recentSuccesses?: number;
  /** Consecutive non-successes ending with the most recent call (0 if the last call succeeded). */
  failStreak?: number;
}

export interface ServiceView extends Listing {
  priceUsdc: string;
  reputation: Reputation;
  /** Expected cost per good result in units: price / successRate. Lower is better. */
  costPerSuccessUnits: string;
  registeredBy: "admin" | "public";
  createdAt: string;
  updatedAt: string;
}

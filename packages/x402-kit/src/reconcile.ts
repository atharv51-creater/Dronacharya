// Reconciliation: does the ledger agree with the chain, to the last unit?
//
// Scope is the buyer WALLET from a session's start block to now, because that is what a judge sees on
// the explorer ("USDC transfers out of the buyer's wallet"). Every USDC transfer out of the wallet in that
// range must be explained by a paid ledger row, and every paid row created since the session started
// must have its transfer on-chain, with the same amount and the same payTo.

import type { Address } from "@dron/shared";
import { fromUnits, txUrl, type LedgerRow } from "@dron/shared";
import { currentBlock, transfersFrom, type UsdcTransfer } from "./chain.ts";

export interface ReconcileIssue {
  kind: "missing_on_chain" | "missing_in_ledger" | "amount_mismatch" | "payto_mismatch";
  txHash: string | null;
  explorerUrl: string | null;
  rowId: string | null;
  ledgerUnits: string | null;
  chainUnits: string | null;
  detail: string;
}

export interface ReconcileReport {
  ok: boolean;
  /** No pending rows: nothing can still change. */
  final: boolean;
  buyer: string;
  fromBlock: string;
  toBlock: string;
  ledger: { paidRows: number; paidUnits: string; paidUsdc: string; pendingRows: number; confirmedRows: number };
  chain: { transfers: number; units: string; usdc: string };
  diffUnits: string;
  matched: number;
  matchedByAmount: number;
  session?: { id: string; paidUnits: string; paidUsdc: string; rows: number };
  issues: ReconcileIssue[];
  summary: string;
}

const isPaid = (r: LedgerRow) => (r.status === "paid" || r.status === "paid_output_rejected") && BigInt(r.paidUnits) > 0n;

/**
 * Pure comparison.
 * `rows`: every ledger row of this buyer (any session; a row from an earlier session may settle in range).
 * `since`: rows created at or after this time are expected to have their transfer in the scanned range.
 */
export function compareLedgerToChain(opts: {
  buyer: string;
  rows: LedgerRow[];
  transfers: UsdcTransfer[];
  since: string;
  fromBlock: bigint;
  toBlock: bigint;
  sessionId?: string;
}): ReconcileReport {
  const { rows, transfers } = opts;
  const issues: ReconcileIssue[] = [];
  const paid = rows.filter(isPaid);
  const expected = paid.filter((r) => r.time >= opts.since);
  const byTx = new Map<string, UsdcTransfer[]>();
  for (const t of transfers) {
    const list = byTx.get(t.txHash.toLowerCase()) ?? [];
    list.push(t);
    byTx.set(t.txHash.toLowerCase(), list);
  }
  const used = new Set<UsdcTransfer>();
  const accounted = new Set<string>();
  let matched = 0;
  let matchedByAmount = 0;

  // 1. Rows with a tx hash: exact match on hash, then amount and payTo.
  for (const row of paid) {
    if (!row.txHash) continue;
    const candidates = byTx.get(row.txHash.toLowerCase()) ?? [];
    const hit = candidates.find((t) => !used.has(t) && t.value === BigInt(row.paidUnits) && t.to.toLowerCase() === row.payTo.toLowerCase()) ?? candidates.find((t) => !used.has(t));
    if (!hit) continue; // checked below if expected in range
    used.add(hit);
    accounted.add(row.id);
    if (hit.value !== BigInt(row.paidUnits)) {
      issues.push(issue("amount_mismatch", row, hit, `ledger says ${row.paidUnits} units, the transfer moved ${hit.value}`));
    } else if (hit.to.toLowerCase() !== row.payTo.toLowerCase()) {
      issues.push(issue("payto_mismatch", row, hit, `ledger says payTo ${row.payTo}, the transfer went to ${hit.to}`));
    } else {
      matched++;
    }
  }

  // 2. Paid rows that never learned their tx hash: match on payTo + amount (flagged as such).
  for (const row of paid) {
    if (accounted.has(row.id) || row.txHash) continue;
    const hit = transfers.find((t) => !used.has(t) && t.value === BigInt(row.paidUnits) && t.to.toLowerCase() === row.payTo.toLowerCase());
    if (hit) {
      used.add(hit);
      accounted.add(row.id);
      matchedByAmount++;
    }
  }

  // 3. Expected rows with no transfer in range.
  for (const row of expected) {
    if (!accounted.has(row.id)) issues.push(issue("missing_on_chain", row, null, row.txHash ? "no USDC transfer from the buyer in this transaction within the scanned blocks" : "paid row has no tx hash and no matching transfer"));
  }

  // 4. Transfers out of the wallet nothing in the ledger explains.
  for (const t of transfers) {
    if (!used.has(t)) issues.push(issue("missing_in_ledger", null, t, `${t.value} units to ${t.to} at block ${t.blockNumber} are not in the ledger`));
  }

  // Ledger side of the equation: rows expected in range, plus older rows whose transfer landed in range.
  const inRange = new Map<string, LedgerRow>();
  for (const r of expected) inRange.set(r.id, r);
  for (const r of paid) if (accounted.has(r.id)) inRange.set(r.id, r);
  const ledgerUnits = [...inRange.values()].reduce((s, r) => s + BigInt(r.paidUnits), 0n);
  const chainUnits = transfers.reduce((s, t) => s + t.value, 0n);
  const diff = chainUnits - ledgerUnits;
  const pending = rows.filter((r) => r.status === "pending").length;
  const ok = issues.length === 0 && diff === 0n;

  let session: ReconcileReport["session"];
  if (opts.sessionId) {
    const sessionRows = paid.filter((r) => r.sessionId === opts.sessionId);
    const units = sessionRows.reduce((s, r) => s + BigInt(r.paidUnits), 0n);
    session = { id: opts.sessionId, paidUnits: units.toString(), paidUsdc: fromUnits(units), rows: sessionRows.length };
  }

  const summary = ok
    ? `Ledger and chain agree to the unit: ${inRange.size} paid call${inRange.size === 1 ? "" : "s"}, ${transfers.length} transfer${transfers.length === 1 ? "" : "s"}, ${fromUnits(chainUnits)} USDC out of ${opts.buyer} between blocks ${opts.fromBlock} and ${opts.toBlock}.${pending ? ` ${pending} row(s) still pending.` : ""}`
    : `MISMATCH: ledger ${fromUnits(ledgerUnits)} USDC vs chain ${fromUnits(chainUnits)} USDC (difference ${diff < 0n ? "-" : ""}${fromUnits(diff < 0n ? -diff : diff)}); ${issues.length} issue(s).`;

  return {
    ok,
    final: pending === 0,
    buyer: opts.buyer,
    fromBlock: opts.fromBlock.toString(),
    toBlock: opts.toBlock.toString(),
    ledger: {
      paidRows: inRange.size,
      paidUnits: ledgerUnits.toString(),
      paidUsdc: fromUnits(ledgerUnits),
      pendingRows: pending,
      confirmedRows: [...inRange.values()].filter((r) => r.onchainConfirmed === true).length,
    },
    chain: { transfers: transfers.length, units: chainUnits.toString(), usdc: fromUnits(chainUnits) },
    diffUnits: diff.toString(),
    matched,
    matchedByAmount,
    session,
    issues,
    summary,
  };
}

function issue(kind: ReconcileIssue["kind"], row: LedgerRow | null, t: UsdcTransfer | null, detail: string): ReconcileIssue {
  const tx = t?.txHash ?? row?.txHash ?? null;
  return {
    kind,
    txHash: tx,
    explorerUrl: tx ? txUrl(tx) : null,
    rowId: row?.id ?? null,
    ledgerUnits: row?.paidUnits ?? null,
    chainUnits: t ? t.value.toString() : null,
    detail,
  };
}

export interface ChainSource {
  transfersFrom(from: Address, fromBlock: bigint, toBlock: bigint): Promise<UsdcTransfer[]>;
  currentBlock(): Promise<bigint>;
}

/**
 * Remembers what has been scanned per wallet, so repeated reconciliations (a dashboard button, a judge
 * clicking twice) only scan new blocks. Only blocks at least FINALITY_BLOCKS below the head are cached:
 * the newest blocks are rescanned every time, in case of a reorg or an RPC that has not indexed them yet.
 */
export const FINALITY_BLOCKS = 5n;

export class TransferCache {
  private readonly scanned = new Map<string, { from: bigint; to: bigint; transfers: UsdcTransfer[] }>();
  constructor(private readonly chain: ChainSource = { transfersFrom, currentBlock }) {}

  async get(wallet: Address, fromBlock: bigint): Promise<{ transfers: UsdcTransfer[]; toBlock: bigint }> {
    const latest = await this.chain.currentBlock();
    if (fromBlock > latest) return { transfers: [], toBlock: latest };
    const stable = latest - FINALITY_BLOCKS;
    const key = wallet.toLowerCase();
    let entry = this.scanned.get(key);
    if (!entry || fromBlock < entry.from) entry = { from: fromBlock, to: fromBlock - 1n, transfers: [] };
    if (stable > entry.to) {
      const more = await this.chain.transfersFrom(wallet, entry.to + 1n, stable);
      entry = { from: entry.from, to: stable, transfers: [...entry.transfers, ...more] };
      this.scanned.set(key, entry);
    }
    const head = latest > entry.to ? await this.chain.transfersFrom(wallet, entry.to + 1n, latest) : [];
    return { transfers: [...entry.transfers, ...head].filter((t) => t.blockNumber >= fromBlock), toBlock: latest };
  }
}

export async function reconcile(opts: { buyer: Address; fromBlock: bigint; rows: LedgerRow[]; since: string; sessionId?: string; cache?: TransferCache }): Promise<ReconcileReport> {
  const cache = opts.cache ?? new TransferCache();
  const { transfers, toBlock } = await cache.get(opts.buyer, opts.fromBlock);
  return compareLedgerToChain({ buyer: opts.buyer, rows: opts.rows, transfers, since: opts.since, fromBlock: opts.fromBlock, toBlock, sessionId: opts.sessionId });
}

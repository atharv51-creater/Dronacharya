// Reputation from the ledger. Success rate is smoothed with a Beta(2,1) prior so a brand-new seller
// starts at 2/3 (neither trusted blindly nor locked out), and only the most recent calls count, so a
// seller that starts returning junk drops quickly.

import type { Database, Reputation } from "@dron/shared";

const PRIOR_SUCCESSES = 2;
const PRIOR_FAILURES = 1;
const WINDOW = 200;
/** Size of the "recent" window buyers use for cool-downs. */
const RECENT = 10;

interface Row {
  service_id: string;
  status: string;
  reason_code: string | null;
  latency_ms: number;
}

export function reputationByService(db: Database): Map<string, Reputation> {
  const rows = db
    .prepare(
      `SELECT service_id, status, reason_code, latency_ms FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY service_id ORDER BY created_at DESC) AS rn FROM ledger
       ) WHERE rn <= ? ORDER BY service_id, created_at DESC`,
    )
    .all(WINDOW) as unknown as Row[];

  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const list = grouped.get(row.service_id) ?? [];
    list.push(row);
    grouped.set(row.service_id, list);
  }
  const out = new Map<string, Reputation>();
  for (const [serviceId, list] of grouped) out.set(serviceId, summarise(list));
  return out;
}

/**
 * Not counted: pending rows (no verdict yet), refusals caused by the buyer's own budget or signer, and
 * calls that failed only because the buyer could not pay (verify failed, e.g. an empty wallet).
 */
const BUYER_SIDE = new Set(["budget", "signing_blocked", "verify_failed"]);
function counts(row: Row): boolean {
  if (row.status === "pending") return false;
  return !(row.reason_code && BUYER_SIDE.has(row.reason_code) && row.status !== "paid" && row.status !== "paid_output_rejected");
}

/** `rows` arrive newest first. */
function summarise(rows: Row[]): Reputation {
  const counted = rows.filter(counts);
  const successes = counted.filter((r) => r.status === "paid");
  const recent = counted.slice(0, RECENT);
  let failStreak = 0;
  while (failStreak < counted.length && counted[failStreak]!.status !== "paid") failStreak++;
  return {
    calls: counted.length,
    successes: successes.length,
    successRate: (successes.length + PRIOR_SUCCESSES) / (counted.length + PRIOR_SUCCESSES + PRIOR_FAILURES),
    medianLatencyMs: median(successes.map((r) => r.latency_ms)),
    recentCalls: recent.length,
    recentSuccesses: recent.filter((r) => r.status === "paid").length,
    failStreak,
  };
}

export const EMPTY_REPUTATION: Reputation = {
  calls: 0,
  successes: 0,
  successRate: PRIOR_SUCCESSES / (PRIOR_SUCCESSES + PRIOR_FAILURES),
  medianLatencyMs: null,
  recentCalls: 0,
  recentSuccesses: 0,
  failStreak: 0,
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

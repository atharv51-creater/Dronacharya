// Runs purchases for a task. Each step is one thing to buy (a page, a rate, a batch of texts):
//
//   - pick the best compatible seller; if it misbehaves (refused 402, junk, failure, no answer), exclude it
//     for the rest of the task and fall back to the next one;
//   - an UNPROVEN seller (no good track record in the registry and none yet in this task) gets one call at
//     a time until it delivers, so a junk seller cannot be paid for five pages in parallel;
//   - at most `max_concurrency` paid calls run at once, served in priority order;
//   - if the budget refuses a call while money is only HELD (a failed call whose authorisation has not
//     expired yet), wait for it to be released instead of giving up; otherwise the step is BLOCKED and
//     reported as a shortfall.
//
// Completed steps are cached by key, so a re-run after a top-up never buys the same thing twice.

import { fromUnits, type LedgerRow, type Logger } from "@dron/shared";
import type { Budget, Buyer } from "@dron/x402-kit";
import type { Candidate, Market, Need } from "./market.ts";

export type StepKind = "scrape" | "fx" | "text";
export type StepState = "pending" | "running" | "done" | "blocked" | "failed";

export interface Attempt {
  serviceId: string;
  sellerId: string;
  rowId: string;
  status: LedgerRow["status"];
  reasonCode: LedgerRow["reasonCode"];
  reason: string | null;
  askedUnits: string | null;
  paidUnits: string;
  txHash: string | null;
  explorerUrl: string | null;
  latencyMs: number;
  httpStatus: number | null;
  why: string;
  usable: boolean;
}

export interface StepRecord {
  key: string;
  kind: StepKind;
  label: string;
  state: StepState;
  priority: number;
  attempts: Attempt[];
  output?: unknown;
  servedBy?: string;
  neededUnits?: string;
  error?: string;
}

export type ExecEvent =
  | { type: "call_started"; step: string; label: string; serviceId: string; why: string; input: unknown; ranking: { serviceId: string; score: number | null }[]; relaxed: string[] }
  | { type: "call_finished"; step: string; label: string; attempt: Attempt }
  | { type: "fallback"; step: string; label: string; from: string; reason: string; next: string | null }
  | { type: "waiting_for_budget"; step: string; label: string; neededUnits: string; heldUnits: string }
  | { type: "step_blocked"; step: string; label: string; neededUnits: string; reason: string }
  | { type: "step_failed"; step: string; label: string; reason: string }
  | { type: "step_done"; step: string; label: string; serviceId: string };

export interface ExecutorOptions {
  buyer: Buyer;
  budget: Budget;
  market: Market;
  taskId: string;
  concurrency: number;
  emit: (event: ExecEvent) => void;
  log: Logger;
  /** Longest a step waits for held reservations to be released. Default 100 s (60 s window + grace). */
  waitForHeldMs?: number;
  /** Most sellers tried for one step. */
  maxAttempts?: number;
  isCancelled?: () => boolean;
}

/**
 * Dishonest or broken-contract behaviour: one strike and the seller is not used again in this task.
 * Operational failures (5xx, unreachable, no answer) only skip the seller for the current step, and strike
 * it after a second one; a 4xx about this particular input (e.g. "no page 999") never counts against it.
 */
const DISHONEST = new Set<LedgerRow["reasonCode"]>([
  "price_above_listing", "payto_mismatch", "network_mismatch", "asset_mismatch", "scheme_unsupported",
  "unreasonable_timeout", "bad_402", "version_unsupported", "output_invalid", "settled_despite_error", "replay_rejected",
]);
const OPERATIONAL_STRIKES = 2;

const STRIKE: Partial<Record<LedgerRow["reasonCode"], string>> = {
  price_above_listing: "its 402 asked more than its listed price",
  payto_mismatch: "its 402 named a different payTo",
  network_mismatch: "its 402 named another network",
  asset_mismatch: "its 402 named another token",
  scheme_unsupported: "its 402 used an unsupported scheme",
  unreasonable_timeout: "its 402 asked for an unreasonable authorisation window",
  bad_402: "its 402 could not be decoded",
  version_unsupported: "its 402 is not x402 v2",
  output_invalid: "it returned output that broke its schema",
  seller_error: "it failed to deliver",
  seller_unreachable: "it could not be reached",
  replay_rejected: "it refused a fresh payment as a replay",
  settle_failed: "its settlement failed",
  no_response: "it gave no answer after payment",
  no_receipt: "it answered without a payment receipt",
  settled_despite_error: "it settled after reporting failure",
};

export class Executor {
  readonly steps = new Map<string, StepRecord>();
  readonly excluded = new Map<string, string>();
  private readonly failures = new Map<string, number>();
  /** Set when the problem is the buyer's own (e.g. an empty wallet): stop buying, blame no seller. */
  halted: string | null = null;
  /** Fallback-ladder events worth explaining (relaxed rules, waits, give-ups), in order. */
  readonly notes: string[] = [];
  private readonly gates = new Map<string, SellerGate>();
  private readonly slots: PrioritySemaphore;
  private readonly waitForHeldMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly o: ExecutorOptions) {
    this.slots = new PrioritySemaphore(Math.max(1, o.concurrency));
    this.waitForHeldMs = o.waitForHeldMs ?? 100_000;
    this.maxAttempts = o.maxAttempts ?? 4;
  }

  /** Buys `need` (or returns the cached result). Never throws for business outcomes. */
  async step(need: Need, kind: StepKind, priority: number): Promise<StepRecord> {
    let rec = this.steps.get(need.key);
    if (rec?.state === "done") return rec;
    if (rec?.state === "running") return this.waitFor(need.key);
    rec ??= { key: need.key, kind, label: need.label, state: "pending", priority, attempts: [] };
    Object.assign(rec, { state: "running", error: undefined, neededUnits: undefined });
    this.steps.set(need.key, rec);
    try {
      await this.buy(need, rec);
    } catch (err) {
      rec.state = "failed";
      rec.error = `unexpected error: ${(err as Error).message}`;
      this.o.log.error("step crashed", { step: rec.key, err });
    }
    this.notify(need.key);
    return rec;
  }

  private async buy(need: Need, rec: StepRecord): Promise<void> {
    const { buyer, budget, market, taskId, emit } = this.o;
    const waitDeadline = Date.now() + this.waitForHeldMs;
    let tried = 0;
    // Sellers skipped for this step only (operational or input-specific failures).
    const skipHere = new Map<string, string>();
    const exclusions = () => new Map([...this.excluded, ...skipHere]);
    const context = () => ({ buyer: buyer.address, budget: { remaining: budget.remaining, reserved: budget.reserved } });

    for (;;) {
      if (this.o.isCancelled?.() || this.halted) {
        rec.state = "failed";
        rec.error = this.halted ?? "task cancelled";
        return;
      }
      const { candidates, skipped, relaxed } = market.candidates(need, exclusions(), context());
      const candidate = candidates[0];
      if (candidate && relaxed.length) {
        const note = `${rec.label}: relaxed ${relaxed.join(", ")} because no seller passed every rule (chose ${candidate.listing.id})`;
        if (!this.notes.includes(note)) this.notes.push(note);
      }
      if (!candidate || tried >= this.maxAttempts) {
        rec.state = "failed";
        const why = skipped.length ? `; ${skipped.map((s) => `${s.serviceId}: ${s.reason}`).join("; ")}` : "";
        rec.error = candidate ? `gave up after ${tried} sellers` : `no compatible ${need.category} seller left${why}`;
        this.notes.push(`${rec.label}: ${rec.error}`);
        emit({ type: "step_failed", step: rec.key, label: rec.label, reason: rec.error });
        return;
      }

      // Unproven sellers get one call at a time until they deliver.
      const gate = this.gate(candidate);
      await gate.enter();
      if (this.excluded.has(candidate.listing.id)) {
        gate.leave(false);
        continue; // struck (by another step) while we waited at the gate
      }

      const release = await this.slots.acquire(rec.priority);
      let attempt: Attempt;
      try {
        emit({
          type: "call_started",
          step: rec.key,
          label: rec.label,
          serviceId: candidate.listing.id,
          why: candidate.why,
          input: candidate.input,
          ranking: candidates.slice(0, 4).map((c) => ({ serviceId: c.listing.id, score: c.score === undefined ? null : Math.round(c.score) })),
          relaxed,
        });
        const out = await buyer.payAndCall({ listing: candidate.listing, input: candidate.input, budget, taskId });
        const problem = out.output !== undefined ? need.usable(out.output) : null;
        attempt = toAttempt(out.row, candidate, out.row.status === "paid" && out.output !== undefined && problem === null);
        rec.attempts.push(attempt);
        emit({ type: "call_finished", step: rec.key, label: rec.label, attempt });

        if (attempt.usable) {
          gate.leave(true);
          rec.state = "done";
          rec.output = out.output;
          rec.servedBy = candidate.listing.id;
          emit({ type: "step_done", step: rec.key, label: rec.label, serviceId: candidate.listing.id });
          return;
        }

        if (out.row.status === "refused" && out.row.reasonCode === "budget") {
          gate.leave(false);
          const asked = BigInt(out.row.askedUnits ?? candidate.listing.priceUnits);
          const held = budget.reserved;
          if (held > 0n && budget.remaining + held >= asked && Date.now() < waitDeadline) {
            emit({ type: "waiting_for_budget", step: rec.key, label: rec.label, neededUnits: asked.toString(), heldUnits: held.toString() });
            this.notes.push(`${rec.label}: waited for ${fromUnits(held)} USDC held by an unsettled payment instead of giving up`);
            await budget.waitForChange(Math.max(1000, waitDeadline - Date.now()));
            continue; // same seller, once held money has settled one way or the other
          }
          rec.state = "blocked";
          rec.neededUnits = asked.toString();
          emit({ type: "step_blocked", step: rec.key, label: rec.label, neededUnits: rec.neededUnits, reason: out.row.reason ?? "budget" });
          return;
        }

        // The facilitator rejected OUR payment because the wallet cannot cover it: not the seller's fault.
        if (out.row.reasonCode === "verify_failed" && /insufficient/i.test(out.row.reason ?? "")) {
          gate.leave(false);
          this.halted = `the buyer wallet cannot cover this payment (${out.row.reason}); fund it with testnet USDC and retry`;
          rec.state = "failed";
          rec.error = this.halted;
          emit({ type: "step_failed", step: rec.key, label: rec.label, reason: rec.error });
          return;
        }

        // Anything else: the seller did not deliver. Decide how hard to hold it against them, then fall back.
        gate.leave(false);
        tried++;
        const id = candidate.listing.id;
        const status = out.row.httpStatus ?? 0;
        let reason: string;
        if (out.row.status === "paid" && problem) {
          reason = `its output is valid for its listing but not usable here (${problem})`;
          skipHere.set(id, reason);
        } else if (DISHONEST.has(out.row.reasonCode)) {
          reason = STRIKE[out.row.reasonCode] ?? out.row.reason ?? out.row.status;
          this.excluded.set(id, reason);
        } else if (out.row.reasonCode === "seller_error" && status >= 400 && status < 500) {
          reason = `it could not serve this request (${out.row.reason ?? `HTTP ${status}`})`;
          skipHere.set(id, reason);
        } else {
          reason = STRIKE[out.row.reasonCode] ?? out.row.reason ?? out.row.status;
          const n = (this.failures.get(id) ?? 0) + 1;
          this.failures.set(id, n);
          if (n >= OPERATIONAL_STRIKES) this.excluded.set(id, `${reason} (${n} times)`);
          else skipHere.set(id, reason);
        }
        const next = market.candidates(need, exclusions(), context()).candidates[0]?.listing.id ?? null;
        emit({ type: "fallback", step: rec.key, label: rec.label, from: id, reason, next });
      } finally {
        release();
      }
    }
  }

  /** Steps that are blocked on budget, with what they need. */
  blocked(): StepRecord[] {
    return [...this.steps.values()].filter((s) => s.state === "blocked");
  }

  private gate(c: Candidate): SellerGate {
    let g = this.gates.get(c.listing.id);
    if (!g) {
      const rep = c.listing.reputation;
      g = new SellerGate(rep.calls >= 3 && rep.successRate >= 0.8);
      this.gates.set(c.listing.id, g);
    }
    return g;
  }

  private readonly waiting = new Map<string, (() => void)[]>();
  private waitFor(key: string): Promise<StepRecord> {
    return new Promise((resolve) => {
      const list = this.waiting.get(key) ?? [];
      list.push(() => resolve(this.steps.get(key)!));
      this.waiting.set(key, list);
    });
  }
  private notify(key: string) {
    const list = this.waiting.get(key) ?? [];
    this.waiting.delete(key);
    for (const fn of list) fn();
  }
}

function toAttempt(row: LedgerRow, c: Candidate, usable: boolean): Attempt {
  return {
    serviceId: c.listing.id,
    sellerId: c.listing.sellerId,
    rowId: row.id,
    status: row.status,
    reasonCode: row.reasonCode,
    reason: row.reason,
    askedUnits: row.askedUnits,
    paidUnits: row.paidUnits,
    txHash: row.txHash,
    explorerUrl: row.explorerUrl,
    latencyMs: row.latencyMs,
    httpStatus: row.httpStatus,
    why: c.why,
    usable,
  };
}

/** One call at a time for an unproven seller; unlimited once it has delivered. */
class SellerGate {
  private busy = false;
  private queue: (() => void)[] = [];
  constructor(private proven: boolean) {}

  async enter(): Promise<void> {
    if (this.proven) return;
    while (this.busy && !this.proven) await new Promise<void>((r) => this.queue.push(r));
    if (!this.proven) this.busy = true;
  }

  leave(delivered: boolean): void {
    if (delivered) this.proven = true;
    this.busy = false;
    const q = this.queue;
    this.queue = [];
    for (const r of q) r();
  }
}

/** Counting semaphore that serves waiters by priority (lower first), then arrival order. */
class PrioritySemaphore {
  private inUse = 0;
  private seq = 0;
  private readonly waiters: { priority: number; seq: number; resolve: (release: () => void) => void }[] = [];
  constructor(private readonly size: number) {}

  acquire(priority: number): Promise<() => void> {
    return new Promise((resolve) => {
      this.waiters.push({ priority, seq: this.seq++, resolve });
      this.waiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.pump();
    });
  }

  private pump() {
    while (this.inUse < this.size && this.waiters.length) {
      const next = this.waiters.shift()!;
      this.inUse++;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        this.inUse--;
        this.pump();
      });
    }
  }
}

export const describeUnits = (units: string | bigint) => `${fromUnits(BigInt(units))} USDC`;

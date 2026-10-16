// Task lifecycle: parse -> plan (estimate) -> buy -> answer -> settle.
//
//   parsing      task text -> TaskSpec (Gemini or rules)
//   planning     load the marketplace, estimate the cost
//   planned      dry run: stop here, nothing bought
//   needs_budget the budget cannot finish the task: a partial answer (if any), the exact shortfall, and a
//                top-up resumes it without re-buying anything already bought
//   running      buying
//   completed    every step delivered; partial: some steps had no seller that could deliver
//   failed / cancelled
//
// "settled" turns true once every payment is final on-chain (receipts confirmed, unsettled authorisations
// expired unused) and the ledger has been delivered to the registry.

import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import type { LocalAccount } from "viem";
import { REPO_ROOT, createLogger, fromUnits, toUnits, type LedgerRow, type Logger } from "@dron/shared";
import {
  Budget,
  Buyer,
  JsonlLedger,
  MemoryLedger,
  RegistryLedgerSink,
  currentBlock,
  usdcBalance,
  type ChainOps,
  type Clock,
  type LedgerSink,
} from "@dron/x402-kit";
import { Executor, type ExecEvent } from "./executor.ts";
import { Market } from "./market.ts";
import { narrateWithGemini, type Narrator } from "./narrate.ts";
import { llmAvailable } from "./parse/llm.ts";
import { parseTask, type LlmParser } from "./parse/index.ts";
import { runPipeline, type TaskResult } from "./pipeline.ts";
import { estimate as estimateCost, type Estimate } from "./plan.ts";
import { answerMarkdown, explain, shortfall, type Explanation, type Shortfall } from "./report.ts";
import { describeSpec, type TaskSpec } from "./spec.ts";

export interface TaskRequest {
  task: string;
  budget: string;
  max_concurrency?: number;
  only_sellers?: string[];
  prefer_sellers?: string[];
  /** "partial" (default): buy what fits, then report the shortfall. "ask": if the estimate exceeds the budget, ask first. */
  on_short_budget?: "partial" | "ask";
  dry_run?: boolean;
}

export type TaskStatus = "parsing" | "planning" | "planned" | "needs_budget" | "running" | "completed" | "partial" | "failed" | "cancelled";

export interface TaskEvent {
  seq: number;
  at: string;
  type: string;
  [key: string]: unknown;
}

export class TaskInputError extends Error {}

interface TaskRun {
  id: string;
  sessionId: string;
  request: Required<Omit<TaskRequest, "only_sellers" | "prefer_sellers">> & { only_sellers: string[]; prefer_sellers: string[] };
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  spec?: TaskSpec;
  specSummary?: string;
  parsedBy?: string;
  notes: string[];
  estimate?: Estimate;
  result?: TaskResult;
  answer?: string;
  explanation?: Explanation;
  narrative?: string;
  shortfall?: Shortfall;
  error?: string;
  settled: boolean;
  budget: Budget;
  buyer: Buyer;
  ledger: MemoryLedger;
  market: Market;
  executor?: Executor;
  sessionStarted: boolean;
  registrySink?: RegistryLedgerSink;
  events: TaskEvent[];
  listeners: Set<(e: TaskEvent) => void>;
  cancelled: boolean;
  running?: Promise<void>;
}

export interface TaskManagerOptions {
  registryUrl: string;
  account: LocalAccount;
  log?: Logger;
  /** Largest budget a single task may be given. Default 0.50 USDC. */
  maxBudgetUnits?: bigint;
  /** Where task snapshots are written; null disables. */
  dataDir?: string | null;
  /** Report ledger rows to the registry (signed). Default true. */
  reportToRegistry?: boolean;
  chain?: ChainOps;
  clock?: Clock;
  llmParser?: LlmParser | null;
  narrator?: Narrator | null;
  blockNumber?: () => Promise<number>;
  /** USDC (units) the buyer wallet holds; checked before buying. Default: read from Base Sepolia. */
  balanceOf?: () => Promise<bigint>;
  waitForHeldMs?: number;
  extraSinks?: LedgerSink[];
}

const MAX_EVENTS = 2000;

export class TaskManager {
  private readonly tasks = new Map<string, TaskRun>();
  private readonly log: Logger;
  private readonly maxBudget: bigint;

  constructor(private readonly o: TaskManagerOptions) {
    this.log = o.log ?? createLogger("buyer-agent");
    this.maxBudget = o.maxBudgetUnits ?? 500_000n;
  }

  get address() {
    return this.o.account.address;
  }

  create(input: TaskRequest): ReturnType<TaskManager["view"]> {
    const request = this.validate(input);
    const id = `task_${randomUUID().slice(0, 8)}`;
    const sessionId = `ses_${id.slice(5)}`;
    const ledger = new MemoryLedger();
    const sinks: LedgerSink[] = [ledger, ...(this.o.extraSinks ?? [])];
    if (this.o.dataDir !== null) sinks.push(new JsonlLedger(`${this.o.dataDir ?? `${REPO_ROOT}.data`}/ledger/${sessionId}.jsonl`));
    let registrySink: RegistryLedgerSink | undefined;
    if (this.o.reportToRegistry ?? true) {
      registrySink = new RegistryLedgerSink(this.o.registryUrl, this.o.account, this.log);
      sinks.push(registrySink);
    }
    const now = new Date().toISOString();
    const run: TaskRun = {
      id,
      sessionId,
      request,
      status: "parsing",
      createdAt: now,
      updatedAt: now,
      notes: [],
      settled: false,
      budget: new Budget(toUnits(request.budget)),
      buyer: new Buyer({ account: this.o.account, sessionId, ledger: sinks, chain: this.o.chain, clock: this.o.clock, log: this.log }),
      ledger,
      market: new Market(this.o.registryUrl, { onlySellers: request.only_sellers, preferSellers: request.prefer_sellers }),
      sessionStarted: false,
      registrySink,
      events: [],
      listeners: new Set(),
      cancelled: false,
    };
    this.tasks.set(id, run);
    run.budget.onChange((_e, s) => this.emit(run, "budget", { spent: s.spent.toString(), reserved: s.reserved.toString(), remaining: s.remaining.toString(), total: s.total.toString() }));
    this.emit(run, "task_created", { task: request.task, budget: request.budget, maxConcurrency: request.max_concurrency });
    run.running = this.drive(run);
    return this.view(run);
  }

  get(id: string) {
    const run = this.tasks.get(id);
    return run ? this.view(run) : undefined;
  }

  list() {
    return [...this.tasks.values()].map((r) => ({ id: r.id, status: r.status, task: r.request.task, budget: r.request.budget, spentUsdc: fromUnits(r.budget.spent), createdAt: r.createdAt })).reverse();
  }

  events(id: string): TaskEvent[] | undefined {
    return this.tasks.get(id)?.events;
  }

  subscribe(id: string, listener: (e: TaskEvent) => void): (() => void) | undefined {
    const run = this.tasks.get(id);
    if (!run) return undefined;
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  /** Waits until the task stops moving (finished, planned, or waiting for budget) and is settled. */
  async idle(id: string): Promise<void> {
    const run = this.tasks.get(id);
    while (run?.running) {
      const current = run.running;
      await current;
      if (run.running === current) break;
    }
  }

  async topUp(id: string, amountUsdc: string) {
    const run = this.tasks.get(id);
    if (!run) throw new TaskInputError("no such task");
    let units: bigint;
    try {
      units = toUnits(amountUsdc);
    } catch {
      throw new TaskInputError("amount must be a USDC amount such as 0.010");
    }
    if (units <= 0n) throw new TaskInputError("amount must be positive");
    if (run.budget.total + units > this.maxBudget) throw new TaskInputError(`a task's budget may not exceed ${fromUnits(this.maxBudget)} USDC`);
    if (!["needs_budget", "planned"].includes(run.status)) throw new TaskInputError(`task is ${run.status}; top-ups apply to tasks that need budget or are planned`);
    run.budget.increase(units);
    this.emit(run, "topped_up", { amountUsdc: fromUnits(units), budgetUsdc: fromUnits(run.budget.total) });
    run.request.dry_run = false;
    this.resume(run);
    return this.view(run);
  }

  /** Runs a task that was only planned (dry run). */
  start(id: string) {
    const run = this.tasks.get(id);
    if (!run) throw new TaskInputError("no such task");
    if (run.status !== "planned") throw new TaskInputError(`task is ${run.status}; only planned tasks can be started`);
    run.request.dry_run = false;
    this.resume(run);
    return this.view(run);
  }

  /** Continues buying; any settlement still in progress for earlier calls keeps going alongside. */
  private resume(run: TaskRun) {
    const previous = run.running ?? Promise.resolve();
    this.setStatus(run, "running");
    run.running = Promise.all([previous, this.execute(run)]).then(() => undefined);
  }

  cancel(id: string) {
    const run = this.tasks.get(id);
    if (!run) throw new TaskInputError("no such task");
    if (["completed", "partial", "failed", "cancelled"].includes(run.status)) return this.view(run);
    run.cancelled = true;
    this.setStatus(run, "cancelled");
    return this.view(run);
  }

  // ---------- lifecycle ----------

  private async drive(run: TaskRun): Promise<void> {
    try {
      // 1. Parse.
      const parsed = await parseTask(run.request.task, { llm: this.o.llmParser === null ? undefined : (this.o.llmParser ?? undefined), useLlm: this.o.llmParser === null ? false : undefined });
      run.spec = parsed.spec;
      run.parsedBy = parsed.parsedBy;
      run.notes.push(...parsed.notes);
      run.specSummary = describeSpec(parsed.spec);
      this.emit(run, "parsed", { spec: parsed.spec, summary: run.specSummary, parsedBy: parsed.parsedBy, notes: parsed.notes });
      if (!parsed.spec.supported) return this.fail(run, parsed.spec.unsupportedReason);

      // 2. Plan.
      this.setStatus(run, "planning");
      await run.market.load();
      run.estimate = estimateCost(parsed.spec, run.market);
      this.emit(run, "estimate", { estimate: run.estimate });
      if (run.estimate.impossible.length) run.notes.push(`no compatible seller for: ${run.estimate.impossible.join(", ")}`);

      if (run.request.dry_run) {
        this.setStatus(run, "planned");
        return;
      }
      const est = BigInt(run.estimate.totalUnits);
      if (run.request.on_short_budget === "ask" && est > run.budget.total) {
        run.shortfall = {
          neededUnits: (est - run.budget.total).toString(),
          neededUsdc: fromUnits(est - run.budget.total),
          freeUsdc: fromUnits(run.budget.remaining),
          blocked: run.estimate.lines.map((l) => ({ step: l.what, usdc: fromUnits(BigInt(l.subtotalUnits ?? "0")) })),
          message: `Estimated ${run.estimate.lowerBound ? "at least " : ""}${run.estimate.totalUsdc} USDC but the budget is ${fromUnits(run.budget.total)}. Nothing has been bought. Top up at least ${fromUnits(est - run.budget.total)} USDC to run it.`,
        };
        this.emit(run, "needs_budget", { shortfall: run.shortfall });
        this.setStatus(run, "needs_budget");
        return;
      }
      if (est > run.budget.total) {
        run.notes.push(`estimate ${run.estimate.totalUsdc} USDC exceeds the ${fromUnits(run.budget.total)} USDC budget: buying the most important steps first, then reporting the shortfall`);
      }
      if (!(await this.walletCovers(run, est < run.budget.total ? est : run.budget.total))) return;
      await this.execute(run);
    } catch (err) {
      this.fail(run, (err as Error).message);
    }
  }

  private async execute(run: TaskRun): Promise<void> {
    if (run.cancelled) return;
    const spec = run.spec!;
    try {
      this.setStatus(run, "running");
      run.shortfall = undefined;
      if (!run.sessionStarted) {
        run.sessionStarted = true;
        const startBlock = await (this.o.blockNumber ?? (async () => Number(await currentBlock())))().catch(() => 0);
        await run.registrySink?.startSession({ id: run.sessionId, buyer: this.o.account.address, startBlock, createdAt: run.createdAt });
      }
      await run.market.load(); // fresh reputation, including what this task has already reported
      run.executor ??= new Executor({
        buyer: run.buyer,
        budget: run.budget,
        market: run.market,
        taskId: run.id,
        concurrency: run.request.max_concurrency,
        emit: (e: ExecEvent) => this.emit(run, e.type, { ...e }),
        log: this.log,
        waitForHeldMs: this.o.waitForHeldMs,
        isCancelled: () => run.cancelled,
      });
      const result = await runPipeline(spec, run.executor, run.market, (msg) => this.emit(run, "progress", { message: msg }));
      if (run.executor.halted) run.error = run.executor.halted;
      run.result = result;
      run.answer = answerMarkdown(spec, result);
      run.shortfall = shortfall([...run.executor.steps.values()], run.budget);
      run.explanation = explain({ steps: [...run.executor.steps.values()], rows: run.ledger.all(), budget: run.budget, result, estimate: run.estimate, excluded: run.executor.excluded, notes: run.executor.notes });
      this.emit(run, "answer", { answer: run.answer, result, explanation: run.explanation });

      if (run.cancelled) return;
      if (run.shortfall) {
        this.emit(run, "needs_budget", { shortfall: run.shortfall });
        this.setStatus(run, "needs_budget");
      } else if (run.executor.halted) {
        this.emit(run, "error", { message: run.executor.halted });
        this.setStatus(run, "failed");
      } else {
        const failed = [...run.executor.steps.values()].some((s) => s.state === "failed");
        this.setStatus(run, failed ? "partial" : "completed");
      }
      await this.settle(run);
    } catch (err) {
      this.fail(run, (err as Error).message);
    }
  }

  /** Pre-flight: refuse to start (spending nothing) when the wallet cannot cover even the first purchases. */
  private async walletCovers(run: TaskRun, needed: bigint): Promise<boolean> {
    let balance: bigint;
    try {
      balance = await (this.o.balanceOf ?? (() => usdcBalance(this.o.account.address)))();
    } catch {
      return true; // cannot check: the runtime guard still stops on an underfunded payment
    }
    this.emit(run, "wallet", { balanceUnits: balance.toString(), balanceUsdc: fromUnits(balance) });
    const cheapest = (run.estimate?.lines ?? []).reduce<bigint | null>((m, l) => (l.unitUnits && (m === null || BigInt(l.unitUnits) < m) ? BigInt(l.unitUnits) : m), null);
    if (balance >= needed || (cheapest !== null && balance >= cheapest && run.request.on_short_budget === "partial")) {
      if (balance < needed) run.notes.push(`the wallet holds ${fromUnits(balance)} USDC, less than the ${fromUnits(needed)} this task needs: it will stop when the wallet runs dry`);
      return true;
    }
    this.fail(run, `the buyer wallet ${this.o.account.address} holds ${fromUnits(balance)} USDC but this task needs ${fromUnits(needed)} USDC; nothing was bought. Fund it at https://faucet.circle.com (Base Sepolia).`);
    return false;
  }

  /** Waits for every payment to be final, refreshes the explanation from final rows, adds a narrative. */
  private async settle(run: TaskRun): Promise<void> {
    run.settled = false;
    await run.buyer.drain();
    if (run.executor) {
      run.explanation = explain({ steps: [...run.executor.steps.values()], rows: run.ledger.all(), budget: run.budget, result: run.result, estimate: run.estimate, excluded: run.executor.excluded, notes: run.executor.notes });
    }
    if (run.shortfall && run.executor) run.shortfall = shortfall([...run.executor.steps.values()], run.budget);
    run.settled = true;
    this.emit(run, "settled", { explanation: run.explanation, ledger: run.ledger.all() });

    const narrator = this.o.narrator === null ? undefined : (this.o.narrator ?? (llmAvailable() ? narrateWithGemini : undefined));
    if (narrator && run.explanation) {
      try {
        run.narrative = await narrator({ task: run.request.task, understood: run.specSummary, answer: run.answer, explanation: run.explanation, shortfall: run.shortfall });
        this.emit(run, "narrative", { narrative: run.narrative });
      } catch (err) {
        this.log.warn("narrative unavailable", { err });
      }
    }
    this.persist(run);
  }

  private fail(run: TaskRun, message: string) {
    run.error = message;
    this.emit(run, "error", { message });
    this.setStatus(run, "failed");
  }

  private setStatus(run: TaskRun, status: TaskStatus) {
    if (run.status === "cancelled" && status !== "cancelled") return;
    run.status = status;
    this.emit(run, "status", { status });
    this.persist(run);
  }

  private emit(run: TaskRun, type: string, data: Record<string, unknown>) {
    run.updatedAt = new Date().toISOString();
    const event: TaskEvent = { seq: run.events.length + 1, at: run.updatedAt, type, ...JSON.parse(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) };
    run.events.push(event);
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
    for (const l of run.listeners) {
      try {
        l(event);
      } catch {
        // a broken listener must not break the task
      }
    }
  }

  private persist(run: TaskRun) {
    if (this.o.dataDir === null) return;
    try {
      const dir = `${this.o.dataDir ?? `${REPO_ROOT}.data`}/tasks`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/${run.id}.json`, JSON.stringify(this.view(run), null, 2));
    } catch (err) {
      this.log.warn("could not write task snapshot", { err });
    }
  }

  private validate(input: TaskRequest): TaskRun["request"] {
    if (!input || typeof input !== "object") throw new TaskInputError("body must be a JSON object");
    const task = typeof input.task === "string" ? input.task.trim() : "";
    if (task.length < 5 || task.length > 2000) throw new TaskInputError("task must be 5-2000 characters");
    let budget: bigint;
    try {
      budget = toUnits(String(input.budget ?? ""));
    } catch {
      throw new TaskInputError('budget must be a USDC amount such as "0.050"');
    }
    if (budget <= 0n) throw new TaskInputError("budget must be positive");
    if (budget > this.maxBudget) throw new TaskInputError(`budget may not exceed ${fromUnits(this.maxBudget)} USDC per task`);
    const concurrency = input.max_concurrency ?? 3;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new TaskInputError("max_concurrency must be an integer from 1 to 10");
    const ids = (v: unknown, name: string): string[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(x))) throw new TaskInputError(`${name} must be a list of service ids`);
      return v as string[];
    };
    const mode = input.on_short_budget ?? "partial";
    if (mode !== "partial" && mode !== "ask") throw new TaskInputError('on_short_budget must be "partial" or "ask"');
    return {
      task,
      budget: fromUnits(budget),
      max_concurrency: concurrency,
      only_sellers: ids(input.only_sellers, "only_sellers"),
      prefer_sellers: ids(input.prefer_sellers, "prefer_sellers"),
      on_short_budget: mode,
      dry_run: Boolean(input.dry_run),
    };
  }

  view(run: TaskRun) {
    const s = run.budget.snapshot();
    const steps = run.executor ? [...run.executor.steps.values()] : [];
    return {
      id: run.id,
      sessionId: run.sessionId,
      buyer: this.o.account.address,
      status: run.status,
      settled: run.settled,
      request: run.request,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      understood: run.specSummary,
      parsedBy: run.parsedBy,
      spec: run.spec,
      notes: run.notes,
      estimate: run.estimate,
      budget: { totalUsdc: fromUnits(s.total), spentUsdc: fromUnits(s.spent), reservedUsdc: fromUnits(s.reserved), remainingUsdc: fromUnits(s.remaining), totalUnits: s.total.toString(), spentUnits: s.spent.toString() },
      steps: steps.map((st) => ({ key: st.key, kind: st.kind, label: st.label, state: st.state, servedBy: st.servedBy ?? null, neededUnits: st.neededUnits ?? null, error: st.error ?? null, attempts: st.attempts })),
      excluded: run.executor ? Object.fromEntries(run.executor.excluded) : {},
      answer: run.answer,
      result: run.result,
      explanation: run.explanation,
      narrative: run.narrative,
      shortfall: run.shortfall,
      error: run.error,
      ledger: run.ledger.all() as LedgerRow[],
    };
  }
}

export type TaskView = ReturnType<TaskManager["view"]>;

// The answer and the explanation. The explanation is built from the ledger rows and the executor's
// recorded decisions only (never from model text), so every number in it is one that actually happened.

import { fromUnits, type LedgerRow } from "@dron/shared";
import type { Budget } from "@dron/x402-kit";
import { formatMoney } from "./compute.ts";
import type { StepRecord } from "./executor.ts";
import type { Estimate } from "./plan.ts";
import type { TaskResult } from "./pipeline.ts";
import { describeSpec, type TaskSpec } from "./spec.ts";

export interface Purchase {
  n: number;
  time: string;
  step: string;
  serviceId: string;
  sellerId: string;
  status: LedgerRow["status"];
  listedUsdc: string;
  askedUsdc: string | null;
  paidUnits: string;
  paidUsdc: string;
  txHash: string | null;
  explorerUrl: string | null;
  onchainConfirmed: boolean | null;
  why: string;
  outcome: string;
}

export interface Explanation {
  summary: string;
  purchases: Purchase[];
  decisions: string[];
  totals: {
    paidUnits: string;
    paidUsdc: string;
    budgetUsdc: string;
    leftUsdc: string;
    transactions: number;
    calls: number;
    byStatus: Record<string, number>;
  };
}

export interface Shortfall {
  neededUnits: string;
  neededUsdc: string;
  freeUsdc: string;
  blocked: { step: string; usdc: string }[];
  message: string;
}

export function shortfall(steps: StepRecord[], budget: Budget): Shortfall | undefined {
  const blocked = steps.filter((s) => s.state === "blocked");
  if (!blocked.length) return undefined;
  const need = blocked.reduce((sum, s) => sum + BigInt(s.neededUnits ?? "0"), 0n);
  const free = budget.remaining;
  const more = need > free ? need - free : 0n;
  const items = blocked.map((s) => ({ step: s.label, usdc: fromUnits(BigInt(s.neededUnits ?? "0")) }));
  return {
    neededUnits: more.toString(),
    neededUsdc: fromUnits(more),
    freeUsdc: fromUnits(free),
    blocked: items,
    message:
      `The budget ran out before ${items.length} step${items.length > 1 ? "s" : ""}: ${items.map((i) => `${i.step} (${i.usdc} USDC)`).join(", ")}. ` +
      `Top up at least ${fromUnits(more)} USDC to finish; ${fromUnits(free)} USDC is unspent. Spending stopped at ${fromUnits(budget.spent)} of ${fromUnits(budget.total)} USDC.`,
  };
}

export function explain(opts: { steps: StepRecord[]; rows: LedgerRow[]; budget: Budget; result?: TaskResult; estimate?: Estimate; excluded: Map<string, string>; notes?: string[] }): Explanation {
  const { steps, budget } = opts;
  const rowsById = new Map(opts.rows.map((r) => [r.id, r]));
  const purchases: Purchase[] = [];

  for (const step of steps) {
    step.attempts.forEach((a, i) => {
      const row = rowsById.get(a.rowId);
      const status = row?.status ?? a.status;
      const paid = row?.paidUnits ?? a.paidUnits;
      const prev = i > 0 ? step.attempts[i - 1]! : undefined;
      purchases.push({
        n: 0,
        time: row?.time ?? "",
        step: step.label,
        serviceId: a.serviceId,
        sellerId: a.sellerId,
        status,
        listedUsdc: fromUnits(BigInt(row?.listedUnits ?? "0")),
        askedUsdc: (row?.askedUnits ?? a.askedUnits) ? fromUnits(BigInt(row?.askedUnits ?? a.askedUnits!)) : null,
        paidUnits: paid,
        paidUsdc: fromUnits(BigInt(paid)),
        txHash: row?.txHash ?? a.txHash,
        explorerUrl: row?.explorerUrl ?? a.explorerUrl,
        onchainConfirmed: row?.onchainConfirmed ?? null,
        why: prev && prev.serviceId !== a.serviceId ? `fallback after ${prev.serviceId} (${outcomeText(prev.status, prev.reason)}); ${a.why}` : a.why,
        outcome: a.usable ? "used" : outcomeText(status, row?.reason ?? a.reason),
      });
    });
  }
  purchases.sort((a, b) => a.time.localeCompare(b.time));
  purchases.forEach((p, i) => (p.n = i + 1));

  const byStatus: Record<string, number> = {};
  let exact = 0n;
  let transactions = 0;
  for (const p of purchases) {
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
    if ((p.status === "paid" || p.status === "paid_output_rejected") && BigInt(p.paidUnits) > 0n) {
      exact += BigInt(p.paidUnits);
      transactions++;
    }
  }

  const decisions: string[] = [];
  const r = opts.result;
  if (r && r.textBatches.calls > 0 && r.textBatches.perCall > 1 && r.textBatches.texts > r.textBatches.calls) {
    decisions.push(`Batched ${r.textBatches.texts} texts into ${r.textBatches.calls} call${r.textBatches.calls > 1 ? "s" : ""} (the seller takes up to ${r.textBatches.perCall} per call), saving ${r.textBatches.texts - r.textBatches.calls} call${r.textBatches.texts - r.textBatches.calls > 1 ? "s" : ""}.`);
  }
  for (const [id, reason] of opts.excluded) decisions.push(`Stopped using ${id}: ${reason}.`);
  for (const note of opts.notes ?? []) decisions.push(`Fallback: ${note}.`);
  if (opts.estimate) decisions.push(`Estimated ${opts.estimate.lowerBound ? "at least " : ""}${opts.estimate.totalUsdc} USDC before buying; spent ${fromUnits(exact)}.`);

  const left = budget.total - budget.spent;
  const summary =
    `Made ${purchases.length} call${purchases.length === 1 ? "" : "s"} and paid ${fromUnits(exact)} USDC in ${transactions} transaction${transactions === 1 ? "" : "s"}, ` +
    `out of a ${fromUnits(budget.total)} USDC budget (${fromUnits(left)} left).` +
    (byStatus.refused ? ` Refused ${byStatus.refused} call${byStatus.refused > 1 ? "s" : ""} before signing.` : "") +
    (byStatus.paid_output_rejected ? ` Rejected ${byStatus.paid_output_rejected} paid result${byStatus.paid_output_rejected > 1 ? "s" : ""} that broke the seller's schema.` : "") +
    (byStatus.failed_not_charged ? ` ${byStatus.failed_not_charged} call${byStatus.failed_not_charged > 1 ? "s" : ""} failed and were not charged.` : "");

  return {
    summary,
    purchases,
    decisions,
    totals: { paidUnits: exact.toString(), paidUsdc: fromUnits(exact), budgetUsdc: fromUnits(budget.total), leftUsdc: fromUnits(left), transactions, calls: purchases.length, byStatus },
  };
}

function outcomeText(status: string, reason: string | null): string {
  switch (status) {
    case "paid":
      return reason ? `paid, not used: ${reason}` : "paid";
    case "paid_output_rejected":
      return `paid, output rejected${reason ? `: ${reason}` : ""}`;
    case "refused":
      return `refused${reason ? `: ${reason}` : ""}`;
    case "failed_not_charged":
      return `failed, not charged${reason ? `: ${reason}` : ""}`;
    default:
      return `${status}${reason ? `: ${reason}` : ""}`;
  }
}

/** Human-readable answer (Markdown). */
export function answerMarkdown(spec: TaskSpec, result: TaskResult): string {
  const out: string[] = [];
  const cur = result.rates.map((r) => r.currency);
  out.push(`**${capitalise(describeSpec(spec))}**`, "");

  if (result.kind === "books") {
    if (result.books.length === 0) out.push("No books matched.");
    else {
      out.push(`| # | Book | Rating | GBP | ${cur.join(" | ")}${cur.length ? " |" : ""}`, `|---|---|---|---|${cur.map(() => "---|").join("")}`);
      for (const b of result.books) {
        out.push(`| ${b.rank} | ${b.title} | ${"★".repeat(b.rating)} | ${formatMoney(b.priceGbp, "GBP")} | ${cur.map((c) => (b.prices[c] !== undefined ? formatMoney(b.prices[c]!, c) : "?")).join(" | ")}${cur.length ? " |" : ""}`);
      }
      const texts = result.books.filter((b) => b.text);
      if (texts.length) {
        out.push("", `**Hindi ${spec.text.style}${texts.length > 1 ? "s" : ""}**`, "");
        for (const b of texts) out.push(`${b.rank}. *${b.title}*: ${b.text}`);
      }
    }
  } else {
    out.push(`| Category | Books | Average (GBP) | ${cur.map((c) => `Average (${c})`).join(" | ")}${cur.length ? " |" : ""} Range (GBP) |`);
    out.push(`|---|---|---|${cur.map(() => "---|").join("")}---|`);
    for (const g of result.groups) {
      out.push(`| ${g.category} | ${g.count} | ${formatMoney(g.averageGbp, "GBP")} | ${cur.map((c) => (g.prices.average[c] !== undefined ? formatMoney(g.prices.average[c]!, c) : "?")).join(" | ")}${cur.length ? " |" : ""} ${formatMoney(g.minGbp, "GBP")} to ${formatMoney(g.maxGbp, "GBP")} |`);
    }
    if (result.combinedText) out.push("", `**Hindi ${spec.text.style}**`, "", result.combinedText);
  }

  if (result.rates.length) {
    out.push("", `Rates: ${result.rates.map((r) => `1 GBP = ${r.rate} ${r.currency}`).join(", ")} (${result.rates[0]!.source ?? "rate seller"}${result.rates[0]!.date ? `, ${result.rates[0]!.date}` : ""}).`);
  }
  out.push(`Scanned ${result.scanned.pages} page${result.scanned.pages === 1 ? "" : "s"}, ${result.scanned.books} books, ${result.scanned.matching} matching the filter.`);
  if (result.gaps.length) out.push("", "**Gaps:** " + result.gaps.join("; ") + ".");
  return out.join("\n");
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

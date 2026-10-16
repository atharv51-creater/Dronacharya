// Seller selection: eight rules and a fallback ladder, deciding which seller the buyer tries first for
// each purchase. Every decision is traced to a rule, so the explanation can say exactly why a seller
// was chosen, ranked lower, or not used.
//
//   HARD (never relaxed)
//   R1 Caller intent    only_sellers restricts a category; prefer_sellers go first; fixtures only when named
//   R2 Contract fit     right category; its inputSchema accepts our request; its outputSchema promises
//                       the fields we need (a preferred seller is checked on arrival instead)
//   R3 Safe listing     Base Sepolia, testnet USDC, price within the 0.10 cap, a real payTo that is not the
//                       buyer's own wallet, an https endpoint (http only on loopback)
//   SOFT (relaxed only when nothing else is left; caller-preferred sellers are exempt from R5 and R6)
//   R4 Affordability    must fit the budget; "fits once held money is released" ranks after "fits now"
//   R5 Fair price       not more than 3x the median of the compatible sellers, when a fairly priced one exists
//   R6 Trust floor      enough evidence of failure excludes; a recent failure streak means a cool-down
//                       (ranked last); a strike earlier in this task excludes
//   SCORE
//   R7 Best value       expected cost per good result = price / P(success), with P discounted for thin
//                       evidence (Beta posterior minus one standard deviation), plus a time cost per second
//                       of median latency
//   R8 Spread near-ties parallel steps rotate across sellers within 10% of the best score, so four pages do
//                       not all queue on one seller
//
// Fallback ladder (driven by the executor): next-ranked seller -> relaxed soft rules (said out loud) ->
// wait for held budget or report the shortfall -> probe unproven sellers one call at a time -> partial
// answer naming the gap.

import { MAX_PRICE_UNITS, NETWORK, USDC_ADDRESS, fromUnits, type ServiceView } from "@dron/shared";
import type { Need } from "./market.ts";

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8";

export const RULES: Record<RuleId, string> = {
  R1: "caller intent",
  R2: "contract fit",
  R3: "safe listing",
  R4: "affordability",
  R5: "fair price",
  R6: "trust floor",
  R7: "best value",
  R8: "spread near-ties",
};

export interface SelectionConfig {
  /** R5: a price above this multiple of the median compatible price is unfair (when a fair one exists). */
  fairPriceMultiple: number;
  /** R6: calls needed before reputation can exclude a seller. */
  trustMinEvidence: number;
  /** R6: below this posterior success rate (with enough evidence) a seller is excluded. */
  trustFloor: number;
  /** R6: this many consecutive recent failures put a seller on cool-down. */
  coolDownStreak: number;
  /** R7: standard deviations subtracted from the posterior mean (confidence discount). */
  confidenceK: number;
  /** R7: score units added per second of median latency (100 = 0.0001 USDC per second). */
  timeValuePerSecond: number;
  /** R8: candidates within this fraction of the best score count as a tie. 0 disables spreading. */
  spreadTolerance: number;
}

export const DEFAULT_SELECTION: SelectionConfig = {
  fairPriceMultiple: 3,
  trustMinEvidence: 5,
  trustFloor: 0.5,
  coolDownStreak: 3,
  confidenceK: 1,
  timeValuePerSecond: 100,
  spreadTolerance: 0.1,
};

export interface SelectionContext {
  prefer: string[];
  only: string[];
  /** Task-local strikes (R6). */
  excluded: Map<string, string>;
  /** Does the service's inputSchema accept this request? (R2) */
  accepts: (service: ServiceView, input: Record<string, unknown>) => boolean;
  /** The buyer's wallet (R3: never pay yourself). */
  buyer?: string;
  /** R4: what is free now, and what is held by unsettled payments. */
  budget?: { remaining: bigint; reserved: bigint };
  /** R8: position of this step among parallel steps of the same kind. */
  spreadKey?: number;
  config?: Partial<SelectionConfig>;
}

export interface RankedSeller {
  listing: ServiceView;
  input: Record<string, unknown>;
  preferred: boolean;
  /** Confidence-adjusted probability of a good result (R7). */
  pSuccess: number;
  /** Expected units per good result, including time cost (R7). Lower is better. */
  score: number;
  /** Soft-rule observations that lowered the rank (R4 later, R6 cool-down) or were relaxed. */
  flags: string[];
  why: string;
}

export interface SkippedSeller {
  serviceId: string;
  rule: RuleId;
  reason: string;
}

export interface Selection {
  candidates: RankedSeller[];
  skipped: SkippedSeller[];
  /** Soft rules that had to be relaxed because nothing else was left. */
  relaxed: RuleId[];
}

const ZERO = "0x0000000000000000000000000000000000000000";
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;

export function selectSellers(need: Need, services: ServiceView[], ctx: SelectionContext): Selection {
  const cfg = { ...DEFAULT_SELECTION, ...ctx.config };
  const skipped: SkippedSeller[] = [];
  const skip = (s: ServiceView, rule: RuleId, reason: string) => skipped.push({ serviceId: s.id, rule, reason });

  // ---------- R1-R3 and task strikes: hard ----------
  const inCategory = services.filter((s) => s.category === need.category);
  const onlyHere = ctx.only.filter((id) => inCategory.some((s) => s.id === id));
  const hard: { s: ServiceView; input: Record<string, unknown>; preferred: boolean }[] = [];
  for (const s of inCategory) {
    const named = ctx.prefer.includes(s.id) || ctx.only.includes(s.id);
    if (onlyHere.length && !onlyHere.includes(s.id)) {
      skip(s, "R1", "not in only_sellers");
      continue;
    }
    if (s.isFixture && !named) {
      skip(s, "R1", "test fixture (used only when named)");
      continue;
    }
    const strike = ctx.excluded.get(s.id);
    if (strike) {
      skip(s, "R6", `struck in this task: ${strike}`);
      continue;
    }
    const input = need.inputs.find((i) => ctx.accepts(s, i));
    if (!input) {
      skip(s, "R2", "its inputSchema does not accept this request");
      continue;
    }
    const preferred = ctx.prefer.includes(s.id) || onlyHere.includes(s.id);
    const missing = need.provides.filter((p) => !schemaProvides(s.outputSchema, p));
    if (missing.length && !preferred) {
      skip(s, "R2", `its outputSchema does not promise ${missing.join(", ")}`);
      continue;
    }
    const unsafe = unsafeListing(s, ctx.buyer);
    if (unsafe) {
      skip(s, "R3", unsafe);
      continue;
    }
    hard.push({ s, input, preferred });
  }

  // ---------- R4-R6: soft ----------
  // R4 and R6 first; R5 then judges prices only against sellers the buyer would actually use (trusted,
  // affordable, not cooling down), so a cheap but untrustworthy seller cannot make honest prices look unfair.
  const knownLatencies = hard.map((h) => h.s.reputation.medianLatencyMs).filter((l): l is number => l !== null).sort((a, b) => a - b);
  const typicalLatency = knownLatencies.length ? knownLatencies[Math.floor(knownLatencies.length / 2)]! : 0;

  type Soft = { h: (typeof hard)[number]; later: boolean; coolDown: boolean; flags: string[]; exclusions: { rule: RuleId; reason: string }[] };
  const soft: Soft[] = hard.map((h) => {
    const price = BigInt(h.s.priceUnits);
    const rep = h.s.reputation;
    const flags: string[] = [];
    const exclusions: Soft["exclusions"] = [];
    let later = false;
    if (ctx.budget) {
      const { remaining, reserved } = ctx.budget;
      if (price > remaining + reserved) exclusions.push({ rule: "R4", reason: `costs ${fromUnits(price)} USDC but only ${fromUnits(remaining + reserved)} can ever be free` });
      else if (price > remaining) {
        later = true;
        flags.push(`R4: fits once ${fromUnits(price - remaining)} USDC of held money is released`);
      }
    }
    if (rep.calls >= cfg.trustMinEvidence && rep.successRate < cfg.trustFloor) {
      const reason = `${(rep.successRate * 100).toFixed(0)}% success over ${rep.calls} calls`;
      if (h.preferred) flags.push(`R6 noted (preferred): ${reason}`);
      else exclusions.push({ rule: "R6", reason });
    }
    const coolDown = (rep.failStreak ?? 0) >= cfg.coolDownStreak;
    if (coolDown) flags.push(`R6: cool-down after ${rep.failStreak} failures in a row`);
    return { h, later, coolDown, flags, exclusions };
  });

  const reference = soft.filter((x) => x.exclusions.length === 0 && !x.coolDown);
  const prices = (reference.length ? reference : soft).map((x) => Number(x.h.s.priceUnits)).sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor((prices.length - 1) / 2)]! : 0;
  const fairCeiling = median * cfg.fairPriceMultiple;
  if (soft.length >= 2) {
    for (const x of soft) {
      const price = Number(x.h.s.priceUnits);
      if (price <= fairCeiling || !reference.some((r) => r !== x && Number(r.h.s.priceUnits) <= fairCeiling)) continue;
      const reason = `${fromUnits(BigInt(price))} USDC is over ${cfg.fairPriceMultiple}x the median ${fromUnits(BigInt(median))} of usable sellers`;
      if (x.h.preferred) x.flags.push(`R5 noted (preferred): ${reason}`);
      else x.exclusions.push({ rule: "R5", reason });
    }
  }

  let survivors = soft.filter((x) => x.exclusions.length === 0);
  const relaxed = new Set<RuleId>();
  if (survivors.length === 0 && soft.length > 0) {
    // Fallback: rather than give up, relax the soft rules (never R1-R3) and say so.
    survivors = soft;
    for (const x of soft) {
      for (const e of x.exclusions) {
        relaxed.add(e.rule);
        x.flags.push(`relaxed ${e.rule} (${RULES[e.rule]}): ${e.reason}`);
      }
    }
  } else {
    for (const x of soft) for (const e of x.exclusions) skip(x.h.s, e.rule, e.reason);
  }

  // ---------- R7: score ----------
  const scored: (RankedSeller & { later: boolean; coolDown: boolean })[] = survivors.map((x) => {
    const rep = x.h.s.reputation;
    const pSuccess = confidentSuccess(rep.successes, rep.calls, cfg.confidenceK);
    const latency = rep.medianLatencyMs ?? typicalLatency;
    const timeCost = (latency / 1000) * cfg.timeValuePerSecond;
    const score = Number(x.h.s.priceUnits) / pSuccess + timeCost;
    return { listing: x.h.s, input: x.h.input, preferred: x.h.preferred, pSuccess, score, flags: x.flags, why: "", later: x.later, coolDown: x.coolDown };
  });

  scored.sort((a, b) => {
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    if (a.preferred && b.preferred) return ctx.prefer.indexOf(a.listing.id) - ctx.prefer.indexOf(b.listing.id);
    if (a.later !== b.later) return a.later ? 1 : -1;
    if (a.coolDown !== b.coolDown) return a.coolDown ? 1 : -1;
    return (
      a.score - b.score ||
      (a.listing.reputation.medianLatencyMs ?? Infinity) - (b.listing.reputation.medianLatencyMs ?? Infinity) ||
      Number(BigInt(a.listing.priceUnits) - BigInt(b.listing.priceUnits)) ||
      a.listing.id.localeCompare(b.listing.id)
    );
  });

  // ---------- R8: spread near-ties across parallel steps ----------
  let spreadNote = "";
  const spreadKey = ctx.spreadKey ?? need.spreadKey;
  if (spreadKey !== undefined && cfg.spreadTolerance > 0 && scored.length > 1 && !scored[0]!.preferred) {
    const lead = scored[0]!;
    const ties = scored.filter((c) => !c.preferred && c.later === lead.later && c.coolDown === lead.coolDown && c.score <= lead.score * (1 + cfg.spreadTolerance));
    if (ties.length > 1) {
      const pick = ties[spreadKey % ties.length]!;
      scored.splice(scored.indexOf(pick), 1);
      scored.unshift(pick);
      spreadNote = `R8: within ${Math.round(cfg.spreadTolerance * 100)}% of ${ties.length} sellers, rotated for parallel steps`;
    }
  }

  const n = scored.length;
  for (const [i, c] of scored.entries()) {
    const price = fromUnits(BigInt(c.listing.priceUnits));
    const evidence = `${(c.pSuccess * 100).toFixed(0)}% confidence-adjusted success over ${c.listing.reputation.calls} call${c.listing.reputation.calls === 1 ? "" : "s"}`;
    const value = `${price} USDC / ${evidence} = ${fromUnits(BigInt(Math.round(c.score)))} per good result`;
    const head = c.preferred ? "R1: requested by the caller" : `R7: rank ${i + 1} of ${n} by value`;
    c.why = [head, value, ...(i === 0 && spreadNote ? [spreadNote] : []), ...c.flags].join("; ");
  }

  return { candidates: scored.map(({ later: _l, coolDown: _c, ...rest }) => rest), skipped, relaxed: [...relaxed] };
}

/** Beta(successes + 2, failures + 1) posterior mean minus k standard deviations, floored at 5%. */
export function confidentSuccess(successes: number, calls: number, k: number): number {
  const a = successes + 2;
  const b = calls - successes + 1;
  const mean = a / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  return Math.max(0.05, mean - k * sd);
}

function unsafeListing(s: ServiceView, buyer: string | undefined): string | null {
  if (s.network !== NETWORK) return `network ${s.network} is not Base Sepolia`;
  if (s.asset.toLowerCase() !== USDC_ADDRESS.toLowerCase()) return "asset is not testnet USDC";
  let price: bigint;
  try {
    price = BigInt(s.priceUnits);
  } catch {
    return "price is not an integer amount";
  }
  if (price <= 0n || price > MAX_PRICE_UNITS) return `price ${s.priceUnits} units is outside 1-${MAX_PRICE_UNITS}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(s.payTo) || s.payTo.toLowerCase() === ZERO) return "payTo is not a usable address";
  if (buyer && s.payTo.toLowerCase() === buyer.toLowerCase()) return "payTo is the buyer's own wallet";
  try {
    const url = new URL(s.endpoint);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.test(url.hostname))) return "endpoint is not https";
  } catch {
    return "endpoint is not a URL";
  }
  return null;
}

/** Does `schema` declare the property path, e.g. "books[].priceGbp"? */
export function schemaProvides(schema: Record<string, unknown> | undefined, path: string): boolean {
  let node: Record<string, unknown> | undefined = schema;
  for (const part of path.split(".")) {
    const isArray = part.endsWith("[]");
    const name = isArray ? part.slice(0, -2) : part;
    const props = node?.properties as Record<string, Record<string, unknown>> | undefined;
    node = props?.[name];
    if (!node) return false;
    if (isArray) {
      node = node.items as Record<string, unknown> | undefined;
      if (!node) return false;
    }
  }
  return true;
}

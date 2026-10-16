// The buyer's view of the marketplace: which listed services can do a job, and in what order to try them.
// The decision itself is the rule engine in selection.ts (R1-R8); this class loads listings, caches
// schema validators, and hands each need plus the live context (budget, task strikes, step position) to it.

import { compileSchema, type Category, type ServiceView, type ValidateFunction } from "@dron/shared";
import { selectSellers, type RuleId, type SelectionConfig, type SkippedSeller } from "./selection.ts";

export { schemaProvides } from "./selection.ts";

export interface Need {
  key: string;
  category: Category;
  label: string;
  /** Request bodies to try, most specific first; the first one a seller's inputSchema accepts is sent. */
  inputs: Record<string, unknown>[];
  /** Output paths the result must contain, e.g. "books[].priceGbp". */
  provides: string[];
  /** Checks a delivered result is usable for this task; returns a problem, or null. */
  usable(output: unknown): string | null;
  /** R8: position among parallel steps of the same kind (page number, batch index). */
  spreadKey?: number;
}

export interface Candidate {
  listing: ServiceView;
  input: Record<string, unknown>;
  preferred: boolean;
  why: string;
  /** R7 score: expected units per good result (lower is better). */
  score?: number;
  pSuccess?: number;
  flags?: string[];
}

export interface MarketOptions {
  /** Restrict to these services (applied per category, only where the list names one in that category). */
  onlySellers?: string[];
  /** Try these services first when they are compatible. */
  preferSellers?: string[];
  /** Tune the selection rules (thresholds, time value, spreading). */
  selection?: Partial<SelectionConfig>;
}

export interface CandidateContext {
  buyer?: string;
  budget?: { remaining: bigint; reserved: bigint };
}

export class Market {
  services: ServiceView[] = [];
  private readonly validators = new Map<string, ValidateFunction | null>();

  constructor(
    readonly registryUrl: string,
    readonly options: MarketOptions = {},
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async load(): Promise<void> {
    const res = await this.fetcher(`${this.registryUrl.replace(/\/+$/, "")}/api/services?includeFixtures=true&sort=score`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`registry answered ${res.status}`);
    this.services = ((await res.json()) as { services: ServiceView[] }).services;
  }

  get(id: string): ServiceView | undefined {
    return this.services.find((s) => s.id === id);
  }

  /** Ranked candidates for `need` under rules R1-R8, plus everything skipped and any relaxed rules. */
  candidates(
    need: Need,
    excluded: Map<string, string> = new Map(),
    ctx: CandidateContext = {},
  ): { candidates: Candidate[]; skipped: { serviceId: string; reason: string; rule?: RuleId }[]; relaxed: RuleId[] } {
    const selection = selectSellers(need, this.services, {
      prefer: this.options.preferSellers ?? [],
      only: this.options.onlySellers ?? [],
      excluded,
      accepts: (s, input) => this.accepts(s, input),
      buyer: ctx.buyer,
      budget: ctx.budget,
      spreadKey: need.spreadKey,
      config: this.options.selection,
    });
    return {
      candidates: selection.candidates,
      skipped: selection.skipped.map((s: SkippedSeller) => ({ serviceId: s.serviceId, rule: s.rule, reason: `${s.rule}: ${s.reason}` })),
      relaxed: selection.relaxed,
    };
  }

  /** Listed price of the best candidate, for estimates (no budget context: R4 does not apply). */
  bestPrice(need: Need): { units: bigint; serviceId: string } | null {
    const best = this.candidates(need).candidates[0];
    return best ? { units: BigInt(best.listing.priceUnits), serviceId: best.listing.id } : null;
  }

  /** How many texts the best inference seller accepts per call (from its inputSchema). */
  maxItems(need: Need, field: string): number {
    const best = this.candidates(need).candidates[0];
    const max = (best?.listing.inputSchema.properties as Record<string, { maxItems?: unknown }> | undefined)?.[field]?.maxItems;
    return typeof max === "number" && max >= 1 ? Math.min(max, 10) : 1;
  }

  private accepts(s: ServiceView, input: Record<string, unknown>): boolean {
    if (!this.validators.has(s.id)) {
      try {
        this.validators.set(s.id, compileSchema(s.inputSchema));
      } catch {
        this.validators.set(s.id, null);
      }
    }
    const validate = this.validators.get(s.id);
    return Boolean(validate && validate(structuredClone(input)));
  }
}

// Pre-flight estimate: what the task will buy and roughly what it costs, before any money moves.
// Uses each step's best compatible seller's listed price. Unknowns ("every page of Travel": we only learn
// the page count from page 1) make it a lower bound, and the buyer says so.

import { fromUnits } from "@dron/shared";
import type { Market } from "./market.ts";
import { fxNeed, sampleTextNeed, sampleTextNeedSingle, scrapeNeed } from "./needs.ts";
import { list, type TaskSpec } from "./spec.ts";

export interface EstimateLine {
  what: string;
  calls: number;
  unitUnits: string | null;
  serviceId: string | null;
  subtotalUnits: string | null;
  note?: string;
}

export interface Estimate {
  totalUnits: string;
  totalUsdc: string;
  /** True when the real cost can only be higher (page counts discovered while scraping). */
  lowerBound: boolean;
  lines: EstimateLine[];
  /** Steps no compatible seller can do. */
  impossible: string[];
}

export function estimate(spec: TaskSpec, market: Market): Estimate {
  const lines: EstimateLine[] = [];
  const impossible: string[] = [];
  let lowerBound = false;
  let total = 0n;

  const add = (what: string, calls: number, price: { units: bigint; serviceId: string } | null, note?: string) => {
    if (calls === 0) return;
    if (!price) {
      impossible.push(what);
      lines.push({ what, calls, unitUnits: null, serviceId: null, subtotalUnits: null, note: "no compatible seller" });
      return;
    }
    const subtotal = price.units * BigInt(calls);
    total += subtotal;
    lines.push({ what, calls, unitUnits: price.units.toString(), serviceId: price.serviceId, subtotalUnits: subtotal.toString(), note });
  };

  const sources = spec.categories.length ? spec.categories : [null];
  for (const category of sources) {
    const where = category ? `${category}` : "catalogue";
    if (spec.pages.mode === "range") {
      const n = spec.pages.to - spec.pages.from + 1;
      add(`scrape ${where} pages ${spec.pages.from}-${spec.pages.to}`, n, market.bestPrice(scrapeNeed(category, spec.pages.from)));
    } else {
      lowerBound = true;
      add(`scrape every page of ${where}`, 1, market.bestPrice(scrapeNeed(category, 1)), "at least 1 page; the count is learned from page 1");
    }
  }

  for (const c of spec.currencies) add(`GBP to ${c} rate`, 1, market.bestPrice(fxNeed(c)));

  if (spec.text.mode !== "none") {
    const perCall = market.maxItems(sampleTextNeed(spec.text.style), "texts");
    const need = perCall >= 2 ? sampleTextNeed(spec.text.style) : sampleTextNeedSingle(spec.text.style);
    if (spec.aggregate.mode === "per_category" || spec.text.mode === "combined") {
      add(`Hindi ${spec.text.style} for ${spec.categories.length ? list(spec.categories) : "the result"}`, 1, market.bestPrice(sampleTextNeedSingle(spec.text.style)));
    } else {
      const texts = spec.select.mode === "top" ? spec.select.limit : undefined;
      if (texts === undefined) lowerBound = true;
      const calls = Math.ceil((texts ?? 1) / perCall);
      const note =
        perCall > 1 && texts && texts > 1
          ? `${texts} texts batched ${perCall} per call (one call per book would be ${texts})`
          : texts === undefined
            ? "at least 1; depends on how many books match"
            : undefined;
      add(`Hindi ${spec.text.style}${spec.text.mode === "each" ? " per book" : ""}`, calls, market.bestPrice(need), note);
    }
  }

  return { totalUnits: total.toString(), totalUsdc: fromUnits(total), lowerBound, lines, impossible };
}

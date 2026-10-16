// From spec to result. Stages, with as much in parallel as max_concurrency allows:
//
//   scrape (pages of each source)  ─┐
//   fx rates (one per currency)  ───┼─> compute (filter, select or compare; free) ─> texts (batched) ─> result
//                                   │
//   "every page" sources discover their page count from page 1 and fan out the rest.
//
// Priorities when slots are scarce: first page of each source, then rates, then remaining pages, then texts.

import { MAX_CATALOGUE_PAGES, list, type TaskSpec } from "./spec.ts";
import { aggregateByCategory, applyFilter, bookText, convertAll, guideText, mergeBooks, selectBooks, type Book, type Group, type Rate } from "./compute.ts";
import type { Executor, StepRecord } from "./executor.ts";
import type { Market } from "./market.ts";
import { fxNeed, sampleTextNeed, scrapeNeed, textNeed, type ScrapedPage } from "./needs.ts";

export interface ResultBook {
  rank: number;
  title: string;
  rating: number;
  priceGbp: number;
  prices: Record<string, number>;
  category: string | null;
  url?: string;
  text?: string;
}

export interface ResultGroup extends Omit<Group, "cheapest" | "priciest" | "bestRated"> {
  prices: { average: Record<string, number>; min: Record<string, number>; max: Record<string, number> };
  cheapest?: string;
  bestRated?: string;
}

export interface TaskResult {
  kind: "books" | "comparison";
  books: ResultBook[];
  groups: ResultGroup[];
  combinedText?: string;
  rates: Rate[];
  scanned: { pages: number; books: number; matching: number };
  textBatches: { calls: number; texts: number; perCall: number };
  gaps: string[];
}

const PRIORITY = { firstPage: 0, rate: 1, page: 2, text: 3 } as const;

export async function runPipeline(spec: TaskSpec, ex: Executor, market: Market, onProgress?: (msg: string) => void): Promise<TaskResult> {
  const gaps: string[] = [];
  const sources = spec.categories.length ? spec.categories : [null];

  // ---- rates (independent of scraping) ----
  const ratesPromise = Promise.all(spec.currencies.map((c, i) => ex.step(fxNeed(c, i), "fx", PRIORITY.rate)));

  // ---- scraping ----
  const pageSteps: { category: string | null; page: number; rec: StepRecord }[] = [];
  await Promise.all(
    sources.map(async (category) => {
      if (spec.pages.mode === "range") {
        const pages = range(spec.pages.from, spec.pages.to);
        const recs = await Promise.all(pages.map((p, i) => ex.step(scrapeNeed(category, p), "scrape", i === 0 ? PRIORITY.firstPage : PRIORITY.page)));
        recs.forEach((rec, i) => pageSteps.push({ category, page: pages[i]!, rec }));
        return;
      }
      // "all": page 1 tells us how many pages the source has.
      const first = await ex.step(scrapeNeed(category, 1), "scrape", PRIORITY.firstPage);
      pageSteps.push({ category, page: 1, rec: first });
      if (first.state !== "done") return;
      const out = first.output as ScrapedPage;
      if (typeof out.totalPages === "number" && out.totalPages > 1) {
        const total = Math.min(out.totalPages, MAX_CATALOGUE_PAGES);
        onProgress?.(`${category ?? "catalogue"} has ${total} pages`);
        const pages = range(2, total);
        const recs = await Promise.all(pages.map((p) => ex.step(scrapeNeed(category, p), "scrape", PRIORITY.page)));
        recs.forEach((rec, i) => pageSteps.push({ category, page: pages[i]!, rec }));
      } else if (out.totalPages === undefined && out.hasNext) {
        // A seller that only says "there is a next page": walk forward one page at a time.
        for (let p = 2, more = true; more && p <= MAX_CATALOGUE_PAGES; p++) {
          const rec = await ex.step(scrapeNeed(category, p), "scrape", PRIORITY.page);
          pageSteps.push({ category, page: p, rec });
          more = rec.state === "done" && Boolean((rec.output as ScrapedPage).hasNext);
        }
      }
    }),
  );

  const donePages = pageSteps.filter((p) => p.rec.state === "done");
  const missingPages = pageSteps.filter((p) => p.rec.state !== "done");
  if (missingPages.length) {
    gaps.push(`not scraped: ${missingPages.map((p) => `${p.category ?? "catalogue"} page ${p.page} (${p.rec.state === "blocked" ? "over budget" : (p.rec.error ?? "failed")})`).join(", ")}`);
  }
  const books = mergeBooks(donePages.map((p) => ({ category: (p.rec.output as ScrapedPage).category ?? p.category, page: p.page, books: (p.rec.output as ScrapedPage).books })));
  const matching = applyFilter(books, spec.filter);

  // Pitches and guides quote prices, so they wait for rates; summaries do not.
  const needsRatesForText = spec.text.mode !== "none" && spec.text.style !== "summary";
  let rates: Rate[] = [];
  const collectRates = async () => {
    const recs = await ratesPromise;
    rates = recs.flatMap((rec, i) => {
      if (rec.state !== "done") {
        gaps.push(`no ${spec.currencies[i]} rate (${rec.state === "blocked" ? "over budget" : (rec.error ?? "failed")})`);
        return [];
      }
      const o = rec.output as { rate: number; date?: string; source?: string };
      return [{ currency: spec.currencies[i]!, rate: o.rate, date: o.date, source: o.source, serviceId: rec.servedBy! }];
    });
  };
  if (needsRatesForText) await collectRates();

  const perCall = spec.text.mode === "none" ? 0 : market.maxItems(sampleTextNeed(spec.text.style), "texts");
  const result: TaskResult = {
    kind: spec.aggregate.mode === "per_category" ? "comparison" : "books",
    books: [],
    groups: [],
    rates: [],
    scanned: { pages: donePages.length, books: books.length, matching: matching.length },
    textBatches: { calls: 0, texts: 0, perCall },
    gaps,
  };

  if (spec.aggregate.mode === "per_category") {
    const groups = aggregateByCategory(matching, spec.categories);
    for (const g of groups) if (g.count === 0) gaps.push(`no matching books found for ${g.category}`);
    if (spec.text.mode !== "none" && groups.some((g) => g.count > 0)) {
      const rec = await ex.step(textNeed([guideText(groups.filter((g) => g.count > 0), rates)], spec.text.style, spec.text.maxSentences, `Hindi ${spec.text.style} for ${list(groups.map((g) => g.category))}`), "text", PRIORITY.text);
      result.textBatches = { calls: 1, texts: 1, perCall };
      if (rec.state === "done") result.combinedText = (rec.output as { results: { text: string }[] }).results[0]!.text;
      else gaps.push(`no Hindi ${spec.text.style} (${rec.state === "blocked" ? "over budget" : (rec.error ?? "failed")})`);
    }
    if (!needsRatesForText) await collectRates();
    result.groups = groups.map(({ cheapest, priciest: _p, bestRated, ...g }) => ({
      ...g,
      prices: { average: convertAll(g.averageGbp, rates), min: convertAll(g.minGbp, rates), max: convertAll(g.maxGbp, rates) },
      cheapest: cheapest?.title,
      bestRated: bestRated?.title,
    }));
  } else {
    const selected = selectBooks(matching, spec.select);
    if (spec.select.mode === "top" && selected.length < spec.select.limit) {
      gaps.push(`only ${selected.length} book${selected.length === 1 ? "" : "s"} matched (asked for ${spec.select.limit})`);
    }
    const texts = new Map<Book, string>();
    if (spec.text.mode !== "none" && selected.length) {
      const batches = chunk(selected, Math.max(1, perCall));
      result.textBatches = { calls: batches.length, texts: selected.length, perCall };
      // Most important first: batch 1 holds the top-ranked books.
      const recs = await Promise.all(
        batches.map((batch, i) =>
          ex.step(
            textNeed(batch.map((b) => bookText(b, spec.text.style, rates)), spec.text.style, spec.text.maxSentences, `Hindi ${spec.text.style}${batches.length > 1 ? ` ${i + 1}/${batches.length}` : ""} (${batch.map((b) => `"${short(b.title)}"`).join(", ")})`, i),
            "text",
            PRIORITY.text + i / 100,
          ),
        ),
      );
      recs.forEach((rec, i) => {
        if (rec.state === "done") {
          const results = (rec.output as { results: { text: string }[] }).results;
          batches[i]!.forEach((b, j) => texts.set(b, results[j]!.text));
        } else {
          gaps.push(`no Hindi ${spec.text.style} for ${batches[i]!.map((b) => `"${short(b.title)}"`).join(", ")} (${rec.state === "blocked" ? "over budget" : (rec.error ?? "failed")})`);
        }
      });
    }
    if (!needsRatesForText) await collectRates();
    result.books = selected.map((b, i) => ({
      rank: i + 1,
      title: b.title,
      rating: b.rating,
      priceGbp: b.priceGbp,
      prices: convertAll(b.priceGbp, rates),
      category: b.category,
      url: b.url,
      text: texts.get(b),
    }));
  }
  result.rates = rates;
  return result;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const chunk = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
const short = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

// The three things this buyer purchases. Each need carries the request variants it can send and a
// usability check for what comes back (on top of the seller's own listed schema, which the payment core
// already enforces).

import { createHash } from "node:crypto";
import type { Need } from "./market.ts";
import type { TextStyle } from "./spec.ts";

export interface ScrapedBook {
  title: string;
  priceGbp: number;
  rating: number;
  description?: string;
  url?: string;
  inStock?: boolean;
}

export interface ScrapedPage {
  books: ScrapedBook[];
  totalPages?: number;
  hasNext?: boolean;
  category?: string | null;
}

export function scrapeNeed(category: string | null, page: number): Need {
  return {
    key: `scrape|${category ?? "*"}|${page}`,
    category: "scraping",
    label: `${category ? `${category} ` : "catalogue "}page ${page}`,
    inputs: category ? [{ page, category }] : [{ page }],
    provides: ["books[].title", "books[].priceGbp", "books[].rating"],
    spreadKey: page,
    usable(output) {
      const o = output as Partial<ScrapedPage> | undefined;
      if (!o || !Array.isArray(o.books)) return "no books array";
      if (o.books.length === 0) return "no books on the page";
      const bad = o.books.findIndex((b) => !b || typeof b.title !== "string" || typeof b.priceGbp !== "number" || !Number.isFinite(b.priceGbp) || typeof b.rating !== "number");
      return bad >= 0 ? `book ${bad} lacks title, priceGbp or rating` : null;
    },
  };
}

export function fxNeed(to: string, position?: number): Need {
  return {
    key: `fx|GBP|${to}`,
    category: "data",
    label: `GBP to ${to} rate`,
    inputs: [{ from: "GBP", to }],
    provides: ["rate"],
    spreadKey: position,
    usable(output) {
      const rate = (output as { rate?: unknown } | undefined)?.rate;
      return typeof rate === "number" && rate > 0 && Number.isFinite(rate) ? null : "no positive rate";
    },
  };
}

export function textNeed(texts: string[], style: TextStyle, maxSentences: number, label: string, position?: number): Need {
  const digest = createHash("sha256").update(JSON.stringify([style, maxSentences, texts])).digest("hex").slice(0, 16);
  return {
    key: `text|${style}|${maxSentences}|${digest}`,
    category: "inference",
    label,
    inputs: [{ texts, style, maxSentences, language: "hi" }, { texts, style, maxSentences }, { texts, style }, { texts }],
    provides: ["results[].text"],
    spreadKey: position,
    usable(output) {
      const results = (output as { results?: unknown } | undefined)?.results;
      if (!Array.isArray(results)) return "no results array";
      if (results.length !== texts.length) return `expected ${texts.length} results, got ${results.length}`;
      return results.every((r) => r && typeof (r as { text?: unknown }).text === "string" && (r as { text: string }).text.trim()) ? null : "an empty result";
    },
  };
}

/** Probe needs used for estimates and batch sizing before the real inputs exist. */
export const sampleTextNeed = (style: TextStyle) => textNeed(["sample one", "sample two"], style, 2, "sample");
export const sampleTextNeedSingle = (style: TextStyle) => textNeed(["sample"], style, 2, "sample");

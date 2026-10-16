// Free, local work on what was bought: filtering, sorting, comparing and currency conversion.
// Display amounts (book prices in GBP, INR...) are not USDC, so ordinary numbers are fine here;
// they are rounded to the currency's minor unit once, at the end.

import type { ScrapedBook } from "./needs.ts";
import type { Metric, TaskSpec } from "./spec.ts";

export interface Book extends ScrapedBook {
  category: string | null;
  page: number;
}

export interface Rate {
  currency: string;
  rate: number;
  date?: string;
  source?: string;
  serviceId: string;
}

const ZERO_DECIMALS = new Set(["JPY", "KRW", "ISK", "HUF", "IDR"]);

export function convert(gbp: number, rate: number, currency: string): number {
  const value = gbp * rate;
  return ZERO_DECIMALS.has(currency) ? Math.round(value) : Math.round(value * 100) / 100;
}

export function convertAll(gbp: number, rates: Rate[]): Record<string, number> {
  return Object.fromEntries(rates.map((r) => [r.currency, convert(gbp, r.rate, r.currency)]));
}

export function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: ZERO_DECIMALS.has(currency) ? 0 : 2,
    }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

/** Dedupes by URL (or title) across pages and sources. */
export function mergeBooks(pages: { category: string | null; page: number; books: ScrapedBook[] }[]): Book[] {
  const seen = new Map<string, Book>();
  for (const p of pages) {
    for (const b of p.books) {
      const key = b.url || `${b.title}|${b.priceGbp}`;
      if (!seen.has(key)) seen.set(key, { ...b, category: p.category, page: p.page });
    }
  }
  return [...seen.values()];
}

export function applyFilter(books: Book[], filter: TaskSpec["filter"]): Book[] {
  return books.filter(
    (b) => b.rating >= filter.minRating && b.rating <= filter.maxRating && (!filter.inStockOnly || b.inStock !== false),
  );
}

export function selectBooks(books: Book[], select: TaskSpec["select"]): Book[] {
  const dir = select.order === "asc" ? 1 : -1;
  const sorted = [...books].sort((a, b) => {
    const primary =
      select.sortBy === "price" ? a.priceGbp - b.priceGbp : select.sortBy === "rating" ? a.rating - b.rating : a.title.localeCompare(b.title);
    // ties: cheaper first, then title, so results are deterministic
    return dir * primary || a.priceGbp - b.priceGbp || a.title.localeCompare(b.title);
  });
  return sorted.slice(0, select.limit);
}

export interface Group {
  category: string;
  count: number;
  averageGbp: number;
  minGbp: number;
  maxGbp: number;
  cheapest?: Book;
  priciest?: Book;
  bestRated?: Book;
}

export function aggregateByCategory(books: Book[], categories: string[]): Group[] {
  const names = categories.length ? categories : ["Whole catalogue"];
  return names.map((name) => {
    const inGroup = categories.length ? books.filter((b) => (b.category ?? "").toLowerCase() === name.toLowerCase()) : books;
    const prices = inGroup.map((b) => b.priceGbp);
    const sum = prices.reduce((a, b) => a + b, 0);
    const by = (f: (a: Book, b: Book) => number) => [...inGroup].sort(f)[0];
    return {
      category: name,
      count: inGroup.length,
      averageGbp: inGroup.length ? Math.round((sum / inGroup.length) * 100) / 100 : 0,
      minGbp: inGroup.length ? Math.min(...prices) : 0,
      maxGbp: inGroup.length ? Math.max(...prices) : 0,
      cheapest: by((a, b) => a.priceGbp - b.priceGbp),
      priciest: by((a, b) => b.priceGbp - a.priceGbp),
      bestRated: by((a, b) => b.rating - a.rating || a.priceGbp - b.priceGbp),
    };
  });
}

export const metricLabel: Record<Metric, string> = {
  average_price: "average price",
  count: "number of books",
  min_price: "cheapest",
  max_price: "most expensive",
};

const MAX_TEXT = 5500;

/** The text sent to the inference seller for one book. */
export function bookText(book: Book, style: string, rates: Rate[]): string {
  const description = (book.description ?? "").trim();
  if (style === "summary") {
    return truncate(description ? `Title: ${book.title}\n\n${description}` : `Title: ${book.title} (no description on the site)`);
  }
  const prices = [`£${book.priceGbp.toFixed(2)}`, ...rates.map((r) => formatMoney(convert(book.priceGbp, r.rate, r.currency), r.currency))].join(" / ");
  return truncate(`Title: ${book.title}\nRating: ${book.rating}/5\nPrice: ${prices}\nDescription: ${description.slice(0, 1500) || "none"}`);
}

/** The single text for a combined guide over the comparison groups. */
export function guideText(groups: Group[], rates: Rate[]): string {
  const money = (gbp: number) => [`£${gbp.toFixed(2)}`, ...rates.map((r) => formatMoney(convert(gbp, r.rate, r.currency), r.currency))].join(" / ");
  const lines = groups.map((g) => {
    const picks = [
      g.cheapest && `cheapest "${g.cheapest.title}" (${money(g.cheapest.priceGbp)})`,
      g.bestRated && `best rated "${g.bestRated.title}" (${g.bestRated.rating}/5, ${money(g.bestRated.priceGbp)})`,
    ].filter(Boolean);
    return `${g.category}: ${g.count} books, average ${money(g.averageGbp)}, range ${money(g.minGbp)} to ${money(g.maxGbp)}; ${picks.join("; ")}.`;
  });
  return truncate(`Book price comparison from books.toscrape.com (a demo shop).\n${lines.join("\n")}\nWrite a short buying guide for a reader choosing between these categories.`);
}

function truncate(s: string): string {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;
}

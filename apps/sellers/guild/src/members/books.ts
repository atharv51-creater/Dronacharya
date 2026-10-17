// rich-shelf and book-inspector: books.toscrape.com, through the shelf-scraper's own fetcher (robots.txt,
// honest User-Agent, concurrency cap). Product pages are parsed for everything they show.

import * as cheerio from "cheerio";
import { HttpError, type JsonSchema } from "@dron/shared";
import type { PaidRoute } from "@dron/x402-kit";
import { fetchHtml, scrapeCataloguePage } from "@dron/seller-scraper/books";
import { scrapeInputSchema, scrapeOutputSchema } from "@dron/seller-scraper/schemas";

const RATING: Record<string, number> = { One: 1, Two: 2, Three: 3, Four: 4, Five: 5 };
const PRODUCT_URL = /^https:\/\/books\.toscrape\.com\/catalogue\/[a-z0-9_-]+\/index\.html$/;

export interface ProductDetails {
  url: string;
  title: string;
  upc: string;
  productType: string;
  priceExclTaxGbp: number;
  priceInclTaxGbp: number;
  taxGbp: number;
  availability: string;
  inStock: boolean;
  stockCount: number | null;
  reviews: number;
  rating: number;
  category: string | null;
  description: string;
  imageUrl: string | null;
}

const cache = new Map<string, { value: ProductDetails; expires: number }>();
const TTL_MS = 6 * 3600_000;
const money = (s: string) => {
  const m = /(\d+(?:\.\d{1,2})?)/.exec(s);
  if (!m) throw new HttpError(502, "upstream_changed", `unexpected price format: ${s.trim()}`);
  return Number(m[1]);
};

export function parseProductPage(html: string, url: string): ProductDetails {
  const $ = cheerio.load(html);
  const main = $(".product_main");
  const title = main.find("h1").first().text().trim();
  if (!title) throw new HttpError(502, "upstream_changed", "no product title on the page");
  const row = (name: string) => $("table.table th").filter((_, th) => $(th).text().trim() === name).first().next("td").text().trim();
  const availability = row("Availability") || main.find(".availability").text().replace(/\s+/g, " ").trim();
  const stock = /\((\d+)\s+available\)/i.exec(availability);
  const ratingClass = (main.find("p.star-rating").attr("class") ?? "").split(/\s+/).find((c) => c in RATING);
  const crumbs = $("ul.breadcrumb li").map((_, li) => $(li).text().trim()).get();
  const img = $("#product_gallery img").attr("src");
  return {
    url,
    title,
    upc: row("UPC"),
    productType: row("Product Type"),
    priceExclTaxGbp: money(row("Price (excl. tax)")),
    priceInclTaxGbp: money(row("Price (incl. tax)")),
    taxGbp: money(row("Tax") || "0"),
    availability,
    inStock: /in stock/i.test(availability),
    stockCount: stock ? Number(stock[1]) : null,
    reviews: Number(row("Number of reviews") || 0) || 0,
    rating: ratingClass ? RATING[ratingClass]! : 0,
    // Home > Books > <Category> > <Title>
    category: crumbs.length >= 4 ? crumbs[2]! : null,
    description: $("#product_description").next("p").text().replace(/\s+/g, " ").replace(/\s*\.\.\.more$/, "").trim(),
    imageUrl: img ? new URL(img, url).href : null,
  };
}

export async function inspectProduct(url: string, signal?: AbortSignal): Promise<ProductDetails> {
  if (!PRODUCT_URL.test(url)) throw new HttpError(400, "not_a_product_page", "url must be a books.toscrape.com product page (…/catalogue/<book>/index.html)");
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.value;
  const html = await fetchHtml(url, signal);
  if (!html) throw new HttpError(404, "book_not_found", "no such product page");
  const value = parseProductPage(html, url);
  cache.set(url, { value, expires: Date.now() + TTL_MS });
  if (cache.size > 3000) cache.delete(cache.keys().next().value!);
  return value;
}

const productProps = {
  url: { type: "string", format: "uri" },
  title: { type: "string", minLength: 1 },
  upc: { type: "string" },
  productType: { type: "string" },
  priceExclTaxGbp: { type: "number", minimum: 0 },
  priceInclTaxGbp: { type: "number", minimum: 0 },
  taxGbp: { type: "number", minimum: 0 },
  availability: { type: "string" },
  inStock: { type: "boolean" },
  stockCount: { type: ["integer", "null"], minimum: 0 },
  reviews: { type: "integer", minimum: 0 },
  rating: { type: "integer", minimum: 0, maximum: 5 },
  category: { type: ["string", "null"] },
  description: { type: "string" },
  imageUrl: { type: ["string", "null"], format: "uri" },
} as const;

export const bookInspector: PaidRoute = {
  id: "book-inspector",
  name: "book-inspector",
  category: "scraping",
  description:
    "Everything one books.toscrape.com product page shows: UPC, prices excl./incl. tax, exact stock count, number of reviews, " +
    "star rating, category (from the breadcrumb), full description and cover image URL. Pass the product page URL.",
  method: "GET",
  path: "/inspect",
  priceUnits: 2000n,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", pattern: PRODUCT_URL.source, description: "Product page, e.g. https://books.toscrape.com/catalogue/sophies-world_966/index.html" },
    },
  },
  outputSchema: { type: "object", additionalProperties: false, required: Object.keys(productProps), properties: productProps },
  timeoutMs: 15_000,
  handler: (input: { url: string }, ctx) => inspectProduct(input.url, ctx.signal),
};

// rich-shelf: the shelf-scraper's page, every book enriched from its product page. Same input and a
// superset of the output, so a buyer that can use shelf-scraper can use this one too.
const base = scrapeOutputSchema as { properties: Record<string, any>; required: string[] };
const bookItem = base.properties.books.items as { properties: Record<string, unknown>; required: string[] };
export const richShelfOutputSchema: JsonSchema = {
  ...base,
  properties: {
    ...base.properties,
    books: {
      ...base.properties.books,
      items: {
        ...bookItem,
        required: [...bookItem.required, "stockCount", "reviews", "bookCategory", "imageUrl"],
        properties: {
          ...bookItem.properties,
          stockCount: productProps.stockCount,
          reviews: productProps.reviews,
          bookCategory: productProps.category,
          imageUrl: productProps.imageUrl,
        },
      },
    },
  },
};

export const richShelf: PaidRoute = {
  id: "rich-shelf",
  name: "rich-shelf",
  category: "scraping",
  description:
    "One books.toscrape.com catalogue page (20 books, optionally within a category) with the shelf-scraper fields " +
    "(title, GBP price, rating, stock, UPC, description) PLUS each book's exact stock count, review count, own category and cover image.",
  method: "GET",
  path: "/scrape",
  priceUnits: 6000n,
  inputSchema: scrapeInputSchema,
  outputSchema: richShelfOutputSchema,
  timeoutMs: 30_000,
  handler: async (input: { page: number; category?: string }, ctx) => {
    const page = await scrapeCataloguePage({ page: input.page, category: input.category, signal: ctx.signal });
    const books = await Promise.all(
      page.books.map(async (b) => {
        const d = await inspectProduct(b.url, ctx.signal);
        return { ...b, stockCount: d.stockCount, reviews: d.reviews, bookCategory: d.category, imageUrl: d.imageUrl };
      }),
    );
    return { ...page, books };
  },
};


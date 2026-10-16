// books.toscrape.com scraper: one catalogue page (optionally inside a category), with each book's
// description and UPC filled in from its product page. The site is a sandbox built for scraping;
// we still honour robots.txt, send an honest User-Agent, cap concurrency and cache everything.

import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import { HttpError } from "@dron/shared";

export const SITE = "https://books.toscrape.com/";
const USER_AGENT = "DronacharyaBot/0.1 (+https://github.com/atharv51-creater/Dronacharya; hackathon)";
const MAX_PARALLEL_FETCHES = 6;
const RATING: Record<string, number> = { One: 1, Two: 2, Three: 3, Four: 4, Five: 5 };

export interface Book {
  title: string;
  priceGbp: number;
  rating: number;
  inStock: boolean;
  availability: string;
  url: string;
  upc: string;
  description: string;
}

export interface CataloguePage {
  source: string;
  page: number;
  totalPages: number;
  hasNext: boolean;
  category: string | null;
  books: Book[];
}

// ---------- tiny TTL cache + concurrency gate ----------

class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();
  constructor(private readonly ttlMs: number, private readonly max = 2000) {}
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: V): void {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}

let active = 0;
const waiting: (() => void)[] = [];
async function gate<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL_FETCHES) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const pageCache = new TtlCache<CataloguePage>(6 * 3600_000, 500);
const productCache = new TtlCache<{ upc: string; description: string }>(24 * 3600_000);
const inflight = new Map<string, Promise<unknown>>();

/** De-duplicates concurrent fetches of the same URL (two buyers asking for page 1 at once fetch it once). */
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- robots.txt ----------

let robots: { isAllowed(url: string, ua?: string): boolean | undefined } | undefined;
let robotsFetchedAt = 0;

async function assertAllowed(url: string, signal?: AbortSignal): Promise<void> {
  if (!robots || Date.now() - robotsFetchedAt > 24 * 3600_000) {
    const robotsUrl = new URL("/robots.txt", SITE).href;
    let body = "";
    try {
      const res = await fetch(robotsUrl, { headers: { "user-agent": USER_AGENT }, signal });
      // 4xx means "no robots.txt": everything is allowed. 5xx means unknown: be conservative and retry later.
      if (res.ok) body = await res.text();
      else if (res.status >= 500) throw new HttpError(503, "robots_unavailable", "robots.txt could not be read");
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, "robots_unavailable", "robots.txt could not be read");
    }
    robots = robotsParser(robotsUrl, body);
    robotsFetchedAt = Date.now();
  }
  if (robots.isAllowed(url, USER_AGENT) === false) throw new HttpError(403, "disallowed_by_robots", `robots.txt disallows ${url}`);
}

// ---------- fetching ----------

async function fetchHtml(url: string, signal?: AbortSignal): Promise<string | null> {
  if (!url.startsWith(SITE)) throw new HttpError(400, "off_site", "only books.toscrape.com is scraped");
  await assertAllowed(url, signal);
  return gate(async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html" }, signal });
        if (res.status === 404) return null;
        if (!res.ok) throw new HttpError(502, "upstream_error", `books.toscrape.com answered ${res.status}`);
        return await res.text();
      } catch (err) {
        if (signal?.aborted || attempt >= 2 || (err instanceof HttpError && err.status !== 502)) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(502, "upstream_unreachable", "could not reach books.toscrape.com");
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  });
}

// ---------- categories ----------

let categories: Map<string, { name: string; slug: string }> | undefined;

async function resolveCategory(input: string, signal?: AbortSignal): Promise<{ name: string; slug: string }> {
  if (!categories) {
    const html = await fetchHtml(SITE + "index.html", signal);
    if (!html) throw new HttpError(502, "upstream_error", "could not load the category list");
    const $ = cheerio.load(html);
    const map = new Map<string, { name: string; slug: string }>();
    $("ul.nav-list ul a").each((_, a) => {
      const name = $(a).text().trim();
      const slug = /category\/books\/([^/]+)\//.exec($(a).attr("href") ?? "")?.[1];
      if (name && slug) {
        const entry = { name, slug };
        map.set(normalise(name), entry);
        map.set(slug, entry);
        map.set(slug.replace(/_\d+$/, ""), entry);
      }
    });
    if (map.size === 0) throw new HttpError(502, "upstream_changed", "category list not found on books.toscrape.com");
    categories = map;
  }
  const hit = categories.get(normalise(input)) ?? categories.get(input.toLowerCase());
  if (!hit) throw new HttpError(404, "unknown_category", `no category called "${input}" on books.toscrape.com`);
  return hit;
}

const normalise = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, "-");

// ---------- parsing ----------

function parseCatalogue(html: string, pageUrl: string) {
  const $ = cheerio.load(html);
  const pager = /Page\s+(\d+)\s+of\s+(\d+)/i.exec($(".pager .current").text());
  const items = $("article.product_pod")
    .map((_, el) => {
      const pod = $(el);
      const link = pod.find("h3 a");
      const ratingClass = (pod.find("p.star-rating").attr("class") ?? "").split(/\s+/).find((c) => c in RATING);
      const availability = pod.find(".availability").text().replace(/\s+/g, " ").trim();
      return {
        title: (link.attr("title") ?? link.text()).trim(),
        priceGbp: parsePrice(pod.find(".price_color").text()),
        rating: ratingClass ? RATING[ratingClass]! : 0,
        inStock: /in stock/i.test(availability),
        availability,
        url: new URL(link.attr("href") ?? "", pageUrl).href,
      };
    })
    .get();
  return { items, totalPages: pager ? Number(pager[2]) : 1, hasNext: $(".pager .next a").length > 0 };
}

function parsePrice(text: string): number {
  const match = /(\d+(?:\.\d{1,2})?)/.exec(text);
  if (!match) throw new HttpError(502, "upstream_changed", `unexpected price format: ${text.trim()}`);
  return Number(match[1]);
}

async function productDetails(url: string, signal?: AbortSignal) {
  const cached = productCache.get(url);
  if (cached) return cached;
  return once(url, async () => {
    const html = await fetchHtml(url, signal);
    if (!html) return { upc: "", description: "" };
    const $ = cheerio.load(html);
    const description = $("#product_description").next("p").text().replace(/\s+/g, " ").replace(/\s*\.\.\.more$/, "").trim();
    const upc = $("th").filter((_, th) => $(th).text().trim() === "UPC").next("td").text().trim();
    const details = { upc, description };
    productCache.set(url, details);
    return details;
  });
}

// ---------- public API ----------

export async function scrapeCataloguePage(opts: { page: number; category?: string; signal?: AbortSignal }): Promise<CataloguePage> {
  const { page, signal } = opts;
  const category = opts.category ? await resolveCategory(opts.category, signal) : null;
  const base = category ? `${SITE}catalogue/category/books/${category.slug}/` : `${SITE}catalogue/`;
  const source = category ? (page === 1 ? `${base}index.html` : `${base}page-${page}.html`) : `${base}page-${page}.html`;

  const cached = pageCache.get(source);
  if (cached) return cached;

  return once(source, async () => {
    const html = await fetchHtml(source, signal);
    if (!html) {
      throw new HttpError(404, "page_not_found", category ? `"${category.name}" has no page ${page}` : `the catalogue has no page ${page}`);
    }
    const { items, totalPages, hasNext } = parseCatalogue(html, source);
    if (items.length === 0) throw new HttpError(502, "upstream_changed", "no books found on the page");

    const books: Book[] = await Promise.all(
      items.map(async (item) => ({ ...item, ...(await productDetails(item.url, signal)) })),
    );
    const result: CataloguePage = { source, page, totalPages, hasNext, category: category?.name ?? null, books };
    pageCache.set(source, result);
    return result;
  });
}

/** Optional: pre-fetch the first N catalogue pages so the first paid calls of a demo are fast. */
export async function warmUp(pages: number, log?: (msg: string) => void): Promise<void> {
  for (let page = 1; page <= pages; page++) {
    try {
      await scrapeCataloguePage({ page });
    } catch (err) {
      log?.(`warm-up of page ${page} failed: ${(err as Error).message}`);
      return;
    }
  }
  log?.(`warmed ${pages} catalogue page(s)`);
}

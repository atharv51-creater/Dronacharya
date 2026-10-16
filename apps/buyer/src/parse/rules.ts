// Deterministic task parser. Always available (no API key, no network), so the demo never depends on
// an LLM reading "pages 2 to 7" correctly. Gemini, when configured, handles phrasings these rules miss.

import { MAX_CATALOGUE_PAGES, emptySpec, type Metric, type TaskSpec } from "../spec.ts";

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, single: 1, two: 2, couple: 2, pair: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

export function toNumber(word: string | undefined): number | undefined {
  if (!word) return undefined;
  const w = word.toLowerCase();
  if (/^\d+$/.test(w)) return Number(w);
  return NUMBER_WORDS[w];
}

const NUM = String.raw`(\d+|a|an|one|single|two|couple|pair|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)`;

// Specific currency names first, so "Canadian dollars" is CAD, not USD.
const CURRENCY_NAMES: [RegExp, string][] = [
  [/\bcanadian dollars?\b/i, "CAD"],
  [/\baustralian dollars?\b/i, "AUD"],
  [/\bnew zealand dollars?\b/i, "NZD"],
  [/\bsingapore(?:an)? dollars?\b/i, "SGD"],
  [/\bhong kong dollars?\b/i, "HKD"],
  [/\b(?:indian )?rupees?\b|₹/i, "INR"],
  [/\beuros?\b|€/i, "EUR"],
  [/\b(?:us |american |u\.s\. )?dollars?\b|\$/i, "USD"],
  [/\b(?:japanese )?yen\b|¥/i, "JPY"],
  [/\b(?:chinese )?yuan\b|\brenminbi\b/i, "CNY"],
  [/\b(?:korean )?won\b/i, "KRW"],
  [/\bswiss francs?\b/i, "CHF"],
  [/\b(?:swedish )?kronor\b|\bkrona\b/i, "SEK"],
  [/\b(?:brazilian )?reals?\b/i, "BRL"],
  [/\bpesos?\b/i, "MXN"],
  [/\bzloty\b/i, "PLN"],
  [/\brand\b/i, "ZAR"],
  [/\b(?:british )?pounds?\b|\bsterling\b|£/i, "GBP"],
];
const ECB_CODES = new Set(
  "AUD BGN BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK JPY KRW MXN MYR NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR".split(" "),
);

export interface RulesResult {
  spec: TaskSpec;
  /** What the rules recognised, for the explanation and for comparing with the LLM's reading. */
  recognised: string[];
}

export function parseWithRules(task: string): RulesResult {
  const text = task.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const spec = emptySpec();
  const recognised: string[] = [];

  // "book" alone is often a verb ("book me a flight"): require the plural, the site, or a shopping phrase.
  const aboutBooks = /toscrape|\bbooks\b|\b(?:cheapest|priciest|most expensive|least expensive|highest[- ]rated|best[- ]rated|top[- ]rated)\s+book\b|\bbook\s+(?:prices?|titles?|descriptions?|categor(?:y|ies)|catalogue)\b/i.test(text);
  const offTopic = /\b(?:flights?|hotels?|weather|tickets?|taxis?|restaurants?|stocks?|crypto)\b/i.test(text) && !/toscrape/i.test(text);
  if (!aboutBooks || offTopic) {
    spec.supported = false;
    spec.unsupportedReason = "this buyer handles tasks about books on books.toscrape.com (scraping + currency data + Hindi text)";
    return { spec, recognised };
  }

  // ---- categories ----
  // Known names first (longest first, so "Historical Fiction" wins over "Historical" and "Fiction",
  // and "Food and Drink" is not split at "and"); then patterns for names we do not know.
  const categories = matchKnownCategories(text);
  if (categories.length === 0) {
    const inCategory = /\b(?:in|from|within) the ([A-Za-z][\w'&, -]*?) (?:category|genre|section)\b/i.exec(text);
    if (inCategory) categories.push(...splitList(inCategory[1]!));
    const compareGroup = /\b(?:of|for|between)\s+((?:[A-Z][\w'&-]*)(?:\s+[A-Z][\w'&-]*)*(?:\s*(?:,|\band\b|\bvs\.?|\bversus\b)\s*(?:[A-Z][\w'&-]*)(?:\s+[A-Z][\w'&-]*)*)+)\s+books\b/.exec(text);
    if (compareGroup) categories.push(...splitList(compareGroup[1]!));
  }
  spec.categories = [...new Set(categories.map((c) => c.trim()).filter((c) => c && !/^books?$/i.test(c)))];
  if (spec.categories.length) recognised.push(`categories: ${spec.categories.join(", ")}`);

  // ---- pages ----
  const range = new RegExp(String.raw`\bpages?\s+(\d+)\s*(?:to|-|–|—|through|thru|until)\s*(\d+)\b`, "i").exec(text);
  const firstN = new RegExp(String.raw`\b(?:first|top|opening)\s+${NUM}\s+(?:catalogue\s+|catalog\s+)?pages?\b`, "i").exec(text);
  const single = /\bpage\s+(\d+)\b/i.exec(text);
  const allPages = /\b(?:all|every|each)(?: of the| the)? (?:catalogue |catalog )?pages\b|\bwhole (?:catalogue|catalog|site)\b|\bentire (?:catalogue|catalog|site)\b|\ball \d+ pages\b/i.test(text);
  if (range) {
    spec.pages = { mode: "range", from: Number(range[1]), to: Number(range[2]) };
    recognised.push(`pages ${range[1]}-${range[2]}`);
  } else if (firstN && toNumber(firstN[1])) {
    spec.pages = { mode: "range", from: 1, to: toNumber(firstN[1])! };
    recognised.push(`first ${spec.pages.to} pages`);
  } else if (allPages) {
    spec.pages = spec.categories.length ? { mode: "all", from: 1, to: 1 } : { mode: "range", from: 1, to: MAX_CATALOGUE_PAGES };
    recognised.push("all pages");
  } else if (single) {
    spec.pages = { mode: "range", from: Number(single[1]), to: Number(single[1]) };
    recognised.push(`page ${single[1]}`);
  } else if (spec.categories.length) {
    spec.pages = { mode: "all", from: 1, to: 1 };
    recognised.push("every page of each category");
  } else {
    recognised.push("no pages named: using catalogue page 1");
  }

  // ---- rating ----
  const star = new RegExp(String.raw`\b${NUM}[- ]?(?:\+\s*)?stars?\b`, "i").exec(text) ?? new RegExp(String.raw`\brated\s+${NUM}\b`, "i").exec(text);
  if (star && toNumber(star[1])) {
    const n = Math.min(5, Math.max(1, toNumber(star[1])!));
    const around = lower.slice(Math.max(0, star.index - 20), star.index + star[0].length + 25);
    if (/at least|minimum|or (?:more|higher|better|above)|and (?:up|above|higher)|\+/.test(around)) {
      spec.filter.minRating = n;
      recognised.push(`rating >= ${n}`);
    } else if (/at most|or (?:less|lower|fewer|below)|and below|maximum/.test(around)) {
      spec.filter.maxRating = n;
      recognised.push(`rating <= ${n}`);
    } else {
      spec.filter.minRating = n;
      spec.filter.maxRating = n;
      recognised.push(`${n}-star`);
    }
  }
  if (/\bin[- ]stock\b|\bavailable\b/i.test(text)) {
    spec.filter.inStockOnly = true;
    recognised.push("in stock only");
  }

  // ---- selection ----
  const ORDER = String.raw`(cheapest|least expensive|lowest[- ]priced|most expensive|priciest|highest[- ]priced|dearest|costliest|top[- ]rated|highest[- ]rated|best[- ]rated|lowest[- ]rated|worst[- ]rated)`;
  const counted = new RegExp(String.raw`\b${NUM}\s+${ORDER}\b`, "i").exec(text) ?? new RegExp(String.raw`\b${ORDER}\s+${NUM}\b`, "i").exec(text);
  const orderOnly = new RegExp(String.raw`\bthe\s+${ORDER}\s+(?:book|title)\b`, "i").exec(text);
  const orderWord = (counted ? (/^\d|^[a-z]+$/i.test(counted[1]!) && toNumber(counted[1]) !== undefined ? counted[2] : counted[1]) : orderOnly?.[1])?.toLowerCase();
  const count = counted ? (toNumber(counted[1]) ?? toNumber(counted[2])) : orderOnly ? 1 : undefined;
  if (orderWord) {
    const desc = /most expensive|priciest|highest|dearest|costliest|top|best/.test(orderWord);
    const byRating = /rated/.test(orderWord);
    spec.select = {
      mode: "top",
      sortBy: byRating ? "rating" : "price",
      order: byRating ? (/lowest|worst/.test(orderWord) ? "asc" : "desc") : desc ? "desc" : "asc",
      limit: count ?? 1,
    };
    recognised.push(`${spec.select.limit} ${orderWord}`);
  } else {
    const plain = new RegExp(String.raw`\b(?:find|list|show|get|pick)\s+(?:the\s+)?${NUM}\s+(?:\w+\s+)?books\b`, "i").exec(text);
    if (plain && toNumber(plain[1])) {
      spec.select = { mode: "top", sortBy: "price", order: "asc", limit: toNumber(plain[1])! };
      recognised.push(`${spec.select.limit} books`);
    } else {
      spec.select = { mode: "all", sortBy: "price", order: "asc", limit: 20 };
    }
  }

  // ---- aggregate ----
  const wantsAverage = /\b(?:average|mean)\b/i.test(text);
  const compares = /\bcompare\b|\bcomparison\b|\bversus\b|\bvs\.?\b/i.test(text);
  if (wantsAverage || (compares && spec.categories.length > 1)) {
    const metrics: Metric[] = ["average_price", "count"];
    if (/\b(?:cheapest|lowest price|min(?:imum)?)\b/i.test(text)) metrics.push("min_price");
    if (/\b(?:most expensive|highest price|max(?:imum)?)\b/i.test(text)) metrics.push("max_price");
    spec.aggregate = { mode: "per_category", metrics };
    recognised.push("compare per category");
  }

  // ---- currencies (in order of appearance) ----
  // Specific names claim their text first, so the "dollars" in "Canadian dollars" cannot also count as USD,
  // while a separate "US dollars" later in the sentence still does.
  const found: { code: string; at: number }[] = [];
  const claimed: [number, number][] = [];
  for (const [re, code] of CURRENCY_NAMES) {
    for (const m of text.matchAll(new RegExp(re.source, `${re.flags.replace("g", "")}g`))) {
      const start = m.index!;
      const end = start + m[0].length;
      if (claimed.some(([a, b]) => start < b && end > a)) continue;
      claimed.push([start, end]);
      if (!found.some((f) => f.code === code)) found.push({ code, at: start });
      break;
    }
  }
  for (const m of text.matchAll(/\b([A-Z]{3})\b/g)) {
    if (ECB_CODES.has(m[1]!) && !found.some((f) => f.code === m[1])) found.push({ code: m[1]!, at: m.index! });
  }
  // "GBP" only counts when it is asked for as an output, not as a description of the source prices.
  spec.currencies = found.sort((a, b) => a.at - b.at).map((f) => f.code);
  if (spec.currencies.length) recognised.push(`currencies: ${spec.currencies.join(", ")}`);

  // ---- text ----
  const sentences = new RegExp(String.raw`\b${NUM}[- ]sentences?\b`, "i").exec(text);
  if (/\bguide\b|\brecommendation\b|\badvice\b/i.test(text)) {
    spec.text = { mode: "combined", style: "guide", language: "hi", maxSentences: toNumber(sentences?.[1]) ?? 4 };
  } else if (/\bpitch(?:es)?\b|\bone[- ]line(?:r)?\b|\btagline\b|\bblurb\b|\bsales line\b/i.test(text)) {
    spec.text = { mode: "each", style: "pitch", language: "hi", maxSentences: 1 };
  } else if (/\bsummar(?:y|ies|ise|ize|ised|ized)\b|\bdescribe\b|\bsynops[ie]s\b/i.test(text)) {
    spec.text = { mode: /\b(?:each|every|all|per)\b/i.test(text) || spec.aggregate.mode === "none" ? "each" : "combined", style: "summary", language: "hi", maxSentences: toNumber(sentences?.[1]) ?? 2 };
  }
  if (spec.text.mode !== "none") {
    recognised.push(`Hindi ${spec.text.style}${spec.text.mode === "each" ? " for each" : ""}`);
    if (/\bin (?!hindi)(english|french|german|spanish|tamil|bengali|marathi|telugu|urdu)\b/i.test(text)) recognised.push("note: only Hindi text is on offer; writing in Hindi");
  }

  return { spec, recognised };
}

/** The 50 categories of books.toscrape.com (a fixed sandbox; the scraper still resolves names live). */
export const KNOWN_CATEGORIES = [
  "Travel", "Mystery", "Historical Fiction", "Sequential Art", "Classics", "Philosophy", "Romance", "Womens Fiction", "Fiction",
  "Childrens", "Religion", "Nonfiction", "Music", "Default", "Science Fiction", "Sports and Games", "Add a comment", "Fantasy",
  "New Adult", "Young Adult", "Science", "Poetry", "Paranormal", "Art", "Psychology", "Autobiography", "Parenting", "Adult Fiction",
  "Humor", "Horror", "History", "Food and Drink", "Christian Fiction", "Business", "Biography", "Thriller", "Contemporary",
  "Spirituality", "Academic", "Self Help", "Historical", "Christian", "Suspense", "Short Stories", "Novels", "Health", "Politics",
  "Cultural", "Erotica", "Crime",
];
// Too generic to recognise from free text unless quoted or followed by "category".
const AMBIGUOUS = new Set(["Default", "Add a comment"]);

function matchKnownCategories(text: string): string[] {
  const taken: [number, number][] = [];
  const hits: { name: string; at: number }[] = [];
  for (const name of [...KNOWN_CATEGORIES].sort((a, b) => b.length - a.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Title Case as written on the site, or any case when it is plainly used as a category.
    const exact = new RegExp(String.raw`\b${escaped}\b`, "g");
    const contextual = new RegExp(String.raw`["“']${escaped}["”']|\b${escaped}\s+(?:category|genre|section)\b`, "gi");
    for (const re of AMBIGUOUS.has(name) ? [contextual] : [exact, contextual]) {
      for (const m of text.matchAll(re)) {
        const start = m.index!;
        const end = start + m[0].length;
        if (taken.some(([s, e]) => start < e && end > s)) continue;
        taken.push([start, end]);
        hits.push({ name, at: start });
      }
    }
  }
  return [...new Set(hits.sort((a, b) => a.at - b.at).map((h) => h.name))];
}

function splitList(s: string): string[] {
  return s
    .split(/\s*(?:,|\band\b|\bvs\.?|\bversus\b|&)\s*/i)
    .map((x) => x.trim().replace(/^the\s+/i, ""))
    .filter(Boolean);
}

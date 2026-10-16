// TaskSpec: what the buyer understood the task to be. The parser (Gemini or rules) only produces this;
// everything after it (planning, buying, computing, explaining) is plain code, so a judge changing the
// numbers in a task changes the spec, never the program.
//
// One spec shape covers the three example task families:
//   1. "From pages 1 to 4 ..., the three cheapest 5-star books, prices in rupees, summarise each in Hindi"
//   2. "In the Travel category ..., the 4 most expensive books, prices in EUR and JPY, a Hindi pitch for each"
//   3. "Compare the average price of Mystery and Historical Fiction books in USD, INR and EUR, plus a Hindi guide"

export const MAX_CATALOGUE_PAGES = 50;
export const MAX_SELECTION = 20;

export type SortBy = "price" | "rating" | "title";
export type TextStyle = "summary" | "pitch" | "guide";
export type Metric = "average_price" | "count" | "min_price" | "max_price";

export interface TaskSpec {
  /** false when the task is not something this buyer can do (it then says why and spends nothing). */
  supported: boolean;
  unsupportedReason: string;
  /** Category names as written ("Travel", "Historical Fiction"); empty means the whole catalogue. */
  categories: string[];
  /** "range": exactly pages from..to of each source. "all": every page of each source (discovered while scraping). */
  pages: { mode: "range" | "all"; from: number; to: number };
  filter: { minRating: number; maxRating: number; inStockOnly: boolean };
  /** "top": sort and keep `limit`. "all": keep every matching book (sorted). */
  select: { mode: "top" | "all"; sortBy: SortBy; order: "asc" | "desc"; limit: number };
  /** "per_category": compute metrics per category instead of listing books. */
  aggregate: { mode: "none" | "per_category"; metrics: Metric[] };
  /** ISO 4217 codes to convert the GBP prices into (GBP itself needs no conversion). */
  currencies: string[];
  /** "each": one text per selected book. "combined": one text for the whole result (e.g. a buying guide). */
  text: { mode: "none" | "each" | "combined"; style: TextStyle; language: "hi"; maxSentences: number };
}

/** JSON Schema for the parser's structured output. Kept to features structured outputs support. */
export const TASK_SPEC_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["supported", "unsupportedReason", "categories", "pages", "filter", "select", "aggregate", "currencies", "text"],
  properties: {
    supported: { type: "boolean" },
    unsupportedReason: { type: "string" },
    categories: { type: "array", items: { type: "string" } },
    pages: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "from", "to"],
      properties: { mode: { type: "string", enum: ["range", "all"] }, from: { type: "integer" }, to: { type: "integer" } },
    },
    filter: {
      type: "object",
      additionalProperties: false,
      required: ["minRating", "maxRating", "inStockOnly"],
      properties: { minRating: { type: "integer" }, maxRating: { type: "integer" }, inStockOnly: { type: "boolean" } },
    },
    select: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "sortBy", "order", "limit"],
      properties: {
        mode: { type: "string", enum: ["top", "all"] },
        sortBy: { type: "string", enum: ["price", "rating", "title"] },
        order: { type: "string", enum: ["asc", "desc"] },
        limit: { type: "integer" },
      },
    },
    aggregate: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "metrics"],
      properties: {
        mode: { type: "string", enum: ["none", "per_category"] },
        metrics: { type: "array", items: { type: "string", enum: ["average_price", "count", "min_price", "max_price"] } },
      },
    },
    currencies: { type: "array", items: { type: "string" } },
    text: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "style", "language", "maxSentences"],
      properties: {
        mode: { type: "string", enum: ["none", "each", "combined"] },
        style: { type: "string", enum: ["summary", "pitch", "guide"] },
        language: { type: "string", enum: ["hi"] },
        maxSentences: { type: "integer" },
      },
    },
  },
} as const;

export class SpecError extends Error {}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/** Makes any parser's output safe and canonical: clamps numbers, dedupes, fixes contradictions. */
export function normaliseSpec(raw: TaskSpec): { spec: TaskSpec; notes: string[] } {
  const notes: string[] = [];
  const spec: TaskSpec = structuredClone(raw);

  spec.categories = [...new Set(spec.categories.map((c) => c.trim()).filter(Boolean))].slice(0, 10);

  if (spec.pages.mode === "range") {
    let { from, to } = spec.pages;
    if (from > to) [from, to] = [to, from];
    const f = clamp(from, 1, MAX_CATALOGUE_PAGES);
    const t = clamp(to, f, MAX_CATALOGUE_PAGES);
    if (f !== from || t !== to) notes.push(`page range adjusted to ${f}-${t} (the catalogue has ${MAX_CATALOGUE_PAGES} pages)`);
    spec.pages = { mode: "range", from: f, to: t };
  } else {
    spec.pages = { mode: "all", from: 1, to: 1 };
  }

  let { minRating, maxRating } = spec.filter;
  if (minRating > maxRating) [minRating, maxRating] = [maxRating, minRating];
  spec.filter = { minRating: clamp(minRating, 1, 5), maxRating: clamp(maxRating, 1, 5), inStockOnly: Boolean(spec.filter.inStockOnly) };

  spec.select = { ...spec.select, limit: clamp(spec.select.limit || 1, 1, MAX_SELECTION) };

  spec.aggregate = { mode: spec.aggregate.mode, metrics: [...new Set(spec.aggregate.metrics)] };
  if (spec.aggregate.mode === "per_category" && spec.aggregate.metrics.length === 0) spec.aggregate.metrics = ["average_price", "count"];

  spec.currencies = [...new Set(spec.currencies.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c)))];
  if (spec.currencies.includes("GBP")) {
    spec.currencies = spec.currencies.filter((c) => c !== "GBP");
    notes.push("prices are already in GBP on books.toscrape.com, so no GBP conversion is bought");
  }

  spec.text = { ...spec.text, language: "hi", maxSentences: clamp(spec.text.maxSentences || 2, 1, 5) };
  if (spec.text.mode === "combined" && spec.text.style !== "guide" && spec.aggregate.mode === "per_category") spec.text.style = "guide";
  if (spec.aggregate.mode === "per_category" && spec.text.mode === "each") {
    spec.text.mode = "combined";
    notes.push("a per-category comparison gets one combined Hindi text rather than one per book");
  }
  if (spec.aggregate.mode === "per_category" && spec.categories.length === 0) {
    notes.push("comparing per category needs at least one category; comparing the whole catalogue as one group");
  }
  return { spec, notes };
}

export function describeSpec(spec: TaskSpec): string {
  if (!spec.supported) return `not supported: ${spec.unsupportedReason}`;
  const where = spec.categories.length ? `the ${list(spec.categories)} categor${spec.categories.length > 1 ? "ies" : "y"}` : "the whole catalogue";
  const pages = spec.pages.mode === "all" ? "every page" : spec.pages.from === spec.pages.to ? `page ${spec.pages.from}` : `pages ${spec.pages.from}-${spec.pages.to}`;
  const rating =
    spec.filter.minRating === 1 && spec.filter.maxRating === 5
      ? ""
      : spec.filter.minRating === spec.filter.maxRating
        ? `, ${spec.filter.minRating}-star only`
        : `, ${spec.filter.minRating}-${spec.filter.maxRating} stars`;
  const what =
    spec.aggregate.mode === "per_category"
      ? `compare ${spec.aggregate.metrics.join(", ").replace(/_/g, " ")} per category`
      : spec.select.mode === "top"
        ? `${spec.select.limit} ${describeOrder(spec.select)} book${spec.select.limit > 1 ? "s" : ""}`
        : `all matching books by ${spec.select.sortBy}`;
  const money = spec.currencies.length ? `; prices in ${spec.currencies.join(", ")}` : "";
  const text = spec.text.mode === "none" ? "" : `; Hindi ${spec.text.style}${spec.text.mode === "each" ? " for each" : ""}`;
  return `${what} from ${pages} of ${where}${rating}${spec.filter.inStockOnly ? ", in stock" : ""}${money}${text}`;
}

function describeOrder(select: TaskSpec["select"]): string {
  if (select.sortBy === "price") return select.order === "asc" ? "cheapest" : "most expensive";
  if (select.sortBy === "rating") return select.order === "desc" ? "highest-rated" : "lowest-rated";
  return select.order === "asc" ? "first (A-Z)" : "last (A-Z)";
}

export const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

export function emptySpec(): TaskSpec {
  return {
    supported: true,
    unsupportedReason: "",
    categories: [],
    pages: { mode: "range", from: 1, to: 1 },
    filter: { minRating: 1, maxRating: 5, inStockOnly: false },
    select: { mode: "top", sortBy: "price", order: "asc", limit: 3 },
    aggregate: { mode: "none", metrics: [] },
    currencies: [],
    text: { mode: "none", style: "summary", language: "hi", maxSentences: 2 },
  };
}

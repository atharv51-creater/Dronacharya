import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTask } from "../../apps/buyer/src/parse/index.ts";
import { parseWithRules } from "../../apps/buyer/src/parse/rules.ts";
import { emptySpec, normaliseSpec, type TaskSpec } from "../../apps/buyer/src/spec.ts";
import { EXAMPLE_TASKS } from "../../apps/buyer/src/examples.ts";

const rules = (t: string) => normaliseSpec(parseWithRules(t).spec).spec;

describe("rules parser: the three example tasks", () => {
  it("task 1", () => {
    const s = rules(EXAMPLE_TASKS[0].task);
    assert.deepEqual(s.pages, { mode: "range", from: 1, to: 4 });
    assert.deepEqual([s.filter.minRating, s.filter.maxRating], [5, 5]);
    assert.deepEqual(s.select, { mode: "top", sortBy: "price", order: "asc", limit: 3 });
    assert.deepEqual(s.currencies, ["INR"]);
    assert.deepEqual([s.text.mode, s.text.style], ["each", "summary"]);
    assert.deepEqual(s.categories, []);
  });
  it("task 2", () => {
    const s = rules(EXAMPLE_TASKS[1].task);
    assert.deepEqual(s.categories, ["Travel"]);
    assert.equal(s.pages.mode, "all");
    assert.deepEqual(s.select, { mode: "top", sortBy: "price", order: "desc", limit: 4 });
    assert.deepEqual(s.currencies, ["EUR", "JPY"]);
    assert.deepEqual([s.text.mode, s.text.style, s.text.maxSentences], ["each", "pitch", 1]);
  });
  it("task 3", () => {
    const s = rules(EXAMPLE_TASKS[2].task);
    assert.deepEqual(s.categories, ["Mystery", "Historical Fiction"]);
    assert.equal(s.aggregate.mode, "per_category");
    assert.ok(s.aggregate.metrics.includes("average_price"));
    assert.deepEqual(s.currencies, ["USD", "INR", "EUR"]);
    assert.deepEqual([s.text.mode, s.text.style], ["combined", "guide"]);
  });
});

describe("rules parser: judges change the numbers", () => {
  const cases: [string, (s: TaskSpec) => void][] = [
    ["From pages 3 to 7 of books.toscrape.com, find the five cheapest 4-star books", (s) => {
      assert.deepEqual(s.pages, { mode: "range", from: 3, to: 7 });
      assert.equal(s.select.limit, 5);
      assert.deepEqual([s.filter.minRating, s.filter.maxRating], [4, 4]);
    }],
    ["Using the first 2 pages, list the 2 most expensive books rated at least 3 stars in yen", (s) => {
      assert.deepEqual(s.pages, { mode: "range", from: 1, to: 2 });
      assert.deepEqual([s.select.order, s.select.limit], ["desc", 2]);
      assert.deepEqual([s.filter.minRating, s.filter.maxRating], [3, 5]);
      assert.deepEqual(s.currencies, ["JPY"]);
    }],
    ["From page 9 of books.toscrape.com find the cheapest book in Canadian dollars and US dollars", (s) => {
      assert.deepEqual(s.pages, { mode: "range", from: 9, to: 9 });
      assert.equal(s.select.limit, 1);
      assert.deepEqual(s.currencies, ["CAD", "USD"]);
    }],
    ["In the Science Fiction category, find the 3 highest-rated books, prices in €, and summarise each in Hindi in one sentence", (s) => {
      assert.deepEqual(s.categories, ["Science Fiction"]);
      assert.deepEqual([s.select.sortBy, s.select.order, s.select.limit], ["rating", "desc", 3]);
      assert.deepEqual(s.currencies, ["EUR"]);
      assert.equal(s.text.maxSentences, 1);
    }],
    ["Compare Food and Drink vs Poetry books: average price in JPY, plus a Hindi buying guide", (s) => {
      assert.deepEqual(s.categories, ["Food and Drink", "Poetry"]);
      assert.equal(s.aggregate.mode, "per_category");
    }],
    ["From pages 1 to 99 of books.toscrape.com, find the three cheapest books", (s) => {
      assert.deepEqual(s.pages, { mode: "range", from: 1, to: 50 }, "clamped to the catalogue");
    }],
  ];
  for (const [task, check] of cases) it(task, () => check(rules(task)));

  it("prices already in GBP: no GBP rate is bought", () => {
    const { spec, notes } = normaliseSpec(parseWithRules("From page 1 of books.toscrape.com, find the cheapest book, price in pounds and rupees").spec);
    assert.deepEqual(spec.currencies, ["INR"]);
    assert.ok(notes.some((n) => /already in GBP/.test(n)));
  });

  for (const t of ["Book me a flight to Paris for tomorrow", "What is the weather in Delhi?", "Find hotel prices in Goa"]) {
    it(`refuses off-topic: "${t}"`, () => assert.equal(rules(t).supported, false));
  }
});

describe("parseTask: LLM first, rules as the safety net", () => {
  const llmSpec = (patch: Partial<TaskSpec>): TaskSpec => ({ ...emptySpec(), pages: { mode: "range", from: 1, to: 4 }, ...patch });

  it("uses a valid LLM reading and notes where the rules disagree", async () => {
    const out = await parseTask(EXAMPLE_TASKS[0].task, {
      llm: async () => ({ spec: llmSpec({ filter: { minRating: 5, maxRating: 5, inStockOnly: false }, currencies: ["INR"], select: { mode: "top", sortBy: "price", order: "asc", limit: 2 } }), model: "gemini-test" }),
    });
    assert.equal(out.parsedBy, "gemini-test");
    assert.equal(out.spec.select.limit, 2);
    assert.ok(out.notes.some((n) => /rules parser read this differently/.test(n)));
  });

  it("falls back to the rules when the LLM fails or returns an invalid spec", async () => {
    const failing = await parseTask(EXAMPLE_TASKS[0].task, { llm: async () => { throw new Error("no credit"); } });
    assert.equal(failing.parsedBy, "rules");
    assert.ok(failing.notes.some((n) => /LLM parser unavailable/.test(n)));
    const invalid = await parseTask(EXAMPLE_TASKS[0].task, { llm: async () => ({ spec: { nonsense: true } as unknown as TaskSpec, model: "x" }) });
    assert.equal(invalid.parsedBy, "rules");
    assert.equal(invalid.spec.select.limit, 3);
  });

  it("normalises whatever the LLM says (clamps, dedupes, drops GBP)", async () => {
    const out = await parseTask("x books", {
      llm: async () => ({ spec: llmSpec({ pages: { mode: "range", from: 9, to: 400 }, currencies: ["inr", "INR", "GBP", "nope"] }), model: "m" }),
    });
    assert.deepEqual(out.spec.pages, { mode: "range", from: 9, to: 50 });
    assert.deepEqual(out.spec.currencies, ["INR"]);
  });
});

// The seller guild: every listing is acceptable to the registry, Scout uses exactly the drop-in
// alternatives, the LLM helper fails over between models, and each seller's own logic is correct.

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { HttpError, LlmError, NETWORK, USDC_ADDRESS, chatText, chatJson, extractJson, type ServiceView } from "@dron/shared";
import { buildListing } from "@dron/x402-kit";
import { validateListing } from "../../apps/registry/src/validation.ts";
import { Market } from "../../apps/buyer/src/market.ts";
import { fxNeed, scrapeNeed, textNeed } from "../../apps/buyer/src/needs.ts";
import { guildRoster } from "../../apps/sellers/guild/src/roster.ts";
import { bookInspector, parseProductPage, richShelf } from "../../apps/sellers/guild/src/members/books.ts";
import { fxGlobal, fxTrend, globalRate, trendStats } from "../../apps/sellers/guild/src/members/fx.ts";
import { LANGUAGES, cleanTag, indicTranslator, nvidiaHindi, openrouterHindi, scriptShare, sentimentTagger } from "../../apps/sellers/guild/src/members/llm.ts";
import { analyseText, rakeKeywords, textInsights } from "../../apps/sellers/guild/src/members/insights.ts";
import { advisePrice, lintListing, listingAuditor, priceAdvisor } from "../../apps/sellers/guild/src/members/advisors.ts";
import { randomPayTo } from "./helpers.ts";

const ROUTES = [richShelf, bookInspector, fxGlobal, fxTrend, nvidiaHindi, openrouterHindi, indicTranslator, sentimentTagger, textInsights, priceAdvisor, listingAuditor];

function view(route: (typeof ROUTES)[number]): ServiceView {
  const listing = buildListing(route, { sellerId: route.id, publicUrl: `https://${route.id}.example`, payTo: randomPayTo() });
  return {
    ...listing,
    priceUsdc: "0",
    reputation: { calls: 0, successes: 0, successRate: 2 / 3, medianLatencyMs: null, failStreak: 0 },
    costPerSuccessUnits: String((BigInt(listing.priceUnits) * 3n) / 2n),
    registeredBy: "admin",
    createdAt: "",
    updatedAt: "",
  } as unknown as ServiceView;
}

describe("seller guild: listings", () => {
  it("has 11 sellers with distinct ids, ports and gateway prefixes, matching the routes", () => {
    const roster = guildRoster();
    assert.equal(roster.length, 11);
    assert.deepEqual(roster.map((m) => m.id).sort(), ROUTES.map((r) => r.id).sort());
    assert.equal(new Set(roster.map((m) => m.port)).size, 11);
    assert.equal(roster[0]!.port, 4111);
  });

  it("every listing is accepted by the registry's own rules", () => {
    for (const r of ROUTES) {
      const listing = buildListing(r, { sellerId: r.id, publicUrl: `https://${r.id}.example`, payTo: randomPayTo() });
      const result = validateListing(listing, { admin: false, allowLoopback: false });
      assert.ok(result.ok, `${r.id}: ${result.ok ? "" : result.errors.join("; ")}`);
      assert.equal(listing.network, NETWORK);
      assert.equal(listing.asset, USDC_ADDRESS);
    }
  });
});

describe("seller guild: Scout uses exactly the drop-in alternatives", () => {
  const market = new Market("http://registry.test", {}, (async () => new Response(JSON.stringify({ services: ROUTES.map(view) }))) as typeof fetch);
  const ids = (need: Parameters<Market["candidates"]>[0]) => market.candidates(need).candidates.map((c) => c.listing.id).sort();

  it("scrape -> rich-shelf (not book-inspector); fx -> fx-global, fx-trend; Hindi -> nvidia/openrouter (not translator, tagger, insights, auditor)", async () => {
    await market.load();
    assert.deepEqual(ids(scrapeNeed(null, 1)), ["rich-shelf"]);
    assert.deepEqual(ids(scrapeNeed("Travel", 2)), ["rich-shelf"]);
    assert.deepEqual(ids(fxNeed("INR")), ["fx-global", "fx-trend"]);
    assert.deepEqual(ids(textNeed(["a", "b"], "summary", 2, "t")), ["nvidia-hindi", "openrouter-hindi"]);
  });
});

describe("OpenAI-compatible helper (NVIDIA / OpenRouter)", () => {
  const saved = { ...process.env };
  afterEach(() => (process.env = { ...saved }));
  const reply = (status: number, content?: string, finish = "stop", model?: string) =>
    new Response(JSON.stringify(status === 200 ? { model, choices: [{ message: { content }, finish_reason: finish }] } : { error: { message: "x" } }), { status });

  it("fails over to the next model when one is overloaded, sends the key and disables Nemotron thinking", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    process.env.NVIDIA_MODELS = "nvidia/nemotron-3-ultra-550b-a55b,nvidia/nemotron-3-super-120b-a12b";
    const calls: { model: string; auth: string | null; body: any }[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ model: body.model, auth: new Headers(init.headers).get("authorization"), body });
      return calls.length === 1 ? reply(503) : reply(200, '```json\n{"ok":true}\n```', "stop", body.model);
    }) as unknown as typeof fetch;
    const out = await chatJson<{ ok: boolean }>({ provider: "nvidia", system: "s", prompt: "p", fetchImpl: fake });
    assert.deepEqual(out.value, { ok: true });
    assert.equal(out.model, "nvidia/nemotron-3-super-120b-a12b");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.auth, "Bearer test-key");
    assert.deepEqual(calls[0]!.body.chat_template_kwargs, { enable_thinking: false });
  });

  it("stops on a bad key (no point trying other models) and maps it to unavailable", async () => {
    process.env.OPENROUTER_API_KEY = "bad";
    process.env.OPENROUTER_MODELS = "a/one,b/two";
    let n = 0;
    const fake = (async () => (n++, reply(401))) as unknown as typeof fetch;
    await assert.rejects(chatText({ provider: "openrouter", system: "s", prompt: "p", fetchImpl: fake }), (e: unknown) => e instanceof LlmError && e.kind === "unavailable" && !e.message.includes("bad"));
    assert.equal(n, 1);
  });

  it("is unavailable without a key, and parses JSON wrapped in prose", async () => {
    delete process.env.OPENROUTER_API_KEY;
    await assert.rejects(chatText({ provider: "openrouter", system: "s", prompt: "p" }), (e: unknown) => e instanceof LlmError && e.kind === "unavailable");
    assert.deepEqual(extractJson('Sure! {"a":1} hope that helps'), { a: 1 });
    assert.equal(extractJson("no json here"), undefined);
  });
});

describe("guild sellers: their own logic", () => {
  it("indic-translator checks the target script; sentiment-tagger only sells valid labels", () => {
    assert.ok(scriptShare("सोफी की दुनिया", LANGUAGES.hi!.range) > 0.9);
    assert.ok(scriptShare("Sophie's World", LANGUAGES.ta!.range) === 0);
    assert.ok(scriptShare("சோஃபியின் உலகம்", LANGUAGES.ta!.range) > 0.9);
    assert.deepEqual(cleanTag({ sentiment: "Positive", score: 1.7, tone: "warm", genres: ["Philosophy", ""], audience: "teens" }, 0), {
      index: 0, sentiment: "positive", score: 1, tone: "warm", genres: ["philosophy"], audience: "teens",
    });
    assert.throws(() => cleanTag({ sentiment: "happy", score: 0.5, genres: ["x"] }, 1), (e: unknown) => e instanceof HttpError && e.status === 502);
    assert.throws(() => cleanTag(undefined, 2), (e: unknown) => e instanceof HttpError && e.code === "model_incomplete");
  });

  it("text-insights counts, scores readability and extracts keyphrases deterministically", () => {
    const text = "Sophie receives mysterious letters. A philosopher teaches her the history of Western philosophy, from Socrates to Sartre.";
    const r = analyseText(text, 0);
    assert.equal(r.words, 17);
    assert.equal(r.sentences, 2);
    assert.equal(r.script, "latin");
    assert.ok(typeof r.fleschReadingEase === "number");
    assert.ok(rakeKeywords(text).some((k) => k.term === "western philosophy"));
    assert.ok(rakeKeywords("A fourteen-year-old girl reads.").some((k) => k.term === "fourteen-year-old girl reads"));
    assert.equal(analyseText("सोफी की दुनिया एक उपन्यास है।", 1).script, "devanagari");
  });

  it("price-advisor undercuts the value leader by 10% at your success rate, in exact units", () => {
    const svc = (id: string, price: string, cps: string, rate: number) => ({ id, priceUnits: price, costPerSuccessUnits: cps, reputation: { calls: 10, successRate: rate, medianLatencyMs: 900 } });
    const out = advisePrice("scraping", [svc("a", "5000", "7500", 0.66), svc("b", "6000", "6600", 0.9)], 0.9);
    // leader b: 6600 -> 6600 * 0.9 * 0.9 = 5346 -> floored to 5300 units
    assert.equal(out.suggestion.priceUnits, "5300");
    assert.equal(out.suggestion.priceUsdc, "0.0053");
    assert.equal(out.stats.medianUsdc, "0.0055");
    assert.equal(advisePrice("data", [], 0.9).suggestion.priceUsdc, "0.001");
  });

  it("listing-auditor flags weak schemas and descriptions", () => {
    const w = lintListing({ description: "Scrapes.", endpoint: "http://x.example/a", inputSchema: { type: "object", properties: { q: { type: "string" } } }, outputSchema: { type: "object" } });
    assert.equal(w.length, 5);
    assert.deepEqual(lintListing(buildListing(bookInspector, { sellerId: "b", publicUrl: "https://b.example", payTo: randomPayTo() }) as unknown as Record<string, unknown>), []);
  });

  it("fx-trend statistics and fx-global rates (unsupported currencies are a 422, never charged)", async () => {
    const t = trendStats([["2026-10-01", 120], ["2026-10-02", 126], ["2026-10-03", 123]]);
    assert.deepEqual({ ...t }, { observations: 3, firstDate: "2026-10-01", firstRate: 120, rate: 123, date: "2026-10-03", min: 120, max: 126, mean: 123, changePct: 2.5 });
    const fake = (async (url: string) =>
      new Response(JSON.stringify(url.endsWith("/XXX") ? { result: "error", "error-type": "unsupported-code" } : { result: "success", time_last_update_unix: 1760659352, rates: { INR: 126.5, AED: 4.89 } }))) as unknown as typeof fetch;
    const r = await globalRate("gbp", "aed", undefined, fake);
    assert.equal(r.rate, 4.89);
    assert.equal(r.from, "GBP");
    await assert.rejects(globalRate("GBP", "ZZZ", undefined, fake), (e: unknown) => e instanceof HttpError && e.status === 422);
    await assert.rejects(globalRate("XXX", "INR", undefined, fake), (e: unknown) => e instanceof HttpError && e.status === 422);
  });

  it("book-inspector parses a product page", () => {
    const html = `<ul class="breadcrumb"><li><a>Home</a></li><li><a>Books</a></li><li><a>Philosophy</a></li><li class="active">Sophie's World</li></ul>
      <div id="product_gallery"><img src="../../media/cache/a.jpg"></div>
      <div class="product_main"><h1>Sophie's World</h1><p class="star-rating Five"></p></div>
      <div id="product_description"><h2>Product Description</h2></div><p>A girl receives letters about philosophy. ...more</p>
      <table class="table"><tr><th>UPC</th><td>6be3beb0793a53e7</td></tr><tr><th>Product Type</th><td>Books</td></tr>
      <tr><th>Price (excl. tax)</th><td>£15.94</td></tr><tr><th>Price (incl. tax)</th><td>£15.94</td></tr><tr><th>Tax</th><td>£0.00</td></tr>
      <tr><th>Availability</th><td>In stock (18 available)</td></tr><tr><th>Number of reviews</th><td>0</td></tr></table>`;
    const url = "https://books.toscrape.com/catalogue/sophies-world_966/index.html";
    const p = parseProductPage(html, url);
    assert.equal(p.title, "Sophie's World");
    assert.equal(p.category, "Philosophy");
    assert.equal(p.stockCount, 18);
    assert.equal(p.rating, 5);
    assert.equal(p.priceInclTaxGbp, 15.94);
    assert.equal(p.description, "A girl receives letters about philosophy.");
    assert.equal(p.imageUrl, "https://books.toscrape.com/media/cache/a.jpg");
  });
});

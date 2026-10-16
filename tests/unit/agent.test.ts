// The buyer agent end to end against an in-process marketplace: the three example tasks (and changed
// numbers), fallback from junk and dishonest sellers, budget shortfall at concurrency 1 and 5 with a
// top-up that never re-buys, "ask first" mode, dry runs, and the explanation's accounting.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EXAMPLE_TASKS } from "../../apps/buyer/src/examples.ts";
import type { TaskView } from "../../apps/buyer/src/tasks.ts";
import { CATALOGUE, FakeChain, FakeClock, RATES, allBooks, manager, round2, startMarket, type Market } from "./agent-harness.ts";
import { body } from "./helpers.ts";

const paidRows = (t: TaskView) => t.ledger.filter((r) => r.status === "paid" || r.status === "paid_output_rejected");
const paidTotal = (t: TaskView) => paidRows(t).reduce((s, r) => s + BigInt(r.paidUnits), 0n);
const byService = (t: TaskView, id: string) => t.ledger.filter((r) => r.serviceId === id);

async function runTask(m: ReturnType<typeof manager>, req: Parameters<ReturnType<typeof manager>["create"]>[0]) {
  const created = m.create(req);
  await m.idle(created.id);
  return m.get(created.id)!;
}

describe("buyer agent: the three example tasks", () => {
  let market: Market;
  before(async () => (market = await startMarket()));
  after(() => market.close());

  it("task 1: three cheapest 5-star books on pages 1-4, in rupees, with Hindi summaries, for exactly 0.041 USDC", async () => {
    const ex = EXAMPLE_TASKS[0];
    const t = await runTask(manager(market), { task: ex.task, budget: ex.budget, max_concurrency: 3 });
    assert.equal(t.status, "completed", JSON.stringify({ error: t.error, gaps: t.result?.gaps }));
    assert.equal(t.settled, true);
    assert.equal(paidTotal(t), 41_000n);
    assert.equal(byService(t, "shelf-scraper").length, 4);
    assert.equal(byService(t, "fx-rates").length, 1);
    assert.equal(byService(t, "hindi-summary").length, 2, "3 descriptions in 2 calls (2 per call)");

    const expected = allBooks("*", [1, 2, 3, 4]).filter((b) => b.rating === 5).sort((a, b) => a.priceGbp - b.priceGbp || a.title.localeCompare(b.title)).slice(0, 3);
    assert.deepEqual(t.result!.books.map((b) => b.title), expected.map((b) => b.title));
    for (const b of t.result!.books) {
      assert.equal(b.prices.INR, round2(b.priceGbp * RATES.INR!));
      assert.match(b.text!, /[ऀ-ॿ]/);
    }
    assert.equal(t.explanation!.totals.paidUnits, "41000");
    assert.equal(t.explanation!.totals.transactions, 7);
    assert.ok(t.explanation!.decisions.some((d) => /Batched 3 texts into 2 calls/.test(d)), t.explanation!.decisions.join("\n"));
    assert.equal(t.estimate!.totalUnits, "41000");
    assert.equal(t.estimate!.lowerBound, false);
    assert.ok(t.explanation!.purchases.every((p) => p.why.length > 0 && p.explorerUrl), "every purchase says why and links its tx");

    const session = await body(await fetch(`${market.registry}/api/sessions/${t.sessionId}`));
    assert.equal(session.totals.paidUnits, "41000", "the registry's signed ledger agrees to the unit");
  });

  it("task 2: four most expensive Travel books in EUR and JPY, with Hindi pitches", async () => {
    const ex = EXAMPLE_TASKS[1];
    const t = await runTask(manager(market), { task: ex.task, budget: ex.budget, max_concurrency: 5 });
    assert.equal(t.status, "completed", t.error);
    assert.equal(paidTotal(t), 27_000n);
    const expected = allBooks("Travel", [1]).sort((a, b) => b.priceGbp - a.priceGbp || a.priceGbp - b.priceGbp).slice(0, 4);
    assert.deepEqual(t.result!.books.map((b) => b.title), expected.map((b) => b.title));
    for (const b of t.result!.books) {
      assert.equal(b.prices.EUR, round2(b.priceGbp * RATES.EUR!));
      assert.equal(b.prices.JPY, Math.round(b.priceGbp * RATES.JPY!));
      assert.match(b.text!, /pitch/);
    }
  });

  it("task 3: Mystery vs Historical Fiction averages in USD, INR and EUR, with one Hindi guide; discovers the page counts", async () => {
    const ex = EXAMPLE_TASKS[2];
    const t = await runTask(manager(market), { task: ex.task, budget: ex.budget, max_concurrency: 5 });
    assert.equal(t.status, "completed", t.error);
    assert.equal(t.estimate!.lowerBound, true);
    assert.equal(t.estimate!.totalUnits, "23000", "1 page per category assumed before page 1 is seen");
    assert.equal(paidTotal(t), 33_000n, "2 pages each + 3 rates + 1 guide");
    for (const g of t.result!.groups) {
      const books = CATALOGUE[g.category]!.flat();
      assert.equal(g.count, books.length);
      assert.equal(g.averageGbp, round2(books.reduce((s, b) => s + b.priceGbp, 0) / books.length));
      assert.equal(g.prices.average.INR, round2(g.averageGbp * RATES.INR!));
    }
    assert.match(t.result!.combinedText!, /guide/);
  });

  it("changed numbers on the spot: pages 2-5, two most expensive 3-star books, euros and yen", async () => {
    const t = await runTask(manager(market), {
      task: "From pages 2 to 5 of books.toscrape.com, find the two most expensive 3-star books, give their prices in euros and yen, and summarise each in Hindi.",
      budget: "0.040",
      max_concurrency: 5,
    });
    assert.equal(t.status, "completed", t.error);
    assert.equal(paidTotal(t), 32_000n, "4 pages + 2 rates + 1 text call for 2 books");
    const expected = allBooks("*", [2, 3, 4, 5]).filter((b) => b.rating === 3).sort((a, b) => b.priceGbp - a.priceGbp).slice(0, 2);
    assert.deepEqual(t.result!.books.map((b) => b.title), expected.map((b) => b.title));
  });
});

describe("buyer agent: sellers that misbehave", () => {
  it("a cheaper junk scraper is tried once, struck, and the task completes elsewhere (even at concurrency 5)", async () => {
    const market = await startMarket([{ id: "a-junk-scraper", category: "scraping", priceUnits: 2000n, behaviour: "junk" }]);
    try {
      const t = await runTask(manager(market), { task: EXAMPLE_TASKS[0].task, budget: "0.050", max_concurrency: 5 });
      assert.equal(t.status, "completed", t.error);
      const junk = byService(t, "a-junk-scraper");
      assert.equal(junk.length, 1, "unproven seller: one call at a time, so junk is bought only once");
      assert.equal(junk[0]!.status, "paid_output_rejected");
      assert.equal(byService(t, "shelf-scraper").filter((r) => r.status === "paid").length, 4);
      assert.equal(paidTotal(t), 43_000n, "41000 for the task + 2000 lost to the junk seller");
      assert.ok(t.explanation!.decisions.some((d) => /a-junk-scraper/.test(d)));
      assert.ok(t.explanation!.purchases.some((p) => /fallback after a-junk-scraper/.test(p.why)));
      const rep = await body(await fetch(`${market.registry}/api/services/a-junk-scraper`));
      assert.ok(rep.reputation.successRate < 2 / 3, "its reputation dropped");
    } finally {
      market.close();
    }
  });

  it("a scraper whose 402 asks 10x its listing, and one naming another payTo, are refused and nothing is paid to them", async () => {
    const market = await startMarket([
      { id: "a-greedy-scraper", category: "scraping", priceUnits: 1000n, behaviour: "overprice" },
      { id: "b-redirect-scraper", category: "scraping", priceUnits: 1500n, behaviour: "wrong-payto" },
    ]);
    try {
      const t = await runTask(manager(market), { task: EXAMPLE_TASKS[0].task, budget: "0.050", max_concurrency: 2 });
      assert.equal(t.status, "completed", t.error);
      for (const id of ["a-greedy-scraper", "b-redirect-scraper"]) {
        const rows = byService(t, id);
        assert.equal(rows.length, 1, `${id} tried once`);
        assert.equal(rows[0]!.status, "refused");
        assert.equal(rows[0]!.paidUnits, "0");
        assert.equal(market.calls.get(id) ?? 0, 0, "its handler never ran: nothing was signed");
      }
      assert.equal(paidTotal(t), 41_000n);
    } finally {
      market.close();
    }
  });

  it("money held by a failed call is waited for, not given up on (tight budget)", async () => {
    const market = await startMarket([{ id: "a-flaky-scraper", category: "scraping", priceUnits: 5000n, behaviour: "fail" }]);
    try {
      const chain = new FakeChain();
      const m = manager(market, { chain, clock: new FakeClock() });
      // exactly enough for 4 pages + 1 rate; the flaky seller holds 0.005 until its authorisation expires
      const t = await runTask(m, { task: "From pages 1 to 4 of books.toscrape.com, find the three cheapest books, give their prices in rupees.", budget: "0.021", max_concurrency: 4 });
      assert.equal(t.status, "completed", JSON.stringify({ e: t.error, s: t.shortfall, gaps: t.result?.gaps }));
      const flaky = byService(t, "a-flaky-scraper");
      assert.ok(flaky.length >= 1 && flaky.length <= 2, "an outage gets one more chance on another step, then a strike");
      for (const row of flaky) {
        assert.equal(row.status, "failed_not_charged");
        assert.equal(row.onchainConfirmed, true, "proven unused on-chain before the money was reused");
      }
      assert.ok(t.explanation!.decisions.some((d) => /Stopped using a-flaky-scraper/.test(d)) || flaky.length === 1);
      assert.equal(paidTotal(t), 21_000n);
      assert.equal(t.budget.spentUnits, "21000");
    } finally {
      market.close();
    }
  });

  it("R8: two equally good scrapers share the parallel pages; every purchase names the rule that chose it", async () => {
    const market = await startMarket([{ id: "twin-scraper", category: "scraping", priceUnits: 5000n, behaviour: "honest" }]);
    try {
      const t = await runTask(manager(market), { task: EXAMPLE_TASKS[0].task, budget: "0.050", max_concurrency: 4 });
      assert.equal(t.status, "completed", t.error);
      const a = byService(t, "shelf-scraper").filter((r) => r.status === "paid").length;
      const b = byService(t, "twin-scraper").filter((r) => r.status === "paid").length;
      assert.equal(a + b, 4);
      assert.ok(a >= 1 && b >= 1, `spread across both (shelf ${a}, twin ${b})`);
      assert.equal(paidTotal(t), 41_000n);
      assert.ok(t.explanation!.purchases.every((p) => /R7: rank|R1: requested/.test(p.why)), "every purchase is traced to a rule");
      assert.ok(t.explanation!.purchases.some((p) => /R8:/.test(p.why)));
    } finally {
      market.close();
    }
  });

  it("test fixtures are only used when named in prefer_sellers", async () => {
    const market = await startMarket([{ id: "cheap-fixture", category: "scraping", priceUnits: 2000n, behaviour: "honest", isFixture: true }]);
    try {
      const plain = await runTask(manager(market), { task: "From page 1 of books.toscrape.com, find the cheapest book.", budget: "0.010" });
      assert.equal(byService(plain, "cheap-fixture").length, 0);
      const preferred = await runTask(manager(market), { task: "From page 1 of books.toscrape.com, find the cheapest book.", budget: "0.010", prefer_sellers: ["cheap-fixture"] });
      assert.equal(byService(preferred, "cheap-fixture")[0]?.status, "paid");
      assert.match(preferred.explanation!.purchases[0]!.why, /requested by the caller/);
    } finally {
      market.close();
    }
  });
});

describe("buyer agent: budget", () => {
  let market: Market;
  before(async () => (market = await startMarket()));
  after(() => market.close());
  const TASK = "From pages 1 to 4 of books.toscrape.com, find the three cheapest books, give their prices in rupees."; // 4 x 0.005 + 0.001 = 0.021

  for (const concurrency of [1, 5]) {
    it(`0.012 USDC for a ~0.02 task at max_concurrency ${concurrency}: never over, stops and says why; a top-up finishes it without re-buying`, async () => {
      const m = manager(market);
      const created = m.create({ task: TASK, budget: "0.012", max_concurrency: concurrency });
      let peak = 0n;
      m.subscribe(created.id, (e) => {
        if (e.type === "budget") {
          const used = BigInt(e.spent as string) + BigInt(e.reserved as string);
          if (used > peak) peak = used;
        }
      });
      await m.idle(created.id);
      let t = m.get(created.id)!;
      assert.equal(t.status, "needs_budget");
      assert.ok(peak <= 12_000n, `peak ${peak}`);
      assert.ok(BigInt(t.budget.spentUnits) <= 12_000n);
      assert.ok(t.shortfall && BigInt(t.shortfall.neededUnits) > 0n);
      assert.match(t.shortfall!.message, /Top up at least/);
      assert.ok(t.ledger.some((r) => r.status === "refused" && r.reasonCode === "budget"), "the over-budget call was refused, with a reason");
      assert.ok(t.answer, "a partial answer is still given");

      await m.topUp(created.id, t.shortfall!.neededUsdc);
      await m.idle(created.id);
      t = m.get(created.id)!;
      assert.equal(t.status, "completed", JSON.stringify(t.shortfall));
      assert.equal(paidTotal(t), 21_000n);
      const pages = byService(t, "shelf-scraper").filter((r) => r.status === "paid");
      assert.equal(pages.length, 4, "every page bought exactly once across both runs");
    });
  }

  it('"ask" mode asks before spending anything, then runs after a top-up', async () => {
    const m = manager(market);
    const created = m.create({ task: TASK, budget: "0.012", on_short_budget: "ask" });
    await m.idle(created.id);
    let t = m.get(created.id)!;
    assert.equal(t.status, "needs_budget");
    assert.equal(t.ledger.length, 0, "nothing was attempted");
    assert.match(t.shortfall!.message, /Nothing has been bought/);
    await m.topUp(created.id, t.shortfall!.neededUsdc);
    await m.idle(created.id);
    t = m.get(created.id)!;
    assert.equal(t.status, "completed");
    assert.equal(paidTotal(t), 21_000n);
  });

  it("a dry run estimates without buying; start runs it", async () => {
    const m = manager(market);
    const created = m.create({ task: EXAMPLE_TASKS[0].task, budget: "0.050", dry_run: true });
    await m.idle(created.id);
    let t = m.get(created.id)!;
    assert.equal(t.status, "planned");
    assert.equal(t.estimate!.totalUsdc, "0.041");
    assert.equal(t.ledger.length, 0);
    m.start(created.id);
    await m.idle(created.id);
    t = m.get(created.id)!;
    assert.equal(t.status, "completed");
    assert.equal(paidTotal(t), 41_000n);
  });

  it("refuses unsupported tasks and spends nothing", async () => {
    const t = await runTask(manager(market), { task: "Book me a flight to Paris for tomorrow", budget: "0.050" });
    assert.equal(t.status, "failed");
    assert.equal(t.ledger.length, 0);
  });

  it("validates requests", () => {
    const m = manager(market);
    assert.throws(() => m.create({ task: "x", budget: "0.01" }), /task must be/);
    assert.throws(() => m.create({ task: EXAMPLE_TASKS[0].task, budget: "-1" }), /budget/);
    assert.throws(() => m.create({ task: EXAMPLE_TASKS[0].task, budget: "5" }), /may not exceed/);
    assert.throws(() => m.create({ task: EXAMPLE_TASKS[0].task, budget: "0.05", max_concurrency: 0 }), /max_concurrency/);
    assert.throws(() => m.create({ task: EXAMPLE_TASKS[0].task, budget: "0.05", prefer_sellers: ["Bad Id!"] }), /prefer_sellers/);
  });
});

// An in-process marketplace for buyer-agent tests: a deterministic fixture catalogue, sellers built with
// our seller kit and the SAME schemas the real sellers publish, a mock facilitator, and a real registry
// (in-memory SQLite) with signed ledger ingestion. No network, no funds.

import type { Server } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { HttpError, type Address, type Listing } from "@dron/shared";
import { createSeller, type ChainOps, type Clock, type PaidRoute } from "@dron/x402-kit";
import { scrapeInputSchema, scrapeOutputSchema } from "@dron/seller-scraper/schemas";
import { inputSchema as fxIn, outputSchema as fxOut } from "@dron/seller-data/schemas";
import { inputSchema as textIn, outputSchema as textOut } from "@dron/seller-inference/schemas";
import { createRegistryApp } from "../../apps/registry/src/app.ts";
import { openRegistryDb } from "../../apps/registry/src/db.ts";
import { TaskManager, type TaskManagerOptions } from "../../apps/buyer/src/tasks.ts";
import { MockFacilitator, listen, randomPayTo } from "./helpers.ts";

export const silent = { debug() {}, info() {}, warn() {}, error() {} };
const ADMIN_TOKEN = "harness-admin-token";

// ---------- fixture catalogue ----------

export interface FixtureBook {
  title: string;
  priceGbp: number;
  rating: number;
  inStock: boolean;
  availability: string;
  url: string;
  upc: string;
  description: string;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function makeBooks(prefix: string, count: number, seed: number): FixtureBook[] {
  const r = rng(seed);
  return Array.from({ length: count }, (_, i) => {
    const price = Math.round((10 + r() * 50) * 100) / 100;
    return {
      title: `${prefix} Book ${i + 1}`,
      priceGbp: price,
      rating: 1 + Math.floor(r() * 5),
      inStock: true,
      availability: "In stock",
      url: `https://books.toscrape.com/catalogue/${prefix.toLowerCase().replace(/\s+/g, "-")}-${i + 1}/index.html`,
      upc: `upc${seed}${i}`,
      description: `A ${prefix.toLowerCase()} story number ${i + 1} about courage, travel and friendship.`,
    };
  });
}

/** source -> pages of books */
export const CATALOGUE: Record<string, FixtureBook[][]> = {
  "*": Array.from({ length: 6 }, (_, p) => makeBooks(`Page${p + 1}`, 20, 100 + p)),
  Travel: [makeBooks("Travel", 11, 7)],
  Mystery: [makeBooks("Mystery", 20, 8), makeBooks("Mystery Two", 12, 9)],
  "Historical Fiction": [makeBooks("Historical", 20, 10), makeBooks("Historical Two", 6, 11)],
};

export const RATES: Record<string, number> = { INR: 126.63, EUR: 1.185, JPY: 210.72, USD: 1.3335, CAD: 1.84 };

function scrapePage(input: { page: number; category?: string }) {
  const pages = CATALOGUE[input.category ?? "*"];
  if (!pages) throw new HttpError(404, "unknown_category", `no category ${input.category}`);
  const books = pages[input.page - 1];
  if (!books) throw new HttpError(404, "page_not_found", `no page ${input.page}`);
  return {
    source: `https://books.toscrape.com/catalogue/${encodeURIComponent((input.category ?? "all").toLowerCase().replace(/\s+/g, "-"))}/page-${input.page}.html`,
    page: input.page,
    totalPages: pages.length,
    hasNext: input.page < pages.length,
    category: input.category ?? null,
    books,
  };
}

// ---------- sellers ----------

export interface ExtraSeller {
  id: string;
  category: "scraping" | "data" | "inference";
  priceUnits: bigint;
  behaviour: "junk" | "overprice" | "wrong-payto" | "fail" | "honest";
  isFixture?: boolean;
}

export interface Market {
  registry: string;
  listings: Map<string, Listing>;
  facilitator: MockFacilitator;
  calls: Map<string, number>;
  register(listing: Listing): Promise<void>;
  close(): void;
}

export async function startMarket(extra: ExtraSeller[] = []): Promise<Market> {
  const servers: Server[] = [];
  const facilitator = new MockFacilitator();
  const calls = new Map<string, number>();
  const count = (id: string) => calls.set(id, (calls.get(id) ?? 0) + 1);

  const registryApp = createRegistryApp({ db: openRegistryDb(":memory:"), log: silent, adminToken: ADMIN_TOKEN, allowLoopback: true });
  const reg = await listen(registryApp);
  servers.push(reg.server);
  const listings = new Map<string, Listing>();
  const register = async (listing: Listing) => {
    const res = await fetch(`${reg.base}/api/services`, { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(listing) });
    if (!res.ok) throw new Error(`register ${listing.id}: ${res.status} ${await res.text()}`);
    listings.set(listing.id, listing);
  };

  const fxImpl = (i: { from: string; to: string }) => {
    const rate = RATES[i.to.toUpperCase()];
    if (!rate) throw new HttpError(422, "unsupported_currency", i.to);
    return { from: i.from.toUpperCase(), to: i.to.toUpperCase(), rate, date: "2026-10-16", source: "fixture ECB", fetchedAt: new Date().toISOString() };
  };
  const textImpl = (i: { texts: string[]; style: string }) => ({
    language: "hi",
    style: i.style ?? "summary",
    model: "fixture",
    results: i.texts.map((t, index) => ({ index, text: `हिंदी ${i.style ?? "summary"}: ${t.split("\n")[0]!.replace(/^Title: /, "")}` })),
  });
  const impl = { scraping: scrapePage, data: fxImpl, inference: textImpl } as const;

  const routes: PaidRoute[] = [
    { id: "shelf-scraper", name: "shelf-scraper", category: "scraping", description: "scrapes", method: "GET", path: "/scrape", priceUnits: 5000n, inputSchema: scrapeInputSchema, outputSchema: scrapeOutputSchema, handler: async (i) => (count("shelf-scraper"), scrapePage(i)) },
    { id: "fx-rates", name: "fx-rates", category: "data", description: "rates", method: "GET", path: "/rate", priceUnits: 1000n, inputSchema: fxIn, outputSchema: fxOut, handler: async (i) => (count("fx-rates"), fxImpl(i)) },
    { id: "hindi-summary", name: "hindi-summary", category: "inference", description: "hindi", method: "POST", path: "/summarise", priceUnits: 10_000n, inputSchema: textIn, outputSchema: textOut, handler: async (i) => (count("hindi-summary"), textImpl(i)) },
  ];

  const alt = randomPayTo();
  for (const x of extra) {
    const base = routes.find((r) => r.category === x.category)!;
    const handler: PaidRoute["handler"] =
      x.behaviour === "junk"
        ? async () => (count(x.id), { nonsense: true })
        : x.behaviour === "fail"
          ? async () => {
              count(x.id);
              throw new HttpError(503, "simulated_outage", "down");
            }
          : async (i) => (count(x.id), (impl[x.category] as (input: unknown) => unknown)(i));
    routes.push({
      ...base,
      id: x.id,
      name: x.id,
      path: `/${x.id}`,
      priceUnits: x.priceUnits,
      handler,
      isFixture: x.isFixture,
      misbehave:
        x.behaviour === "junk"
          ? { skipSelfValidation: true }
          : x.behaviour === "overprice"
            ? { advertisedPriceUnits: x.priceUnits * 10n }
            : x.behaviour === "wrong-payto"
              ? { advertisedPayTo: alt }
              : undefined,
    });
  }

  const seller = createSeller({ sellerId: "market", publicUrl: "http://127.0.0.1:0", payTo: randomPayTo(), facilitator, replayDbPath: ":memory:", log: silent, routes });
  const s = await listen(seller.app);
  servers.push(s.server);
  for (const l of seller.listings) {
    // each route is its own seller in the registry
    await register({ ...l, sellerId: l.id, endpoint: l.endpoint.replace("http://127.0.0.1:0", s.base) });
  }

  return {
    registry: reg.base,
    listings,
    facilitator,
    calls,
    register,
    close() {
      for (const srv of servers) {
        srv.closeAllConnections?.();
        srv.close();
      }
    },
  };
}

// ---------- chain + clock fakes ----------

export class FakeChain implements ChainOps {
  usedNow: (nonce: string) => boolean = () => false;
  async authorizationUsed(_from: Address, nonce: Hex) {
    return this.usedNow(nonce);
  }
  async findAuthorizationTx() {
    return `0x${"ab".repeat(32)}` as Hex;
  }
  async confirmTransfer() {
    return { confirmed: true };
  }
}

export class FakeClock implements Clock {
  private t = Date.now();
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
    await new Promise((r) => setImmediate(r));
  }
}

export function manager(market: Market, over: Partial<TaskManagerOptions> = {}) {
  return new TaskManager({
    registryUrl: market.registry,
    account: privateKeyToAccount(generatePrivateKey()),
    log: silent,
    dataDir: null,
    chain: new FakeChain(),
    llmParser: null,
    narrator: null,
    blockNumber: async () => 0,
    balanceOf: async () => 1_000_000_000n,
    ...over,
  });
}

// ---------- expected answers, computed independently from the fixture ----------

export function allBooks(source: string, pages: number[]): FixtureBook[] {
  return pages.flatMap((p) => CATALOGUE[source]![p - 1] ?? []);
}
export const round2 = (n: number) => Math.round(n * 100) / 100;

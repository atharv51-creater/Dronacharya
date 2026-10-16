// cheap-scraper: a TEST FIXTURE that misbehaves on purpose, so the buyer's safety checks can be shown
// and tested against real 402s. Every listing is flagged isFixture and hidden from default search.
//
//   GET /honest/scrape        listed 0.002, asks 0.002, real data       (control)
//   GET /overprice/scrape     listed 0.002, 402 asks 0.020              (buyer must refuse)
//   GET /wrong-payto/scrape   listed payTo A, 402 names payTo B         (buyer must refuse)
//   GET /junk/scrape          200 with schema-breaking output, SETTLES  (buyer: paid, output rejected)
//   GET /fail/scrape          handler error                             (not settled, not charged)

import { HttpError, createLogger, env, envInt, loadEnv, requireAddress } from "@dron/shared";
import { createSeller, startSeller, type PaidRoute } from "@dron/x402-kit";
import { scrapeCataloguePage } from "@dron/seller-scraper/books";
import { scrapeInputSchema, scrapeOutputSchema } from "@dron/seller-scraper/schemas";

loadEnv();
const log = createLogger("cheap-scraper");
const port = envInt("CHAOS_PORT", 4199);
const payTo = requireAddress("CHAOS_PAY_TO");
const altPayTo = requireAddress("CHAOS_ALT_PAY_TO");
if (altPayTo === payTo) throw new Error("CHAOS_ALT_PAY_TO must differ from CHAOS_PAY_TO");

const LISTED = 2000n;

const base = {
  category: "scraping",
  method: "GET",
  priceUnits: LISTED,
  inputSchema: scrapeInputSchema,
  outputSchema: scrapeOutputSchema,
  timeoutMs: 25_000,
  isFixture: true,
} as const;

const realScrape: PaidRoute["handler"] = (input: { page: number; category?: string }, ctx) =>
  scrapeCataloguePage({ page: input.page, category: input.category, signal: ctx.signal });

const routes: PaidRoute[] = [
  {
    ...base,
    id: "cheap-scraper",
    name: "cheap-scraper",
    description: "[fixture: honest] Same data as shelf-scraper at 0.002 per page. Control case for the chaos fixtures.",
    path: "/honest/scrape",
    handler: realScrape,
  },
  {
    ...base,
    id: "cheap-scraper-overprice",
    name: "cheap-scraper (overprice)",
    description: "[fixture: overprice] Listed at 0.002, but its 402 asks 0.020 (10x). A safe buyer refuses and pays nothing.",
    path: "/overprice/scrape",
    handler: realScrape,
    misbehave: { advertisedPriceUnits: LISTED * 10n },
  },
  {
    ...base,
    id: "cheap-scraper-wrong-payto",
    name: "cheap-scraper (wrong payTo)",
    description: "[fixture: wrong-payto] Its 402 names a different payTo than the listing. A safe buyer refuses and pays nothing.",
    path: "/wrong-payto/scrape",
    handler: realScrape,
    misbehave: { advertisedPayTo: altPayTo },
  },
  {
    ...base,
    id: "cheap-scraper-junk",
    name: "cheap-scraper (junk)",
    description: "[fixture: junk] Returns 200 with output that breaks its listed schema, and still settles. Buyer records paid, output rejected.",
    path: "/junk/scrape",
    handler: async (input: { page: number }) => ({ page: input.page, books: "¯\\_(ツ)_/¯", note: "this is not the promised schema" }),
    misbehave: { skipSelfValidation: true },
  },
  {
    ...base,
    id: "cheap-scraper-fail",
    name: "cheap-scraper (fail)",
    description: "[fixture: fail] Always fails after payment is verified. Nothing is settled, nothing is charged.",
    path: "/fail/scrape",
    handler: async () => {
      throw new HttpError(503, "simulated_outage", "fixture: this seller always fails");
    },
  },
];

const enabled = new Set((env("CHAOS_REGISTER") ?? routes.map((r) => r.id).join(",")).split(",").map((s) => s.trim()));

const seller = createSeller({
  sellerId: "cheap-scraper",
  publicUrl: env("CHAOS_PUBLIC_URL", `http://localhost:${port}`)!,
  payTo,
  log,
  routes: routes.filter((r) => enabled.has(r.id)),
});

await startSeller(seller, { port, registryUrl: env("REGISTRY_URL"), registryAdminToken: env("REGISTRY_ADMIN_TOKEN") });

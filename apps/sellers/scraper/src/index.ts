// shelf-scraper: scraping category. GET /scrape?page=N[&category=Travel] for 0.005 USDC per page.

import { createLogger, env, envInt, loadEnv, requireAddress } from "@dron/shared";
import { createSeller, startSeller } from "@dron/x402-kit";
import { scrapeCataloguePage, warmUp } from "./books.ts";
import { scrapeInputSchema, scrapeOutputSchema } from "./schemas.ts";

loadEnv();
const log = createLogger("shelf-scraper");
const port = envInt("SCRAPER_PORT", 4101);

const seller = createSeller({
  sellerId: "shelf-scraper",
  publicUrl: env("SCRAPER_PUBLIC_URL", `http://localhost:${port}`)!,
  payTo: requireAddress("SCRAPER_PAY_TO"),
  log,
  routes: [
    {
      id: "shelf-scraper",
      name: "shelf-scraper",
      category: "scraping",
      description:
        "Scrapes one catalogue page of books.toscrape.com (20 books), optionally within a category, " +
        "including each book's description and UPC from its product page.",
      method: "GET",
      path: "/scrape",
      priceUnits: 5000n,
      inputSchema: scrapeInputSchema,
      outputSchema: scrapeOutputSchema,
      timeoutMs: 25_000,
      handler: (input: { page: number; category?: string }, ctx) =>
        scrapeCataloguePage({ page: input.page, category: input.category, signal: ctx.signal }),
    },
  ],
});

await startSeller(seller, { port, registryUrl: env("REGISTRY_URL"), registryAdminToken: env("REGISTRY_ADMIN_TOKEN") });

const warm = envInt("SCRAPER_WARM_PAGES", 0);
if (warm > 0) void warmUp(warm, (m) => log.info(m));

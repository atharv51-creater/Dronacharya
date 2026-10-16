// fx-rates: data category. GET /rate?from=GBP&to=INR for 0.001 USDC per currency pair.

import { createLogger, env, envInt, loadEnv, requireAddress } from "@dron/shared";
import { createSeller, startSeller } from "@dron/x402-kit";
import { getRate } from "./rates.ts";
import { inputSchema, outputSchema } from "./schemas.ts";

loadEnv();
const log = createLogger("fx-rates");
const port = envInt("DATA_PORT", 4102);

const seller = createSeller({
  sellerId: "fx-rates",
  publicUrl: env("DATA_PUBLIC_URL", `http://localhost:${port}`)!,
  payTo: requireAddress("DATA_PAY_TO"),
  log,
  routes: [
    {
      id: "fx-rates",
      name: "fx-rates",
      category: "data",
      description: "Latest ECB reference exchange rate for one currency pair (e.g. GBP to INR). 1 unit of `from` = `rate` units of `to`.",
      method: "GET",
      path: "/rate",
      priceUnits: 1000n,
      inputSchema,
      outputSchema,
      timeoutMs: 10_000,
      handler: (input: { from: string; to: string }, ctx) => getRate(input.from, input.to, ctx.signal),
    },
  ],
});

await startSeller(seller, { port, registryUrl: env("REGISTRY_URL"), registryAdminToken: env("REGISTRY_ADMIN_TOKEN") });

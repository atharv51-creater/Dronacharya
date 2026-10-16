// hindi-summary: inference category. POST /summarise with up to 2 texts for 0.010 USDC per call.

import { createLogger, env, envInt, loadEnv, requireAddress } from "@dron/shared";
import { createSeller, startSeller } from "@dron/x402-kit";
import { inputSchema, outputSchema } from "./schemas.ts";
import { inferenceConfigured, summarise, type SummariseInput } from "./summarise.ts";

loadEnv();
const log = createLogger("hindi-summary");
const port = envInt("INFERENCE_PORT", 4103);

if (!inferenceConfigured()) {
  log.warn("GEMINI_API_KEY is not set: /summarise will answer 503 (never charged) until it is");
}

const seller = createSeller({
  sellerId: "hindi-summary",
  publicUrl: env("INFERENCE_PUBLIC_URL", `http://localhost:${port}`)!,
  payTo: requireAddress("INFERENCE_PAY_TO"),
  log,
  routes: [
    {
      id: "hindi-summary",
      name: "hindi-summary",
      category: "inference",
      description:
        "Summarises up to 2 texts per call in Hindi (Devanagari) with Gemini. Styles: summary, pitch (one line) or guide. " +
        "Output is checked to be Hindi before the call is settled.",
      method: "POST",
      path: "/summarise",
      priceUnits: 10_000n,
      inputSchema,
      outputSchema,
      timeoutMs: 40_000,
      handler: (input: SummariseInput, ctx) => summarise(input, ctx.signal),
    },
  ],
});

await startSeller(seller, { port, registryUrl: env("REGISTRY_URL"), registryAdminToken: env("REGISTRY_ADMIN_TOKEN") });

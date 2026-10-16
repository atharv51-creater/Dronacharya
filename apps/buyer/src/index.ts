// Buyer agent service (port 4200): takes tasks in plain language and a budget, and buys what they need.

import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createLogger, env, envBool, envInt, fromUnits, loadEnv, requireEnv, toUnits } from "@dron/shared";
import { assertTestnet, basePathOf, mountAt, usdcBalance } from "@dron/x402-kit";
import { createBuyerApp } from "./app.ts";
import { llmAvailable } from "./parse/llm.ts";
import { TaskManager } from "./tasks.ts";

loadEnv();
const log = createLogger("buyer-agent");
const port = envInt("BUYER_PORT", 4200);
const registryUrl = env("REGISTRY_URL", "http://localhost:4000")!;

try {
  await assertTestnet();
} catch (err) {
  log.error("testnet check failed; not starting", { err });
  process.exit(1);
}

const account = privateKeyToAccount(requireEnv("BUYER_PRIVATE_KEY") as Hex);
const apiToken = env("BUYER_API_TOKEN");
if (!apiToken) log.warn("BUYER_API_TOKEN is not set: only requests from this machine can create tasks");

const manager = new TaskManager({ registryUrl, account, log, maxBudgetUnits: toUnits(env("BUYER_MAX_TASK_BUDGET", "0.50")!) });
const publicUrl = env("BUYER_PUBLIC_URL", `http://localhost:${port}`)!;
const app = mountAt(createBuyerApp({ manager, log, apiToken, registryUrl, allowLoopback: envBool("BUYER_ALLOW_LOOPBACK", true) }), basePathOf(publicUrl));

app.listen(port, () => {
  log.info(`listening on :${port}`, { console: `${publicUrl.replace(/\/+$/, "")}/`, buyer: account.address, parser: llmAvailable() ? "gemini + rules" : "rules (GEMINI_API_KEY not set)" });
  usdcBalance(account.address)
    .then((b) => log.info(`buyer wallet holds ${fromUnits(b)} USDC`, b === 0n ? { hint: "fund it at https://faucet.circle.com (Base Sepolia)" } : {}))
    .catch(() => {});
});

import { REPO_ROOT, createLogger, env, envBool, envInt, loadEnv } from "@dron/shared";
import { assertTestnet, basePathOf, mountAt } from "@dron/x402-kit";
import { createRegistryApp } from "./app.ts";
import { openRegistryDb } from "./db.ts";
import { EtherscanHistory, etherscanChainSource } from "./etherscan.ts";

loadEnv();
const log = createLogger("registry");
const port = envInt("REGISTRY_PORT", 4000);

try {
  await assertTestnet();
} catch (err) {
  log.error("testnet check failed; not starting", { err });
  process.exit(1);
}

const adminToken = env("REGISTRY_ADMIN_TOKEN");
if (!adminToken) log.warn("REGISTRY_ADMIN_TOKEN is not set: our sellers cannot update their listings after the first registration");

const db = openRegistryDb(env("REGISTRY_DB", `${REPO_ROOT}.data/registry.db`)!);
const publicUrl = env("REGISTRY_PUBLIC_URL", `http://localhost:${port}`)!;
const etherscanKey = env("ETHERSCAN_API_KEY");
const chain = etherscanKey ? etherscanChainSource(etherscanKey, { log }) : undefined;
log.info(etherscanKey ? "Etherscan enabled: reconciliation history and wallet transfers" : "ETHERSCAN_API_KEY not set: reconciliation scans the RPC only, no wallet history");
const app = mountAt(
  createRegistryApp({
    db,
    log,
    adminToken,
    allowLoopback: envBool("REGISTRY_ALLOW_LOOPBACK", true),
    chain,
    chainSourceName: chain?.lastSource,
    history: etherscanKey ? new EtherscanHistory(etherscanKey) : undefined,
  }),
  basePathOf(publicUrl),
);

const server = app.listen(port, () => log.info(`listening on :${port}`, { marketplace: `${publicUrl.replace(/\/+$/, "")}/`, local: `http://localhost:${port}/` }));

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

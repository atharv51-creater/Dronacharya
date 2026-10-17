import { REPO_ROOT, closeMongo, createLogger, env, envBool, envInt, loadEnv, mongoConfigured, mongoDb, mongoDbName } from "@dron/shared";
import { assertTestnet, basePathOf, mountAt } from "@dron/x402-kit";
import { createRegistryApp } from "./app.ts";
import { openRegistryDb } from "./db.ts";
import { EtherscanHistory, etherscanChainSource } from "./etherscan.ts";
import { startMongoSync, type MongoSync } from "./mongo-sync.ts";

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

// MongoDB Atlas: durable cloud copy of every table (restores an empty local database before serving).
let sync: MongoSync | undefined;
if (mongoConfigured()) sync = await startMongoSync({ db, mongo: () => mongoDb(), dbName: mongoDbName(), log });
else log.info("MONGODB_URI not set: data is kept in the local SQLite database only");
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
    storage: () => ({
      primary: "sqlite",
      atlas: sync ? { enabled: true, database: mongoDbName(), pendingWrites: sync.pending(), pushed: sync.pushed } : { enabled: false },
    }),
  }),
  basePathOf(publicUrl),
);

const server = app.listen(port, () => log.info(`listening on :${port}`, { marketplace: `${publicUrl.replace(/\/+$/, "")}/`, local: `http://localhost:${port}/` }));

const shutdown = () => {
  server.close(async () => {
    await sync?.stop(); // last drain of the outbox to Atlas (anything left is sent on the next start)
    await closeMongo();
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

// Gateway (port 8080): the one public origin. Serves the built web UI (dronacharya-frontend/dist) and all
// /api routes, plus each service under its path prefix for sellers and judges. Put ONE tunnel in front of it.

import { existsSync } from "node:fs";
import { REPO_ROOT, createLogger, env, envInt, loadEnv, toUnits } from "@dron/shared";
import { guildRoster } from "@dron/seller-guild/roster";
import { createGateway, parseRoutes } from "./proxy.ts";

loadEnv();
const log = createLogger("gateway");
const port = envInt("PORT", envInt("GATEWAY_PORT", 8080));
const local = (p: string, d: number) => `http://127.0.0.1:${envInt(p, d)}`;
const routes = parseRoutes(
  env("GATEWAY_ROUTES") ??
    [
      `/registry=${local("REGISTRY_PORT", 4000)}`,
      `/scraper=${local("SCRAPER_PORT", 4101)}`,
      `/fx=${local("DATA_PORT", 4102)}`,
      `/summary=${local("INFERENCE_PORT", 4103)}`,
      `/chaos=${local("CHAOS_PORT", 4199)}`,
      `/buyer=${local("BUYER_PORT", 4200)}`,
      ...guildRoster(envInt("GUILD_BASE_PORT", 4111)).map((m) => `${m.prefix}=http://127.0.0.1:${m.port}`),
    ].join(","),
);

const staticDir = env("FRONTEND_DIST", `${REPO_ROOT}dronacharya-frontend/dist`)!;
const buyerToken = env("BUYER_API_TOKEN");
if (!buyerToken) log.warn("BUYER_API_TOKEN is not set: signed-in users cannot run Scout tasks through the UI");

createGateway(routes, {
  log: (m, f) => log.warn(m, f),
  staticDir,
  api: {
    registry: new URL(local("REGISTRY_PORT", 4000)),
    buyer: new URL(local("BUYER_PORT", 4200)),
    buyerToken,
    dailyCapUnits: toUnits(env("SCOUT_DAILY_CAP_USDC", "0.20")!),
  },
}).listen(port, () => {
  log.info(`listening on :${port}`, {
    ui: existsSync(`${staticDir}/index.html`) ? staticDir : "not built (npm run build:frontend)",
    routes: Object.fromEntries(routes.map((r) => [`${r.prefix}/`, r.target.origin])),
  });
});

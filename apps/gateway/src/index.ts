// Gateway (port 8080): put ONE tunnel in front of this (ngrok static domain, cloudflared) and every
// service is public under a path. Run `npm run deploy:configure -- https://<your-host>` first so each
// service knows its public URL.

import { createLogger, envInt, env, loadEnv } from "@dron/shared";
import { createGateway, parseRoutes } from "./proxy.ts";

loadEnv();
const log = createLogger("gateway");
const port = envInt("GATEWAY_PORT", 8080);
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
    ].join(","),
);

createGateway(routes, { log: (m, f) => log.warn(m, f) }).listen(port, () => {
  log.info(`listening on :${port}`, { routes: Object.fromEntries(routes.map((r) => [`${r.prefix}/`, r.target.origin])) });
});

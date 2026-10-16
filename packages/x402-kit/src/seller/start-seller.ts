import type { Server } from "node:http";
import { createLogger, type Listing } from "@dron/shared";
import { assertTestnet } from "../chain.ts";
import type { Seller } from "./create-seller.ts";

export interface StartOptions {
  port: number;
  registryUrl?: string;
  /** Lets our own sellers upsert their listings. Without it, registration is insert-only. */
  registryAdminToken?: string;
}

/** Refuses to start off-testnet, listens, then registers listings in the background (with retries). */
export async function startSeller(seller: Seller, opts: StartOptions): Promise<Server> {
  const { log } = seller;
  try {
    await assertTestnet();
  } catch (err) {
    log.error("testnet check failed; not starting", { err });
    process.exit(1);
  }

  const server = await new Promise<Server>((resolve, reject) => {
    const s = seller.app.listen(opts.port, () => resolve(s));
    s.once("error", reject);
  });
  log.info(`listening on :${opts.port}`, { listings: seller.listings.map((l) => `${l.method} ${l.endpoint} @ ${l.priceUnits}u`) });

  if (opts.registryUrl) void registerAll(seller.listings, opts.registryUrl, opts.registryAdminToken, log);

  const shutdown = () => {
    log.info("shutting down");
    server.close(() => {
      seller.replayStore.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}

async function registerAll(listings: Listing[], registryUrl: string, token: string | undefined, log = createLogger("register")) {
  if (!token) log.warn("REGISTRY_ADMIN_TOKEN not set: registering as public (insert-only, cannot update existing listings)");
  for (const listing of listings) {
    for (let attempt = 1; attempt <= 12; attempt++) {
      try {
        const res = await fetch(`${registryUrl.replace(/\/+$/, "")}/api/services`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(listing),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          log.info("registered", { id: listing.id, endpoint: listing.endpoint });
          break;
        }
        const body = await res.text();
        if (res.status >= 400 && res.status < 500) {
          log.error("registry rejected listing", { id: listing.id, status: res.status, body: body.slice(0, 500) });
          break;
        }
        throw new Error(`registry answered ${res.status}`);
      } catch (err) {
        if (attempt === 12) {
          log.error("could not register listing; is the registry running?", { id: listing.id, err });
          break;
        }
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 8000)));
      }
    }
  }
}

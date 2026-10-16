// Serving a service under a path prefix, so several services can share one public hostname behind the
// gateway (https://host/scraper/scrape, https://host/registry/ledger...). The app is mounted at the prefix
// AND at the root: public traffic arrives prefixed through the gateway; local tools keep using
// http://localhost:<port>/... unchanged.
//
// x402 note: the middleware matches routes on req.path (relative to the mount) and builds resource.url
// from the Host header plus req.originalUrl (the full path), so a 402 served at /scraper/scrape says
// https://host/scraper/scrape?page=1, exactly the URL the buyer called.

import express, { type Express, type NextFunction, type Request, type Response } from "express";

/** "/scraper" for https://host/scraper, "" for https://host or https://host/. */
export function basePathOf(publicUrl: string): string {
  try {
    return new URL(publicUrl).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function mountAt(app: Express, basePath: string): Express {
  if (!basePath) return app;
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(basePath)) throw new Error(`invalid base path ${JSON.stringify(basePath)}`);
  const outer = express();
  outer.disable("x-powered-by");
  outer.set("trust proxy", "loopback");
  // Pages use relative links, so "/registry" must become "/registry/".
  outer.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === basePath && (req.method === "GET" || req.method === "HEAD")) {
      const q = req.originalUrl.indexOf("?");
      res.redirect(301, `${basePath}/${q >= 0 ? req.originalUrl.slice(q) : ""}`);
      return;
    }
    next();
  });
  outer.use(basePath, app);
  outer.use("/", app);
  return outer;
}

/**
 * True when a request came through a proxy or tunnel (the gateway, cloudflared, ngrok...). Such a request
 * is never treated as "from this machine", even though its socket is on loopback.
 */
export function viaProxy(req: Request): boolean {
  return Boolean(req.get("x-forwarded-for") || req.get("x-forwarded-host") || req.get("forwarded") || req.get("cf-connecting-ip") || req.get("x-real-ip"));
}

export function isDirectLocal(req: Request): boolean {
  if (viaProxy(req)) return false;
  const ip = req.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

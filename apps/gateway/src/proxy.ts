// One public origin for everything.
//
//   /api/buyer-meta            -> buyer   /api/meta
//   /api/tasks...              -> buyer   (POSTs: BUYER_API_TOKEN, or a Google session allowed to run Scout)
//   /api/auth..., /api/sellers -> registry (sign-in sessions, wallet-proven seller registration)
//   /api/...                   -> registry
//   /registry/ /scraper/ /fx/ /summary/ /chaos/ /buyer/   -> each service (paths unchanged; sellers and judges)
//   anything else              -> the built web UI (SPA fallback to index.html), when it is present
//
// Proxying keeps the path, gives the service the public Host (x402 builds resource.url from it), appends
// X-Forwarded-For/Proto/Host, and streams bodies, so Server-Sent Events flow straight through unbuffered.
//
// A Google session never sees the buyer's API token: the gateway checks the session with the registry,
// enforces the per-email daily cap (check and record happen synchronously, with no await in between), and
// only then forwards the request with the server-side BUYER_API_TOKEN.

import { createReadStream, existsSync, statSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fromUnits, toUnits } from "@dron/shared";

export interface Route {
  prefix: string;
  target: URL;
}

export interface ApiOptions {
  registry: URL;
  buyer: URL;
  /** Server-side token the buyer accepts; required for any session to spend. */
  buyerToken?: string;
  /** Per-email, per-UTC-day spending cap for Google sessions, in USDC units. */
  dailyCapUnits: bigint;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
const MAX_BODY = 64 * 1024;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/** "/registry=http://127.0.0.1:4000,/scraper=http://127.0.0.1:4101" */
export function parseRoutes(spec: string): Route[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [prefix, target] = pair.split("=");
      if (!prefix?.startsWith("/") || !target) throw new Error(`bad route ${JSON.stringify(pair)} (want /prefix=http://host:port)`);
      return { prefix: prefix.replace(/\/+$/, ""), target: new URL(target) };
    })
    .sort((a, b) => b.prefix.length - a.prefix.length);
}

export function match(routes: Route[], path: string): Route | undefined {
  return routes.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`) || path.startsWith(`${r.prefix}?`));
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  path: string,
  opts: { body?: Buffer; authorization?: string; onStatus?: (status: number) => void; log?: (msg: string, fields?: Record<string, unknown>) => void; label: string },
) {
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  const remote = req.socket.remoteAddress ?? "";
  headers["x-forwarded-for"] = req.headers["x-forwarded-for"] ? `${req.headers["x-forwarded-for"]}, ${remote}` : remote;
  headers["x-forwarded-proto"] = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  const publicHost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || req.headers.host || "";
  headers["x-forwarded-host"] = publicHost;
  // x402 builds resource.url from Host, so services see the PUBLIC host.
  headers.host = publicHost;
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  if (opts.body) headers["content-length"] = String(opts.body.length);

  const upstream = http.request({ protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path, headers, agent }, (up) => {
    opts.onStatus?.(up.statusCode ?? 502);
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
    const sse = String(up.headers["content-type"] ?? "").startsWith("text/event-stream");
    if (sse) {
      out["x-accel-buffering"] = "no";
      out["cache-control"] = "no-cache, no-transform";
    }
    res.writeHead(up.statusCode ?? 502, out);
    if (sse) res.flushHeaders();
    up.pipe(res);
  });
  upstream.on("error", (err) => {
    opts.onStatus?.(502);
    opts.log?.("upstream unreachable", { service: opts.label, err: err.message });
    if (!res.headersSent) json(res, 502, { error: "service_unavailable", service: opts.label });
    else res.destroy();
  });
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => upstream.destroy());
  if (opts.body) upstream.end(opts.body);
  else req.pipe(upstream);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function getJson(url: URL, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function serveStatic(root: string, path: string, res: ServerResponse, method: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  const file = resolve(root, `.${normalize(decoded)}`);
  if (!file.startsWith(resolve(root))) return false;
  const isFile = existsSync(file) && statSync(file).isFile();
  const target = isFile ? file : join(root, "index.html"); // SPA fallback
  if (!existsSync(target)) return false;
  const immutable = isFile && path.startsWith("/assets/");
  res.writeHead(200, {
    "content-type": TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (method === "HEAD") res.end();
  else createReadStream(target).pipe(res);
  return true;
}

export function createGateway(
  routes: Route[],
  opts: { home?: string; api?: ApiOptions; staticDir?: string; log?: (msg: string, fields?: Record<string, unknown>) => void } = {},
) {
  const home = opts.home ?? routes.find((r) => r.prefix === "/registry")?.prefix ?? routes[0]?.prefix ?? "/";
  const staticDir = opts.staticDir && existsSync(join(opts.staticDir, "index.html")) ? opts.staticDir : undefined;
  const spent = new Map<string, bigint>(); // `${email}|${utc day}` -> units committed today

  async function scoutPost(req: IncomingMessage, res: ServerResponse, path: string, api: ApiOptions) {
    const auth = req.headers.authorization ?? "";
    if (!api.buyerToken) return json(res, 503, { error: "buyer_not_configured", message: "BUYER_API_TOKEN is not set on the server" });
    if (auth === `Bearer ${api.buyerToken}`) return forward(req, res, api.buyer, path, { label: "buyer", log: opts.log });

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 413, { error: "body_too_large" });
    }
    if (!auth.startsWith("Bearer ")) return json(res, 401, { error: "unauthorised", message: "Sign in with Google to continue" });
    let session: { authenticated?: boolean; user?: { email?: string; canRunScout?: boolean } };
    try {
      session = await getJson(new URL("/api/auth/session", api.registry), { authorization: auth });
    } catch {
      return json(res, 502, { error: "service_unavailable", service: "registry" });
    }
    if (!session.authenticated || !session.user?.email) return json(res, 401, { error: "unauthorised", message: "Sign in with Google to continue" });
    if (!session.user.canRunScout) return json(res, 403, { error: "forbidden", message: "This account is not allowed to run Scout tasks" });

    // What this request can commit the buyer wallet to.
    let parsed: Record<string, unknown> = {};
    try {
      parsed = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return json(res, 400, { error: "invalid_json" });
    }
    const usdc = (v: unknown) => {
      try {
        return toUnits(String(v ?? "0"));
      } catch {
        return 0n; // the buyer rejects malformed amounts itself
      }
    };
    let units = 0n;
    const m = /^\/api\/tasks\/([^/?]+)\/(start|topup|cancel)/.exec(path);
    if (!m) units = parsed.dry_run ? 0n : usdc(parsed.budget);
    else if (m[2] === "topup") units = usdc(parsed.amount);
    else if (m[2] === "start") {
      try {
        units = usdc((await getJson(new URL(`/api/tasks/${m[1]}`, api.buyer))).request?.budget);
      } catch {
        return json(res, 404, { error: "not_found" });
      }
    }

    // Check and record synchronously: concurrent requests cannot both pass the cap.
    const key = `${session.user.email}|${new Date().toISOString().slice(0, 10)}`;
    const used = spent.get(key) ?? 0n;
    if (used + units > api.dailyCapUnits) {
      return json(res, 429, { error: "daily_cap", message: `Daily limit of ${fromUnits(api.dailyCapUnits)} USDC reached for ${session.user.email} (${fromUnits(used)} used today)` });
    }
    spent.set(key, used + units);

    forward(req, res, api.buyer, path, {
      body,
      authorization: `Bearer ${api.buyerToken}`,
      label: "buyer",
      log: opts.log,
      onStatus: (status) => {
        if (status >= 400) spent.set(key, (spent.get(key) ?? 0n) - units); // the buyer refused it: nothing committed
      },
    });
  }

  return http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0]!;
    const api = opts.api;

    if (path === "/gateway/health") {
      return json(res, 200, { ok: true, ui: Boolean(staticDir), api: Boolean(api), routes: routes.map((r) => ({ prefix: r.prefix, target: r.target.origin })) });
    }

    if (api && (path === "/api" || path.startsWith("/api/"))) {
      // Answered by the buyer; always arrives there with forwarding headers, so it reports local:false.
      if (path === "/api/auth/mode") return forward(req, res, api.buyer, url, { label: "buyer", log: opts.log });
      if (path === "/api/buyer-meta") return forward(req, res, api.buyer, `/api/meta${url.slice(path.length)}`, { label: "buyer", log: opts.log });
      if (path === "/api/tasks" || path.startsWith("/api/tasks/")) {
        if (req.method === "POST") {
          void scoutPost(req, res, url, api).catch((err) => {
            opts.log?.("scout request failed", { err: (err as Error).message });
            if (!res.headersSent) json(res, 500, { error: "internal_error" });
          });
          return;
        }
        return forward(req, res, api.buyer, url, { label: "buyer", log: opts.log });
      }
      return forward(req, res, api.registry, url, { label: "registry", log: opts.log });
    }

    const route = match(routes, path);
    if (route) return forward(req, res, route.target, url, { label: route.prefix, log: opts.log });

    if (staticDir && serveStatic(staticDir, path, res, req.method ?? "GET")) return;
    if (path === "/" || path === "") {
      res.writeHead(302, { location: `${home}/` });
      res.end();
      return;
    }
    json(res, 404, { error: "not_found", services: routes.map((r) => `${r.prefix}/`) });
  });
}

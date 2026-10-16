// A small path-prefix reverse proxy: one public hostname for every service.
//
//   https://host/registry/...  -> registry      https://host/fx/...      -> fx-rates
//   https://host/scraper/...   -> shelf-scraper https://host/summary/... -> hindi-summary
//   https://host/buyer/...     -> buyer agent   https://host/chaos/...   -> fixtures
//
// The path is forwarded unchanged (each service is mounted at its prefix), the service sees the public
// Host (x402 builds resource.url from it), X-Forwarded-For/Proto/Host are appended, and bodies are
// streamed, so Server-Sent Events flow straight through.

import http, { type IncomingMessage, type ServerResponse } from "node:http";

export interface Route {
  prefix: string;
  target: URL;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

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

export function createGateway(routes: Route[], opts: { home?: string; log?: (msg: string, fields?: Record<string, unknown>) => void } = {}) {
  const home = opts.home ?? routes.find((r) => r.prefix === "/registry")?.prefix ?? routes[0]?.prefix ?? "/";

  return http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0]!;

    if (path === "/" || path === "") {
      res.writeHead(302, { location: `${home}/` });
      res.end();
      return;
    }
    if (path === "/gateway/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, routes: routes.map((r) => ({ prefix: r.prefix, target: r.target.origin })) }));
      return;
    }
    const route = match(routes, path);
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", services: routes.map((r) => `${r.prefix}/`) }));
      return;
    }

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    const remote = req.socket.remoteAddress ?? "";
    headers["x-forwarded-for"] = req.headers["x-forwarded-for"] ? `${req.headers["x-forwarded-for"]}, ${remote}` : remote;
    headers["x-forwarded-proto"] = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
    const publicHost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || req.headers.host || "";
    headers["x-forwarded-host"] = publicHost;
    // x402 builds resource.url from the Host header, so the service must see the PUBLIC host: the client's
    // Host, or the original host a tunnel passed in X-Forwarded-Host after rewriting Host.
    headers.host = publicHost;

    const upstream = http.request(
      { protocol: route.target.protocol, hostname: route.target.hostname, port: route.target.port, method: req.method, path: url, headers, agent },
      (up) => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
        res.writeHead(up.statusCode ?? 502, out);
        if (String(up.headers["content-type"] ?? "").startsWith("text/event-stream")) res.flushHeaders();
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      opts.log?.("upstream unreachable", { prefix: route.prefix, err: err.message });
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "service_unavailable", service: route.prefix }));
      } else res.destroy();
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
}

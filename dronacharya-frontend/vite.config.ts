import type { IncomingMessage } from "node:http";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev-only proxy (the browser calls same-origin /api/...):
//   /api/tasks*, /api/auth/mode -> the buyer directly (DEV_BUYER_URL, default http://localhost:4200), so a run
//                                  started from THIS machine passes the buyer's own loopback rule ("local mode")
//   everything else under /api  -> the gateway (DEV_API_TARGET, default http://localhost:8080)
//
// The dev server also listens on the LAN, so the buyer must not mistake a LAN visitor (or another website's
// page in your browser) for local: such requests get an X-Forwarded-For header, which makes the buyer treat
// them as remote and require auth. The proxy never adds X-Forwarded-* otherwise (xfwd: false).
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function fromThisMachine(req: IncomingMessage): boolean {
  if (!LOOPBACK_IPS.has(req.socket.remoteAddress ?? "")) return false;
  const host = req.headers.host ?? "";
  if (!LOOPBACK_HOST.test(host)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}`; // a cross-site page cannot borrow local mode
}

const markRemote: ProxyOptions["configure"] = (proxy) => {
  proxy.on("proxyReq", (proxyReq, req) => {
    if (!fromThisMachine(req)) proxyReq.setHeader("x-forwarded-for", req.socket.remoteAddress || "unknown");
  });
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const gateway = env.DEV_API_TARGET || "http://localhost:8080";
  const buyer = env.DEV_BUYER_URL || "http://localhost:4200";
  const toBuyer: ProxyOptions = { target: buyer, changeOrigin: true, xfwd: false, configure: markRemote };

  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      proxy: {
        // More specific prefixes first.
        "/api/tasks": toBuyer,
        "/api/auth/mode": toBuyer,
        "/api": { target: gateway, changeOrigin: true },
      },
    },
    preview: { port: 4173 },
  };
});

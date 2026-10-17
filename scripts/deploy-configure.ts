// Points every service at its public URL.
//
//   npm run deploy:configure -- https://abc.ngrok-free.app     one hostname, path prefixes through the gateway
//   npm run deploy:configure -- --subdomains example.com       registry.example.com, scraper.example.com, ...
//   npm run deploy:configure -- --local                        back to http://localhost:<port>
//
// Then restart (npm start), start your tunnel, and run npm run deploy:check.

import { envInt, loadEnv } from "@dron/shared";
import { guildRoster } from "@dron/seller-guild/roster";
import { setEnvValues } from "./env-file.ts";

loadEnv();
const args = process.argv.slice(2);

// service -> [env key, path prefix (gateway), subdomain, local port]
const SERVICES: [string, string, string, number][] = [
  ["REGISTRY_PUBLIC_URL", "/registry", "registry", envInt("REGISTRY_PORT", 4000)],
  ["SCRAPER_PUBLIC_URL", "/scraper", "scraper", envInt("SCRAPER_PORT", 4101)],
  ["DATA_PUBLIC_URL", "/fx", "fx", envInt("DATA_PORT", 4102)],
  ["INFERENCE_PUBLIC_URL", "/summary", "summary", envInt("INFERENCE_PORT", 4103)],
  ["CHAOS_PUBLIC_URL", "/chaos", "chaos", envInt("CHAOS_PORT", 4199)],
  ["BUYER_PUBLIC_URL", "/buyer", "buyer", envInt("BUYER_PORT", 4200)],
  ...guildRoster(envInt("GUILD_BASE_PORT", 4111)).map((m): [string, string, string, number] => [`${m.env}_PUBLIC_URL`, m.prefix, m.id, m.port]),
];

let values: Record<string, string>;
let mode: string;
if (args.includes("--local")) {
  mode = "local";
  values = Object.fromEntries(SERVICES.map(([key, , , port]) => [key, `http://localhost:${port}`]));
  values.REGISTRY_ALLOW_LOOPBACK = "true";
} else if (args.includes("--subdomains")) {
  const domain = args[args.indexOf("--subdomains") + 1];
  if (!domain || domain.includes("/")) throw new Error("usage: --subdomains example.com");
  mode = "subdomains";
  values = Object.fromEntries(SERVICES.map(([key, , sub]) => [key, `https://${sub}.${domain}`]));
  values.REGISTRY_ALLOW_LOOPBACK = "false";
} else {
  // https for real deployments; http://localhost:<gateway port> only to rehearse locally.
  const base = args.find((a) => /^https:\/\//.test(a) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(a));
  if (base?.startsWith("http://")) console.log("rehearsal: http://localhost is not public; use it to test the gateway, then configure your https tunnel");
  if (!base) {
    console.error("usage: npm run deploy:configure -- https://<public-host>   |   --subdomains <domain>   |   --local");
    process.exit(64);
  }
  const origin = new URL(base).origin;
  mode = "gateway";
  values = Object.fromEntries(SERVICES.map(([key, prefix]) => [key, `${origin}${prefix}`]));
  values.REGISTRY_ALLOW_LOOPBACK = "false";
}

setEnvValues(values);
console.log(`\n.env updated (${mode}):\n`);
for (const [k, v] of Object.entries(values)) console.log(`  ${k}=${v}`);

if (mode === "gateway") {
  const origin = new URL(values.REGISTRY_PUBLIC_URL!).origin;
  console.log(`
Next:
  1. npm start                      (restart: services pick up their public URLs; the gateway listens on :8080)
  2. expose port 8080 at ${origin}, for example:
       ngrok http --domain=${new URL(origin).host} 8080
       cloudflared tunnel --url http://localhost:8080        (quick tunnel: new URL each run, re-run this script)
  3. npm run deploy:check`);
} else if (mode === "subdomains") {
  console.log(`
Next: route each hostname to its port (no gateway needed), e.g. deploy/cloudflared-config.example.yml or
deploy/Caddyfile.example, then npm start and npm run deploy:check.`);
}

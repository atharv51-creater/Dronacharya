// Checks a deployment the way a judge will meet it, through the PUBLIC URLs in .env:
//   - every service answers over HTTPS;
//   - our listings point at public endpoints (no localhost), and each seller's 402 names its public URL
//     as resource.url and the listed payTo;
//   - the public registry refuses a localhost listing; the public buyer API refuses unauthenticated calls.
// Prints (and saves) the "Public URLs and wallets" table for the README.
//
//   npm run deploy:check                 (after deploy:configure + npm start + tunnel)
//   npm run deploy:check -- --allow-http (dry run against localhost URLs)

import { mkdirSync, writeFileSync } from "node:fs";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { REPO_ROOT, addressUrl, env, loadEnv, type Listing } from "@dron/shared";

loadEnv();
const allowHttp = process.argv.includes("--allow-http");
const urls = {
  registry: env("REGISTRY_PUBLIC_URL", "http://localhost:4000")!,
  scraper: env("SCRAPER_PUBLIC_URL", "http://localhost:4101")!,
  fx: env("DATA_PUBLIC_URL", "http://localhost:4102")!,
  summary: env("INFERENCE_PUBLIC_URL", "http://localhost:4103")!,
  chaos: env("CHAOS_PUBLIC_URL", "http://localhost:4199")!,
  buyer: env("BUYER_PUBLIC_URL", "http://localhost:4200")!,
};
const trim = (u: string) => u.replace(/\/+$/, "");

let failures = 0;
const line = (ok: boolean, what: string, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${what}${detail ? `  ${detail}` : ""}`);
};
const get = async (url: string, init?: RequestInit) => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: "manual" });
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).cause ? String((err as { cause: Error }).cause.message ?? (err as Error).cause) : (err as Error).message } as unknown as Response & { error: string };
  }
};

console.log("\n1. Every service over HTTPS");
for (const [name, base] of Object.entries(urls)) {
  const https = base.startsWith("https://");
  if (allowHttp && !https) console.log(`  – ${name} uses https  (skipped: --allow-http)  ${base}`);
  else line(https, `${name} uses https`, base);
  const health = name === "registry" || name === "buyer" ? `${trim(base)}/api/health` : `${trim(base)}/health`;
  const res = await get(health);
  line(res.status === 200, `${name} reachable`, res.status ? `${health} -> ${res.status}` : `${health} -> ${(res as unknown as { error: string }).error}`);
}

console.log("\n2. Listings point at public endpoints; each 402 names its public URL and the listed payTo");
const reg = await get(`${trim(urls.registry)}/api/services?includeFixtures=true`);
const services = reg.status === 200 ? ((await reg.json()) as { services: Listing[] }).services : [];
const ours: Record<string, string> = { "shelf-scraper": urls.scraper, "fx-rates": urls.fx, "hindi-summary": urls.summary, "cheap-scraper": urls.chaos };
const samples: Record<string, { query?: string; body?: unknown }> = {
  "shelf-scraper": { query: "page=1" },
  "fx-rates": { query: "from=GBP&to=INR" },
  "hindi-summary": { body: { texts: ["probe"] } },
  "cheap-scraper": { query: "page=1" },
};
for (const [id, base] of Object.entries(ours)) {
  const l = services.find((s) => s.id === id);
  if (!l) {
    line(false, `${id} is registered`);
    continue;
  }
  line(l.endpoint.startsWith(trim(base)), `${id} listing endpoint is public`, l.endpoint);
  const sample = samples[id]!;
  const url = sample.query ? `${l.endpoint}?${sample.query}` : l.endpoint;
  const res = await get(url, sample.body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sample.body) } : undefined);
  const header = res.status === 402 ? res.headers.get("PAYMENT-REQUIRED") : null;
  if (!header) {
    line(false, `${id} answers 402`, `got ${res.status}`);
    continue;
  }
  const required = decodePaymentRequiredHeader(header);
  line(required.resource.url.startsWith(l.endpoint), `${id} 402 resource.url is the public URL`, required.resource.url);
  line(required.accepts[0]?.payTo.toLowerCase() === l.payTo.toLowerCase(), `${id} 402 payTo matches the listing`, l.payTo);
}
const local = services.filter((s) => /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(s.endpoint) && !s.id.startsWith("ref-"));
if (allowHttp) console.log("  – no listing points at localhost  (skipped: --allow-http)");
else line(local.length === 0, "no listing points at localhost", local.map((s) => s.id).join(", "));

console.log("\n3. Public endpoints are locked down");
if (!allowHttp) {
  const probe = await get(`${trim(urls.registry)}/api/services`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: `probe-${Date.now()}`, name: "probe", category: "data", description: "deploy check", endpoint: "http://localhost:9/x", price: "0.001", payTo: "0x1111111111111111111111111111111111111111", inputSchema: { type: "object" }, outputSchema: { type: "object" } }),
  });
  line(probe.status === 400, "registry refuses a localhost listing from the public", `HTTP ${probe.status}`);
}
const anon = await get(`${trim(urls.buyer)}/api/tasks`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" }, body: JSON.stringify({ task: "From page 1 of books.toscrape.com, find the cheapest book.", budget: "0.01", dry_run: true }) });
line(anon.status === 401, "buyer API refuses unauthenticated remote calls", `HTTP ${anon.status}`);
const token = env("BUYER_API_TOKEN");
if (token) {
  const authed = await get(`${trim(urls.buyer)}/api/tasks`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ task: "From page 1 of books.toscrape.com, find the cheapest book.", budget: "0.01", dry_run: true }) });
  line(authed.status === 202, "buyer API accepts the token (dry run, nothing bought)", `HTTP ${authed.status}`);
}

// ---------- the README table ----------
const buyerKey = env("BUYER_PRIVATE_KEY");
const wallets: [string, string | undefined][] = [
  ["Buyer", buyerKey ? privateKeyToAccount(buyerKey as Hex).address : undefined],
  ["shelf-scraper `payTo`", env("SCRAPER_PAY_TO")],
  ["fx-rates `payTo`", env("DATA_PAY_TO")],
  ["hindi-summary `payTo`", env("INFERENCE_PAY_TO")],
  ["cheap-scraper `payTo` (fixtures)", env("CHAOS_PAY_TO")],
];
const md = [
  "| Service | URL |",
  "|---|---|",
  `| Registry (marketplace) | ${trim(urls.registry)}/ |`,
  `| Ledger dashboard | ${trim(urls.registry)}/ledger |`,
  `| Buyer agent (console + API) | ${trim(urls.buyer)}/ |`,
  `| shelf-scraper | ${trim(urls.scraper)}/scrape |`,
  `| fx-rates | ${trim(urls.fx)}/rate |`,
  `| hindi-summary | ${trim(urls.summary)}/summarise |`,
  `| cheap-scraper (fixtures) | ${trim(urls.chaos)}/ |`,
  "",
  "| Wallet | Address (Base Sepolia) |",
  "|---|---|",
  ...wallets.filter(([, a]) => a).map(([name, a]) => `| ${name} | [\`${a}\`](${addressUrl(a!)}) |`),
].join("\n");
mkdirSync(`${REPO_ROOT}.data/deploy`, { recursive: true });
writeFileSync(`${REPO_ROOT}.data/deploy/public-urls.md`, md + "\n");
console.log(`\n${md}\n\n(saved to .data/deploy/public-urls.md)`);
console.log(failures ? `\n${failures} check(s) failed` : "\nall deployment checks passed");
process.exit(failures ? 1 : 0);

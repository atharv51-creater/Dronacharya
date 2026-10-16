// The judges' test pack, run against the live stack on Base Sepolia (`npm start` first).
//
//   npm run judge                        # everything
//   npm run judge -- --only price,replay # some checks
//   npm run judge -- --keep              # keep the reference sellers' listings afterwards
//
// Checks: happy · reconcile · budget · price · replay · failure · junk · standard · hygiene
// Each prints PASS / FAIL / SKIP with explorer links; a Markdown report goes to .data/judge/.
// Costs about 0.08 testnet USDC with a funded buyer. Without funds, payment checks are skipped (with the
// reason) and the price check runs through the buyer's payment core, which refuses before paying anyway.

import { mkdirSync, writeFileSync } from "node:fs";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { DEFAULT_FACILITATOR_URL, REPO_ROOT, env, fromUnits, geminiConfigured, loadEnv, requireEnv, txUrl, type Address, type LedgerRow, type Listing } from "@dron/shared";
import { Budget, Buyer, MemoryLedger, assertTestnet, authorizationUsed, confirmTransfer, usdcBalance } from "@dron/x402-kit";
import { scrapeInputSchema, scrapeOutputSchema } from "@dron/seller-scraper/schemas";
import { send, signPaymentFor } from "../live/lib.ts";
import { scanHygiene } from "./hygiene.ts";
import { startReferenceSeller, type ReferenceMode, type ReferenceSeller } from "./reference-seller.ts";

loadEnv();
await assertTestnet();

const args = process.argv.slice(2);
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1]!.split(",")) : null;
const keep = args.includes("--keep");
const REGISTRY = env("REGISTRY_URL", "http://localhost:4000")!.replace(/\/+$/, "");
const BUYER_API = env("BUYER_URL", "http://localhost:4200")!.replace(/\/+$/, "");
const FACILITATOR = env("FACILITATOR_URL", DEFAULT_FACILITATOR_URL)!;
const account = privateKeyToAccount(requireEnv("BUYER_PRIVATE_KEY") as Hex);
const adminToken = env("REGISTRY_ADMIN_TOKEN");
const buyerToken = env("BUYER_API_TOKEN");

type Status = "PASS" | "FAIL" | "SKIP";
interface Result {
  id: string;
  title: string;
  status: Status;
  notes: string[];
}
const results: Result[] = [];

async function check(id: string, title: string, fn: (r: Result) => Promise<void>) {
  if (only && !only.has(id)) return;
  const r: Result = { id, title, status: "PASS", notes: [] };
  console.log(`\n▶ ${title}`);
  try {
    await fn(r);
  } catch (err) {
    r.status = "FAIL";
    r.notes.push(`error: ${(err as Error).message}`);
  }
  for (const n of r.notes) console.log(`    ${n}`);
  console.log(`  ${r.status === "PASS" ? "✓ PASS" : r.status === "SKIP" ? "– SKIP" : "✗ FAIL"}`);
  results.push(r);
}
const expect = (r: Result, ok: boolean, what: string) => {
  r.notes.push(`${ok ? "ok  " : "BAD "} ${what}`);
  if (!ok) r.status = "FAIL";
};
const skip = (r: Result, why: string) => {
  r.status = "SKIP";
  r.notes.push(why);
};

// ---------- helpers ----------

const json = async (res: Response) => res.json() as Promise<any>;
const buyerHeaders = { "content-type": "application/json", ...(buyerToken ? { authorization: `Bearer ${buyerToken}` } : {}) };

async function runTask(body: Record<string, unknown>, timeoutMs = 240_000) {
  const res = await fetch(`${BUYER_API}/api/tasks`, { method: "POST", headers: buyerHeaders, body: JSON.stringify(body) });
  if (res.status !== 202) throw new Error(`buyer agent answered ${res.status}: ${await res.text()}`);
  const { taskId } = await json(res);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = await json(await fetch(`${BUYER_API}/api/tasks/${taskId}`));
    const final = ["completed", "partial", "failed", "cancelled", "needs_budget", "planned"].includes(t.status);
    if ((final && t.settled) || (final && ["failed", "planned"].includes(t.status))) return t;
    if (Date.now() > deadline) throw new Error(`task ${taskId} still ${t.status} after ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function confirmRows(r: Result, rows: LedgerRow[]) {
  for (const row of rows) {
    const c = await confirmTransfer(row.txHash as Hex, { from: account.address, to: row.payTo as Address, amount: BigInt(row.paidUnits) }, { wait: true });
    expect(r, c.confirmed, `${row.serviceId}: ${row.paidUnits} units ${short(account.address)} -> ${short(row.payTo)} on-chain  ${txUrl(row.txHash!)}`);
  }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const paidRows = (t: { ledger: LedgerRow[] }) => t.ledger.filter((x) => (x.status === "paid" || x.status === "paid_output_rejected") && BigInt(x.paidUnits) > 0n);

const references: ReferenceSeller[] = [];
const registered: string[] = [];
const refPayTo = (env("CHAOS_ALT_PAY_TO") as Address | undefined) ?? privateKeyToAccount(generatePrivateKey()).address;
const otherPayTo = privateKeyToAccount(generatePrivateKey()).address;

async function referenceListing(mode: ReferenceMode, outputSchema: Record<string, unknown>): Promise<Listing> {
  const seller = await startReferenceSeller({ mode, listedPrice: "$0.001", payTo: refPayTo, otherPayTo, facilitatorUrl: FACILITATOR });
  references.push(seller);
  const id = `ref-${mode}-${Date.now().toString(36)}`;
  const listing = {
    id,
    sellerId: id,
    name: `reference ${mode}`,
    category: "scraping",
    description: `[judge pack] stock @x402/express reference seller (${mode})`,
    endpoint: seller.url,
    method: "GET",
    price: "0.001",
    payTo: refPayTo,
    inputSchema: { type: "object", properties: { page: { type: "integer" }, category: { type: "string" } } },
    outputSchema,
    isFixture: true,
  };
  const res = await fetch(`${REGISTRY}/api/services`, { method: "POST", headers: { "content-type": "application/json", ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}) }, body: JSON.stringify(listing) });
  if (!res.ok) throw new Error(`could not register ${id}: ${res.status} ${await res.text()}`);
  registered.push(id);
  return (await json(res)) as Listing;
}

// ---------- preflight ----------

const balance = await usdcBalance(account.address);
const funded = balance >= 80_000n;
const gemini = geminiConfigured();
console.log(`buyer ${account.address}: ${fromUnits(balance)} USDC${funded ? "" : " (needs ~0.08 for the payment checks: https://faucet.circle.com)"}`);
console.log(`gemini: ${gemini ? "configured" : "GEMINI_API_KEY not set (Hindi text cannot be bought)"}`);
for (const [name, url] of [["registry", `${REGISTRY}/api/health`], ["buyer agent", `${BUYER_API}/api/health`]] as const) {
  const ok = await fetch(url).then((r) => r.ok).catch(() => false);
  if (!ok) {
    console.error(`${name} is not reachable at ${url}; start the stack with npm start`);
    process.exit(2);
  }
}

let happySession: string | null = null;

// ---------- 1. happy path ----------
await check("happy", "Happy path: one of our tasks with changed numbers; >= 3 paid calls, each transfer correct on-chain", async (r) => {
  if (!funded) return skip(r, "buyer wallet not funded");
  if (!gemini) return skip(r, "GEMINI_API_KEY not set: the Hindi step cannot be bought");
  const task = "From pages 2 to 5 of books.toscrape.com, find the two cheapest 4-star books, give their prices in euros, and summarise each description in Hindi.";
  r.notes.push(`task: ${task}`);
  const t = await runTask({ task, budget: "0.040", max_concurrency: 3 });
  happySession = t.sessionId;
  expect(r, t.status === "completed", `task completed (status ${t.status}${t.error ? `: ${t.error}` : ""})`);
  const rows = paidRows(t);
  expect(r, rows.length >= 3, `${rows.length} paid calls (>= 3)`);
  await confirmRows(r, rows);
  r.notes.push(`answer: ${t.result?.books?.map((b: { title: string; prices: Record<string, number> }) => `${b.title} €${b.prices.EUR}`).join("; ")}`);
  r.notes.push(`ledger: ${REGISTRY}/ledger?session=${t.sessionId}`);
});

// ---------- 2. reconciliation ----------
await check("reconcile", "Reconciliation: paid ledger entries add up to the USDC transfers out of the buyer wallet, to the unit", async (r) => {
  if (!happySession) return skip(r, "needs the happy-path session");
  const rep = await json(await fetch(`${REGISTRY}/api/ledger/reconcile?sessionId=${happySession}`));
  expect(r, rep.ok === true, rep.summary);
  expect(r, rep.diffUnits === "0", `difference ${rep.diffUnits} units`);
});

// ---------- 3. budget ----------
await check("budget", "Budget: 0.012 USDC for a ~0.021 task at max_concurrency 1, then 5; spend never passes 0.012, buyer says why", async (r) => {
  if (!funded) return skip(r, "buyer wallet not funded");
  const task = "From pages 1 to 4 of books.toscrape.com, find the three cheapest books, give their prices in rupees.";
  for (const c of [1, 5]) {
    const before = await usdcBalance(account.address);
    const t = await runTask({ task, budget: "0.012", max_concurrency: c });
    const after = await usdcBalance(account.address);
    expect(r, BigInt(t.budget.spentUnits) <= 12_000n, `concurrency ${c}: ledger spend ${t.budget.spentUsdc} USDC <= 0.012`);
    expect(r, before - after <= 12_000n, `concurrency ${c}: wallet moved ${fromUnits(before - after)} USDC on-chain <= 0.012`);
    expect(r, t.status === "needs_budget" && Boolean(t.shortfall?.message), `concurrency ${c}: stopped and said why: ${t.shortfall?.message ?? t.status}`);
  }
});

// ---------- 4. price check ----------
await check("price", "Price check: a seller listed at 0.001 whose 402 asks 0.010, and one whose 402 names another payTo; both refused, nothing paid", async (r) => {
  const loose = { type: "object" };
  const greedy = await referenceListing("overprice", loose);
  const redirect = await referenceListing("wrong-payto", loose);
  const before = await usdcBalance(account.address);
  for (const listing of [greedy, redirect]) {
    let rows: LedgerRow[];
    if (funded) {
      const t = await runTask({ task: "From page 1 of books.toscrape.com, find the cheapest book.", budget: "0.010", only_sellers: [listing.id] });
      rows = t.ledger.filter((x: LedgerRow) => x.serviceId === listing.id);
    } else {
      r.notes.push("(unfunded wallet: exercised through the buyer's payment core, which decides before paying)");
      const buyer = new Buyer({ account, ledger: [new MemoryLedger()] });
      const out = await buyer.payAndCall({ listing, input: { page: 1 }, budget: new Budget(10_000n) });
      rows = [out.row];
    }
    const refused = rows.length > 0 && rows.every((x) => x.status === "refused" && x.paidUnits === "0" && x.nonce === null);
    expect(r, refused, `${listing.id}: ${rows.map((x) => `${x.status} (${x.reason})`).join("; ")}`);
  }
  const after = await usdcBalance(account.address);
  expect(r, before === after, `wallet balance unchanged (${fromUnits(before)} -> ${fromUnits(after)} USDC)`);
});

// ---------- 5. replay ----------
await check("replay", "Replay: one signed payment sent twice, then five times in parallel; one result and one transfer each", async (r) => {
  if (!funded) return skip(r, "buyer wallet not funded");
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  const { x402HTTPClient } = await import("@x402/core/client");
  const buyer = { account, client, http: new x402HTTPClient(client) };
  const fx = (await json(await fetch(`${REGISTRY}/api/services/fx-rates`))) as Listing;
  const url = `${fx.endpoint}?from=GBP&to=INR`;

  const a = await signPaymentFor(buyer, url);
  const seq = [await send(url, {}, a.headers), await send(url, {}, a.headers)];
  expect(r, seq[0]!.status === 200 && seq[1]!.status === 409, `sequential: ${seq.map((x) => x.status).join(", ")}`);
  const b = await signPaymentFor(buyer, url);
  const par = await Promise.all(Array.from({ length: 5 }, () => send(url, {}, b.headers)));
  const wins = par.filter((x) => x.status === 200);
  expect(r, wins.length === 1, `parallel: ${par.map((x) => x.status).sort().join(", ")}`);
  for (const [label, sig, tx] of [["sequential", a, seq[0]!.settle?.transaction], ["parallel", b, wins[0]?.settle?.transaction]] as const) {
    const c = tx ? await confirmTransfer(tx as Hex, { from: account.address, to: sig.payload.accepted.payTo as Address, amount: BigInt(sig.payload.accepted.amount) }, { wait: true }) : { confirmed: false, transfers: [] };
    expect(r, c.confirmed && c.transfers.length === 1, `${label}: exactly one transfer  ${tx ? txUrl(tx) : "(no tx)"}`);
  }
});

// ---------- 6. seller failure ----------
await check("failure", "Seller failure: requests our sellers cannot fulfil return an error and transfer nothing", async (r) => {
  if (!funded) return skip(r, "buyer wallet not funded (an unfunded payment is rejected before the seller even runs)");
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  const { x402HTTPClient } = await import("@x402/core/client");
  const buyer = { account, client, http: new x402HTTPClient(client) };
  const shelf = (await json(await fetch(`${REGISTRY}/api/services/shelf-scraper`))) as Listing;
  const fx = (await json(await fetch(`${REGISTRY}/api/services/fx-rates`))) as Listing;
  const cases = [
    [`${shelf.endpoint}?page=999`, 404],
    [`${fx.endpoint}?from=GBP&to=XYZ`, 422],
  ] as const;
  const signed: { url: string; from: Address; nonce: Hex }[] = [];
  for (const [url, status] of cases) {
    const sig = await signPaymentFor(buyer, url);
    const res = await send(url, {}, sig.headers);
    expect(r, res.status === status && !res.settle?.success, `${url}: HTTP ${res.status}, not settled`);
    signed.push({ url, from: sig.from, nonce: sig.nonce as Hex });
  }
  await new Promise((res) => setTimeout(res, 5000));
  for (const s of signed) expect(r, !(await authorizationUsed(s.from, s.nonce)), `${s.url}: authorisation unused on-chain`);
});

// ---------- 7. junk output ----------
await check("junk", "Junk output: a seller returns 200 with schema-breaking output; paid, output rejected, not used, reputation lowered, bought elsewhere", async (r) => {
  if (!funded) return skip(r, "buyer wallet not funded");
  const junk = await referenceListing("junk", scrapeOutputSchema);
  const t = await runTask({ task: "From page 1 of books.toscrape.com, find the cheapest book.", budget: "0.010", prefer_sellers: [junk.id] });
  const row = t.ledger.find((x: LedgerRow) => x.serviceId === junk.id);
  expect(r, row?.status === "paid_output_rejected", `${junk.id}: ${row?.status} (${row?.reason})`);
  if (row?.txHash) await confirmRows(r, [row]);
  const used = t.result?.books?.[0];
  expect(r, t.status === "completed" && used && used.title !== "Reference Book", `bought elsewhere and used that: ${used?.title} (served by ${t.steps?.[0]?.servedBy})`);
  const rep = await json(await fetch(`${REGISTRY}/api/services/${junk.id}`));
  expect(r, rep.reputation.successRate < 2 / 3, `${junk.id} success rate ${(rep.reputation.successRate * 100).toFixed(1)}% (below the 66.7% start)`);
});

// ---------- 8. standard client ----------
await check("standard", "Standard client: a stock x402 v2 buyer pays our seller; our buyer pays a stock x402 v2 seller", async (r) => {
  if (!funded) return skip(r, "buyer wallet not funded");
  const fx = (await json(await fetch(`${REGISTRY}/api/services/fx-rates`))) as Listing;
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  const res = await wrapFetchWithPayment(fetch, client)(`${fx.endpoint}?from=GBP&to=EUR`);
  const header = res.headers.get("PAYMENT-RESPONSE");
  const settle = header ? decodePaymentResponseHeader(header) : null;
  expect(r, res.status === 200 && settle?.success === true, `@x402/fetch -> fx-rates: HTTP ${res.status}  ${settle ? txUrl(settle.transaction) : ""}`);
  if (settle?.transaction) {
    const c = await confirmTransfer(settle.transaction as Hex, { from: account.address, to: fx.payTo, amount: BigInt(fx.priceUnits) }, { wait: true });
    expect(r, c.confirmed, "exact amount moved buyer -> fx-rates payTo");
  }
  const honest = await referenceListing("honest", { type: "object", required: ["books"], properties: { books: { type: "array" } } });
  const t = await runTask({ task: "From page 1 of books.toscrape.com, find the cheapest book.", budget: "0.010", only_sellers: [honest.id] });
  const row = t.ledger.find((x: LedgerRow) => x.serviceId === honest.id);
  expect(r, row?.status === "paid", `our buyer -> stock @x402/express seller: ${row?.status}`);
  if (row?.txHash) await confirmRows(r, [row]);
});

// ---------- 9. key hygiene ----------
await check("hygiene", "Key hygiene: no private key or API secret in the repo, its history, the web bundle or the logs", async (r) => {
  const logFiles = (env("JUDGE_LOG_FILES") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = scanHygiene({ logFiles });
  r.notes.push(`gitleaks: ${h.gitleaks}; scanned ${h.scanned.historyCommits} commits, ${h.scanned.files} files, ${h.scanned.bundleFiles} bundle files, ${h.scanned.logFiles} log files`);
  for (const f of h.findings) r.notes.push(`BAD  ${f.where}: ${f.what}`);
  expect(r, h.ok, h.ok ? "no secrets found" : `${h.findings.length} finding(s)`);
});

// ---------- cleanup + report ----------
for (const s of references) s.close();
if (!keep && adminToken) {
  for (const id of registered) await fetch(`${REGISTRY}/api/services/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${adminToken}` } }).catch(() => {});
}

const counts = { PASS: 0, FAIL: 0, SKIP: 0 } as Record<Status, number>;
for (const r of results) counts[r.status]++;
console.log(`\n${"=".repeat(72)}`);
for (const r of results) console.log(`${r.status.padEnd(5)} ${r.id.padEnd(10)} ${r.title}`);
console.log(`${"=".repeat(72)}\n${counts.PASS} passed, ${counts.FAIL} failed, ${counts.SKIP} skipped`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = `${REPO_ROOT}.data/judge`;
mkdirSync(dir, { recursive: true });
const md = [
  `# Judge pack report (${new Date().toISOString()})`,
  "",
  `Buyer \`${account.address}\` · registry ${REGISTRY} · buyer agent ${BUYER_API} · ${fromUnits(balance)} USDC at start`,
  "",
  "| Check | Result |",
  "|---|---|",
  ...results.map((r) => `| ${r.title} | **${r.status}** |`),
  "",
  ...results.flatMap((r) => [`## ${r.status} · ${r.title}`, "", ...r.notes.map((n) => `- ${n}`), ""]),
].join("\n");
writeFileSync(`${dir}/report-${stamp}.md`, md);
console.log(`report: .data/judge/report-${stamp}.md`);
process.exit(counts.FAIL ? 1 : 0);

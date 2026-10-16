// Make paid calls through the buyer's payment core (price check, budget, signing guard, ledger).
//
//   npm run buy -- <serviceId> [json-input] [--budget 0.01] [--repeat 4] [--concurrency 5] [--no-wait]
//
// Examples:
//   npm run buy -- fx-rates '{"from":"GBP","to":"INR"}'
//   npm run buy -- shelf-scraper '{"page":2}'
//   npm run buy -- cheap-scraper-overprice '{"page":1}'               # refused, nothing signed
//   npm run buy -- shelf-scraper '{"page":1}' --budget 0.012 --repeat 4 --concurrency 5
//
// Every attempt is reported (signed) to the registry ledger and appended to .data/ledger/<session>.jsonl.

import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { REPO_ROOT, env, fromUnits, loadEnv, requireEnv, toUnits, type LedgerRow, type Listing } from "@dron/shared";
import { Budget, Buyer, JsonlLedger, MemoryLedger, RegistryLedgerSink, assertTestnet, currentBlock, type CallOutcome } from "@dron/x402-kit";

loadEnv();
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, v && !v.startsWith("--") ? 2 : 1);
  return v && !v.startsWith("--") ? v : "true";
};
const budgetArg = flag("budget");
const repeat = Number(flag("repeat") ?? 1);
const concurrency = Math.max(1, Number(flag("concurrency") ?? 1));
const noWait = flag("no-wait") !== undefined;
const registry = flag("registry") ?? env("REGISTRY_URL", "http://localhost:4000")!;
const [serviceId, inputJson] = args;

if (!serviceId) {
  console.error("usage: npm run buy -- <serviceId> [json-input] [--budget 0.01] [--repeat N] [--concurrency C] [--no-wait]");
  process.exit(64);
}
const input = inputJson ? (JSON.parse(inputJson) as Record<string, unknown>) : {};

await assertTestnet();
const res = await fetch(`${registry}/api/services/${encodeURIComponent(serviceId)}`);
if (!res.ok) {
  console.error(`service "${serviceId}" not found in the registry at ${registry} (${res.status})`);
  process.exit(1);
}
const listing = (await res.json()) as Listing;

const account = privateKeyToAccount(requireEnv("BUYER_PRIVATE_KEY") as Hex);
const sessionId = `ses_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;
const memory = new MemoryLedger();
const sink = new RegistryLedgerSink(registry, account);
const buyer = new Buyer({
  account,
  sessionId,
  ledger: [memory, new JsonlLedger(`${REPO_ROOT}.data/ledger/${sessionId}.jsonl`), sink],
});
await sink.startSession({ id: sessionId, buyer: account.address, startBlock: Number(await currentBlock()), createdAt: new Date().toISOString() });

const budget = new Budget(budgetArg ? toUnits(budgetArg) : BigInt(listing.priceUnits) * BigInt(repeat));
console.log(`\nbuyer    ${account.address}`);
console.log(`service  ${listing.id} (${listing.category}) ${listing.method} ${listing.endpoint}`);
console.log(`listed   ${fromUnits(BigInt(listing.priceUnits))} USDC (${listing.priceUnits} units) -> payTo ${listing.payTo}`);
console.log(`budget   ${fromUnits(budget.total)} USDC, ${repeat} call(s), concurrency ${concurrency}, session ${sessionId}\n`);

const line = (n: number, row: LedgerRow) => {
  const money = row.status === "refused" ? `asked ${row.askedUnits ?? "?"}` : `paid ${row.paidUnits}`;
  const tx = row.explorerUrl ? `  ${row.explorerUrl}` : "";
  console.log(`#${String(n).padEnd(3)} ${row.status.padEnd(21)} ${money.padEnd(14)} ${String(row.latencyMs).padStart(6)} ms  ${row.reason ?? ""}${tx}`);
};

const outcomes: CallOutcome[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, repeat) }, async () => {
    while (next < repeat) {
      const n = ++next;
      const out = await buyer.payAndCall({ listing, input, budget, taskId: "cli" });
      outcomes.push(out);
      line(n, out.row);
      if (out.output !== undefined && repeat === 1) console.log(JSON.stringify(out.output, null, 2).slice(0, 1500));
    }
  }),
);

console.log(`\nbudget   ${budget.describe()}`);
// Only rows that signed something have anything to settle on-chain (refusals never signed).
const open = outcomes.filter((o) => o.row.status === "pending" || (o.row.nonce !== null && o.row.onchainConfirmed === null));
if (!noWait && open.length) {
  console.log(`\nwaiting for on-chain finality of ${open.length} row(s) (receipts, or expiry of unsettled authorisations; up to ~75 s)...`);
  const finals = await Promise.all(outcomes.map((o) => o.finalized));
  finals.forEach((row, i) => line(i + 1, row));
}
await buyer.drain();

const paid = memory.paidUnits();
console.log(`\ntotal paid ${fromUnits(paid)} USDC (${paid} units) in ${memory.all().filter((r) => BigInt(r.paidUnits) > 0n).length} transaction(s)`);
console.log(`budget     ${budget.describe()}`);
console.log(`ledger     ${registry}/api/ledger?sessionId=${sessionId}`);

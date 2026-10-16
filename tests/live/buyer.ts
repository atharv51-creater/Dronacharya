// Live judged-test rehearsal for the buyer's payment core, on Base Sepolia (needs a funded buyer and
// `npm start`). Costs about 0.03 testnet USDC.
//
//   Happy path       fx-rates paid; the receipt shows exactly 1000 units buyer -> payTo
//   Price check      overpriced 402 and wrong-payTo 402 refused; nothing signed, nothing paid
//   Junk output      paid, output rejected; the money moved, the output is not used
//   Seller failure   failed and not charged; authorisation proven unused after it expires
//   Budget           0.012 USDC for 4 x 0.005 at concurrency 1 and 5: 2 paid, 2 refused, never over
//   Reconciliation   buyer wallet balance drop == ledger paid total, to the unit; registry agrees
//
//   npm run test:buyer

import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { REPO_ROOT, env, fromUnits, loadEnv, requireEnv, type Listing } from "@dron/shared";
import { Budget, Buyer, JsonlLedger, MemoryLedger, RegistryLedgerSink, assertTestnet, currentBlock, usdcBalance } from "@dron/x402-kit";
import { check, finish } from "./lib.ts";

loadEnv();
await assertTestnet();
const registry = env("REGISTRY_URL", "http://localhost:4000")!;
const account = privateKeyToAccount(requireEnv("BUYER_PRIVATE_KEY") as Hex);
const startBalance = await usdcBalance(account.address);
console.log(`buyer ${account.address} holds ${fromUnits(startBalance)} USDC`);
if (startBalance < 40_000n) {
  console.error("needs at least 0.04 testnet USDC: fund it at https://faucet.circle.com (Base Sepolia)");
  process.exit(2);
}

const listing = async (id: string) => (await (await fetch(`${registry}/api/services/${id}`)).json()) as Listing;
const sessionId = `ses_live_${Date.now().toString(36)}`;
const memory = new MemoryLedger();
const sink = new RegistryLedgerSink(registry, account);
const buyer = new Buyer({ account, sessionId, ledger: [memory, sink, new JsonlLedger(`${REPO_ROOT}.data/ledger/${sessionId}.jsonl`)] });
await sink.startSession({ id: sessionId, buyer: account.address, startBlock: Number(await currentBlock()), createdAt: new Date().toISOString() });

console.log("\nHappy path: fx-rates GBP -> INR");
{
  const out = await buyer.payAndCall({ listing: await listing("fx-rates"), input: { from: "GBP", to: "INR" }, budget: new Budget(1000n) });
  check(out.row.status === "paid", "paid", out.row.reason ?? out.row.explorerUrl);
  check(typeof (out.output as { rate?: unknown })?.rate === "number", "output validated and returned", out.output);
  const final = await out.finalized;
  check(final.onchainConfirmed === true, "receipt shows exactly 1000 units buyer -> payTo", final.explorerUrl);
}

console.log("\nPrice check: fixtures whose 402 disagrees with their listing");
for (const id of ["cheap-scraper-overprice", "cheap-scraper-wrong-payto"]) {
  const budget = new Budget(100_000n);
  const out = await buyer.payAndCall({ listing: await listing(id), input: { page: 1 }, budget });
  check(out.row.status === "refused" && out.row.paidUnits === "0" && out.row.nonce === null, `${id}: refused, nothing signed`, out.row.reason);
  check(budget.spent + budget.reserved === 0n, `${id}: budget untouched`);
}

console.log("\nJunk output: cheap-scraper-junk");
{
  const out = await buyer.payAndCall({ listing: await listing("cheap-scraper-junk"), input: { page: 1 }, budget: new Budget(2000n) });
  check(out.row.status === "paid_output_rejected", "recorded as paid, output rejected", out.row.reason);
  check(out.output === undefined, "the junk is not handed to the caller");
  check((await out.finalized).onchainConfirmed === true, "the 2000-unit transfer is on-chain", out.row.explorerUrl);
}

console.log("\nSeller failure: cheap-scraper-fail (waits for the authorisation to expire, about 75 s)");
{
  const budget = new Budget(2000n);
  const out = await buyer.payAndCall({ listing: await listing("cheap-scraper-fail"), input: { page: 1 }, budget });
  check(out.row.status === "failed_not_charged", "failed and not charged", out.row.reason);
  check(budget.reserved === 2000n, "reservation held while the seller still holds a valid signature");
  const final = await out.finalized;
  check(final.status === "failed_not_charged" && final.onchainConfirmed === true, "authorisation expired unused (checked on-chain)", final.reason);
  check(budget.reserved === 0n && budget.spent === 0n, "reservation released, nothing spent");
}

for (const concurrency of [1, 5]) {
  console.log(`\nBudget: 0.012 USDC for 4 x shelf-scraper (0.005 each) at concurrency ${concurrency}`);
  const shelf = await listing("shelf-scraper");
  const budget = new Budget(12_000n);
  let peak = 0n;
  budget.onChange((_e, s) => {
    if (s.spent + s.reserved > peak) peak = s.spent + s.reserved;
  });
  const pages = [1, 2, 3, 4];
  const rows = [];
  for (let i = 0; i < pages.length; i += concurrency) {
    const batch = pages.slice(i, i + concurrency).map((page) => buyer.payAndCall({ listing: shelf, input: { page }, budget, taskId: `budget-c${concurrency}` }));
    rows.push(...(await Promise.all(batch)).map((o) => o.row));
  }
  const paid = rows.filter((r) => r.status === "paid");
  const refused = rows.filter((r) => r.status === "refused" && r.reasonCode === "budget");
  check(paid.length === 2 && refused.length === 2, "2 paid, 2 refused for budget", rows.map((r) => r.status));
  check(peak <= 12_000n && budget.spent <= 12_000n, `spend never passed 0.012 (peak ${fromUnits(peak)})`);
  console.log(`  reason given: ${refused[0]?.reason}`);
}

await buyer.drain();
console.log("\nReconciliation");
const endBalance = await usdcBalance(account.address);
const ledgerPaid = memory.paidUnits();
check(startBalance - endBalance === ledgerPaid, `wallet dropped by exactly the ledger total (${ledgerPaid} units)`, { start: String(startBalance), end: String(endBalance) });
const session = (await (await fetch(`${registry}/api/sessions/${sessionId}`)).json()) as { totals: { paidUnits: string } };
check(session.totals.paidUnits === ledgerPaid.toString(), "registry ledger agrees to the unit", session.totals);
console.log(`  ${registry}/api/ledger?sessionId=${sessionId}`);

finish();

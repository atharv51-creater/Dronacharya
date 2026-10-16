// Prints USDC and ETH balances for every configured wallet (public data only).

import { formatEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addressUrl, env, fromUnits, loadEnv, type Address } from "@dron/shared";
import { assertTestnet, ethBalance, usdcBalance } from "@dron/x402-kit";

loadEnv();
await assertTestnet();

const wallets: [string, Address][] = [];
for (const name of ["BUYER_PRIVATE_KEY", "BUYER_SPARE_PRIVATE_KEY"]) {
  const key = env(name);
  if (key) wallets.push([name.replace("_PRIVATE_KEY", ""), privateKeyToAccount(key as Hex).address]);
}
for (const name of ["SCRAPER_PAY_TO", "DATA_PAY_TO", "INFERENCE_PAY_TO", "CHAOS_PAY_TO", "CHAOS_ALT_PAY_TO"]) {
  const address = env(name);
  if (address) wallets.push([name, address as Address]);
}
if (wallets.length === 0) {
  console.log("No wallets configured. Run: npm run wallets:new");
  process.exit(0);
}

const rows = await Promise.all(
  wallets.map(async ([label, address]) => {
    const [usdc, eth] = await Promise.all([usdcBalance(address), ethBalance(address)]);
    return { label, address, usdc, eth };
  }),
);
for (const r of rows) {
  console.log(
    `${r.label.padEnd(18)} ${r.address}  ${fromUnits(r.usdc).padStart(10)} USDC  ${Number(formatEther(r.eth)).toFixed(5).padStart(9)} ETH  ${addressUrl(r.address)}`,
  );
}

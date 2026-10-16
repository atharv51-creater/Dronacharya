// Creates fresh TESTNET wallets and writes them into .env (created from .env.example if missing).
// Only empty values are filled; existing ones are never overwritten. Private keys are never printed:
// this script prints public addresses only.
//
// - Buyer keys go into .env (the buyer is the only service that signs).
// - Seller payTo addresses go into .env as public addresses. Their private keys go to
//   .secrets/seller-keys.json (git-ignored, mode 600) so testnet funds can be swept back later;
//   no service ever loads that file.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { REPO_ROOT, addressUrl } from "@dron/shared";

const envPath = `${REPO_ROOT}.env`;
const secretsDir = `${REPO_ROOT}.secrets`;
const sellerKeysPath = `${secretsDir}/seller-keys.json`;

const PAY_TO_VARS = ["SCRAPER_PAY_TO", "DATA_PAY_TO", "INFERENCE_PAY_TO", "CHAOS_PAY_TO", "CHAOS_ALT_PAY_TO"] as const;
const BUYER_VARS = ["BUYER_PRIVATE_KEY", "BUYER_SPARE_PRIVATE_KEY"] as const;

if (!existsSync(envPath)) {
  writeFileSync(envPath, readFileSync(`${REPO_ROOT}.env.example`, "utf8"), { mode: 0o600 });
  console.log("created .env from .env.example");
}

const lines = readFileSync(envPath, "utf8").split("\n");
const current = new Map<string, string>();
for (const line of lines) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m) current.set(m[1]!, m[2]!.trim());
}

const updates = new Map<string, string>();
const sellerKeys: Record<string, { address: string; privateKey: string }> = existsSync(sellerKeysPath)
  ? JSON.parse(readFileSync(sellerKeysPath, "utf8"))
  : {};

for (const name of BUYER_VARS) {
  if (!current.get(name)) updates.set(name, generatePrivateKey());
}
for (const name of PAY_TO_VARS) {
  if (!current.get(name)) {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    updates.set(name, address);
    sellerKeys[name] = { address, privateKey: key };
  }
}
if (!current.get("REGISTRY_ADMIN_TOKEN")) updates.set("REGISTRY_ADMIN_TOKEN", randomBytes(32).toString("hex"));
if (!current.get("BUYER_API_TOKEN")) updates.set("BUYER_API_TOKEN", randomBytes(24).toString("base64url"));

if (updates.size > 0) {
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (m && updates.has(m[1]!)) {
      seen.add(m[1]!);
      return `${m[1]}=${updates.get(m[1]!)}`;
    }
    return line;
  });
  for (const [k, v] of updates) if (!seen.has(k)) out.push(`${k}=${v}`);
  writeFileSync(envPath, out.join("\n"), { mode: 0o600 });
  chmodSync(envPath, 0o600);

  if (Object.keys(sellerKeys).length) {
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    writeFileSync(sellerKeysPath, JSON.stringify(sellerKeys, null, 2) + "\n", { mode: 0o600 });
    chmodSync(sellerKeysPath, 0o600);
  }
}

const finalEnv = new Map(current);
for (const [k, v] of updates) finalEnv.set(k, v);

const filled = [...updates.keys()];
console.log(filled.length ? `filled: ${filled.join(", ")}` : "nothing to do: every wallet is already set");
console.log("\nTestnet wallets (Base Sepolia). Public addresses only:\n");
for (const name of BUYER_VARS) {
  const key = finalEnv.get(name);
  if (key) {
    const address = privateKeyToAccount(key as `0x${string}`).address;
    console.log(`  ${name.replace("_PRIVATE_KEY", "").padEnd(18)} ${address}  ${addressUrl(address)}`);
  }
}
for (const name of PAY_TO_VARS) {
  const address = finalEnv.get(name);
  if (address) console.log(`  ${name.padEnd(18)} ${address}`);
}
console.log(`
Next: fund the BUYER address with testnet USDC at https://faucet.circle.com (choose Base Sepolia).
The buyer needs no ETH: the facilitator pays gas. Then run: npm run wallets:balances`);

// Ledger vs chain, to the last unit, for one buyer session (asks the registry, which scans Base Sepolia).
//
//   npm run reconcile -- <sessionId>
//   npm run reconcile                 # the most recent session
//
// Exit code 0 when ledger and chain agree, 1 when they do not.

import { env, fromUnits, loadEnv } from "@dron/shared";
import type { ReconcileReport } from "@dron/x402-kit";

loadEnv();
const registry = env("REGISTRY_URL", "http://localhost:4000")!.replace(/\/+$/, "");
let sessionId = process.argv[2];
if (!sessionId) {
  const { sessions } = (await (await fetch(`${registry}/api/sessions`)).json()) as { sessions: { id: string }[] };
  sessionId = sessions[0]?.id;
  if (!sessionId) {
    console.error("no sessions in the registry yet");
    process.exit(1);
  }
}

const res = await fetch(`${registry}/api/ledger/reconcile?sessionId=${encodeURIComponent(sessionId)}`);
const body = (await res.json()) as ReconcileReport & { message?: string };
if (!res.ok) {
  console.error(`reconciliation failed: ${body.message ?? res.status}`);
  process.exit(1);
}
console.log(`\nsession  ${sessionId}\nbuyer    ${body.buyer}\nblocks   ${body.fromBlock} to ${body.toBlock}`);
console.log(`ledger   ${fromUnits(BigInt(body.ledger.paidUnits))} USDC in ${body.ledger.paidRows} paid rows (${body.ledger.confirmedRows} receipts checked, ${body.ledger.pendingRows} pending)`);
console.log(`chain    ${fromUnits(BigInt(body.chain.units))} USDC in ${body.chain.transfers} transfers out of the wallet`);
if (body.session) console.log(`session  ${fromUnits(BigInt(body.session.paidUnits))} USDC in ${body.session.rows} rows of this session`);
for (const i of body.issues) console.log(`  ${i.kind.padEnd(18)} ${i.detail}${i.explorerUrl ? `  ${i.explorerUrl}` : ""}`);
console.log(`\n${body.ok ? "OK" : "MISMATCH"}: ${body.summary}`);
process.exit(body.ok ? 0 : 1);

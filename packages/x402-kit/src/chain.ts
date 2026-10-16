// Read-only chain access (no keys). Used to refuse non-testnet RPCs, check EIP-3009 nonce state,
// and confirm that a settlement moved exactly the expected USDC from the buyer to the payTo.

import { createPublicClient, erc20Abi, getAddress, http, parseAbi, parseAbiItem, parseEventLogs, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { CHAIN_ID, DEFAULT_RPC_URL, NETWORK, USDC_ADDRESS, env, envInt, type Address } from "@dron/shared";

const eip3009Abi = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

let client: ReturnType<typeof makeClient> | undefined;

function makeClient() {
  return createPublicClient({ chain: baseSepolia, transport: http(env("RPC_URL", DEFAULT_RPC_URL), { retryCount: 2, timeout: 15_000 }) });
}

export function publicClient() {
  client ??= makeClient();
  return client;
}

/** Exits the process unless we are provably on Base Sepolia. Call before serving anything. */
export async function assertTestnet(): Promise<void> {
  if (NETWORK !== "eip155:84532") throw new Error("network constant is not Base Sepolia");
  const chainId = await publicClient().getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(`RPC_URL reports chain id ${chainId}; this project only runs on Base Sepolia (${CHAIN_ID}). Refusing to start.`);
  }
}

export async function usdcBalance(address: Address): Promise<bigint> {
  return publicClient().readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] });
}

export async function ethBalance(address: Address): Promise<bigint> {
  return publicClient().getBalance({ address });
}

/** True once an EIP-3009 authorisation (authorizer, nonce) has been used on-chain. */
export async function authorizationUsed(authorizer: Address, nonce: Hex): Promise<boolean> {
  return publicClient().readContract({ address: USDC_ADDRESS, abi: eip3009Abi, functionName: "authorizationState", args: [authorizer, nonce] });
}

const authorizationUsedEvent = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** Largest block span per eth_getLogs call. Base Sepolia's public RPC allows 200; a paid RPC allows more. */
export const logsMaxRange = () => BigInt(Math.max(1, envInt("RPC_LOGS_MAX_RANGE", 200)));

/** Splits [from, to] into windows the RPC accepts. */
export function blockWindows(from: bigint, to: bigint, size = logsMaxRange()): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let start = from; start <= to; start += size) out.push([start, start + size - 1n < to ? start + size - 1n : to]);
  return out;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 300 * 2 ** i));
    }
  }
}

/** Runs `fn` over every window with bounded parallelism, preserving window order in the result. */
async function scanWindows<T>(windows: [bigint, bigint][], fn: (from: bigint, to: bigint) => Promise<T[]>, concurrency = 4): Promise<T[]> {
  const results: T[][] = new Array(windows.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, windows.length) }, async () => {
      while (next < windows.length) {
        const i = next++;
        const [from, to] = windows[i]!;
        results[i] = await withRetry(() => fn(from, to));
      }
    }),
  );
  return results.flat();
}

export interface UsdcTransfer {
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  from: Address;
  to: Address;
  value: bigint;
}

/** Every USDC transfer out of `from` in [fromBlock, toBlock], scanned in RPC-sized windows. */
export async function transfersFrom(from: Address, fromBlock: bigint, toBlock: bigint): Promise<UsdcTransfer[]> {
  const pc = publicClient();
  const logs = await scanWindows(blockWindows(fromBlock, toBlock), (a, b) =>
    pc.getLogs({ address: USDC_ADDRESS, event: transferEvent, args: { from }, fromBlock: a, toBlock: b }),
  );
  return logs.map((l) => ({
    txHash: l.transactionHash,
    blockNumber: l.blockNumber,
    logIndex: l.logIndex,
    from: getAddress(l.args.from!),
    to: getAddress(l.args.to!),
    value: l.args.value!,
  }));
}

/**
 * Finds the transaction that used an authorisation, from USDC's AuthorizationUsed event, newest blocks
 * first. Recovers the tx hash when a seller settled but never sent a PAYMENT-RESPONSE.
 */
export async function findAuthorizationTx(authorizer: Address, nonce: Hex, lookbackBlocks = 1800n): Promise<Hex | null> {
  const pc = publicClient();
  const latest = await pc.getBlockNumber();
  const from = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;
  const windows = blockWindows(from, latest).reverse();
  for (let i = 0; i < windows.length; i += 3) {
    const batch = windows.slice(i, i + 3);
    const found = await Promise.all(
      batch.map(([a, b]) => withRetry(() => pc.getLogs({ address: USDC_ADDRESS, event: authorizationUsedEvent, args: { authorizer, nonce }, fromBlock: a, toBlock: b }))),
    );
    const hit = found.flat()[0];
    if (hit) return hit.transactionHash;
  }
  return null;
}

export async function currentBlock(): Promise<bigint> {
  return publicClient().getBlockNumber();
}

export interface TransferCheck {
  confirmed: boolean;
  /** Matching USDC Transfer logs in the receipt (should be exactly one). */
  transfers: { from: Address; to: Address; value: bigint }[];
  status: "success" | "reverted" | "not_found";
  blockNumber?: bigint;
}

/**
 * Confirms a settlement on-chain: the receipt succeeded and contains a USDC Transfer
 * of exactly `amount` from `from` to `to`.
 */
export async function confirmTransfer(
  txHash: Hex,
  expect: { from: Address; to: Address; amount: bigint },
  opts: { wait?: boolean } = {},
): Promise<TransferCheck> {
  const pc = publicClient();
  let receipt;
  try {
    receipt = opts.wait
      ? await pc.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 })
      : await pc.getTransactionReceipt({ hash: txHash });
  } catch {
    return { confirmed: false, transfers: [], status: "not_found" };
  }
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs })
    .filter((log) => getAddress(log.address) === USDC_ADDRESS)
    .map((log) => ({ from: getAddress(log.args.from), to: getAddress(log.args.to), value: log.args.value }));
  const match = transfers.filter(
    (t) => t.from === getAddress(expect.from) && t.to === getAddress(expect.to) && t.value === expect.amount,
  );
  return {
    confirmed: receipt.status === "success" && match.length === 1,
    transfers,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
  };
}

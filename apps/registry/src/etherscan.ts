// Etherscan V2 (one API key for every chain; here chainid 84532 = Base Sepolia). Server-side only: the key
// never leaves the registry. Two uses:
//
//  1. etherscanChainSource(): a ChainSource for reconciliation. Etherscan returns a wallet's USDC Transfer
//     logs for any block range in a few calls, where the public RPC allows 200 blocks per eth_getLogs.
//     Blocks near the head (RECENT_BLOCKS) still come from the RPC, because Etherscan indexes a little
//     behind, and on any Etherscan error the whole range falls back to the RPC. The comparison logic in
//     x402-kit is untouched: it receives the same UsdcTransfer[] either way.
//  2. EtherscanHistory: recent USDC transfers in and out of a wallet, for the Wallets page.

import { getAddress, pad, type Address, type Hex } from "viem";
import { CHAIN_ID, USDC_ADDRESS, fromUnits, txUrl, type Logger } from "@dron/shared";
import { currentBlock as rpcCurrentBlock, transfersFrom as rpcTransfersFrom, type ChainSource, type UsdcTransfer } from "@dron/x402-kit";

const API = "https://api.etherscan.io/v2/api";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAGE = 1000; // Etherscan's maximum records per page
const MAX_PAGES = 10; // page * offset may not exceed 10,000
/** Blocks this close to the head are read from the RPC (Etherscan may not have indexed them yet). */
export const RECENT_BLOCKS = 100n;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class EtherscanError extends Error {}

/** One Etherscan call. "No records found" is an empty list, not an error. */
async function call<T>(apiKey: string, params: Record<string, string>, fetchImpl: Fetch): Promise<T[]> {
  const url = `${API}?${new URLSearchParams({ chainid: String(CHAIN_ID), ...params, apikey: apiKey })}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new EtherscanError(`etherscan unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) throw new EtherscanError(`etherscan HTTP ${res.status}`);
  const body = (await res.json()) as { status?: string; message?: string; result?: unknown };
  if (body.status === "1" && Array.isArray(body.result)) return body.result as T[];
  if (body.status === "0" && /no (records|transactions) found/i.test(body.message ?? "")) return [];
  // Never echo the URL: it carries the key.
  throw new EtherscanError(`etherscan: ${body.message ?? "error"}${typeof body.result === "string" ? ` (${body.result.slice(0, 120)})` : ""}`);
}

interface EtherscanLog {
  transactionHash: Hex;
  blockNumber: Hex;
  logIndex: Hex;
  topics: Hex[];
  data: Hex;
}

const big = (h: string) => BigInt(h === "0x" ? 0 : h);
const topicAddress = (t: Hex) => getAddress(`0x${t.slice(-40)}`);

/** Every USDC Transfer out of `from` in [fromBlock, toBlock], via Etherscan's getLogs (paginated, split when large). */
export async function etherscanTransfersFrom(apiKey: string, from: Address, fromBlock: bigint, toBlock: bigint, fetchImpl: Fetch = fetch): Promise<UsdcTransfer[]> {
  if (fromBlock > toBlock) return [];
  const out: UsdcTransfer[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const logs = await call<EtherscanLog>(
      apiKey,
      {
        module: "logs",
        action: "getLogs",
        address: USDC_ADDRESS,
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
        topic0: TRANSFER_TOPIC,
        topic0_1_opr: "and",
        topic1: pad(from.toLowerCase() as Hex, { size: 32 }),
        page: String(page),
        offset: String(PAGE),
      },
      fetchImpl,
    );
    for (const l of logs) {
      if (l.topics.length < 3 || l.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
      out.push({ txHash: l.transactionHash, blockNumber: big(l.blockNumber), logIndex: Number(big(l.logIndex)), from: topicAddress(l.topics[1]!), to: topicAddress(l.topics[2]!), value: big(l.data) });
    }
    if (logs.length < PAGE) return dedupe(out);
  }
  // More than 10,000 transfers in the range: split it and scan the halves.
  if (fromBlock === toBlock) throw new EtherscanError("too many transfers in one block");
  const mid = (fromBlock + toBlock) / 2n;
  return dedupe([...(await etherscanTransfersFrom(apiKey, from, fromBlock, mid, fetchImpl)), ...(await etherscanTransfersFrom(apiKey, from, mid + 1n, toBlock, fetchImpl))]);
}

function dedupe(list: UsdcTransfer[]): UsdcTransfer[] {
  const seen = new Map<string, UsdcTransfer>();
  for (const t of list) seen.set(`${t.txHash.toLowerCase()}:${t.logIndex}`, t);
  return [...seen.values()].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
}

/** Reconciliation source: Etherscan for settled history, RPC for the newest blocks and as the fallback. */
export function etherscanChainSource(
  apiKey: string,
  opts: { log?: Logger; fetchImpl?: Fetch; rpc?: ChainSource } = {},
): ChainSource & { lastSource: () => "etherscan" | "rpc" | "mixed" | null } {
  const rpc = opts.rpc ?? { transfersFrom: rpcTransfersFrom, currentBlock: rpcCurrentBlock };
  let head = 0n;
  // Health of the last Etherscan attempt. Scans of only the newest blocks never touch Etherscan, so they
  // leave this alone: a reconciliation whose history came from Etherscan still reports "mixed".
  let etherscanOk: boolean | null = null;
  const currentBlock = async () => {
    head = await rpc.currentBlock();
    return head;
  };
  return {
    lastSource: () => (etherscanOk ? "mixed" : etherscanOk === false ? "rpc" : null),
    currentBlock,
    async transfersFrom(from, fromBlock, toBlock) {
      const latest = head || (await currentBlock());
      const cutoff = latest > RECENT_BLOCKS ? latest - RECENT_BLOCKS : 0n;
      if (fromBlock > cutoff) {
        return rpc.transfersFrom(from, fromBlock, toBlock);
      }
      const oldEnd = toBlock < cutoff ? toBlock : cutoff;
      try {
        const old = await etherscanTransfersFrom(apiKey, from, fromBlock, oldEnd, opts.fetchImpl);
        const recent = toBlock > oldEnd ? await rpc.transfersFrom(from, oldEnd + 1n, toBlock) : [];
        etherscanOk = true;
        return [...old, ...recent];
      } catch (err) {
        opts.log?.warn("etherscan transfer scan failed; using the RPC", { err: (err as Error).message });
        etherscanOk = false;
        return rpc.transfersFrom(from, fromBlock, toBlock);
      }
    },
  };
}

export interface WalletTransfer {
  txHash: Hex;
  explorerUrl: string;
  blockNumber: number;
  time: string;
  direction: "in" | "out" | "self";
  counterparty: Address;
  units: string;
  usdc: string;
}

interface EtherscanTokenTx {
  hash: Hex;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
}

/** Recent USDC transfers for a wallet (both directions), cached briefly to stay inside the free rate limit. */
export class EtherscanHistory {
  private readonly cache = new Map<string, { at: number; transfers: WalletTransfer[] }>();
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly ttlMs = 30_000,
  ) {}

  async recent(wallet: Address, limit = 25): Promise<WalletTransfer[]> {
    const key = `${wallet.toLowerCase()}|${limit}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.transfers;
    const rows = await call<EtherscanTokenTx>(
      this.apiKey,
      { module: "account", action: "tokentx", contractaddress: USDC_ADDRESS, address: wallet, page: "1", offset: String(limit), sort: "desc" },
      this.fetchImpl,
    );
    const me = wallet.toLowerCase();
    const transfers = rows.map((r): WalletTransfer => {
      const from = r.from.toLowerCase();
      const to = r.to.toLowerCase();
      const direction = from === me && to === me ? "self" : from === me ? "out" : "in";
      const units = BigInt(r.value);
      return {
        txHash: r.hash,
        explorerUrl: txUrl(r.hash),
        blockNumber: Number(r.blockNumber),
        time: new Date(Number(r.timeStamp) * 1000).toISOString(),
        direction,
        counterparty: getAddress(direction === "out" ? r.to : r.from),
        units: units.toString(),
        usdc: fromUnits(units),
      };
    });
    this.cache.set(key, { at: Date.now(), transfers });
    return transfers;
  }
}

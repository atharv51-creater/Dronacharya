// Fixed protocol facts. These are constants on purpose: the network is not configurable,
// so no environment variable can point this project at mainnet.

export const NETWORK = "eip155:84532" as const;
export const CHAIN_ID = 84532;

/** Circle testnet USDC on Base Sepolia (6 decimals). */
export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
export const USDC_DECIMALS = 6;
/** EIP-712 domain of the token, needed to sign EIP-3009 authorisations. */
export const USDC_EIP712 = { name: "USDC", version: "2" } as const;

/** Rule from the brief: at most 0.10 USDC per call. */
export const MAX_PRICE_UNITS = 100_000n;

export const EXPLORER_URL = "https://sepolia.basescan.org";
export const DEFAULT_RPC_URL = "https://sepolia.base.org";
export const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";

/** How long a signed authorisation stays valid. Sellers must finish (handler + settle) well inside it. */
export const MAX_TIMEOUT_SECONDS = 60;

export const CATEGORIES = ["data", "inference", "scraping"] as const;

export const txUrl = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const addressUrl = (address: string) => `${EXPLORER_URL}/address/${address}`;

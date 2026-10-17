// The seller guild: 11 more seller agents, each its own seller (own sellerId, payTo wallet, port, listing),
// run together by one process (apps/sellers/guild). This roster is the single list the gateway, the deploy
// scripts and the wallet generator read, so adding a seller here wires it everywhere.
//
//   env prefix X  ->  X_PAY_TO (required), X_PUBLIC_URL (optional, default http://localhost:<port>)
//   port          ->  GUILD_BASE_PORT (default 4111) + position in this list
//   gateway path  ->  /<id>

export interface GuildMember {
  id: string;
  /** Env prefix: <ENV>_PAY_TO, <ENV>_PUBLIC_URL. */
  env: string;
  port: number;
  prefix: string;
}

export const GUILD_IDS = [
  ["rich-shelf", "RICH_SHELF"],
  ["book-inspector", "BOOK_INSPECTOR"],
  ["fx-global", "FX_GLOBAL"],
  ["fx-trend", "FX_TREND"],
  ["nvidia-hindi", "NVIDIA_HINDI"],
  ["openrouter-hindi", "OPENROUTER_HINDI"],
  ["indic-translator", "INDIC_TRANSLATOR"],
  ["sentiment-tagger", "SENTIMENT_TAGGER"],
  ["text-insights", "TEXT_INSIGHTS"],
  ["price-advisor", "PRICE_ADVISOR"],
  ["listing-auditor", "LISTING_AUDITOR"],
] as const;

export type GuildId = (typeof GUILD_IDS)[number][0];

export function guildRoster(basePort = 4111): GuildMember[] {
  return GUILD_IDS.map(([id, env], i) => ({ id, env, port: basePort + i, prefix: `/${id}` }));
}

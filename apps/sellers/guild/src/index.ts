// The seller guild: 11 independent seller agents in one process. Each has its own sellerId, payTo wallet
// (<ENV>_PAY_TO), port (GUILD_BASE_PORT + position) and registry listing. A seller whose wallet is not set
// is skipped with a warning, so the others still start. GUILD_SELLERS=a,b limits which ones run.

import { chatConfigured, createLogger, env, envInt, loadEnv } from "@dron/shared";
import { createSeller, startSeller, type PaidRoute } from "@dron/x402-kit";
import { getAddress, isAddress } from "viem";
import { guildRoster, type GuildId } from "./roster.ts";
import { bookInspector, richShelf } from "./members/books.ts";
import { fxGlobal, fxTrend } from "./members/fx.ts";
import { indicTranslator, nvidiaHindi, openrouterHindi, sentimentTagger } from "./members/llm.ts";
import { textInsights } from "./members/insights.ts";
import { listingAuditor, priceAdvisor } from "./members/advisors.ts";

export const ROUTES: Record<GuildId, PaidRoute> = {
  "rich-shelf": richShelf,
  "book-inspector": bookInspector,
  "fx-global": fxGlobal,
  "fx-trend": fxTrend,
  "nvidia-hindi": nvidiaHindi,
  "openrouter-hindi": openrouterHindi,
  "indic-translator": indicTranslator,
  "sentiment-tagger": sentimentTagger,
  "text-insights": textInsights,
  "price-advisor": priceAdvisor,
  "listing-auditor": listingAuditor,
};

loadEnv();
const log = createLogger("guild");
process.setMaxListeners(64); // every seller registers its own shutdown handler

if (!chatConfigured("nvidia")) log.warn("NVIDIA_API_KEY is not set: nvidia-hindi and sentiment-tagger will answer 503 (never charged)");
if (!chatConfigured("openrouter")) log.warn("OPENROUTER_API_KEY is not set: openrouter-hindi and indic-translator will answer 503; listing-auditor skips its AI review");

const only = env("GUILD_SELLERS") ? new Set(env("GUILD_SELLERS")!.split(",").map((s) => s.trim())) : null;
const started: string[] = [];
for (const member of guildRoster(envInt("GUILD_BASE_PORT", 4111))) {
  if (only && !only.has(member.id)) continue;
  const payTo = env(`${member.env}_PAY_TO`);
  if (!payTo || !isAddress(payTo, { strict: false })) {
    log.warn(`${member.id}: ${member.env}_PAY_TO is not set; skipped (run npm run wallets:new)`);
    continue;
  }
  const seller = createSeller({
    sellerId: member.id,
    publicUrl: env(`${member.env}_PUBLIC_URL`, `http://localhost:${member.port}`)!,
    payTo: getAddress(payTo),
    log: createLogger(member.id),
    routes: [ROUTES[member.id as GuildId]],
  });
  await startSeller(seller, { port: member.port, registryUrl: env("REGISTRY_URL"), registryAdminToken: env("REGISTRY_ADMIN_TOKEN") });
  started.push(`${member.id}:${member.port}`);
}
log.info(`guild running ${started.length} seller(s)`, { sellers: started });

// Registry HTTP API + marketplace page.
//
//   GET    /api/meta                         public chain/asset config for clients
//   GET    /api/services                     search: category, maxPrice, maxPriceUnits, minSuccessRate, q, sort, includeFixtures
//   GET    /api/services/:id                 one listing with schemas and reputation
//   POST   /api/services                     register (insert-only; admin token may update and mark fixtures)
//   DELETE /api/services/:id                 admin only
//   GET    /api/sellers/:sellerId/reputation per-seller aggregate + per-service breakdown
//   GET    /api/ledger, /api/ledger/:id      every attempted call (sessionId, status, serviceId, limit)
//   POST   /api/ledger                       buyer reports a row, signed by its wallet (upsert along legal transitions)
//   POST   /api/sessions, GET /api/sessions/:id   buyer session (start block for reconciliation) + exact totals

import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  CATEGORIES,
  CHAIN_ID,
  DEFAULT_FACILITATOR_URL,
  EXPLORER_URL,
  MAX_PRICE_UNITS,
  NETWORK,
  USDC_ADDRESS,
  env,
  fromUnits,
  isUnitString,
  toUnits,
  type Address,
  type Database,
  type Logger,
  type Reputation,
  type ServiceView,
} from "@dron/shared";
import { ServiceStore, type ServiceRow } from "./db.ts";
import { TransferCache, usdcBalance, type ChainSource, reconcile as reconcileWallet } from "@dron/x402-kit";
import { LedgerStore } from "./ledger.ts";
import { EMPTY_REPUTATION, reputationByService } from "./reputation.ts";
import { validateListing } from "./validation.ts";

export interface RegistryOptions {
  db: Database;
  log: Logger;
  adminToken?: string;
  allowLoopback: boolean;
  /** Chain access for reconciliation and wallet balances (tests inject fakes). */
  chain?: ChainSource;
  balanceOf?: (address: Address) => Promise<bigint>;
}

const SORTS = ["score", "price", "latency", "successRate", "name"] as const;
type Sort = (typeof SORTS)[number];

export function createRegistryApp(opts: RegistryOptions) {
  const { db, log } = opts;
  const store = new ServiceStore(db);
  const ledger = new LedgerStore(db);
  const transfers = new TransferCache(opts.chain);
  const balanceOf = opts.balanceOf ?? usdcBalance;
  const balances = new Map<string, { at: number; units: bigint }>();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.set("json spaces", 2);
  app.use(cors);
  app.use(express.json({ limit: "128kb" }));

  const isAdmin = (req: Request) => {
    const token = opts.adminToken;
    const header = req.get("authorization") ?? "";
    if (!token || !header.startsWith("Bearer ")) return false;
    const given = Buffer.from(header.slice(7).trim());
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const view = (row: ServiceRow, reputation: Reputation | undefined): ServiceView => {
    const rep = reputation ?? EMPTY_REPUTATION;
    const price = BigInt(row.listing.priceUnits);
    return {
      ...row.listing,
      priceUsdc: fromUnits(price),
      reputation: rep,
      costPerSuccessUnits: String(Math.round(Number(price) / rep.successRate)),
      registeredBy: row.registeredBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  };

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, services: store.all().length });
  });

  app.get("/api/meta", (_req, res) => {
    res.json({
      network: NETWORK,
      chainId: CHAIN_ID,
      asset: { address: USDC_ADDRESS, symbol: "USDC", decimals: 6 },
      explorer: EXPLORER_URL,
      facilitator: env("FACILITATOR_URL", DEFAULT_FACILITATOR_URL),
      maxPriceUnits: MAX_PRICE_UNITS.toString(),
      categories: CATEGORIES,
    });
  });

  app.get("/api/services", (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const errors: string[] = [];

    const category = q.category?.trim().toLowerCase();
    if (category && !(CATEGORIES as readonly string[]).includes(category)) errors.push(`category must be one of ${CATEGORIES.join(", ")}`);

    let maxPrice: bigint | undefined;
    try {
      if (q.maxPriceUnits) {
        if (!isUnitString(q.maxPriceUnits)) throw new Error();
        maxPrice = BigInt(q.maxPriceUnits);
      } else if (q.maxPrice) {
        maxPrice = toUnits(q.maxPrice);
      }
    } catch {
      errors.push("maxPrice must be a USDC amount such as 0.005 (or maxPriceUnits such as 5000)");
    }

    const minSuccessRate = q.minSuccessRate === undefined ? undefined : Number(q.minSuccessRate);
    if (minSuccessRate !== undefined && !(minSuccessRate >= 0 && minSuccessRate <= 1)) errors.push("minSuccessRate must be between 0 and 1");

    const sort = (q.sort ?? "score") as Sort;
    if (!SORTS.includes(sort)) errors.push(`sort must be one of ${SORTS.join(", ")}`);

    if (errors.length) {
      res.status(400).json({ error: "invalid_query", details: errors });
      return;
    }

    const includeFixtures = q.includeFixtures === "true" || q.includeFixtures === "1";
    const text = q.q?.trim().toLowerCase();
    const reputation = reputationByService(db);

    const services = store
      .all()
      .filter((row) => includeFixtures || !row.listing.isFixture)
      .filter((row) => !category || row.listing.category === category)
      .filter((row) => maxPrice === undefined || BigInt(row.listing.priceUnits) <= maxPrice)
      .map((row) => view(row, reputation.get(row.listing.id)))
      .filter((s) => minSuccessRate === undefined || s.reputation.successRate >= minSuccessRate)
      .filter((s) => !text || `${s.id} ${s.name} ${s.description}`.toLowerCase().includes(text))
      .sort(comparator(sort));

    res.json({ count: services.length, services });
  });

  app.get("/api/services/:id", (req, res) => {
    const row = store.get(req.params.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(view(row, reputationByService(db).get(row.listing.id)));
  });

  app.post("/api/services", (req, res) => {
    const admin = isAdmin(req);
    // The admin (our own services, the judge pack's local reference sellers) may list loopback endpoints.
    const result = validateListing(req.body, { admin, allowLoopback: opts.allowLoopback || admin });
    if (!result.ok) {
      res.status(400).json({ error: "invalid_listing", details: result.errors });
      return;
    }
    const outcome = store.save(result.listing, admin ? "admin" : "public", admin);
    if (outcome === "conflict") {
      res.status(409).json({ error: "id_taken", message: `a service with id "${result.listing.id}" already exists; choose another id` });
      return;
    }
    log.info(`service ${outcome}`, {
      id: result.listing.id,
      by: admin ? "admin" : "public",
      priceUnits: result.listing.priceUnits,
      payTo: result.listing.payTo,
      endpoint: result.listing.endpoint,
    });
    const row = store.get(result.listing.id)!;
    res.status(outcome === "created" ? 201 : 200).json(view(row, reputationByService(db).get(row.listing.id)));
  });

  app.delete("/api/services/:id", (req, res) => {
    if (!isAdmin(req)) {
      res.status(401).json({ error: "admin_token_required" });
      return;
    }
    if (!store.delete(req.params.id)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    log.info("service deleted", { id: req.params.id });
    res.status(204).end();
  });

  app.get("/api/sellers/:sellerId/reputation", (req, res) => {
    const reputation = reputationByService(db);
    const rows = store.all().filter((r) => r.listing.sellerId === req.params.sellerId);
    if (rows.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const services = rows.map((r) => ({
      serviceId: r.listing.id,
      priceUnits: r.listing.priceUnits,
      priceUsdc: fromUnits(BigInt(r.listing.priceUnits)),
      ...(reputation.get(r.listing.id) ?? EMPTY_REPUTATION),
    }));
    const calls = services.reduce((n, s) => n + s.calls, 0);
    const successes = services.reduce((n, s) => n + s.successes, 0);
    res.json({
      sellerId: req.params.sellerId,
      calls,
      successes,
      successRate: (successes + 2) / (calls + 3),
      medianLatencyMs: weightedMedian(services),
      services,
    });
  });

  app.get("/api/ledger", (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(q.limit ?? 200) || 200, 1), 1000);
    const rows = ledger.list({ sessionId: q.sessionId, status: q.status, serviceId: q.serviceId, limit });
    res.json({ count: rows.length, rows });
  });

  // Live feed of ledger rows (new and updated) for the dashboard.
  app.get("/api/ledger/stream", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": connected\n\n");
    const unsubscribe = ledger.onChange((row) => {
      if (!sessionId || row.sessionId === sessionId) res.write(`event: row\ndata: ${JSON.stringify(row)}\n\n`);
    });
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // Ledger vs chain, to the unit, for the buyer wallet from the session's start block to now.
  app.get("/api/ledger/reconcile", async (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    const session = sessionId ? ledger.session(sessionId) : undefined;
    if (!session) {
      res.status(404).json({ error: "unknown_session", message: "pass ?sessionId= of a session the buyer reported" });
      return;
    }
    if (session.startBlock < 0) {
      res.status(409).json({ error: "no_start_block", message: "the buyer did not report this session's start block" });
      return;
    }
    try {
      const report = await reconcileWallet({
        buyer: session.buyer as Address,
        fromBlock: BigInt(session.startBlock),
        rows: ledger.forBuyer(session.buyer),
        since: session.createdAt,
        sessionId: session.id,
        cache: transfers,
      });
      log.info("reconciled", { session: session.id, ok: report.ok, ledger: report.ledger.paidUnits, chain: report.chain.units, issues: report.issues.length });
      res.json(report);
    } catch (err) {
      log.warn("reconciliation failed", { err });
      res.status(502).json({ error: "chain_unavailable", message: `could not read the chain: ${(err as Error).message.slice(0, 200)}` });
    }
  });

  app.get("/api/sessions", (_req, res) => {
    res.json({ sessions: ledger.sessions() });
  });

  // Every wallet the marketplace knows about (buyers from sessions, sellers' payTo), with USDC balances.
  app.get("/api/wallets", async (_req, res) => {
    const wallets = new Map<string, { address: string; roles: Set<string> }>();
    const add = (address: string, role: string) => {
      const key = address.toLowerCase();
      const w = wallets.get(key) ?? { address, roles: new Set<string>() };
      w.roles.add(role);
      wallets.set(key, w);
    };
    for (const s of ledger.sessions()) add(s.buyer, "buyer");
    for (const row of store.all()) add(row.listing.payTo, `payTo of ${row.listing.id}${row.listing.isFixture ? " (fixture)" : ""}`);
    const list = await Promise.all(
      [...wallets.values()].map(async (w) => {
        const key = w.address.toLowerCase();
        let cached = balances.get(key);
        if (!cached || Date.now() - cached.at > 30_000) {
          try {
            cached = { at: Date.now(), units: await balanceOf(w.address as Address) };
            balances.set(key, cached);
          } catch {
            cached = undefined;
          }
        }
        return { address: w.address, roles: [...w.roles], usdcUnits: cached ? cached.units.toString() : null, usdc: cached ? fromUnits(cached.units) : null, explorerUrl: `${EXPLORER_URL}/address/${w.address}` };
      }),
    );
    res.json({ wallets: list });
  });

  app.get("/api/ledger/:id", (req, res) => {
    const row = ledger.get(req.params.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(row);
  });

  // Buyers report every attempted call here, signed by their wallet.
  app.post("/api/ledger", async (req, res) => {
    const result = await ledger.ingest(req.body, store);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error, details: result.details });
      return;
    }
    log.info(result.created ? "ledger row" : "ledger update", {
      id: result.row.id,
      service: result.row.serviceId,
      status: result.row.status,
      paidUnits: result.row.paidUnits,
      tx: result.row.txHash,
    });
    res.status(result.created ? 201 : 200).json(result.row);
  });

  app.post("/api/sessions", async (req, res) => {
    const result = await ledger.ingestSession(req.body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json(result.session);
  });

  app.get("/api/sessions/:id", (req, res) => {
    const session = ledger.session(req.params.id);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ...session, totals: ledger.totals(session.id) });
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // Marketplace page (plain HTML/JS; the React app from apps/web replaces it later).
  app.use(express.static(fileURLToPath(new URL("../public/", import.meta.url)), { extensions: ["html"] }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status >= 500) log.error("unhandled error", { err });
    if (!res.headersSent) res.status(status).json({ error: status === 400 ? "invalid_json" : "internal_error" });
  });

  return app;
}

function comparator(sort: Sort) {
  const byScore = (a: ServiceView, b: ServiceView) => Number(a.costPerSuccessUnits) - Number(b.costPerSuccessUnits);
  const byLatency = (a: ServiceView, b: ServiceView) =>
    (a.reputation.medianLatencyMs ?? Number.MAX_SAFE_INTEGER) - (b.reputation.medianLatencyMs ?? Number.MAX_SAFE_INTEGER);
  const byPrice = (a: ServiceView, b: ServiceView) => Number(BigInt(a.priceUnits) - BigInt(b.priceUnits));
  return (a: ServiceView, b: ServiceView): number => {
    switch (sort) {
      case "price":
        return byPrice(a, b) || byScore(a, b);
      case "latency":
        return byLatency(a, b) || byScore(a, b);
      case "successRate":
        return b.reputation.successRate - a.reputation.successRate || byScore(a, b);
      case "name":
        return a.name.localeCompare(b.name);
      default:
        return byScore(a, b) || byLatency(a, b) || a.id.localeCompare(b.id);
    }
  };
}

function weightedMedian(services: { medianLatencyMs: number | null; successes: number }[]): number | null {
  const withData = services.filter((s) => s.medianLatencyMs !== null && s.successes > 0);
  if (withData.length === 0) return null;
  // Good enough for a seller summary: the median of per-service medians, weighted by successful calls.
  const expanded = withData.flatMap((s) => Array(Math.min(s.successes, 1000)).fill(s.medianLatencyMs as number));
  expanded.sort((a, b) => a - b);
  return expanded[Math.floor(expanded.length / 2)] ?? null;
}

function cors(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

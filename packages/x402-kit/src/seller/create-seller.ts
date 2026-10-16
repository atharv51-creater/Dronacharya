// The seller kit. Every paid route goes through the same pipeline, in this order:
//
//   1. input validation          400 before any 402, so nobody pays for a malformed request
//   2. replay guard              409 if this (payer, nonce) was ever seen; the handler never runs
//   3. x402 v2 middleware        402 + PAYMENT-REQUIRED, or verify with the facilitator
//   4. handler with a deadline   504 on timeout
//   5. output self-validation    500 if the result breaks our own outputSchema
//   6. settlement                the x402 middleware settles ONLY when the status is < 400, and
//                                withholds the body if settlement fails
//
// Steps 4-6 are what make "no service, no charge" true: any failure is a status >= 400, and a
// status >= 400 is never settled.

import express, { type NextFunction, type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type FacilitatorClient, type RoutesConfig } from "@x402/core/server";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  DEFAULT_FACILITATOR_URL,
  HttpError,
  MAX_PRICE_UNITS,
  MAX_TIMEOUT_SECONDS,
  NETWORK,
  REPO_ROOT,
  USDC_ADDRESS,
  USDC_EIP712,
  compileSchema,
  createLogger,
  env,
  formatErrors,
  fromUnits,
  type Address,
  type Category,
  type HttpMethod,
  type JsonSchema,
  type Listing,
  type Logger,
} from "@dron/shared";
import { basePathOf, mountAt } from "../http.ts";
import { paymentIdentity, readPaymentHeader } from "./payment-identity.ts";
import { ReplayStore } from "./replay-store.ts";

export interface HandlerContext {
  /** Aborted when the deadline passes; pass it to fetch() and SDK calls. */
  signal: AbortSignal;
  log: Logger;
  /** Address that signed the payment (public). */
  payer: string | null;
}

export interface PaidRoute<I = any, O = any> {
  /** Registry listing id, e.g. "shelf-scraper". */
  id: string;
  name: string;
  category: Category;
  description: string;
  method: HttpMethod;
  path: string;
  priceUnits: bigint;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  handler: (input: I, ctx: HandlerContext) => Promise<O>;
  /** Must leave room for settlement inside MAX_TIMEOUT_SECONDS. Default 20 s. */
  timeoutMs?: number;
  isFixture?: boolean;
  /**
   * Test fixtures only. Makes the 402 disagree with the listing (wrong price or payTo), or
   * skips output self-validation so junk gets settled. Real sellers never set this.
   */
  misbehave?: { advertisedPriceUnits?: bigint; advertisedPayTo?: Address; skipSelfValidation?: boolean };
}

export interface SellerConfig {
  sellerId: string;
  /** Public base URL, e.g. https://scraper.example.com. Listings point here. */
  publicUrl: string;
  payTo: Address;
  routes: PaidRoute[];
  /** Defaults to the HTTP facilitator at FACILITATOR_URL. Tests inject a local one. */
  facilitator?: FacilitatorClient;
  /** SQLite file for the replay store. Default .data/<sellerId>-nonces.db; ":memory:" in tests. */
  replayDbPath?: string;
  log?: Logger;
  syncFacilitatorOnStart?: boolean;
}

export interface Seller {
  app: express.Express;
  listings: Listing[];
  replayStore: ReplayStore;
  log: Logger;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function buildListing(route: PaidRoute, config: Pick<SellerConfig, "sellerId" | "publicUrl" | "payTo">): Listing {
  return {
    id: route.id,
    sellerId: config.sellerId,
    name: route.name,
    category: route.category,
    description: route.description,
    endpoint: `${config.publicUrl.replace(/\/+$/, "")}${route.path}`,
    method: route.method,
    priceUnits: route.priceUnits.toString(),
    network: NETWORK,
    asset: USDC_ADDRESS,
    payTo: config.payTo,
    inputSchema: route.inputSchema,
    outputSchema: route.outputSchema,
    ...(route.isFixture ? { isFixture: true } : {}),
  };
}

export function createSeller(config: SellerConfig): Seller {
  const log = config.log ?? createLogger(config.sellerId);
  const replayStore = new ReplayStore(config.replayDbPath ?? `${REPO_ROOT}.data/${config.sellerId}-nonces.db`);
  const facilitator =
    config.facilitator ?? new HTTPFacilitatorClient({ url: env("FACILITATOR_URL", DEFAULT_FACILITATOR_URL), timeoutMs: 45_000 });
  const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());

  for (const route of config.routes) {
    if (route.priceUnits <= 0n || route.priceUnits > MAX_PRICE_UNITS) {
      throw new Error(`${route.id}: price must be between 1 and ${MAX_PRICE_UNITS} units (0.10 USDC)`);
    }
    if ((route.timeoutMs ?? DEFAULT_TIMEOUT_MS) > (MAX_TIMEOUT_SECONDS - 15) * 1000) {
      throw new Error(`${route.id}: timeoutMs leaves no time to settle before the authorisation expires`);
    }
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback"); // so resource.url in the 402 shows the public https URL behind a tunnel
  app.use(cors);
  app.use(express.json({ limit: "64kb" }));

  const listings = config.routes.map((route) => buildListing(route, config));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, sellerId: config.sellerId, network: NETWORK, routes: config.routes.map((r) => `${r.method} ${r.path}`) });
  });
  app.get("/listing", (_req, res) => {
    res.json({ sellerId: config.sellerId, listings });
  });

  // Steps 1-2 run before the x402 middleware.
  for (const route of config.routes) {
    const verb = route.method === "GET" ? "get" : "post";
    app[verb](route.path, validateInput(route), replayGuard(route, replayStore, log));
  }

  // Step 3: standard x402 v2 middleware, so any unmodified x402 client can pay us.
  app.use(paymentMiddleware(routesConfig(config), resourceServer, undefined, undefined, config.syncFacilitatorOnStart ?? true));

  // Steps 4-5. Step 6 happens inside the x402 middleware after this responds.
  for (const route of config.routes) {
    const verb = route.method === "GET" ? "get" : "post";
    app[verb](route.path, runHandler(route, log));
  }

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status >= 500) log.error("unhandled error", { err });
    if (!res.headersSent) res.status(status).json({ error: status === 400 ? "invalid_json" : "internal_error", charged: false });
  });

  // https://host/scraper as PUBLIC_URL: serve under /scraper (behind the gateway) and at / (locally).
  return { app: mountAt(app, basePathOf(config.publicUrl)), listings, replayStore, log };
}

function routesConfig(config: SellerConfig): RoutesConfig {
  const routes: RoutesConfig = {};
  for (const route of config.routes) {
    const amount = route.misbehave?.advertisedPriceUnits ?? route.priceUnits;
    const payTo = route.misbehave?.advertisedPayTo ?? config.payTo;
    routes[`${route.method} ${route.path}`] = {
      accepts: [
        {
          scheme: "exact",
          network: NETWORK,
          payTo,
          price: { amount: amount.toString(), asset: USDC_ADDRESS, extra: { assetTransferMethod: "eip3009", ...USDC_EIP712 } },
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        },
      ],
      description: route.description,
      mimeType: "application/json",
      serviceName: route.name,
      unpaidResponseBody: async () => ({
        contentType: "application/json",
        body: {
          error: "payment_required",
          service: route.id,
          price: { units: amount.toString(), usdc: fromUnits(amount), asset: USDC_ADDRESS, network: NETWORK },
          hint: "Decode the PAYMENT-REQUIRED header (base64 JSON) and retry with a PAYMENT-SIGNATURE header.",
        },
      }),
      settlementFailedResponseBody: async (_ctx, result) => ({
        contentType: "application/json",
        body: { error: "settlement_failed", reason: result.errorReason, charged: false },
      }),
    };
  }
  return routes;
}

function validateInput(route: PaidRoute) {
  const coerce = route.method === "GET";
  const validate = compileSchema(route.inputSchema, { coerce });
  return (req: Request, res: Response, next: NextFunction) => {
    // Copy: Ajv coercion and defaults mutate the object.
    const input = coerce ? { ...(req.query as Record<string, unknown>) } : structuredClone(req.body ?? {});
    if (!validate(input)) {
      res.status(400).json({ error: "invalid_input", details: formatErrors(validate.errors), charged: false });
      return;
    }
    res.locals.input = input;
    next();
  };
}

function replayGuard(route: PaidRoute, store: ReplayStore, log: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = readPaymentHeader((name) => req.get(name));
    if (!header) return next(); // unpaid: the x402 middleware answers 402
    const identity = paymentIdentity(header);
    if (!identity) return next(); // undecodable: the x402 middleware rejects it

    if (!store.claim(identity, `${route.method} ${route.path}`)) {
      const previous = store.get(identity.key);
      log.warn("replayed payment refused", { route: route.id, payer: identity.payer, previousState: previous?.state });
      res.status(409).json({
        x402Version: 2,
        error: "payment_already_used",
        message: "This payment authorisation was already presented. Sign a new one; nothing was charged for this request.",
        charged: false,
      });
      return;
    }

    res.locals.payer = identity.payer;
    const started = performance.now();
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      const raw = res.getHeader("PAYMENT-RESPONSE");
      let tx: string | null = null;
      let settled = false;
      if (raw) {
        try {
          const settle = decodePaymentResponseHeader(String(raw));
          settled = settle.success;
          tx = settle.transaction || null;
        } catch {
          // malformed header: treat as not settled
        }
      }
      store.finish(identity.key, { state: settled ? "settled" : "failed", status: res.statusCode, txHash: tx });
      log.info(settled ? "paid call settled" : "paid call not settled (not charged)", {
        route: route.id,
        status: res.statusCode,
        payer: identity.payer,
        tx,
        ms: Math.round(performance.now() - started),
      });
    };
    res.once("finish", record);
    res.once("close", record);
    next();
  };
}

class DeadlineExceeded extends Error {}

function runHandler(route: PaidRoute, log: Logger) {
  const validateOutput = compileSchema(route.outputSchema);
  const timeoutMs = route.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (_req: Request, res: Response) => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new DeadlineExceeded(`handler exceeded ${timeoutMs} ms`));
        reject(new DeadlineExceeded());
      }, timeoutMs);
    });

    try {
      const ctx: HandlerContext = { signal: controller.signal, log, payer: (res.locals.payer as string | undefined) ?? null };
      const output = await Promise.race([route.handler(res.locals.input, ctx), deadline]);
      if (!route.misbehave?.skipSelfValidation && !validateOutput(output)) {
        const details = formatErrors(validateOutput.errors);
        log.error("output failed self-check; refusing to settle", { route: route.id, details });
        throw new HttpError(500, "output_failed_self_check", "Result did not match our own output schema", details);
      }
      res.status(200).json(output);
    } catch (err) {
      if (err instanceof DeadlineExceeded) {
        res.status(504).json({ error: "handler_timeout", message: `No result within ${timeoutMs} ms`, charged: false });
      } else if (err instanceof HttpError) {
        if (err.status >= 500) log.warn("handler failed", { route: route.id, code: err.code, message: err.message });
        res.status(err.status).json({ error: err.code, message: err.message, details: err.details, charged: false });
      } else {
        log.error("handler crashed", { route: route.id, err });
        res.status(500).json({ error: "internal_error", charged: false });
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

function cors(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

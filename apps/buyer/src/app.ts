// Buyer agent HTTP API.
//
//   POST /api/tasks                { task, budget, max_concurrency?, only_sellers?, prefer_sellers?, on_short_budget?, dry_run? }
//   GET  /api/tasks                list
//   GET  /api/tasks/:id            full state: understanding, estimate, steps, answer, explanation, ledger
//   GET  /api/tasks/:id/events     Server-Sent Events (replays history; honours Last-Event-ID)
//   POST /api/tasks/:id/topup      { amount }   the "ask for more" answer: resume with a bigger budget
//   POST /api/tasks/:id/start      run a dry-run (planned) task
//   POST /api/tasks/:id/cancel
//   GET  /api/meta                 buyer address, registry, example tasks
//
// This API spends the buyer's (testnet) money, so every POST needs `Authorization: Bearer $BUYER_API_TOKEN`
// unless it comes from this machine.

import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { EXPLORER_URL, NETWORK, type Logger } from "@dron/shared";
import { isDirectLocal } from "@dron/x402-kit";
import { EXAMPLE_TASKS } from "./examples.ts";
import { TaskInputError, type TaskManager } from "./tasks.ts";

export interface BuyerAppOptions {
  manager: TaskManager;
  log: Logger;
  apiToken?: string;
  registryUrl: string;
  allowLoopback: boolean;
}

export function createBuyerApp(o: BuyerAppOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.set("json spaces", 2);
  app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Last-Event-ID");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  const authorised = (req: Request): boolean => {
    const header = req.get("authorization") ?? "";
    if (o.apiToken && header.startsWith("Bearer ")) {
      const given = Buffer.from(header.slice(7).trim());
      const expected = Buffer.from(o.apiToken);
      if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
    }
    // Only a DIRECT request from this machine skips the token: anything that came through the gateway or a
    // tunnel (which also connect from loopback) is remote.
    return o.allowLoopback && isDirectLocal(req);
  };
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (authorised(req)) return next();
    res.status(401).json({ error: "unauthorised", message: "POST endpoints spend the buyer's funds: send Authorization: Bearer <BUYER_API_TOKEN>" });
  };
  const handle = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof TaskInputError) res.status(400).json({ error: "invalid_request", message: err.message });
      else {
        o.log.error("request failed", { err });
        res.status(500).json({ error: "internal_error" });
      }
    }
  };

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, buyer: o.manager.address });
  });

  app.get("/api/meta", (_req, res) => {
    res.json({ buyer: o.manager.address, network: NETWORK, explorer: EXPLORER_URL, registry: o.registryUrl, examples: EXAMPLE_TASKS, authRequired: Boolean(o.apiToken) });
  });

  app.get("/api/tasks", (_req, res) => {
    res.json({ tasks: o.manager.list() });
  });

  app.post("/api/tasks", requireAuth, handle((req, res) => {
    const task = o.manager.create(req.body);
    o.log.info("task created", { id: task.id, budget: task.request.budget, concurrency: task.request.max_concurrency });
    res.status(202).json({ taskId: task.id, sessionId: task.sessionId, status: task.status, events: `/api/tasks/${task.id}/events` });
  }));

  app.get("/api/tasks/:id", (req, res) => {
    const task = o.manager.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(task);
  });

  app.get("/api/tasks/:id/events", (req, res) => {
    const history = o.manager.events(req.params.id);
    if (!history) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const after = Number(req.get("last-event-id") ?? 0) || 0;
    const send = (e: { seq: number; type: string }) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    for (const e of history) if (e.seq > after) send(e);
    const unsubscribe = o.manager.subscribe(req.params.id, send);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe?.();
    });
  });

  app.post("/api/tasks/:id/topup", requireAuth, handle(async (req, res) => {
    const view = await o.manager.topUp(String(req.params.id), String((req.body as { amount?: unknown })?.amount ?? ""));
    o.log.info("task topped up", { id: view.id, budget: view.budget.totalUsdc });
    res.json(view);
  }));

  app.post("/api/tasks/:id/start", requireAuth, handle((req, res) => {
    res.json(o.manager.start(String(req.params.id)));
  }));

  app.post("/api/tasks/:id/cancel", requireAuth, handle((req, res) => {
    res.json(o.manager.cancel(String(req.params.id)));
  }));

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  app.use(express.static(fileURLToPath(new URL("../public/", import.meta.url)), { extensions: ["html"] }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (!res.headersSent) res.status(status).json({ error: status === 400 ? "invalid_json" : "internal_error" });
  });
  return app;
}

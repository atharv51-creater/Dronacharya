// The buyer agent over HTTP: auth (it spends money), the SSE stream, top-up validation, and the two
// "the buyer's own problem" paths: an empty wallet before starting, and an underfunded payment mid-task.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBuyerApp } from "../../apps/buyer/src/app.ts";
import { EXAMPLE_TASKS } from "../../apps/buyer/src/examples.ts";
import { FakeClock, manager, silent, startMarket, type Market } from "./agent-harness.ts";
import { body, listen } from "./helpers.ts";

let market: Market;
before(async () => (market = await startMarket()));
after(() => market.close());

async function serve(opts: { allowLoopback: boolean; apiToken?: string; m?: ReturnType<typeof manager> }) {
  const m = opts.m ?? manager(market);
  const app = createBuyerApp({ manager: m, log: silent, apiToken: opts.apiToken, registryUrl: market.registry, allowLoopback: opts.allowLoopback });
  const { server, base } = await listen(app);
  return { m, base, close: () => (server.closeAllConnections?.(), server.close()) };
}

const json = { "content-type": "application/json" };

describe("buyer API", () => {
  it("POST needs the API token unless loopback is trusted", async () => {
    const s = await serve({ allowLoopback: false, apiToken: "s3cret-token" });
    try {
      const req = { task: EXAMPLE_TASKS[0].task, budget: "0.050", dry_run: true };
      const anon = await fetch(`${s.base}/api/tasks`, { method: "POST", headers: json, body: JSON.stringify(req) });
      assert.equal(anon.status, 401);
      const wrong = await fetch(`${s.base}/api/tasks`, { method: "POST", headers: { ...json, authorization: "Bearer nope" }, body: JSON.stringify(req) });
      assert.equal(wrong.status, 401);
      const ok = await fetch(`${s.base}/api/tasks`, { method: "POST", headers: { ...json, authorization: "Bearer s3cret-token" }, body: JSON.stringify(req) });
      assert.equal(ok.status, 202);
      const { taskId } = await body(ok);
      await s.m.idle(taskId);
      const t = await body(await fetch(`${s.base}/api/tasks/${taskId}`));
      assert.equal(t.status, "planned");
      assert.equal(t.estimate.totalUsdc, "0.041");
    } finally {
      s.close();
    }
  });

  it("streams the task as Server-Sent Events, from creation to settlement", async () => {
    const s = await serve({ allowLoopback: true });
    try {
      const res = await fetch(`${s.base}/api/tasks`, { method: "POST", headers: json, body: JSON.stringify({ task: EXAMPLE_TASKS[1].task, budget: "0.035", max_concurrency: 5 }) });
      const { taskId } = await body(res);
      const stream = await fetch(`${s.base}/api/tasks/${taskId}/events`);
      assert.equal(stream.headers.get("content-type"), "text/event-stream");
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      const seen: string[] = [];
      let buffer = "";
      const deadline = Date.now() + 15_000;
      while (!seen.includes("settled") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const m of buffer.matchAll(/^event: (\w+)$/gm)) if (!seen.includes(m[1]!)) seen.push(m[1]!);
      }
      await reader.cancel();
      for (const type of ["task_created", "parsed", "estimate", "call_started", "call_finished", "answer", "settled"]) assert.ok(seen.includes(type), `saw ${type} (got ${seen.join(", ")})`);
    } finally {
      s.close();
    }
  });

  it("validates top-ups", async () => {
    const s = await serve({ allowLoopback: true });
    try {
      const { taskId } = await body(await fetch(`${s.base}/api/tasks`, { method: "POST", headers: json, body: JSON.stringify({ task: EXAMPLE_TASKS[0].task, budget: "0.050" }) }));
      await s.m.idle(taskId);
      const res = await fetch(`${s.base}/api/tasks/${taskId}/topup`, { method: "POST", headers: json, body: JSON.stringify({ amount: "0.01" }) });
      assert.equal(res.status, 400, "a completed task cannot be topped up");
      const bad = await fetch(`${s.base}/api/tasks`, { method: "POST", headers: json, body: JSON.stringify({ task: "x", budget: "0.01" }) });
      assert.equal(bad.status, 400);
      assert.equal((await fetch(`${s.base}/api/tasks/nope`)).status, 404);
    } finally {
      s.close();
    }
  });
});

describe("buyer agent: the buyer's own problems are reported, not blamed on sellers", () => {
  it("an empty wallet stops the task before anything is bought", async () => {
    const m = manager(market, { balanceOf: async () => 0n });
    const created = m.create({ task: EXAMPLE_TASKS[0].task, budget: "0.050" });
    await m.idle(created.id);
    const t = m.get(created.id)!;
    assert.equal(t.status, "failed");
    assert.match(t.error!, /holds 0 USDC/);
    assert.equal(t.ledger.length, 0);
  });

  it("a payment the facilitator rejects for insufficient balance halts the task; no seller is struck", async () => {
    market.facilitator.verifyResult = { isValid: false, invalidReason: "invalid_exact_evm_insufficient_balance" };
    try {
      const m = manager(market, { clock: new FakeClock() });
      const created = m.create({ task: EXAMPLE_TASKS[0].task, budget: "0.050", max_concurrency: 1 });
      await m.idle(created.id);
      const t = m.get(created.id)!;
      assert.equal(t.status, "failed");
      assert.match(t.error!, /cannot cover/);
      assert.deepEqual(t.excluded, {}, "no seller was blamed");
      assert.ok(t.ledger.every((r) => r.status === "failed_not_charged" && r.paidUnits === "0"));
      assert.equal(t.budget.spentUnits, "0");
      const rep = await body(await fetch(`${market.registry}/api/services/shelf-scraper`));
      assert.equal(rep.reputation.calls >= 0, true);
    } finally {
      market.facilitator.verifyResult = {};
    }
  });
});

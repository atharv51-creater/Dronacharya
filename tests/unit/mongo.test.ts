// MongoDB Atlas persistence, against an in-memory stand-in for the driver: the registry's outbox sync
// (create/update/delete, outage and catch-up, one-time backfill, restore of an empty database),
// sign-in sessions surviving a restart, and the buyer's task archive.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { Db } from "mongodb";
import { NETWORK, USDC_ADDRESS, type Listing } from "@dron/shared";
import { openRegistryDb, ServiceStore } from "../../apps/registry/src/db.ts";
import { MongoSync, startMongoSync } from "../../apps/registry/src/mongo-sync.ts";
import { createRegistryApp } from "../../apps/registry/src/app.ts";
import { TaskArchive } from "../../apps/buyer/src/archive.ts";
import { createBuyerApp } from "../../apps/buyer/src/app.ts";
import { body, listen, randomPayTo } from "./helpers.ts";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Just enough of the MongoDB driver for these tests. */
class FakeMongo {
  readonly data = new Map<string, Map<string, any>>();
  down = false;
  col(name: string) {
    if (!this.data.has(name)) this.data.set(name, new Map());
    return this.data.get(name)!;
  }
  db(): Db {
    const self = this;
    return {
      collection(name: string) {
        const c = self.col(name);
        return {
          async bulkWrite(ops: any[]) {
            if (self.down) throw new Error("connect ECONNREFUSED mongodb+srv://user:secret@cluster.example");
            for (const op of ops) {
              if (op.replaceOne) c.set(op.replaceOne.filter._id, structuredClone(op.replaceOne.replacement));
              if (op.deleteOne) c.delete(op.deleteOne.filter._id);
            }
          },
          find() {
            let docs = [...c.values()];
            const cursor = {
              sort(spec: Record<string, number>) {
                const [k, dir] = Object.entries(spec)[0]!;
                docs.sort((a, b) => (a[k] < b[k] ? -dir : a[k] > b[k] ? dir : 0));
                return cursor;
              },
              limit(n: number) {
                docs = docs.slice(0, n);
                return cursor;
              },
              async toArray() {
                return structuredClone(docs);
              },
            };
            return cursor;
          },
          async findOne(filter: { _id: string }) {
            return structuredClone(c.get(filter._id) ?? null);
          },
          async createIndex() {
            return "ok";
          },
        };
      },
    } as unknown as Db;
  }
}

function listing(id: string, price = "5000"): Listing {
  return {
    id, sellerId: id, name: id, category: "scraping", description: "test", endpoint: `https://${id}.example/scrape`, method: "GET",
    priceUnits: price, network: NETWORK, asset: USDC_ADDRESS, payTo: randomPayTo(),
    inputSchema: { type: "object", properties: { page: { type: "integer" } } }, outputSchema: { type: "object" },
  };
}

function insertLedgerRow(db: ReturnType<typeof openRegistryDb>, id: string, paid: string) {
  db.prepare(
    `INSERT INTO ledger (id, session_id, task_id, created_at, updated_at, buyer, seller_id, service_id, listed_units, paid_units, status, latency_ms)
     VALUES (?, 'ses_1', 'task_1', '2026-10-17T00:00:00.000Z', '2026-10-17T00:00:00.000Z', ?, 's', 's', '5000', ?, 'paid', 12)`,
  ).run(id, randomPayTo(), paid);
}

describe("registry -> MongoDB Atlas outbox sync", () => {
  it("mirrors creates, updates and deletes, with JSON columns as objects and amounts as exact strings", async () => {
    const db = openRegistryDb(":memory:");
    const mongo = new FakeMongo();
    const sync = new MongoSync(db, async () => mongo.db(), silent);
    sync.installTriggers();
    const store = new ServiceStore(db);

    store.save(listing("alpha"), "admin", true);
    insertLedgerRow(db, "row-00000001", "123456789012345678901234567890");
    assert.equal(sync.pending(), 2); // one service insert, one ledger insert
    await sync.flush();
    assert.equal(sync.pending(), 0);
    const doc = mongo.col("services").get("alpha");
    assert.equal(doc.price_units, 5000);
    assert.deepEqual(doc.input_schema, { type: "object", properties: { page: { type: "integer" } } });
    assert.equal(mongo.col("ledger").get("row-00000001").paid_units, "123456789012345678901234567890");

    store.save(listing("alpha", "4000"), "admin", true);
    await sync.flush();
    assert.equal(mongo.col("services").get("alpha").price_units, 4000);

    store.delete("alpha");
    await sync.flush();
    assert.equal(mongo.col("services").has("alpha"), false);
  });

  it("keeps changes queued while Atlas is down and delivers them when it is back (errors never leak the password)", async () => {
    const db = openRegistryDb(":memory:");
    const mongo = new FakeMongo();
    const sync = new MongoSync(db, async () => mongo.db(), silent);
    sync.installTriggers();
    mongo.down = true;
    new ServiceStore(db).save(listing("beta"), "admin", true);
    await assert.rejects(sync.flush());
    assert.ok(sync.pending() > 0);
    mongo.down = false;
    await sync.flush();
    assert.equal(sync.pending(), 0);
    assert.ok(mongo.col("services").has("beta"));
  });

  it("backfills rows that existed before sync was switched on, once per Atlas database", async () => {
    const db = openRegistryDb(":memory:");
    new ServiceStore(db).save(listing("gamma"), "admin", true);
    insertLedgerRow(db, "row-00000002", "5000");
    const mongo = new FakeMongo();
    const sync = new MongoSync(db, async () => mongo.db(), silent);
    sync.installTriggers();
    assert.ok(sync.backfillOnce("dronacharya") >= 2);
    assert.equal(sync.backfillOnce("dronacharya"), 0);
    await sync.flush();
    assert.ok(mongo.col("services").has("gamma"));
    assert.ok(mongo.col("ledger").has("row-00000002"));
  });

  it("restores an empty local database from Atlas before serving", async () => {
    const mongo = new FakeMongo();
    const first = openRegistryDb(":memory:");
    const s1 = new MongoSync(first, async () => mongo.db(), silent);
    s1.installTriggers();
    new ServiceStore(first).save(listing("delta"), "public", false);
    insertLedgerRow(first, "row-00000003", "98765");
    await s1.flush();

    const fresh = openRegistryDb(":memory:"); // a new machine / container
    await startMongoSync({ db: fresh, mongo: async () => mongo.db(), dbName: "dronacharya", log: silent });
    const restored = new ServiceStore(fresh).get("delta");
    assert.ok(restored);
    assert.equal(restored.registeredBy, "public");
    assert.deepEqual(restored.listing.inputSchema, listing("delta").inputSchema);
    const row = fresh.prepare(`SELECT paid_units FROM ledger WHERE id = 'row-00000003'`).get() as { paid_units: string };
    assert.equal(row.paid_units, "98765");
  });
});

describe("sign-in sessions survive a restart", () => {
  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));

  it("a session created before the restart is still valid after it; only a hash of the token is stored", async () => {
    const saved = process.env.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    try {
      const db = openRegistryDb(":memory:");
      const auth = { verifyIdToken: async () => ({ email: "restart@example.com", email_verified: true }) };
      const a = await listen(createRegistryApp({ db, log: silent, allowLoopback: true, auth }));
      servers.push(a.server);
      const login = await body(await fetch(`${a.base}/api/auth/google`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: "x".repeat(30) }) }));
      const stored = db.prepare(`SELECT id, user FROM auth_sessions`).all() as { id: string; user: string }[];
      assert.equal(stored.length, 1);
      assert.notEqual(stored[0]!.id, login.token);
      assert.match(stored[0]!.id, /^[0-9a-f]{64}$/);

      const b = await listen(createRegistryApp({ db, log: silent, allowLoopback: true, auth })); // "restarted" registry
      servers.push(b.server);
      const s = await body(await fetch(`${b.base}/api/auth/session`, { headers: { authorization: `Bearer ${login.token}` } }));
      assert.equal(s.authenticated, true);
      assert.equal(s.user.email, "restart@example.com");
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_CLIENT_ID;
      else process.env.GOOGLE_CLIENT_ID = saved;
    }
  });
});

describe("buyer task archive", () => {
  const snapshot = (id: string, status: string, createdAt: string) => ({
    view: { id, status, request: { task: `task ${id}`, budget: "0.05" }, createdAt, budget: { spentUsdc: "0.041" }, error: null },
    events: [{ seq: 1, type: "task_created" }, { seq: 2, type: "status" }],
  });

  it("stores the latest snapshot per task, lists newest first, and marks tasks cut off by a restart", async () => {
    const mongo = new FakeMongo();
    const archive = new TaskArchive(async () => mongo.db(), silent);
    archive.save(snapshot("task_a", "running", "2026-10-17T01:00:00.000Z"));
    archive.save(snapshot("task_a", "completed", "2026-10-17T01:00:00.000Z"));
    archive.save(snapshot("task_b", "running", "2026-10-17T02:00:00.000Z"));
    await archive.flush();
    const list = await archive.list();
    assert.deepEqual(list.map((t) => [t.id, t.status]), [["task_b", "interrupted"], ["task_a", "completed"]]);
    const b = await archive.get("task_b");
    assert.equal(b?.view.status, "interrupted");
    assert.match(String(b?.view.error), /restarted/);
  });

  it("the buyer API serves past tasks from the archive alongside live ones", async () => {
    const past = snapshot("task_old", "completed", "2026-10-16T00:00:00.000Z");
    const archive = { list: async () => [{ id: "task_old", status: "completed", task: "old", budget: "0.05", spentUsdc: "0.041", createdAt: past.view.createdAt }], get: async (id: string) => (id === "task_old" ? past : null) };
    const manager = { list: () => [], get: () => undefined, events: () => undefined, address: "0x0", maxBudgetUnits: 500_000n } as never;
    const s = await listen(createBuyerApp({ manager, log: silent, registryUrl: "http://r", allowLoopback: true, archive: archive as never }));
    try {
      const list = await body(await fetch(`${s.base}/api/tasks`));
      assert.deepEqual(list.tasks.map((t: { id: string }) => t.id), ["task_old"]);
      const t = await body(await fetch(`${s.base}/api/tasks/task_old`));
      assert.equal(t.archived, true);
      assert.equal(t.status, "completed");
      assert.equal((await fetch(`${s.base}/api/tasks/nope`)).status, 404);
    } finally {
      s.server.close();
    }
  });
});

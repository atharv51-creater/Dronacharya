// MongoDB Atlas as the registry's durable cloud copy: listings, users, buyer sessions, sign-in sessions and
// every ledger transaction.
//
// How it works (storage level, so no registry, ledger or payment logic changes):
//   - SQLite triggers on each synced table write (table, id, op) into a durable outbox table, in the same
//     transaction as the change itself. Every writer is covered, including future ones.
//   - A loop drains the outbox to Atlas with idempotent bulk upserts/deletes. If Atlas is unreachable the
//     outbox keeps growing and is drained when it comes back, even after a restart.
//   - First run against a database: every existing row is queued once (backfill).
//   - Empty local database (fresh machine, container or deploy): rows are restored from Atlas before the
//     registry starts serving.
// Documents keep the table's column names; _id is the row id. Amounts stay exact decimal strings.

import { scrubMongoError, type Database, type Logger } from "@dron/shared";
import type { AnyBulkWriteOperation, Db, Document } from "mongodb";

export interface SyncedTable {
  table: string;
  /** TEXT columns holding JSON: stored as objects in Atlas, as text locally. */
  json?: string[];
  /** INTEGER 0/1 columns: stored as booleans in Atlas. */
  bool?: string[];
  /** Extra fields for Atlas only (e.g. a Date for a TTL index). */
  extra?: (row: Record<string, unknown>) => Record<string, unknown>;
  indexes?: { key: Record<string, 1 | -1>; options?: Record<string, unknown> }[];
}

export const SYNCED_TABLES: SyncedTable[] = [
  { table: "services", json: ["input_schema", "output_schema"], bool: ["is_fixture"], indexes: [{ key: { category: 1, price_units: 1 } }, { key: { pay_to: 1 } }] },
  { table: "users", indexes: [{ key: { wallet: 1 } }, { key: { email: 1 } }] },
  { table: "sessions", indexes: [{ key: { buyer: 1, created_at: -1 } }] },
  {
    table: "ledger",
    bool: ["onchain_confirmed"],
    indexes: [{ key: { session_id: 1, created_at: 1 } }, { key: { service_id: 1, created_at: 1 } }, { key: { tx_hash: 1 } }, { key: { buyer: 1 } }, { key: { status: 1 } }],
  },
  {
    table: "auth_sessions",
    json: ["user"],
    extra: (row) => ({ expiresAt: new Date(Number(row.expires)) }),
    // Atlas deletes expired sign-in sessions on its own.
    indexes: [{ key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } }],
  },
];

const BATCH = 500;

type Row = Record<string, unknown>;
/** Atlas documents use the row id (a string) as _id. */
type SyncDoc = Document & { _id: string };

export class MongoSync {
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<number> | undefined;
  private failing = false;
  private readonly tables: SyncedTable[];
  pushed = 0;

  constructor(
    private readonly db: Database,
    private readonly mongo: () => Promise<Db>,
    private readonly log: Logger,
    tables: SyncedTable[] = SYNCED_TABLES,
  ) {
    const existing = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name));
    this.tables = tables.filter((t) => existing.has(t.table));
  }

  /** Outbox, state table and triggers (idempotent). */
  installTriggers(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, row_id TEXT NOT NULL, op TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    for (const { table: t } of this.tables) {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS sync_${t}_ins AFTER INSERT ON ${t} BEGIN INSERT INTO sync_outbox (tbl, row_id, op) VALUES ('${t}', NEW.id, 'upsert'); END;
        CREATE TRIGGER IF NOT EXISTS sync_${t}_upd AFTER UPDATE ON ${t} BEGIN INSERT INTO sync_outbox (tbl, row_id, op) VALUES ('${t}', NEW.id, 'upsert'); END;
        CREATE TRIGGER IF NOT EXISTS sync_${t}_del AFTER DELETE ON ${t} BEGIN INSERT INTO sync_outbox (tbl, row_id, op) VALUES ('${t}', OLD.id, 'delete'); END;
      `);
    }
  }

  pending(): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM sync_outbox`).get() as { n: number }).n);
  }

  /** Queues every existing row once per Atlas database (first run, or a database switch). */
  backfillOnce(key: string): number {
    const flag = `backfilled:${key}`;
    if (this.db.prepare(`SELECT 1 FROM sync_state WHERE key = ?`).get(flag)) return 0;
    let queued = 0;
    this.db.exec("BEGIN");
    try {
      for (const { table: t } of this.tables) {
        queued += Number(this.db.prepare(`INSERT INTO sync_outbox (tbl, row_id, op) SELECT '${t}', id, 'upsert' FROM ${t}`).run().changes);
      }
      this.db.prepare(`INSERT INTO sync_state (key, value) VALUES (?, ?)`).run(flag, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return queued;
  }

  /** Records that this database already matches Atlas (after a restore), so no backfill is queued. */
  markBackfilled(key: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO sync_state (key, value) VALUES (?, ?)`).run(`backfilled:${key}`, new Date().toISOString());
  }

  localIsEmpty(): boolean {
    return this.tables.every(({ table: t }) => !this.db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get());
  }

  /** Copies every document from Atlas into the (empty) local tables. Run before installTriggers. */
  async restore(): Promise<Record<string, number>> {
    const mongo = await this.mongo();
    const counts: Record<string, number> = {};
    const docs: [SyncedTable, Document[]][] = [];
    for (const spec of this.tables) docs.push([spec, await mongo.collection(spec.table).find({}).toArray()]);
    this.db.exec("BEGIN");
    try {
      for (const [spec, list] of docs) {
        const columns = (this.db.prepare(`PRAGMA table_info(${spec.table})`).all() as { name: string }[]).map((c) => c.name);
        const insert = this.db.prepare(`INSERT OR REPLACE INTO ${spec.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
        for (const doc of list) {
          const values = columns.map((c) => {
            const v = c === "id" ? doc._id : doc[c];
            if (v === undefined) return null;
            if (spec.json?.includes(c) && v !== null && typeof v === "object") return JSON.stringify(v);
            if (typeof v === "boolean") return v ? 1 : 0;
            return v as string | number | null;
          });
          insert.run(...values);
        }
        counts[spec.table] = list.length;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return counts;
  }

  toDoc(spec: SyncedTable, row: Row): SyncDoc {
    const doc: SyncDoc = { _id: String(row.id) };
    for (const [k, v] of Object.entries(row)) {
      if (k === "id") continue;
      if (spec.json?.includes(k) && typeof v === "string") doc[k] = safeJson(v);
      else if (spec.bool?.includes(k) && (v === 0 || v === 1)) doc[k] = v === 1;
      else doc[k] = v;
    }
    return { ...doc, ...spec.extra?.(row), _syncedAt: new Date() };
  }

  /** Pushes up to one batch of the outbox to Atlas. Returns how many outbox entries were applied. */
  async flushOnce(): Promise<number> {
    const batch = this.db.prepare(`SELECT seq, tbl, row_id, op FROM sync_outbox ORDER BY seq LIMIT ${BATCH}`).all() as { seq: number; tbl: string; row_id: string; op: string }[];
    if (batch.length === 0) return 0;
    const maxSeq = batch[batch.length - 1]!.seq;
    const mongo = await this.mongo();
    for (const spec of this.tables) {
      const ids = [...new Set(batch.filter((b) => b.tbl === spec.table).map((b) => b.row_id))];
      if (ids.length === 0) continue;
      // Whatever the queued ops were, the current local row is the truth: present -> upsert, gone -> delete.
      const rows = this.db.prepare(`SELECT * FROM ${spec.table} WHERE id IN (${ids.map(() => "?").join(", ")})`).all(...ids) as Row[];
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      const ops = ids.map((id): AnyBulkWriteOperation<SyncDoc> => {
        const row = byId.get(id);
        if (row) return { replaceOne: { filter: { _id: id }, replacement: this.toDoc(spec, row), upsert: true } };
        return { deleteOne: { filter: { _id: id } } };
      });
      await mongo.collection<SyncDoc>(spec.table).bulkWrite(ops, { ordered: false });
    }
    this.db.prepare(`DELETE FROM sync_outbox WHERE seq <= ?`).run(maxSeq);
    this.pushed += batch.length;
    return batch.length;
  }

  /** Drains the whole outbox (loops over batches). */
  async flush(): Promise<number> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      let total = 0;
      for (;;) {
        const n = await this.flushOnce();
        total += n;
        if (n < BATCH) return total;
      }
    })().finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  async ensureIndexes(): Promise<void> {
    const mongo = await this.mongo();
    for (const spec of this.tables) {
      for (const ix of spec.indexes ?? []) await mongo.collection(spec.table).createIndex(ix.key, ix.options ?? {});
    }
  }

  /** Background drain every `intervalMs`; logs once when Atlas goes away and once when it is back. */
  start(intervalMs = 1000): void {
    const tick = async () => {
      try {
        await this.flush();
        if (this.failing) this.log.info("MongoDB Atlas reachable again; outbox drained");
        this.failing = false;
      } catch (err) {
        if (!this.failing) this.log.warn("MongoDB Atlas sync paused; changes are queued locally and retried", { err: scrubMongoError(err), pending: this.pending() });
        this.failing = true;
      }
      this.timer = setTimeout(tick, this.failing ? Math.min(intervalMs * 15, 15_000) : intervalMs);
      this.timer.unref?.();
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.flush().catch(() => {});
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Startup sequence for the registry: restore an empty local database from Atlas, install the triggers,
 * queue a one-time backfill, create indexes and start draining. Never blocks startup for long: if Atlas
 * is unreachable the registry serves from SQLite and the outbox catches up later.
 */
export async function startMongoSync(opts: { db: Database; mongo: () => Promise<Db>; dbName: string; log: Logger }): Promise<MongoSync> {
  const sync = new MongoSync(opts.db, opts.mongo, opts.log);
  let restored = false;
  try {
    if (sync.localIsEmpty()) {
      const counts = await withTimeout(sync.restore(), 20_000);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (total > 0) {
        restored = true;
        opts.log.info("restored the registry from MongoDB Atlas", counts);
      }
    }
  } catch (err) {
    opts.log.warn("could not restore from MongoDB Atlas; starting from the local database", { err: scrubMongoError(err) });
  }
  sync.installTriggers();
  if (restored) sync.markBackfilled(opts.dbName);
  const queued = sync.backfillOnce(opts.dbName);
  if (queued) opts.log.info("queued existing rows for MongoDB Atlas", { rows: queued });
  sync.ensureIndexes().catch((err) => opts.log.warn("could not create MongoDB indexes (will work without them)", { err: scrubMongoError(err) }));
  sync.start();
  opts.log.info("MongoDB Atlas sync on", { database: opts.dbName, tables: SYNCED_TABLES.map((t) => t.table) });
  return sync;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms).unref())]);
}

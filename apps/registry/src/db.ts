import { openDatabase, type Database, type Listing } from "@dron/shared";

export function openRegistryDb(path: string): Database {
  const db = openDatabase(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      id            TEXT PRIMARY KEY,
      seller_id     TEXT NOT NULL,
      name          TEXT NOT NULL,
      category      TEXT NOT NULL CHECK (category IN ('data', 'inference', 'scraping')),
      description   TEXT NOT NULL,
      endpoint      TEXT NOT NULL,
      method        TEXT NOT NULL CHECK (method IN ('GET', 'POST')),
      price_units   INTEGER NOT NULL CHECK (price_units > 0 AND price_units <= 100000),
      network       TEXT NOT NULL,
      asset         TEXT NOT NULL,
      pay_to        TEXT NOT NULL,
      input_schema  TEXT NOT NULL,
      output_schema TEXT NOT NULL,
      is_fixture    INTEGER NOT NULL DEFAULT 0,
      registered_by TEXT NOT NULL CHECK (registered_by IN ('admin', 'public')),
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS services_category ON services (category, price_units);

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      buyer       TEXT NOT NULL,
      start_block INTEGER,
      created_at  TEXT NOT NULL
    );
  `);
  migrateLedger(db);
  return db;
}

// Every attempted call, reported (and signed) by buyers. Amounts are TEXT so arbitrary 402 amounts
// (a seller can ask for anything) stay exact; sums are done with BigInt in code.
const LEDGER_DDL = `
  CREATE TABLE ledger (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL,
    task_id           TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    buyer             TEXT NOT NULL,
    seller_id         TEXT NOT NULL,
    service_id        TEXT NOT NULL,
    endpoint          TEXT NOT NULL DEFAULT '',
    pay_to            TEXT NOT NULL DEFAULT '',
    listed_units      TEXT NOT NULL,
    asked_units       TEXT,
    paid_units        TEXT NOT NULL DEFAULT '0',
    status            TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'paid_output_rejected', 'refused', 'failed_not_charged')),
    reason            TEXT,
    reason_code       TEXT NOT NULL DEFAULT 'ok',
    tx_hash           TEXT,
    nonce             TEXT,
    valid_before      INTEGER,
    http_status       INTEGER,
    latency_ms        INTEGER NOT NULL,
    onchain_confirmed INTEGER
  );
  CREATE INDEX ledger_service ON ledger (service_id, created_at);
  CREATE INDEX ledger_session ON ledger (session_id, created_at);
  CREATE INDEX ledger_tx ON ledger (tx_hash);
`;

/** Creates the ledger table, or upgrades a step-3 table (no pending state, integer amounts) in place. */
function migrateLedger(db: Database) {
  const columns = (db.prepare(`PRAGMA table_info(ledger)`).all() as { name: string }[]).map((c) => c.name);
  if (columns.length === 0) {
    db.exec(LEDGER_DDL);
    return;
  }
  if (columns.includes("pay_to")) return;
  db.exec("BEGIN");
  try {
    db.exec(`DROP INDEX IF EXISTS ledger_service; DROP INDEX IF EXISTS ledger_session; ALTER TABLE ledger RENAME TO ledger_v1;`);
    db.exec(LEDGER_DDL);
    db.exec(`
      INSERT INTO ledger (id, session_id, task_id, created_at, updated_at, buyer, seller_id, service_id, listed_units, asked_units,
        paid_units, status, reason, reason_code, tx_hash, nonce, valid_before, latency_ms, onchain_confirmed)
      SELECT id, session_id, task_id, created_at, created_at, buyer, seller_id, service_id, CAST(listed_units AS TEXT),
        CAST(asked_units AS TEXT), CAST(paid_units AS TEXT), status, reason, COALESCE(reason_code, 'ok'), tx_hash, nonce,
        valid_before, latency_ms, onchain_confirmed
      FROM ledger_v1;
      DROP TABLE ledger_v1;
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface ServiceRow {
  listing: Listing;
  registeredBy: "admin" | "public";
  createdAt: string;
  updatedAt: string;
}

function rowToService(row: Record<string, unknown>): ServiceRow {
  return {
    listing: {
      id: String(row.id),
      sellerId: String(row.seller_id),
      name: String(row.name),
      category: row.category as Listing["category"],
      description: String(row.description),
      endpoint: String(row.endpoint),
      method: row.method as Listing["method"],
      priceUnits: String(row.price_units),
      network: row.network as Listing["network"],
      asset: row.asset as Listing["asset"],
      payTo: row.pay_to as Listing["payTo"],
      inputSchema: JSON.parse(String(row.input_schema)),
      outputSchema: JSON.parse(String(row.output_schema)),
      ...(row.is_fixture ? { isFixture: true } : {}),
    },
    registeredBy: row.registered_by as "admin" | "public",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class ServiceStore {
  constructor(private readonly db: Database) {}

  all(): ServiceRow[] {
    return (this.db.prepare(`SELECT * FROM services ORDER BY category, price_units, id`).all() as Record<string, unknown>[]).map(rowToService);
  }

  get(id: string): ServiceRow | undefined {
    const row = this.db.prepare(`SELECT * FROM services WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToService(row) : undefined;
  }

  /** Inserts, or (when `allowUpdate`) replaces an existing listing. Returns what happened. */
  save(listing: Listing, registeredBy: "admin" | "public", allowUpdate: boolean): "created" | "updated" | "conflict" {
    const now = new Date().toISOString();
    const values = [
      listing.sellerId,
      listing.name,
      listing.category,
      listing.description,
      listing.endpoint,
      listing.method,
      Number(listing.priceUnits),
      listing.network,
      listing.asset,
      listing.payTo,
      JSON.stringify(listing.inputSchema),
      JSON.stringify(listing.outputSchema),
      listing.isFixture ? 1 : 0,
    ];
    const inserted = this.db
      .prepare(
        `INSERT INTO services (id, seller_id, name, category, description, endpoint, method, price_units, network, asset,
           pay_to, input_schema, output_schema, is_fixture, registered_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(listing.id, ...values, registeredBy, now, now);
    if (Number(inserted.changes) === 1) return "created";
    if (!allowUpdate) return "conflict";
    this.db
      .prepare(
        `UPDATE services SET seller_id = ?, name = ?, category = ?, description = ?, endpoint = ?, method = ?, price_units = ?,
           network = ?, asset = ?, pay_to = ?, input_schema = ?, output_schema = ?, is_fixture = ?, registered_by = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(...values, registeredBy, now, listing.id);
    return "updated";
  }

  delete(id: string): boolean {
    return Number(this.db.prepare(`DELETE FROM services WHERE id = ?`).run(id).changes) === 1;
  }
}

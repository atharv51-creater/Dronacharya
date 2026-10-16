// One authorisation unlocks one response. Claims are a single synchronous INSERT against a
// PRIMARY KEY, so of N concurrent requests carrying the same payment exactly one wins, in this
// process and across processes sharing the file.

import { openDatabase, type Database } from "@dron/shared";
import type { PaymentIdentity } from "./payment-identity.ts";

export type NonceState = "claimed" | "settled" | "failed";

export interface NonceRecord {
  key: string;
  payer: string | null;
  nonce: string | null;
  route: string;
  state: NonceState;
  status: number | null;
  txHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ReplayStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = openDatabase(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payment_nonces (
        key        TEXT PRIMARY KEY,
        payer      TEXT,
        nonce      TEXT,
        route      TEXT NOT NULL,
        state      TEXT NOT NULL CHECK (state IN ('claimed', 'settled', 'failed')),
        status     INTEGER,
        tx_hash    TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  /** Returns true only for the first caller with this identity. */
  claim(identity: PaymentIdentity, route: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO payment_nonces (key, payer, nonce, route, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'claimed', ?, ?) ON CONFLICT(key) DO NOTHING`,
      )
      .run(identity.key, identity.payer, identity.nonce, route, now, now);
    return Number(result.changes) === 1;
  }

  /** Records how the claimed payment ended. A claim is never released: retries need a fresh signature. */
  finish(key: string, outcome: { state: Exclude<NonceState, "claimed">; status: number; txHash?: string | null }): void {
    this.db
      .prepare(`UPDATE payment_nonces SET state = ?, status = ?, tx_hash = ?, updated_at = ? WHERE key = ?`)
      .run(outcome.state, outcome.status, outcome.txHash ?? null, new Date().toISOString(), key);
  }

  get(key: string): NonceRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM payment_nonces WHERE key = ?`).get(key) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      key: String(row.key),
      payer: (row.payer as string | null) ?? null,
      nonce: (row.nonce as string | null) ?? null,
      route: String(row.route),
      state: row.state as NonceState,
      status: (row.status as number | null) ?? null,
      txHash: (row.tx_hash as string | null) ?? null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  close(): void {
    this.db.close();
  }
}

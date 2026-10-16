// Ledger ingestion. Buyers report every attempted call, signed with their wallet (EIP-191), so:
//   - nobody can file calls in another buyer's name (to inflate or wreck a seller's reputation);
//   - every row is attributable to the wallet whose USDC it describes.
// Rows are upserted by id as they move pending -> final and gain on-chain confirmation, but only along
// legal transitions, and identity fields never change after the first report.

import { getAddress, isAddress, verifyMessage, type Hex } from "viem";
import {
  REASON_CODES,
  compileSchema,
  formatErrors,
  ledgerMessage,
  sessionMessage,
  txUrl,
  type Database,
  type LedgerRow,
  type LedgerState,
  type SessionRecord,
} from "@dron/shared";

const unit = { type: "string", pattern: "^(0|[1-9][0-9]{0,40})$" };
const hex32 = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" };
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });

const rowSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "time", "updatedAt", "sessionId", "taskId", "buyer", "sellerId", "serviceId", "endpoint", "payTo", "listedUnits",
    "askedUnits", "paidUnits", "status", "reasonCode", "reason", "txHash", "explorerUrl", "nonce", "validBefore", "httpStatus",
    "latencyMs", "onchainConfirmed",
  ],
  properties: {
    id: { type: "string", minLength: 8, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" },
    time: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    sessionId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_.:-]+$" },
    taskId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_.:-]+$" },
    buyer: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
    sellerId: { type: "string", maxLength: 64 },
    serviceId: { type: "string", maxLength: 64 },
    endpoint: { type: "string", maxLength: 600 },
    payTo: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
    listedUnits: unit,
    askedUnits: nullable(unit),
    paidUnits: unit,
    status: { enum: ["pending", "paid", "paid_output_rejected", "refused", "failed_not_charged"] },
    reasonCode: { enum: [...REASON_CODES] },
    reason: nullable({ type: "string", maxLength: 1000 }),
    txHash: nullable(hex32),
    explorerUrl: nullable({ type: "string", maxLength: 200 }),
    nonce: nullable(hex32),
    validBefore: nullable({ type: "integer", minimum: 0 }),
    httpStatus: nullable({ type: "integer", minimum: 100, maximum: 599 }),
    latencyMs: { type: "integer", minimum: 0, maximum: 86_400_000 },
    onchainConfirmed: nullable({ type: "boolean" }),
  },
};
const validateRowShape = compileSchema(rowSchema);

const ALLOWED: Record<LedgerState, LedgerState[]> = {
  pending: ["pending", "paid", "paid_output_rejected", "failed_not_charged"],
  // a seller that claimed failure but settled anyway is discovered later
  failed_not_charged: ["failed_not_charged", "paid_output_rejected"],
  paid: ["paid"],
  paid_output_rejected: ["paid_output_rejected"],
  refused: ["refused"],
};
const IMMUTABLE: (keyof LedgerRow)[] = ["sessionId", "taskId", "buyer", "sellerId", "serviceId", "listedUnits", "time"];

export type IngestResult = { ok: true; row: LedgerRow; created: boolean } | { ok: false; status: number; error: string; details?: string[] };

export class LedgerStore {
  private readonly listeners = new Set<(row: LedgerRow) => void>();

  constructor(private readonly db: Database) {}

  /** Called with the stored row after every accepted create or update (feeds the live dashboard). */
  onChange(listener: (row: LedgerRow) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every row of one buyer wallet (for wallet-level reconciliation). */
  forBuyer(buyer: string): LedgerRow[] {
    return (this.db.prepare(`SELECT * FROM ledger WHERE lower(buyer) = lower(?) ORDER BY created_at`).all(buyer) as Record<string, unknown>[]).map(fromDb);
  }

  sessions(): (SessionRecord & { totals: ReturnType<LedgerStore["totals"]> })[] {
    const rows = this.db.prepare(`SELECT id FROM sessions ORDER BY created_at DESC LIMIT 500`).all() as { id: string }[];
    return rows.map((r) => ({ ...this.session(r.id)!, totals: this.totals(r.id) }));
  }

  get(id: string): LedgerRow | undefined {
    const r = this.db.prepare(`SELECT * FROM ledger WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? fromDb(r) : undefined;
  }

  list(filter: { sessionId?: string; status?: string; serviceId?: string; limit: number }): LedgerRow[] {
    const where: string[] = [];
    const params: string[] = [];
    for (const [col, value] of [["session_id", filter.sessionId], ["status", filter.status], ["service_id", filter.serviceId]] as const) {
      if (value) {
        where.push(`${col} = ?`);
        params.push(value);
      }
    }
    const sql = `SELECT * FROM ledger ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ${Math.floor(filter.limit)}`;
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(fromDb);
  }

  /** Verifies, checks consistency and transitions, then upserts. */
  async ingest(body: unknown, services: { get(id: string): { listing: { sellerId: string; priceUnits: string } } | undefined }): Promise<IngestResult> {
    const b = (body ?? {}) as { row?: unknown; signature?: unknown };
    if (!validateRowShape(b.row)) return { ok: false, status: 400, error: "invalid_row", details: formatErrors(validateRowShape.errors) };
    const row = b.row as LedgerRow;
    if (typeof b.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(b.signature)) return { ok: false, status: 400, error: "signature_required" };

    let valid = false;
    try {
      valid = await verifyMessage({ address: getAddress(row.buyer), message: ledgerMessage(row), signature: b.signature as Hex });
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, status: 401, error: "bad_signature", details: ["the row must be signed by the buyer wallet it names"] };

    const service = services.get(row.serviceId);
    if (!service) return { ok: false, status: 404, error: "unknown_service", details: [`no service "${row.serviceId}" in this registry`] };
    if (service.listing.sellerId !== row.sellerId) return { ok: false, status: 400, error: "seller_mismatch" };

    const problems = consistency(row);
    if (problems.length) return { ok: false, status: 400, error: "inconsistent_row", details: problems };

    const existing = this.get(row.id);
    if (existing) {
      if (existing.buyer.toLowerCase() !== row.buyer.toLowerCase()) return { ok: false, status: 403, error: "not_your_row" };
      for (const field of IMMUTABLE) {
        if (String(existing[field]) !== String(row[field])) return { ok: false, status: 409, error: "immutable_field", details: [`${field} cannot change`] };
      }
      if (existing.nonce && row.nonce !== existing.nonce) return { ok: false, status: 409, error: "immutable_field", details: ["nonce cannot change"] };
      if (!ALLOWED[existing.status].includes(row.status)) {
        return { ok: false, status: 409, error: "illegal_transition", details: [`${existing.status} -> ${row.status}`] };
      }
      if (row.updatedAt < existing.updatedAt) return { ok: true, row: existing, created: false }; // stale report: keep the newer one
    }

    this.ensureSession(row.sessionId, row.buyer);
    this.db
      .prepare(
        `INSERT INTO ledger (id, session_id, task_id, created_at, updated_at, buyer, seller_id, service_id, endpoint, pay_to,
           listed_units, asked_units, paid_units, status, reason, reason_code, tx_hash, nonce, valid_before, http_status, latency_ms, onchain_confirmed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, endpoint = excluded.endpoint, pay_to = excluded.pay_to,
           asked_units = excluded.asked_units, paid_units = excluded.paid_units, status = excluded.status, reason = excluded.reason,
           reason_code = excluded.reason_code, tx_hash = excluded.tx_hash, nonce = excluded.nonce, valid_before = excluded.valid_before,
           http_status = excluded.http_status, latency_ms = excluded.latency_ms, onchain_confirmed = excluded.onchain_confirmed`,
      )
      .run(
        row.id, row.sessionId, row.taskId, row.time, row.updatedAt, getAddress(row.buyer), row.sellerId, row.serviceId, row.endpoint,
        getAddress(row.payTo), row.listedUnits, row.askedUnits, row.paidUnits, row.status, row.reason, row.reasonCode, row.txHash,
        row.nonce, row.validBefore, row.httpStatus, row.latencyMs, row.onchainConfirmed === null ? null : row.onchainConfirmed ? 1 : 0,
      );
    const stored = this.get(row.id)!;
    for (const listener of this.listeners) {
      try {
        listener(stored);
      } catch {
        // a broken subscriber must not break ingestion
      }
    }
    return { ok: true, row: stored, created: !existing };
  }

  async ingestSession(body: unknown): Promise<{ ok: true; session: SessionRecord } | { ok: false; status: number; error: string }> {
    const b = (body ?? {}) as { session?: Partial<SessionRecord>; signature?: unknown };
    const s = b.session;
    if (!s || typeof s.id !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(s.id) || typeof s.buyer !== "string" || !isAddress(s.buyer) ||
      !Number.isSafeInteger(s.startBlock) || (s.startBlock as number) < 0 || typeof s.createdAt !== "string") {
      return { ok: false, status: 400, error: "invalid_session" };
    }
    if (typeof b.signature !== "string") return { ok: false, status: 400, error: "signature_required" };
    const session = { id: s.id, buyer: s.buyer, startBlock: s.startBlock as number, createdAt: s.createdAt } satisfies SessionRecord;
    const ok = await verifyMessage({ address: getAddress(session.buyer), message: sessionMessage(session), signature: b.signature as Hex }).catch(() => false);
    if (!ok) return { ok: false, status: 401, error: "bad_signature" };

    const existing = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(session.id) as Record<string, unknown> | undefined;
    if (existing && String(existing.buyer).toLowerCase() !== session.buyer.toLowerCase()) return { ok: false, status: 403, error: "not_your_session" };
    if (existing) {
      this.db.prepare(`UPDATE sessions SET start_block = COALESCE(start_block, ?) WHERE id = ?`).run(session.startBlock, session.id);
    } else {
      this.db.prepare(`INSERT INTO sessions (id, buyer, start_block, created_at) VALUES (?, ?, ?, ?)`).run(session.id, getAddress(session.buyer), session.startBlock, session.createdAt);
    }
    return { ok: true, session: this.session(session.id)! };
  }

  session(id: string): SessionRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return { id: String(r.id), buyer: String(r.buyer), startBlock: r.start_block == null ? -1 : Number(r.start_block), createdAt: String(r.created_at) };
  }

  /** Exact totals for a session (BigInt sums of TEXT amounts). */
  totals(sessionId: string) {
    const rows = this.list({ sessionId, limit: 100_000 });
    const byStatus: Record<string, number> = {};
    let paid = 0n;
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      if (r.status === "paid" || r.status === "paid_output_rejected") paid += BigInt(r.paidUnits);
    }
    return { calls: rows.length, byStatus, paidUnits: paid.toString() };
  }

  private ensureSession(id: string, buyer: string) {
    this.db
      .prepare(`INSERT INTO sessions (id, buyer, start_block, created_at) VALUES (?, ?, NULL, ?) ON CONFLICT(id) DO NOTHING`)
      .run(id, getAddress(buyer), new Date().toISOString());
  }
}

/** Amount rules every row must satisfy. */
function consistency(row: LedgerRow): string[] {
  const p: string[] = [];
  const paid = BigInt(row.paidUnits);
  const asked = row.askedUnits === null ? null : BigInt(row.askedUnits);
  const listed = BigInt(row.listedUnits);
  const settled = row.status === "paid" || row.status === "paid_output_rejected";

  if (!settled && paid !== 0n) p.push(`a ${row.status} row cannot have paidUnits`);
  if (settled && row.reasonCode !== "free") {
    if (asked === null) p.push("a paid row needs askedUnits");
    else if (paid !== asked) p.push("paidUnits must equal askedUnits (exact scheme)");
    if (asked !== null && asked > listed) p.push("paid more than the listed price");
    if (paid === 0n) p.push("a paid row must have paidUnits");
  }
  if (row.status === "paid" && row.reasonCode === "free" && paid !== 0n) p.push("a free call has no paidUnits");
  if (row.status === "pending" && !row.nonce) p.push("a pending row must carry the authorisation nonce");
  if (row.txHash && row.explorerUrl && row.explorerUrl !== txUrl(row.txHash)) p.push("explorerUrl does not match txHash");
  return p;
}

function fromDb(r: Record<string, unknown>): LedgerRow {
  const tx = (r.tx_hash as string | null) ?? null;
  return {
    id: String(r.id),
    time: String(r.created_at),
    updatedAt: String(r.updated_at),
    sessionId: String(r.session_id),
    taskId: String(r.task_id),
    buyer: String(r.buyer),
    sellerId: String(r.seller_id),
    serviceId: String(r.service_id),
    endpoint: String(r.endpoint ?? ""),
    payTo: String(r.pay_to ?? ""),
    listedUnits: String(r.listed_units),
    askedUnits: r.asked_units == null ? null : String(r.asked_units),
    paidUnits: String(r.paid_units ?? "0"),
    status: r.status as LedgerState,
    reasonCode: (r.reason_code as LedgerRow["reasonCode"]) ?? "ok",
    reason: (r.reason as string | null) ?? null,
    txHash: tx,
    explorerUrl: tx ? txUrl(tx) : null,
    nonce: (r.nonce as string | null) ?? null,
    validBefore: r.valid_before == null ? null : Number(r.valid_before),
    httpStatus: r.http_status == null ? null : Number(r.http_status),
    latencyMs: Number(r.latency_ms),
    onchainConfirmed: r.onchain_confirmed == null ? null : Boolean(r.onchain_confirmed),
  };
}

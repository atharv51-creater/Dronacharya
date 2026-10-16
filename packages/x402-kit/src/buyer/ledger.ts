// Where ledger rows go. Every attempted call produces a row; a row may be re-recorded as it moves from
// pending to final and as on-chain confirmation arrives, so sinks treat record() as an upsert.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LocalAccount } from "viem";
import { createLogger, ledgerMessage, sessionMessage, type LedgerRow, type Logger, type SessionRecord } from "@dron/shared";

export interface LedgerSink {
  record(row: LedgerRow): void | Promise<void>;
  /** Resolves once everything recorded so far has been delivered. */
  flush?(): Promise<void>;
}

/** In-process ledger: the source for a task's explanation and for tests. */
export class MemoryLedger implements LedgerSink {
  private readonly rows = new Map<string, LedgerRow>();

  record(row: LedgerRow): void {
    this.rows.set(row.id, { ...row });
  }

  all(): LedgerRow[] {
    return [...this.rows.values()].sort((a, b) => a.time.localeCompare(b.time));
  }

  get(id: string): LedgerRow | undefined {
    return this.rows.get(id);
  }

  /** Sum of units that left the wallet (paid + paid_output_rejected). */
  paidUnits(filter: (row: LedgerRow) => boolean = () => true): bigint {
    return this.all()
      .filter(filter)
      .filter((r) => r.status === "paid" || r.status === "paid_output_rejected")
      .reduce((sum, r) => sum + BigInt(r.paidUnits), 0n);
  }
}

/** Append-only JSON Lines audit trail: every version of every row, in order. Public data only. */
export class JsonlLedger implements LedgerSink {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }
  record(row: LedgerRow): void {
    appendFileSync(this.path, JSON.stringify(row) + "\n");
  }
}

/**
 * Reports rows to the registry, each signed by the buyer wallet (EIP-191), so nobody can forge calls
 * in another buyer's name to move a seller's reputation. Deliveries for the same row are serialised so
 * an update never overtakes the row it updates.
 */
export class RegistryLedgerSink implements LedgerSink {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly log: Logger;

  constructor(
    private readonly registryUrl: string,
    private readonly account: LocalAccount,
    log?: Logger,
  ) {
    this.log = log ?? createLogger("ledger");
  }

  async startSession(session: SessionRecord): Promise<void> {
    const signature = await this.account.signMessage({ message: sessionMessage(session) });
    await this.post("/api/sessions", { session, signature });
  }

  record(row: LedgerRow): void {
    const snapshot = { ...row };
    const previous = this.chains.get(row.id) ?? Promise.resolve();
    const next = previous.then(() => this.deliver(snapshot));
    this.chains.set(row.id, next);
    void next.finally(() => {
      if (this.chains.get(row.id) === next) this.chains.delete(row.id);
    });
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.chains.values()]);
  }

  private async deliver(row: LedgerRow): Promise<void> {
    const signature = await this.account.signMessage({ message: ledgerMessage(row) });
    await this.post("/api/ledger", { row, signature });
  }

  private async post(path: string, body: unknown): Promise<void> {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(`${this.registryUrl.replace(/\/+$/, "")}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return;
        const text = (await res.text()).slice(0, 300);
        if (res.status < 500) {
          this.log.warn("registry refused a ledger report", { path, status: res.status, body: text });
          return;
        }
        throw new Error(`registry answered ${res.status}`);
      } catch (err) {
        if (attempt === 4) {
          this.log.warn("could not report to the registry (the local ledger still has it)", { path, err });
          return;
        }
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
  }
}

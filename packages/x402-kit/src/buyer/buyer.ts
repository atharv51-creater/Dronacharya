// The buyer's payment core: one paid call, done safely.
//
//   1. Call the endpoint unpaid and read the 402.
//   2. PRICE CHECK: keep only payment options that match the registry listing; otherwise refuse.
//   3. BUDGET: reserve the asked amount synchronously; refuse if it does not fit.
//   4. SIGN: an EIP-3009 authorisation for exactly the approved option (a signing guard blocks
//      anything else, and spend controls cap any single payment at 0.10 USDC).
//   5. Retry with PAYMENT-SIGNATURE.
//   6. CLASSIFY:
//        settled (PAYMENT-RESPONSE success)  -> commit; validate output -> paid | paid_output_rejected
//        explicit error, not settled         -> failed_not_charged; reservation HELD until the
//                                               authorisation expires and the chain shows it unused
//        no answer / no receipt              -> pending; poll the chain until settled or expired
//   7. LEDGER: every attempt is a row, re-recorded as it becomes final and as the chain confirms it.
//
// The reservation is only released when money provably cannot move, so `spent` can never exceed the
// budget, even if a seller lies about failing and settles later.

import { randomUUID } from "node:crypto";
import type { Hex, LocalAccount } from "viem";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import {
  NETWORK,
  compileSchema,
  createLogger,
  formatErrors,
  fromUnits,
  txUrl,
  type Address,
  type LedgerRow,
  type LedgerState,
  type Listing,
  type Logger,
  type ReasonCode,
  type ValidateFunction,
} from "@dron/shared";
import * as liveChain from "../chain.ts";
import type { Budget, Reservation } from "./budget.ts";
import type { LedgerSink } from "./ledger.ts";
import { checkPaymentRequired, fingerprint } from "./price-check.ts";

export interface ChainOps {
  authorizationUsed(authorizer: Address, nonce: Hex): Promise<boolean>;
  findAuthorizationTx(authorizer: Address, nonce: Hex): Promise<Hex | null>;
  confirmTransfer(txHash: Hex, expect: { from: Address; to: Address; amount: bigint }, opts?: { wait?: boolean }): Promise<{ confirmed: boolean }>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export interface BuyerOptions {
  account: LocalAccount;
  sessionId?: string;
  ledger?: LedgerSink[];
  chain?: ChainOps;
  clock?: Clock;
  fetch?: typeof fetch;
  log?: Logger;
  /** Per-request timeout for the paid request. Default 50 s (seller deadline + settlement). */
  requestTimeoutMs?: number;
  /** Wait for each paid receipt and check the transfer. Default true. */
  confirmOnChain?: boolean;
  /** How often to poll the chain for an unclear outcome. Default 4 s. */
  pollIntervalMs?: number;
  /** Extra time after validBefore before declaring an authorisation dead. Default 15 s. */
  expiryGraceMs?: number;
}

export interface CallRequest {
  listing: Listing;
  input?: Record<string, unknown>;
  budget: Budget;
  taskId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CallOutcome {
  /** The row as it stood when payAndCall returned. */
  row: LedgerRow;
  /** The seller's result: set only when it passed the listed output schema. */
  output?: unknown;
  /** Why the output was rejected, when it was. */
  validationErrors?: string[];
  /** Resolves with the final row (pending resolved, failures confirmed unused, receipts confirmed). */
  finalized: Promise<LedgerRow>;
}

const PRE_CONNECT_ERRORS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "ERR_INVALID_URL"]);
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class Buyer {
  readonly address: Address;
  readonly sessionId: string;

  private readonly x402: x402Client;
  private readonly http: x402HTTPClient;
  private readonly sinks: LedgerSink[];
  private readonly chain: ChainOps;
  private readonly clock: Clock;
  private readonly fetch: typeof fetch;
  private readonly log: Logger;
  private readonly opts: Required<Pick<BuyerOptions, "requestTimeoutMs" | "confirmOnChain" | "pollIntervalMs" | "expiryGraceMs">>;
  private readonly approved = new Map<string, number>();
  private readonly validators = new Map<string, ValidateFunction | null>();
  private readonly background = new Set<Promise<unknown>>();

  constructor(options: BuyerOptions) {
    this.address = options.account.address;
    this.sessionId = options.sessionId ?? `ses_${randomUUID().slice(0, 8)}`;
    this.sinks = options.ledger ?? [];
    this.chain = options.chain ?? liveChain;
    this.clock = options.clock ?? realClock;
    this.fetch = options.fetch ?? fetch;
    this.log = options.log ?? createLogger("buyer");
    this.opts = {
      requestTimeoutMs: options.requestTimeoutMs ?? 50_000,
      confirmOnChain: options.confirmOnChain ?? true,
      pollIntervalMs: options.pollIntervalMs ?? 4_000,
      expiryGraceMs: options.expiryGraceMs ?? 15_000,
    };

    this.x402 = new x402Client();
    // Sign for Base Sepolia only, cap any single payment at the 0.10 USDC rule, and refuse to sign any
    // option the price check did not approve for this exact call.
    registerExactEvmScheme(this.x402, { signer: options.account, networks: [NETWORK] });
    this.x402.setSpendControls({ maxAmountPerPayment: "$0.10" });
    this.x402.onBeforePaymentCreation(async ({ selectedRequirements }) => {
      const key = fingerprint(selectedRequirements);
      const count = this.approved.get(key) ?? 0;
      if (count <= 0) return { abort: true as const, reason: "payment option was not approved by the price check" };
      return undefined;
    });
    this.http = new x402HTTPClient(this.x402);
  }

  /** Waits for every background resolution and confirmation, then flushes the sinks. */
  async drain(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
    await Promise.allSettled(this.sinks.map((s) => s.flush?.()));
  }

  async payAndCall(req: CallRequest): Promise<CallOutcome> {
    const { listing, budget } = req;
    const started = this.clock.now();
    const row = this.newRow(req);
    const { url, init } = buildRequest(listing, req.input ?? {});
    const timeoutMs = req.timeoutMs ?? this.opts.requestTimeoutMs;
    const signal = () => (req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs));
    const done = (state: LedgerState, code: ReasonCode, reason: string | null, extra: Partial<CallOutcome> = {}) => {
      Object.assign(row, { status: state, reasonCode: code, reason, latencyMs: Math.round(this.clock.now() - started) });
      this.record(row);
      return { row: { ...row }, finalized: Promise.resolve({ ...row }), ...extra } satisfies CallOutcome;
    };

    // 1. Unpaid request.
    let first: Response;
    try {
      first = await this.fetch(url, { ...init, signal: signal() });
    } catch (err) {
      return done("failed_not_charged", "seller_unreachable", `could not reach the seller: ${errorText(err)}`);
    }
    row.httpStatus = first.status;
    if (first.status !== 402) {
      const body = await readBody(first);
      if (!first.ok) return done("failed_not_charged", "seller_error", `seller answered ${first.status} before payment: ${summarise(body)}`);
      // Served without asking for payment: nothing to pay; still hold it to the listed schema.
      const verdict = this.validate(listing, body);
      if (verdict.ok) return done("paid", "free", "seller served the request without asking for payment", { output: body.value });
      return done("failed_not_charged", "output_invalid", `free response broke the listed schema: ${verdict.errors.join("; ")}`, {
        validationErrors: verdict.errors,
      });
    }

    // 2. Price check.
    let required: PaymentRequired;
    try {
      const body = await readBody(first);
      required = this.http.getPaymentRequiredResponse((n) => first.headers.get(n), body.value);
    } catch (err) {
      return done("refused", "bad_402", `402 could not be decoded: ${errorText(err)}`);
    }
    const check = checkPaymentRequired(required, listing);
    if (!check.ok) {
      row.askedUnits = check.askedUnits;
      return done("refused", check.code, check.reason);
    }
    const chosen = check.chosen;
    const amount = BigInt(chosen.amount);
    row.askedUnits = chosen.amount;
    row.payTo = chosen.payTo;

    // 3. Budget.
    const reservation = budget.reserve(amount, `${listing.id} ${row.id}`);
    if (!reservation) {
      return done(
        "refused",
        "budget",
        `needs ${fromUnits(amount)} USDC but only ${fromUnits(budget.remaining)} is free (${fromUnits(budget.spent)} spent, ${fromUnits(budget.reserved)} reserved of ${fromUnits(budget.total)})`,
      );
    }

    // 4. Sign exactly the approved option.
    let payload: PaymentPayload;
    try {
      payload = await this.sign(required, chosen);
    } catch (err) {
      budget.release(reservation);
      return done("refused", "signing_blocked", `signing refused: ${errorText(err)}`);
    }
    const auth = (payload.payload as { authorization?: { from: string; to: string; value: string; validBefore: string; nonce: string } }).authorization;
    if (!auth || auth.value !== chosen.amount || auth.to.toLowerCase() !== chosen.payTo.toLowerCase() || auth.from.toLowerCase() !== this.address.toLowerCase()) {
      budget.release(reservation); // never sent
      return done("refused", "signing_blocked", "signed authorisation does not match the approved option; not sent");
    }
    row.nonce = auth.nonce;
    row.validBefore = Number(auth.validBefore);
    row.status = "pending";
    row.reason = "payment sent, awaiting the seller";
    this.record(row); // durable before the payment leaves this process

    // 5. Paid request.
    let paid: Response;
    try {
      paid = await this.fetch(url, { ...init, headers: { ...init.headers, ...this.http.encodePaymentSignatureHeader(payload) }, signal: signal() });
    } catch (err) {
      if (neverConnected(err)) {
        budget.release(reservation); // the signature never left this machine
        return done("failed_not_charged", "seller_unreachable", `could not reach the seller: ${errorText(err)}`);
      }
      Object.assign(row, { status: "pending", reasonCode: "no_response", reason: `no answer after paying (${errorText(err)}); checking the chain`, latencyMs: Math.round(this.clock.now() - started) });
      this.record(row);
      return { row: { ...row }, finalized: this.track(this.resolveOnChain(row, reservation, budget, "poll", false)) };
    }

    // 6. Classify.
    row.httpStatus = paid.status;
    const body = await readBody(paid);
    const settle = decodeSettle(paid.headers);

    if (settle?.success && settle.transaction) {
      budget.commit(reservation, amount);
      Object.assign(row, { paidUnits: chosen.amount, txHash: settle.transaction, explorerUrl: txUrl(settle.transaction) });
      const verdict = paid.ok ? this.validate(listing, body) : { ok: false as const, errors: [`HTTP ${paid.status}`] };
      const outcome = verdict.ok
        ? done("paid", "ok", null, { output: body.value })
        : done("paid_output_rejected", "output_invalid", `paid, but the output broke the listed schema: ${verdict.errors.join("; ")}`, {
            validationErrors: verdict.errors,
          });
      return { ...outcome, finalized: this.track(this.confirmPaid(row, chosen)) };
    }

    if (!paid.ok) {
      const { code, text } = explainFailure(paid, body, settle);
      const outcome = done("failed_not_charged", code, `${text}; reservation held until the authorisation expires unused`);
      return { ...outcome, finalized: this.track(this.resolveOnChain(row, reservation, budget, "expiry", false)) };
    }

    // 2xx without a successful receipt: we may or may not have paid. Find out on-chain.
    const verdict = this.validate(listing, body);
    Object.assign(row, {
      status: "pending",
      reasonCode: "no_receipt",
      reason: "seller answered without a PAYMENT-RESPONSE receipt; checking the chain",
      latencyMs: Math.round(this.clock.now() - started),
    });
    this.record(row);
    return {
      row: { ...row },
      ...(verdict.ok ? { output: body.value } : { validationErrors: verdict.errors }),
      finalized: this.track(this.resolveOnChain(row, reservation, budget, "poll", verdict.ok)),
    };
  }

  // ---------- internals ----------

  private newRow(req: CallRequest): LedgerRow {
    const now = new Date(this.clock.now()).toISOString();
    return {
      id: randomUUID(),
      time: now,
      updatedAt: now,
      sessionId: this.sessionId,
      taskId: req.taskId ?? "adhoc",
      buyer: this.address,
      sellerId: req.listing.sellerId,
      serviceId: req.listing.id,
      endpoint: req.listing.endpoint,
      payTo: req.listing.payTo,
      listedUnits: req.listing.priceUnits,
      askedUnits: null,
      paidUnits: "0",
      status: "pending",
      reasonCode: "ok",
      reason: null,
      txHash: null,
      explorerUrl: null,
      nonce: null,
      validBefore: null,
      httpStatus: null,
      latencyMs: 0,
      onchainConfirmed: null,
    };
  }

  private record(row: LedgerRow) {
    row.updatedAt = new Date(this.clock.now()).toISOString();
    const snapshot = { ...row };
    for (const sink of this.sinks) {
      try {
        const result = sink.record(snapshot);
        if (result instanceof Promise) result.catch((err) => this.log.warn("ledger sink failed", { err }));
      } catch (err) {
        this.log.warn("ledger sink failed", { err });
      }
    }
  }

  private async sign(required: PaymentRequired, chosen: PaymentRequirements): Promise<PaymentPayload> {
    const key = fingerprint(chosen);
    this.approved.set(key, (this.approved.get(key) ?? 0) + 1);
    try {
      // Offer the signer only the approved option.
      return await this.x402.createPaymentPayload({ ...required, accepts: [chosen] });
    } finally {
      const left = (this.approved.get(key) ?? 1) - 1;
      if (left > 0) this.approved.set(key, left);
      else this.approved.delete(key);
    }
  }

  private validate(listing: Listing, body: ParsedBody): { ok: true } | { ok: false; errors: string[] } {
    if (!body.json) return { ok: false, errors: [body.error ?? "response is not JSON"] };
    const cacheKey = `${listing.id}:${JSON.stringify(listing.outputSchema).length}:${listing.priceUnits}`;
    if (!this.validators.has(cacheKey)) {
      try {
        this.validators.set(cacheKey, compileSchema(listing.outputSchema));
      } catch {
        this.validators.set(cacheKey, null);
      }
    }
    const validate = this.validators.get(cacheKey);
    if (!validate) return { ok: false, errors: ["the listing's output schema is invalid"] };
    return validate(body.value) ? { ok: true } : { ok: false, errors: formatErrors(validate.errors) };
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.background.add(promise);
    void promise.finally(() => this.background.delete(promise)).catch(() => {});
    return promise;
  }

  /** Waits for the settlement receipt and checks it moved exactly the asked amount buyer -> payTo. */
  private async confirmPaid(row: LedgerRow, chosen: PaymentRequirements): Promise<LedgerRow> {
    if (!this.opts.confirmOnChain || !row.txHash) return { ...row };
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await this.chain.confirmTransfer(
          row.txHash as Hex,
          { from: this.address, to: chosen.payTo as Address, amount: BigInt(chosen.amount) },
          { wait: true },
        );
        row.onchainConfirmed = result.confirmed;
        if (!result.confirmed) {
          row.reason = `${row.reason ? row.reason + "; " : ""}WARNING: the receipt does not show exactly this transfer`;
          this.log.warn("settlement receipt did not match", { id: row.id, tx: row.txHash });
        }
        this.record(row);
        return { ...row };
      } catch (err) {
        if (attempt === 3) this.log.warn("could not confirm settlement on-chain yet", { id: row.id, tx: row.txHash, err });
        else await this.clock.sleep(2000 * attempt);
      }
    }
    return { ...row };
  }

  /**
   * Decides a signed-but-unsettled payment from the chain itself.
   * "poll": check every few seconds (we do not know what happened).
   * "expiry": the seller said it failed; check once the authorisation can no longer be used.
   * Either way the reservation stays held until the answer is certain.
   */
  private async resolveOnChain(row: LedgerRow, reservation: Reservation, budget: Budget, mode: "poll" | "expiry", outputUsable: boolean): Promise<LedgerRow> {
    const from = this.address;
    const nonce = row.nonce as Hex;
    const deadline = (row.validBefore ?? 0) * 1000 + this.opts.expiryGraceMs;
    let rpcFailures = 0;

    for (;;) {
      const now = this.clock.now();
      if (mode === "poll" || now >= deadline) {
        let used: boolean;
        try {
          used = await this.chain.authorizationUsed(from, nonce);
          rpcFailures = 0;
        } catch (err) {
          if (++rpcFailures >= 10) {
            this.log.error("cannot read authorisation state; leaving the reservation held", { id: row.id, err });
            return { ...row };
          }
          await this.clock.sleep(this.opts.pollIntervalMs);
          continue;
        }

        if (used) {
          const tx = await this.chain.findAuthorizationTx(from, nonce).catch(() => null);
          budget.commit(reservation, reservation.amount);
          const wasExplicitFailure = row.status === "failed_not_charged";
          Object.assign(row, {
            paidUnits: reservation.amount.toString(),
            txHash: tx,
            explorerUrl: tx ? txUrl(tx) : null,
            onchainConfirmed: true,
          });
          if (wasExplicitFailure) {
            Object.assign(row, { status: "paid_output_rejected", reasonCode: "settled_despite_error", reason: "seller reported a failure but settled the payment anyway" });
          } else if (outputUsable) {
            Object.assign(row, { status: "paid", reasonCode: "ok", reason: "settled (receipt recovered from the chain)" });
          } else {
            Object.assign(row, { status: "paid_output_rejected", reasonCode: row.reasonCode, reason: "settled on-chain, but no usable result was received" });
          }
          this.log.warn("payment settled without a normal receipt", { id: row.id, tx, service: row.serviceId });
          this.record(row);
          return { ...row };
        }

        if (now >= deadline) {
          budget.release(reservation);
          Object.assign(row, {
            status: "failed_not_charged",
            reasonCode: row.reasonCode,
            reason: `${(row.reason ?? "").replace(/; reservation held until the authorisation expires unused$/, "").replace(/; checking the chain$/, "")}; authorisation expired unused (confirmed on-chain)`,
            onchainConfirmed: true,
          });
          this.record(row);
          return { ...row };
        }
      }
      const wait = mode === "poll" ? this.opts.pollIntervalMs : Math.max(deadline - this.clock.now(), 0);
      await this.clock.sleep(Math.min(wait, Math.max(deadline - this.clock.now(), 0)) || this.opts.pollIntervalMs);
    }
  }
}

// ---------- helpers ----------

export function buildRequest(listing: Listing, input: Record<string, unknown>): { url: string; init: RequestInit & { headers: Record<string, string> } } {
  const url = new URL(listing.endpoint);
  const headers: Record<string, string> = { accept: "application/json" };
  if (listing.method === "GET") {
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, typeof v === "object" ? JSON.stringify(v) : String(v));
      else url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    return { url: url.href, init: { method: "GET", headers } };
  }
  headers["content-type"] = "application/json";
  return { url: url.href, init: { method: "POST", headers, body: JSON.stringify(input) } };
}

interface ParsedBody {
  json: boolean;
  value: unknown;
  text: string;
  error?: string;
}

async function readBody(res: Response): Promise<ParsedBody> {
  let text = "";
  try {
    text = await res.text();
  } catch (err) {
    return { json: false, value: undefined, text: "", error: `body could not be read: ${errorText(err)}` };
  }
  if (text.length > MAX_BODY_BYTES) return { json: false, value: undefined, text: "", error: "response body too large" };
  try {
    return { json: true, value: JSON.parse(text), text };
  } catch {
    return { json: false, value: undefined, text, error: "response is not valid JSON" };
  }
}

function decodeSettle(headers: Headers): SettleResponse | null {
  const raw = headers.get("PAYMENT-RESPONSE") ?? headers.get("X-PAYMENT-RESPONSE");
  if (!raw) return null;
  try {
    return decodePaymentResponseHeader(raw);
  } catch {
    return null;
  }
}

function explainFailure(res: Response, body: ParsedBody, settle: SettleResponse | null): { code: ReasonCode; text: string } {
  if (res.status === 402) {
    let error = "payment rejected";
    const header = res.headers.get("PAYMENT-REQUIRED");
    if (header) {
      try {
        error = decodePaymentRequiredHeader(header).error ?? error;
      } catch {
        // keep the generic text
      }
    }
    return { code: settle && !settle.success ? "settle_failed" : "verify_failed", text: `seller rejected the payment (${error})` };
  }
  if (res.status === 409) return { code: "replay_rejected", text: "seller refused the payment as already used" };
  return { code: "seller_error", text: `seller answered ${res.status}: ${summarise(body)}` };
}

function summarise(body: ParsedBody): string {
  if (body.json && body.value && typeof body.value === "object") {
    const v = body.value as { error?: unknown; message?: unknown };
    const parts = [v.error, v.message].filter((x): x is string => typeof x === "string");
    if (parts.length) return parts.join(": ").slice(0, 300);
  }
  return (body.text || body.error || "no body").slice(0, 200);
}

function neverConnected(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
  return typeof code === "string" && PRE_CONNECT_ERRORS.has(code);
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (err.name === "TimeoutError" || err.name === "AbortError") return "timed out";
    return cause?.code ? `${err.message} (${cause.code})` : err.message;
  }
  return String(err);
}

// The buyer's spending limit. Invariant, checked after every operation:
//
//     spent + reserved <= total
//
// reserve() is synchronous (no await between the check and the add), and Node runs JavaScript on one
// thread, so any number of concurrent calls can race for the same budget and the invariant still holds.
// Money is reserved BEFORE an authorisation is signed and only released once it provably cannot move.

import { fromUnits } from "@dron/shared";

export type ReservationState = "held" | "committed" | "released";

export interface Reservation {
  readonly id: number;
  readonly amount: bigint;
  readonly label: string;
  state: ReservationState;
}

export interface BudgetSnapshot {
  total: bigint;
  spent: bigint;
  reserved: bigint;
  remaining: bigint;
  /** Number of reservations still held (signed or about to be signed, outcome not final). */
  held: number;
}

export type BudgetEvent =
  | { type: "reserve"; reservation: Reservation }
  | { type: "refuse"; amount: bigint; label: string }
  | { type: "commit"; reservation: Reservation; paid: bigint }
  | { type: "release"; reservation: Reservation }
  | { type: "increase"; amount: bigint };

export class BudgetError extends Error {}

export class Budget {
  private _spent = 0n;
  private _reserved = 0n;
  private nextId = 1;
  private readonly held = new Map<number, Reservation>();
  private readonly listeners = new Set<(event: BudgetEvent, snapshot: BudgetSnapshot) => void>();
  private waiters: (() => void)[] = [];
  private _total: bigint;

  constructor(total: bigint) {
    if (total < 0n) throw new BudgetError("budget cannot be negative");
    this._total = total;
  }

  get total() {
    return this._total;
  }
  get spent() {
    return this._spent;
  }
  get reserved() {
    return this._reserved;
  }
  get remaining() {
    return this._total - this._spent - this._reserved;
  }

  /** Raises the limit (a human approved more spend). Budgets only ever grow; they never shrink under held money. */
  increase(amount: bigint): void {
    if (amount <= 0n) throw new BudgetError("a top-up must be positive");
    this._total += amount;
    this.check();
    this.emit({ type: "increase", amount });
  }

  /** Atomically sets aside `amount`, or returns null if that would exceed the budget. */
  reserve(amount: bigint, label = ""): Reservation | null {
    if (amount <= 0n) throw new BudgetError("reservation amount must be positive");
    if (this._spent + this._reserved + amount > this.total) {
      this.emit({ type: "refuse", amount, label });
      return null;
    }
    const reservation: Reservation = { id: this.nextId++, amount, label, state: "held" };
    this._reserved += amount;
    this.held.set(reservation.id, reservation);
    this.check();
    this.emit({ type: "reserve", reservation });
    return reservation;
  }

  /** Converts a held reservation into spend. `paid` may be lower than reserved (the rest is freed), never higher. */
  commit(reservation: Reservation, paid: bigint = reservation.amount): void {
    this.assertHeld(reservation);
    if (paid < 0n || paid > reservation.amount) {
      throw new BudgetError(`cannot commit ${paid} against a reservation of ${reservation.amount}`);
    }
    this._reserved -= reservation.amount;
    this._spent += paid;
    reservation.state = "committed";
    this.held.delete(reservation.id);
    this.check();
    this.emit({ type: "commit", reservation, paid });
  }

  /** Frees a held reservation (the payment provably did not and cannot move money). Idempotent. */
  release(reservation: Reservation): void {
    if (reservation.state !== "held") return;
    this.assertOwned(reservation);
    this._reserved -= reservation.amount;
    reservation.state = "released";
    this.held.delete(reservation.id);
    this.check();
    this.emit({ type: "release", reservation });
  }

  snapshot(): BudgetSnapshot {
    return { total: this._total, spent: this._spent, reserved: this._reserved, remaining: this.remaining, held: this.held.size };
  }

  describe(): string {
    const s = this.snapshot();
    return `${fromUnits(s.spent)} spent + ${fromUnits(s.reserved)} reserved of ${fromUnits(s.total)} USDC (${fromUnits(s.remaining)} left)`;
  }

  onChange(listener: (event: BudgetEvent, snapshot: BudgetSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Resolves on the next commit or release (or after `timeoutMs`). Lets a planner wait for held
   * reservations to settle instead of giving up while money is only temporarily locked.
   */
  waitForChange(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(done);
    });
  }

  private emit(event: BudgetEvent) {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(event, snapshot);
      } catch {
        // listeners must not break accounting
      }
    }
    if (event.type === "commit" || event.type === "release" || event.type === "increase") {
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    }
  }

  private assertHeld(reservation: Reservation) {
    this.assertOwned(reservation);
    if (reservation.state !== "held") throw new BudgetError(`reservation ${reservation.id} is already ${reservation.state}`);
  }

  private assertOwned(reservation: Reservation) {
    if (this.held.get(reservation.id) !== reservation && reservation.state === "held") {
      throw new BudgetError("reservation does not belong to this budget");
    }
  }

  private check() {
    if (this._reserved < 0n || this._spent < 0n || this._spent + this._reserved > this._total) {
      throw new BudgetError(`budget invariant violated: ${this.describe()}`);
    }
  }
}

export const createBudget = (total: bigint) => new Budget(total);

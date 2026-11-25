import { PoolError } from "./errors.js";
import {
  aAt,
  applyEvent,
  calcTokenAmount,
  calcWithdrawOneCoin,
  getDx,
  getDy,
  initialState,
  poolMode,
  validateParams,
  virtualPrice,
  type PoolMode,
} from "./machine.js";
import type { Amount, CoinIndex, Height, PartyId, PoolEvent, PoolParams, PoolState, Receipt } from "./types.js";

export type AppendResult =
  | { readonly ok: true; readonly event: PoolEvent; readonly receipt: Receipt; readonly state: PoolState }
  | { readonly ok: false; readonly error: PoolError };

/** Copies and freezes an event, including its arrays, so the recorded log cannot be changed afterwards. */
function freezeEvent(event: PoolEvent): PoolEvent {
  if (event === null || typeof event !== "object") return event;
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) copy[k] = Array.isArray(v) ? Object.freeze([...v]) : v;
  return Object.freeze(copy) as unknown as PoolEvent;
}

/** Freezes the committed state (shares stay a Map, exposed as ReadonlyMap). */
function freezeState(state: PoolState): PoolState {
  const t = state.totals;
  for (const a of [state.balances, state.adminBalances, state.rates, state.rateUpdatedAt, state.backing, t.deposited, t.withdrawn, t.adminWithdrawn, t.writtenDown]) {
    Object.freeze(a);
  }
  for (const b of state.backing) if (b !== null) Object.freeze(b);
  if (state.pendingFees !== null) Object.freeze(state.pendingFees);
  Object.freeze(state.ramp);
  Object.freeze(t);
  return Object.freeze(state);
}

/** Called synchronously after an event is committed. Must not append (REENTRANCY). */
export type PoolListener = (event: PoolEvent, receipt: Receipt, state: PoolState) => void;

/**
 * Append-only event ledger. The event list is the only source of truth; the
 * state is a cache that `replay(params, events)` rebuilds exactly. Appends are
 * atomic: a rejected event leaves the ledger untouched.
 *
 * One lock spans every state-changing entry point. State is committed before
 * listeners run (checks-effects-interactions), any append attempted from a
 * listener fails with REENTRANCY, and a failing listener reverts the append.
 */
export class PoolLedger {
  readonly params: PoolParams;
  #events: PoolEvent[] = [];
  #receipts: Receipt[] = [];
  #state: PoolState;
  #locked = false;
  #listeners = new Set<PoolListener>();

  constructor(params: PoolParams) {
    validateParams(params);
    this.params = Object.freeze({ ...params, coins: Object.freeze(params.coins.map((c) => Object.freeze({ ...c }))) });
    this.#state = freezeState(initialState(this.params));
  }

  /** Rebuilds a ledger from a recorded event log, re-validating every event. */
  static fromEvents(params: PoolParams, events: readonly PoolEvent[]): PoolLedger {
    const ledger = new PoolLedger(params);
    for (const event of events) ledger.append(event);
    return ledger;
  }

  /**
   * Validates and records `event`, or throws without changing anything.
   * Listeners run after the commit; if one throws (including a REENTRANCY
   * error it did not catch), the whole append is undone, like a reverted
   * transaction, and the error propagates.
   */
  append(event: PoolEvent): Receipt {
    if (this.#locked) throw new PoolError("REENTRANCY", "append called while the ledger is locked");
    this.#locked = true;
    const previous = this.#state;
    const length = this.#events.length;
    try {
      const frozen = freezeEvent(event);
      const applied = applyEvent(this.#state, frozen, this.params);
      const state = freezeState(applied.state);
      const receipt = Object.freeze(applied.receipt);
      this.#events.push(frozen);
      this.#receipts.push(receipt);
      this.#state = state;
      for (const listener of [...this.#listeners]) listener(frozen, receipt, state);
      return receipt;
    } catch (error) {
      this.#events.length = length;
      this.#receipts.length = length;
      this.#state = previous;
      throw error;
    } finally {
      this.#locked = false;
    }
  }

  /** Like `append`, but returns a result instead of throwing PoolError. */
  tryAppend(event: PoolEvent): AppendResult {
    try {
      const receipt = this.append(event);
      return { ok: true, event: this.#events[this.#events.length - 1] as PoolEvent, receipt, state: this.#state };
    } catch (error) {
      if (error instanceof PoolError) return { ok: false, error };
      throw error;
    }
  }

  subscribe(listener: PoolListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get events(): readonly PoolEvent[] {
    return this.#events.slice();
  }

  get receipts(): readonly Receipt[] {
    return this.#receipts.slice();
  }

  get state(): PoolState {
    return this.#state;
  }

  get head(): Height | null {
    return this.#state.head;
  }

  sharesOf(who: PartyId): Amount {
    return this.#state.shares.get(who) ?? 0n;
  }

  mode(height: Height): PoolMode {
    return poolMode(this.#state, this.params, height);
  }

  A(height: Height): bigint {
    return aAt(this.#state, height);
  }

  getDy(i: CoinIndex, j: CoinIndex, dx: Amount, height: Height): Amount {
    return getDy(this.#state, this.params, height, i, j, dx);
  }

  getDx(i: CoinIndex, j: CoinIndex, dy: Amount, height: Height): Amount {
    return getDx(this.#state, this.params, height, i, j, dy);
  }

  calcTokenAmount(amounts: readonly Amount[], isDeposit: boolean, height: Height): Amount {
    return calcTokenAmount(this.#state, this.params, height, amounts, isDeposit);
  }

  calcWithdrawOneCoin(shares: Amount, coin: CoinIndex, height: Height): Amount {
    return calcWithdrawOneCoin(this.#state, this.params, height, shares, coin);
  }

  virtualPrice(height: Height): bigint {
    return virtualPrice(this.#state, this.params, height);
  }
}

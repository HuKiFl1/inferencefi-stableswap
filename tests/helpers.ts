import { expect } from "vitest";
import {
  A_PRECISION,
  PoolError,
  PoolLedger,
  getD,
  xpOf,
  ampAt,
  type Amount,
  type CoinConfig,
  type PoolErrorCode,
  type PoolEvent,
  type PoolParams,
  type PoolState,
} from "../src/index.js";

export const RUNS = Number(process.env.PROPERTY_RUNS ?? 200);

export const E18 = 10n ** 18n;
export const E6 = 10n ** 6n;
export const ADMIN = "admin";

/** credit[model-x] from three providers: one 18-decimal and two 6-decimal vouchers. */
export const COINS3: CoinConfig[] = [
  { symbol: "credit[x,p1]", rate: E18 },
  { symbol: "credit[x,p2]", rate: 10n ** 30n },
  { symbol: "credit[x,p3]", rate: 10n ** 30n },
];

export function params(overrides: Partial<PoolParams> = {}): PoolParams {
  return {
    coins: COINS3,
    A: 200n,
    fee: 4_000_000n,
    adminFee: 5_000_000_000n,
    admin: ADMIN,
    minRampBlocks: 100n,
    adminDelayBlocks: 50n,
    minimumLiquidity: 1_000n,
    minInitialD: E18,
    minTradeAmount: 1_000_000n,
    maxRateChangeBps: 1_000n,
    minRateUpdateBlocks: 10n,
    stalenessBlocks: 10n,
    challengeWindowBlocks: 5n,
    ...overrides,
  };
}

/** Whole tokens -> native units for COINS3. */
export function units(a: bigint, b: bigint, c: bigint): Amount[] {
  return [a * E18, b * E6, c * E6];
}

export function bootstrapped(p: PoolParams = params(), amounts: readonly Amount[] = units(1_000_000n, 1_000_000n, 1_000_000n)): PoolLedger {
  const ledger = new PoolLedger(p);
  ledger.append({ type: "AddLiquidity", height: 1n, by: "lp0", amounts, minMint: 0n });
  return ledger;
}

export function expectCode(fn: () => unknown, code: PoolErrorCode): PoolError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected PoolError ${code}`).toBeInstanceOf(PoolError);
  expect((caught as PoolError).code, (caught as Error).message).toBe(code);
  return caught as PoolError;
}

/** A rejected append must leave events, receipts and state exactly as they were. */
export function expectRejectedAtomically(ledger: PoolLedger, event: PoolEvent, code: PoolErrorCode): void {
  const events = ledger.events;
  const receipts = ledger.receipts;
  const state = ledger.state;
  expectCode(() => ledger.append(event), code);
  expect(ledger.events).toEqual(events);
  expect(ledger.receipts).toEqual(receipts);
  expect(ledger.state).toBe(state);
}

export function dOf(state: PoolState, height: bigint): bigint {
  return getD(xpOf(state.balances, state.rates), ampAt(state.ramp, height));
}

const prod = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => a * b, 1n);
const sum = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

/**
 * Exact (rational, no Newton) check that `after` lies on or above the level
 * set of the StableSwap invariant through `before` at the fixed D. In Curve's
 * code convention (Ann = A·n, i.e. code A = paper A·nⁿ⁻¹) the invariant is
 *   Ann·Σx + D = Ann·D + D^(n+1) / (nⁿ·Πx),
 * so at fixed D the state function is F(x) = Ann·Σx − D^(n+1) / (nⁿ·Πx),
 * increasing in every x. We require F(after) >= F(before), cross-multiplied
 * by A_PRECISION·nⁿ·Πa·Πb > 0 so it stays in integers.
 */
export function invariantNotDecreased(before: readonly bigint[], after: readonly bigint[], d: bigint, amp: bigint): boolean {
  const n = BigInt(before.length);
  const pa = prod(after);
  const pb = prod(before);
  const lhs = amp * n * n ** n * pa * pb * (sum(after) - sum(before));
  const rhs = A_PRECISION * d ** (n + 1n) * (pb - pa);
  return lhs >= rhs;
}

/** Conservation per coin: deposited − withdrawn − adminWithdrawn − writtenDown = balance + adminBalance. */
export function expectConservation(state: PoolState): void {
  state.balances.forEach((b, k) => {
    const t = state.totals;
    const inflow = t.deposited[k]! - t.withdrawn[k]! - t.adminWithdrawn[k]! - t.writtenDown[k]!;
    expect(inflow, `coin ${k} conservation`).toBe(b + state.adminBalances[k]!);
    expect(b >= 0n && state.adminBalances[k]! >= 0n).toBe(true);
  });
  let held = 0n;
  for (const v of state.shares.values()) {
    expect(v > 0n).toBe(true);
    held += v;
  }
  expect(held, "share conservation").toBe(state.supply);
}

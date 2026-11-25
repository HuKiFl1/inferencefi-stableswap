import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FEE_DENOMINATOR,
  PRECISION,
  PoolLedger,
  ampAt,
  getDUp,
  invariantResidual,
  isPoolError,
  xpOf,
  type CoinConfig,
  type PoolEvent,
  type PoolParams,
} from "../src/index.js";
import { E18, RUNS, params } from "./helpers.js";

/**
 * Balancer CSP (Nov 2025) was drained through many tiny swaps in a low-liquidity
 * state, where each scaled amount lost almost a full unit to one-directional
 * rounding. These properties search exactly that region: pools just above
 * minInitialD, trade sizes near minTradeAmount, rates with non-trivial low
 * digits, and amounts nudged to maximise `amount·rate mod 1e18`.
 */

const awkwardRate = fc.oneof(
  fc.bigInt({ min: 0n, max: 10n ** 17n }).map((c) => E18 + c),
  fc.bigInt({ min: 0n, max: 10n ** 29n }).map((c) => 10n ** 30n - c),
  fc.bigInt({ min: 10n ** 17n, max: 10n ** 19n }),
);

/** Moves `a` (by < 2000) to the value with the largest `a·rate mod 1e18`, i.e. the largest truncation loss. */
function worstRemainder(a: bigint, rate: bigint): bigint {
  let best = a;
  let bestRem = -1n;
  for (let k = 0n; k < 2_000n; k++) {
    const rem = ((a + k) * rate) % PRECISION;
    if (rem > bestRem) [best, bestRem] = [a + k, rem];
  }
  return best;
}

interface Setup {
  readonly p: PoolParams;
  readonly initial: readonly bigint[];
}

const setupArb: fc.Arbitrary<Setup> = fc
  .record({
    rates: fc.array(awkwardRate, { minLength: 2, maxLength: 3 }),
    A: fc.oneof(fc.constant(1n), fc.bigInt({ min: 2n, max: 5_000n })),
    fee: fc.oneof(fc.constant(0n), fc.bigInt({ min: 1n, max: 10_000_000n })),
    // Total normalised liquidity of about 1-50 whole units: barely above minInitialD.
    weights: fc.array(fc.bigInt({ min: 1n, max: 50n }), { minLength: 3, maxLength: 3 }),
  })
  .map(({ rates, A, fee, weights }) => {
    const coins: CoinConfig[] = rates.map((rate, k) => ({ symbol: `c${k}`, rate }));
    const p = params({ coins, A, fee, adminFee: 5_000_000_000n, minInitialD: E18, minTradeAmount: 1_000_000n });
    // Native amount that is `w` whole normalised units.
    const initial = rates.map((r, k) => (weights[k]! * E18 * PRECISION + r - 1n) / r);
    return { p, initial };
  });

function boot(s: Setup): PoolLedger | null {
  const ledger = new PoolLedger(s.p);
  const r = ledger.tryAppend({ type: "AddLiquidity", height: 1n, by: "lp0", amounts: s.initial, minMint: 0n });
  return r.ok ? ledger : null;
}

const dust = (rate: bigint, f: bigint): bigint => worstRemainder((f * 1_000_000n * PRECISION) / rate + 1n, rate);

function accepted(ledger: PoolLedger, e: PoolEvent): boolean {
  const r = ledger.tryAppend(e);
  if (!r.ok) expect(isPoolError(r.error)).toBe(true);
  return r.ok;
}

/** Guards against vacuous properties: at least `share` of the runs must reach the assertion. */
function coverage(share: number) {
  let hits = 0;
  return {
    hit: () => void (hits += 1),
    check: () => expect(hits, `only ${hits}/${RUNS} runs reached the assertion`).toBeGreaterThanOrEqual(Math.floor(RUNS * share)),
  };
}

describe("rounding favours the pool on every path, in the dust region", () => {
  it("exact-in swap: the post-trade LP balances stay on or above the pre-trade curve (exact residual), and the fee is at least the rational fee", () => {
    const cov = coverage(0.3);
    fc.assert(
      fc.property(setupArb, fc.nat({ max: 2 }), fc.nat({ max: 2 }), fc.bigInt({ min: 1n, max: 100_000n }), (s, ii, jj, f) => {
        const n = s.p.coins.length;
        const [i, j] = [ii % n, jj % n];
        if (i === j) return;
        const ledger = boot(s);
        if (ledger === null) return;
        const before = ledger.state;
        const amp = ampAt(before.ramp, 2n);
        let d0: bigint;
        try {
          d0 = getDUp(xpOf(before.balances, before.rates), amp);
        } catch {
          return;
        }
        const dx = dust(s.p.coins[i]!.rate, f);
        const r = ledger.tryAppend({ type: "Exchange", height: 2n, by: "t", i, j, dx, minDy: 0n });
        if (!r.ok || r.receipt.type !== "Exchange") return;
        const after = ledger.state;
        // LP balances include the LP fee, so this holds with and without fees.
        expect(invariantResidual(xpOf(after.balances, after.rates), d0, amp) >= 0n).toBe(true);
        // Admin share leaves the pool; even without it the trader's side alone keeps the curve.
        const withAdmin = after.balances.map((b, k) => b + (k === j ? r.receipt.type === "Exchange" ? r.receipt.adminFee : 0n : 0n));
        expect(invariantResidual(xpOf(withAdmin, after.rates), d0, amp) >= 0n).toBe(true);
        const dyXpFloor = (r.receipt.dy * s.p.coins[j]!.rate) / PRECISION;
        expect(r.receipt.feeXp * FEE_DENOMINATOR >= s.p.fee * (r.receipt.feeXp + dyXpFloor)).toBe(true);
        cov.hit();
      }),
      { numRuns: RUNS },
    );
    cov.check();
  });

  it("exact-out swap: the input is the smallest dx whose exact-in quote covers dy (rounded up), and pays exactly dy", () => {
    const cov = coverage(0.5);
    fc.assert(
      fc.property(setupArb, fc.bigInt({ min: 1n, max: 100_000n }), (s, f) => {
        const ledger = boot(s);
        if (ledger === null) return;
        const dy = dust(s.p.coins[1]!.rate, f);
        let dx: bigint;
        try {
          dx = ledger.getDx(0, 1, dy, 2n);
        } catch (error) {
          expect(isPoolError(error)).toBe(true);
          return;
        }
        expect(ledger.getDy(0, 1, dx, 2n) >= dy).toBe(true);
        try {
          expect(ledger.getDy(0, 1, dx - 1n, 2n) < dy).toBe(true);
        } catch (error) {
          expect(isPoolError(error)).toBe(true);
        }
        const r = ledger.append({ type: "ExchangeExactOut", height: 2n, by: "t", i: 0, j: 1, dy, maxDx: dx });
        expect(r.type === "ExchangeExactOut" && r.dy).toBe(dy);
        cov.hit();
      }),
      { numRuns: RUNS },
    );
    cov.check();
  });

  it("round trips never profit: swap there and back, deposit then single-coin exit, imbalanced withdraw then re-deposit", () => {
    const covSwap = coverage(0.3);
    const covAdd = coverage(0.3);
    const covBurn = coverage(0.3);
    fc.assert(
      fc.property(setupArb, fc.bigInt({ min: 1n, max: 2_000_000n }), (s, f) => {
        const ledger = boot(s);
        if (ledger === null) return;
        const dx = dust(s.p.coins[0]!.rate, f);

        const there = ledger.tryAppend({ type: "Exchange", height: 2n, by: "t", i: 0, j: 1, dx, minDy: 0n });
        if (there.ok && there.receipt.type === "Exchange") {
          const back = ledger.tryAppend({ type: "Exchange", height: 2n, by: "t", i: 1, j: 0, dx: there.receipt.dy, minDy: 0n });
          if (back.ok && back.receipt.type === "Exchange") {
            expect(back.receipt.dy <= dx).toBe(true);
            covSwap.hit();
          }
        }

        const add = ledger.tryAppend({ type: "AddLiquidity", height: 3n, by: "lp9", amounts: s.initial.map((_, k) => (k === 0 ? dx : 0n)), minMint: 0n });
        if (add.ok && add.receipt.type === "AddLiquidity") {
          const out = ledger.tryAppend({ type: "RemoveLiquidityOneCoin", height: 3n, by: "lp9", shares: add.receipt.minted, coin: 0, minAmount: 0n });
          if (out.ok && out.receipt.type === "RemoveLiquidityOneCoin") {
            expect(out.receipt.dy <= dx).toBe(true);
            covAdd.hit();
          }
        }

        const take = s.initial.map((_, k) => (k === 1 ? dust(s.p.coins[1]!.rate, f) : 0n));
        const burn = ledger.tryAppend({ type: "RemoveLiquidityImbalance", height: 4n, by: "lp0", amounts: take, maxBurn: 2n ** 255n });
        if (burn.ok && burn.receipt.type === "RemoveLiquidityImbalance") {
          const back = ledger.tryAppend({ type: "AddLiquidity", height: 4n, by: "lp0", amounts: take, minMint: 0n });
          if (back.ok && back.receipt.type === "AddLiquidity") {
            expect(back.receipt.minted <= burn.receipt.burned).toBe(true);
            covBurn.hit();
          }
        }
      }),
      { numRuns: RUNS },
    );
    covSwap.check();
    covAdd.check();
    covBurn.check();
  });

  it("deposits and exits mint down and burn up: value per share never falls on add, imbalanced remove, or one-coin remove", () => {
    const cov = coverage(0.3);
    fc.assert(
      fc.property(setupArb, fc.bigInt({ min: 1n, max: 2_000_000n }), fc.nat({ max: 2 }), (s, f, op) => {
        const ledger = boot(s);
        if (ledger === null) return;
        const before = ledger.state;
        const amp = ampAt(before.ramp, 2n);
        const amount = dust(s.p.coins[1]!.rate, f);
        const e: PoolEvent =
          op === 0 ? { type: "AddLiquidity", height: 2n, by: "lp1", amounts: s.initial.map((_, k) => (k === 1 ? amount : 0n)), minMint: 0n }
          : op === 1 ? { type: "RemoveLiquidityImbalance", height: 2n, by: "lp0", amounts: s.initial.map((_, k) => (k === 1 ? amount : 0n)), maxBurn: 2n ** 255n }
          : { type: "RemoveLiquidityOneCoin", height: 2n, by: "lp0", shares: amount, coin: 1, minAmount: 0n };
        if (!accepted(ledger, e)) return;
        const after = ledger.state;
        // Exact check by homogeneity of the invariant (D(λx) = λD(x)):
        //   D(after)/s1 >= D(before)/s0  <=>  after·s0 lies on or above the curve through D = ⌈D(before)⌉·s1 ... scaled down
        // to fit MAX_XP: compare against ⌈D(before)·s1/s0⌉, the smallest integer D that would satisfy it.
        const dBefore = getDUp(xpOf(before.balances, before.rates), amp);
        const needed = (dBefore * after.supply + before.supply - 1n) / before.supply;
        // needed - 1 absorbs the ceil on D(before): we require D(after) > ⌈D0⌉·s1/s0 − 1 >= D0·s1/s0 − 1.
        expect(invariantResidual(xpOf(after.balances, after.rates), needed - 1n, amp) >= 0n).toBe(true);
        cov.hit();
      }),
      { numRuns: RUNS },
    );
    cov.check();
  });

  it("every path enforces the minimum trade amount in normalised units", () => {
    const cov = coverage(0.8);
    fc.assert(
      fc.property(setupArb, (s) => {
        const ledger = boot(s);
        if (ledger === null) return;
        const tiny = (k: number): bigint => (999_999n * PRECISION) / s.p.coins[k]!.rate;
        const amounts = s.initial.map((_, k) => (k === 0 ? tiny(0) : 0n));
        for (const e of [
          { type: "Exchange", height: 2n, by: "t", i: 0, j: 1, dx: tiny(0), minDy: 0n },
          { type: "ExchangeExactOut", height: 2n, by: "t", i: 0, j: 1, dy: tiny(1), maxDx: 2n ** 200n },
          { type: "AddLiquidity", height: 2n, by: "x", amounts, minMint: 0n },
          { type: "RemoveLiquidityImbalance", height: 2n, by: "lp0", amounts, maxBurn: 2n ** 200n },
        ] satisfies PoolEvent[]) {
          if (e.type !== "Exchange" && e.type !== "ExchangeExactOut" && (e.amounts[0] ?? 0n) === 0n) continue;
          if (e.type === "Exchange" && e.dx === 0n) continue;
          if (e.type === "ExchangeExactOut" && e.dy === 0n) continue;
          const r = ledger.tryAppend(e);
          expect(r.ok).toBe(false);
          if (!r.ok) expect(["BELOW_MIN_TRADE", "INVALID_EVENT"]).toContain(r.error.code);
        }
        cov.hit();
      }),
      { numRuns: RUNS },
    );
    cov.check();
  });
});

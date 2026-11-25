import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expectCode, params } from "./helpers.js";
import {
  A_PRECISION,
  PoolLedger,
  curveExchangeDy,
  getD,
  getDDown,
  getDUp,
  getY,
  quoteAddLiquidity,
  quoteExchange,
  quoteRemoveLiquidityImbalance,
  quoteRemoveLiquidityOneCoin,
  xpOf,
  type Snapshot,
} from "../src/index.js";

/**
 * Cross-check against Curve 3pool. The fixture is produced by
 * scripts/curve_3pool_reference.py, a line-by-line transcription of the
 * StableSwap3Pool.vy math (get_D, get_y, get_dy, exchange, get_y_D,
 * _calc_withdraw_one_coin, calc_token_amount), for 4 pools x 4 values of A.
 *
 * - get_D and get_y must match bit for bit.
 * - Pool operations round in the pool's favour (fee rounded up, exactly
 *   rounded D and y), so they may pay slightly less / burn slightly more than
 *   3pool. The bound on that deviation is asserted per path below.
 */
interface Fixture {
  crossChecks: string[];
  rates: string[];
  nonConvergence: { A: number; balances: string[]; converged: boolean; lastGuess: string }[];
  drift: { A: number; balances: string[]; i: number; j: number; dx: string; D0: string; D1: string; converged: boolean }[];
  cases: {
    pool: string;
    balances: string[];
    A: number;
    D: string;
    swaps: { i: number; j: number; dx: string; y: string; byFee: { fee: number; exchange: string; getDy: string }[] }[];
    withdrawOne: { i: number; shares: string; supply: string; byFee: { fee: number; dy: string; fee_amount: string }[] }[];
    tokenAmount: { amounts: string[]; deposit: boolean; supply: string; result: string }[];
  }[];
}

const fixture = JSON.parse(readFileSync(new URL("./fixtures/curve-3pool-reference.json", import.meta.url), "utf8")) as Fixture;
const rates = fixture.rates.map(BigInt);
const big = (xs: string[]): bigint[] => xs.map(BigInt);

function snap(balances: bigint[], A: number, fee: bigint, supply: bigint): Snapshot {
  return {
    balances,
    rates,
    amp: BigInt(A) * A_PRECISION,
    fee,
    adminFee: 0n,
    supply,
    minTradeAmount: 1n,
    minimumLiquidity: 1n,
    minInitialD: 2n,
  };
}

/** Deviation of `ours` from `ref`, expressed in normalised (1e18) units of the coin. */
const xpDev = (ref: bigint, ours: bigint, rate: bigint): bigint => ((ref - ours) * rate) / 10n ** 18n;

/** |a − b| <= max(a, b) / inverse  (relative tolerance 1/inverse). */
const relClose = (a: bigint, b: bigint, inverse: bigint): boolean => {
  const diff = a > b ? a - b : b - a;
  const big = a > b ? a : b;
  return diff * inverse <= big;
};

const stats = { curveDyExact: 0, swapsReverted: 0, cases: 0, dExact: 0, yExact: 0, swaps: 0, swapsExact: 0, maxSwapDevXp: 0n, getDyMismatches: 0, oneCoin: 0, oneCoinExact: 0, maxOneCoinDevXp: 0n, tokenAmount: 0, tokenAmountExact: 0 };

describe("Curve 3pool reference values", () => {
  it("fixture covers 16 pool/A combinations", () => {
    expect(fixture.cases.length).toBe(16);
  });

  for (const c of fixture.cases) {
    describe(`${c.pool}, A=${c.A}`, () => {
      const balances = big(c.balances);
      const xp = xpOf(balances, rates);
      const amp = BigInt(c.A) * A_PRECISION;
      const D = BigInt(c.D);

      it("get_D matches bit for bit; exactly rounded D brackets it within 1 unit per side of the real root", () => {
        stats.cases++;
        expect(getD(xp, amp)).toBe(D);
        stats.dExact++;
        const up = getDUp(xp, amp);
        const down = getDDown(xp, amp);
        expect(up - down <= 1n).toBe(true);
        // Newton's D vs the exact root: relative tolerance (1e-15), not exact.
        expect(relClose(up, D, 10n ** 15n)).toBe(true);
      });

      it("get_y matches bit for bit", () => {
        for (const s of c.swaps) {
          const x = xp[s.i]! + (BigInt(s.dx) * rates[s.i]!) / 10n ** 18n;
          expect(getY(s.i, s.j, x, xp, amp, D)).toBe(BigInt(s.y));
          stats.yExact++;
        }
      });

      it("get_dy with Curve's own formula (3pool exchange / NG get_dy) matches to the wei", () => {
        for (const s of c.swaps) {
          for (const f of s.byFee) {
            expect(curveExchangeDy(snap(balances, c.A, BigInt(f.fee), D), s.i, s.j, BigInt(s.dx))).toBe(BigInt(f.exchange));
            stats.curveDyExact++;
          }
        }
      });

      it("exchange: never pays more than 3pool, and at most a few normalised units less", () => {
        for (const s of c.swaps) {
          for (const f of s.byFee) {
            const ref = BigInt(f.exchange);
            let ours: bigint;
            try {
              ours = quoteExchange(snap(balances, c.A, BigInt(f.fee), D), s.i, s.j, BigInt(s.dx)).dy;
            } catch (error) {
              // The post-trade state is one where Curve's D never converges (finding: A <= 2-ish
              // or extreme imbalance). 3pool executes without recomputing D; the pool reverts.
              expect((error as { code?: string }).code).toBe("NO_CONVERGENCE");
              expect(() => getD(xpOf(balances.map((b, k) => (k === s.i ? b + BigInt(s.dx) : k === s.j ? b - ref : b)), rates), amp)).toThrow();
              stats.swapsReverted++;
              continue;
            }
            stats.swaps++;
            if (ours === ref) stats.swapsExact++;
            if (BigInt(f.getDy) !== ref) stats.getDyMismatches++;
            expect(ours <= ref, `${c.pool} A=${c.A} ${s.i}->${s.j} fee=${f.fee}`).toBe(true);
            const dev = xpDev(ref, ours, rates[s.j]!);
            if (dev > stats.maxSwapDevXp) stats.maxSwapDevXp = dev;
            // One native unit of the output coin, or 16 normalised units for 18-decimal coins.
            expect(ref - ours <= (rates[s.j]! === 10n ** 18n ? 16n : 1n)).toBe(true);
          }
        }
      });

      it("remove_liquidity_one_coin: never pays more than 3pool, and at most a few normalised units less", () => {
        for (const w of c.withdrawOne) {
          for (const f of w.byFee) {
            const ref = BigInt(f.dy);
            const ours = quoteRemoveLiquidityOneCoin(snap(balances, c.A, BigInt(f.fee), BigInt(w.supply)), BigInt(w.shares), w.i).dy;
            stats.oneCoin++;
            if (ours === ref) stats.oneCoinExact++;
            expect(ours <= ref).toBe(true);
            const dev = xpDev(ref, ours, rates[w.i]!);
            if (dev > stats.maxOneCoinDevXp) stats.maxOneCoinDevXp = dev;
            expect(ref - ours <= (rates[w.i]! === 10n ** 18n ? 16n : 1n)).toBe(true);
          }
        }
      });

      it("calc_token_amount (fee = 0): deposits mint at most 3pool's amount, withdrawals burn at least 3pool's amount", () => {
        for (const t of c.tokenAmount) {
          const ref = BigInt(t.result);
          const s = snap(balances, c.A, 0n, BigInt(t.supply));
          const amounts = big(t.amounts);
          stats.tokenAmount++;
          if (t.deposit) {
            const ours = quoteAddLiquidity(s, amounts).minted;
            if (ours === ref) stats.tokenAmountExact++;
            expect(ours <= ref && ref - ours <= 2n).toBe(true);
          } else {
            const ours = quoteRemoveLiquidityImbalance(s, amounts).burned;
            // 3pool's calc_token_amount omits the +1 that remove_liquidity_imbalance adds.
            if (ours === ref + 1n) stats.tokenAmountExact++;
            expect(ours >= ref + 1n && ours - ref <= 3n).toBe(true);
          }
        }
      });
    });
  }

  it("summary", () => {
    // Recorded for the README; printed so the numbers are visible in CI logs.
    console.log(`[reference] ${JSON.stringify(stats, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    expect(stats.dExact).toBe(16);
    expect(stats.yExact).toBe(80);
    expect(stats.swaps + stats.swapsReverted).toBe(240);
    expect(stats.curveDyExact).toBe(240);
  });

  it("a second implementation (curve-contract tests/simulation.py) agreed on every D and y when the fixture was generated", () => {
    expect(fixture.crossChecks.join("\n")).toContain("96/96 values agree to the wei");
  });
});

describe("Curve get_D non-convergence (A <= 3, ~2000:1 and ~5000:1 imbalance)", () => {
  it("where 3pool silently returns its last guess, getD and every pool path revert with NO_CONVERGENCE", () => {
    const failing = fixture.nonConvergence.filter((c) => !c.converged);
    expect(failing.length).toBeGreaterThan(20);
    for (const c of fixture.nonConvergence) {
      const xp = xpOf(big(c.balances), rates);
      const amp = BigInt(c.A) * A_PRECISION;
      if (c.converged) {
        expect(getD(xp, amp)).toBe(BigInt(c.lastGuess));
        continue;
      }
      expectCode(() => getD(xp, amp), "NO_CONVERGENCE");
      expectCode(() => getDUp(xp, amp), "NO_CONVERGENCE");
      const ledger = new PoolLedger(params({ A: BigInt(c.A), minInitialD: 10n ** 6n }));
      expectCode(() => ledger.append({ type: "AddLiquidity", height: 1n, by: "lp", amounts: big(c.balances), minMint: 0n }), "NO_CONVERGENCE");
      expect(ledger.events.length).toBe(0);
    }
  });
});

describe("D drift after get_y (A = 1-2, 180:1)", () => {
  it("recomputing Curve's D after a get_y swap drifts by a few wei, so D comparisons against Newton use a relative tolerance", () => {
    let maxDrift = 0n;
    for (const c of fixture.drift) {
      const d0 = BigInt(c.D0);
      const d1 = BigInt(c.D1);
      const drift = d1 > d0 ? d1 - d0 : d0 - d1;
      if (drift > maxDrift) maxDrift = drift;
      expect(relClose(d0, d1, 10n ** 15n)).toBe(true);
    }
    expect(maxDrift > 0n && maxDrift <= 16n).toBe(true);
    console.log(`[reference] max D drift after get_y: ${maxDrift} wei`);
  });

  it("the pool's own swaps on the same states never lower the exactly rounded D", () => {
    for (const c of fixture.drift) {
      if (!c.converged) continue;
      const s = snap(big(c.balances), c.A, 0n, 10n ** 18n);
      try {
        const q = quoteExchange(s, c.i, c.j, BigInt(c.dx));
        expect(q.d1 >= q.d0).toBe(true);
        expect(getDDown(xpOf(q.balances, rates), BigInt(c.A) * A_PRECISION) >= getDUp(xpOf(s.balances, rates), BigInt(c.A) * A_PRECISION)).toBe(true);
      } catch (error) {
        expect(["BELOW_MIN_TRADE", "NO_CONVERGENCE"]).toContain((error as { code?: string }).code);
      }
    }
  });
});

describe("xp_j − y − 1 never goes negative", () => {
  it("1-2 wei inputs into very skewed pools are rejected with BELOW_MIN_TRADE, in Curve's formula and in the pool", () => {
    let guarded = 0;
    for (const balances of [[1_000_000n * 10n ** 18n, 1n, 10n ** 6n], [10n ** 24n, 10n ** 6n, 3n], [5n, 10n ** 12n, 10n ** 12n]]) {
      for (const A of [1, 2, 100]) {
        const s = snap(balances, A, 0n, 10n ** 18n);
        for (const [i, j] of [[0, 1], [0, 2], [1, 0], [2, 1]] as const) {
          for (const dx of [1n, 2n]) {
            for (const fn of [() => curveExchangeDy(s, i, j, dx), () => quoteExchange(s, i, j, dx).dy]) {
              try {
                const dy = fn();
                expect(dy >= 0n).toBe(true);
              } catch (error) {
                expect(["BELOW_MIN_TRADE", "NO_CONVERGENCE", "DOMAIN"]).toContain((error as { code?: string }).code);
                if ((error as { code?: string }).code === "BELOW_MIN_TRADE") guarded++;
              }
            }
          }
        }
      }
    }
    expect(guarded).toBeGreaterThan(10);
  });
});

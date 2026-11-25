import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expectCode, params } from "./helpers.js";
import {
  A_PRECISION,
  PoolLedger,
  getD,
  getDDown,
  getDUp,
  getY,
  getYUp,
  invariantResidual,
  newtonExchangeDy,
  quoteAddLiquidity,
  quoteExchange,
  quoteRemoveLiquidityImbalance,
  quoteRemoveLiquidityOneCoin,
  xpOf,
  type Snapshot,
} from "../src/index.js";

/**
 * Cross-check against an independent reference. The fixture is produced by
 * scripts/stableswap_paper_reference.py, derived from the StableSwap paper
 * (Egorov 2019); conventions match public Curve docs. It solves the paper's
 * invariant exactly over the integers by bisection (no Newton iteration) and
 * applies fees and unit conversions in exact rationals with one final floor,
 * for 4 pools x 4 values of A.
 *
 * - The exactly rounded solvers (getDUp, getDDown, getYUp) must equal the
 *   bisection roots exactly.
 * - Newton's getD / getY land within NEWTON_TOL units of the exact root.
 * - Pool operations round in the pool's favour, so they pay at most the ideal
 *   amount (or burn at least it) and stay within a small documented bound.
 */
interface Fixture {
  rates: string[];
  extremeStates: { A: number; balances: string[]; dUp: string; dDown: string }[];
  drift: { A: number; balances: string[]; i: number; j: number; dx: string; dUp: string }[];
  cases: {
    pool: string;
    balances: string[];
    A: number;
    dUp: string;
    dDown: string;
    swaps: { i: number; j: number; dx: string; yUp: string; byFee: { fee: number; dyIdeal: string }[] }[];
    withdrawOne: { i: number; shares: string; supply: string; byFee: { fee: number; dyIdeal: string }[] }[];
    tokenAmount: { amounts: string[]; deposit: boolean; supply: string; low: string; high: string }[];
  }[];
}

const fixture = JSON.parse(readFileSync(new URL("./fixtures/stableswap-paper-reference.json", import.meta.url), "utf8")) as Fixture;
const rates = fixture.rates.map(BigInt);
const big = (xs: string[]): bigint[] => xs.map(BigInt);

/** Newton results (floored intermediate terms, ±1 stopping rule) vs the exact integer root, in normalised units. */
const NEWTON_TOL = 2n;
/** Correction budget of the exact solvers (MAX_CORRECTION_STEPS in src/math.ts). */
const EXTREME_TOL = 64n;
/** Tolerance in native units of the output coin: 1 unit for 6-decimal coins, 16 for 18-decimal coins. */
const nativeTol = (rate: bigint): bigint => (rate === 10n ** 18n ? 16n : 1n);

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

const absDiff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);
/** Deviation of `ours` from `ref`, expressed in normalised (1e18) units of the coin. */
const xpDev = (ref: bigint, ours: bigint, rate: bigint): bigint => ((ref - ours) * rate) / 10n ** 18n;

/** |a − b| <= max(a, b) / inverse  (relative tolerance 1/inverse). */
const relClose = (a: bigint, b: bigint, inverse: bigint): boolean => {
  const diff = absDiff(a, b);
  const larger = a > b ? a : b;
  return diff * inverse <= larger;
};

const stats = {
  cases: 0,
  dExact: 0,
  dNewtonExact: 0,
  yExact: 0,
  yNewtonMaxDev: 0n,
  newtonDy: 0,
  newtonDyExact: 0,
  newtonDyMaxOver: 0n,
  swaps: 0,
  swapsReverted: 0,
  swapsExact: 0,
  maxSwapDevXp: 0n,
  oneCoin: 0,
  oneCoinExact: 0,
  maxOneCoinDevXp: 0n,
  tokenAmount: 0,
};

describe("Independent StableSwap paper reference values", () => {
  it("fixture covers 16 pool/A combinations", () => {
    expect(fixture.cases.length).toBe(16);
  });

  for (const c of fixture.cases) {
    describe(`${c.pool}, A=${c.A}`, () => {
      const balances = big(c.balances);
      const xp = xpOf(balances, rates);
      const amp = BigInt(c.A) * A_PRECISION;
      const dUp = BigInt(c.dUp);
      const dDown = BigInt(c.dDown);

      it("exactly rounded D equals the bisection root; Newton's D is within NEWTON_TOL", () => {
        stats.cases++;
        expect(getDUp(xp, amp)).toBe(dUp);
        expect(getDDown(xp, amp)).toBe(dDown);
        stats.dExact++;
        const newton = getD(xp, amp);
        expect(newton >= dDown - NEWTON_TOL && newton <= dUp + NEWTON_TOL).toBe(true);
        if (newton === dUp || newton === dDown) stats.dNewtonExact++;
      });

      it("the library's residual and the paper residual agree on the sign around the root", () => {
        expect(invariantResidual(xp, dDown, amp) >= 0n).toBe(true);
        expect(invariantResidual(xp, dUp, amp) <= 0n).toBe(true);
        if (dUp !== dDown) {
          expect(dUp - dDown).toBe(1n);
          expect(invariantResidual(xp, dDown, amp) > 0n).toBe(true);
          expect(invariantResidual(xp, dUp, amp) < 0n).toBe(true);
        }
      });

      it("exactly rounded y equals the bisection root; Newton's y is within NEWTON_TOL", () => {
        for (const s of c.swaps) {
          const x = xp[s.i]! + (BigInt(s.dx) * rates[s.i]!) / 10n ** 18n;
          expect(getYUp(s.i, s.j, x, xp, amp, dUp)).toBe(BigInt(s.yUp));
          stats.yExact++;
          const dev = absDiff(getY(s.i, s.j, x, xp, amp, dUp), BigInt(s.yUp));
          if (dev > stats.yNewtonMaxDev) stats.yNewtonMaxDev = dev;
          expect(dev <= NEWTON_TOL).toBe(true);
        }
      });

      it("newtonExchangeDy is within one native tolerance of the ideal output", () => {
        for (const s of c.swaps) {
          for (const f of s.byFee) {
            const ideal = BigInt(f.dyIdeal);
            const ours = newtonExchangeDy(snap(balances, c.A, BigInt(f.fee), dUp), s.i, s.j, BigInt(s.dx));
            stats.newtonDy++;
            if (ours === ideal) stats.newtonDyExact++;
            if (ours > ideal && ours - ideal > stats.newtonDyMaxOver) stats.newtonDyMaxOver = ours - ideal;
            expect(absDiff(ours, ideal) <= nativeTol(rates[s.j]!) + 1n).toBe(true);
          }
        }
      });

      it("exchange: never pays more than the ideal output, and at most a few normalised units less", () => {
        for (const s of c.swaps) {
          for (const f of s.byFee) {
            const ideal = BigInt(f.dyIdeal);
            let ours: bigint;
            try {
              ours = quoteExchange(snap(balances, c.A, BigInt(f.fee), dUp), s.i, s.j, BigInt(s.dx)).dy;
            } catch (error) {
              // The post-trade state is one where Newton's D does not converge (low A, extreme
              // imbalance). The pool reverts instead of pricing from an unverified D.
              expect((error as { code?: string }).code).toBe("NO_CONVERGENCE");
              expect(() => getD(xpOf(balances.map((b, k) => (k === s.i ? b + BigInt(s.dx) : k === s.j ? b - ideal : b)), rates), amp)).toThrow();
              stats.swapsReverted++;
              continue;
            }
            stats.swaps++;
            if (ours === ideal) stats.swapsExact++;
            expect(ours <= ideal, `${c.pool} A=${c.A} ${s.i}->${s.j} fee=${f.fee}`).toBe(true);
            const dev = xpDev(ideal, ours, rates[s.j]!);
            if (dev > stats.maxSwapDevXp) stats.maxSwapDevXp = dev;
            expect(ideal - ours <= nativeTol(rates[s.j]!)).toBe(true);
          }
        }
      });

      it("remove_liquidity_one_coin: never pays more than the ideal exit, and at most a few normalised units less", () => {
        for (const w of c.withdrawOne) {
          for (const f of w.byFee) {
            const ideal = BigInt(f.dyIdeal);
            const ours = quoteRemoveLiquidityOneCoin(snap(balances, c.A, BigInt(f.fee), BigInt(w.supply)), BigInt(w.shares), w.i).dy;
            stats.oneCoin++;
            if (ours === ideal) stats.oneCoinExact++;
            expect(ours <= ideal, `${c.pool} A=${c.A} i=${w.i} fee=${f.fee} ours=${ours} ideal=${ideal}`).toBe(true);
            const dev = xpDev(ideal, ours, rates[w.i]!);
            if (dev > stats.maxOneCoinDevXp) stats.maxOneCoinDevXp = dev;
            expect(ideal - ours <= nativeTol(rates[w.i]!)).toBe(true);
          }
        }
      });

      it("fee-free deposits mint within the exact range, withdrawals burn within it (plus the pool's +1)", () => {
        for (const t of c.tokenAmount) {
          const low = BigInt(t.low);
          const high = BigInt(t.high);
          const s = snap(balances, c.A, 0n, BigInt(t.supply));
          const amounts = big(t.amounts);
          stats.tokenAmount++;
          if (t.deposit) {
            const ours = quoteAddLiquidity(s, amounts).minted;
            expect(ours >= low && ours <= high, `minted ${ours} not in [${low}, ${high}]`).toBe(true);
          } else {
            const ours = quoteRemoveLiquidityImbalance(s, amounts).burned;
            expect(ours >= low && ours <= high + 1n, `burned ${ours} not in [${low}, ${high + 1n}]`).toBe(true);
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
    expect(stats.newtonDy).toBe(240);
    expect(stats.swaps + stats.swapsReverted).toBe(240);
  });
});

describe("Newton non-convergence (A <= 3, ~2000:1 and ~5000:1 imbalance)", () => {
  it("where Newton's integer iteration cycles, getD and every pool path revert with NO_CONVERGENCE; elsewhere it lands on the exact root", () => {
    let failing = 0;
    let maxExtremeDev = 0n;
    for (const c of fixture.extremeStates) {
      const xp = xpOf(big(c.balances), rates);
      const amp = BigInt(c.A) * A_PRECISION;
      let newton: bigint | undefined;
      try {
        newton = getD(xp, amp);
      } catch (error) {
        expect((error as { code?: string }).code).toBe("NO_CONVERGENCE");
      }
      if (newton !== undefined) {
        // At extreme imbalance Newton's floored iteration can stop tens of units from the root;
        // the exact solvers correct up to EXTREME_TOL units and revert beyond that.
        const dev = newton < BigInt(c.dDown) ? BigInt(c.dDown) - newton : newton > BigInt(c.dUp) ? newton - BigInt(c.dUp) : 0n;
        if (dev > maxExtremeDev) maxExtremeDev = dev;
        if (dev <= EXTREME_TOL) expect(getDUp(xp, amp)).toBe(BigInt(c.dUp));
        else expectCode(() => getDUp(xp, amp), "NO_CONVERGENCE");
        continue;
      }
      failing++;
      expectCode(() => getDUp(xp, amp), "NO_CONVERGENCE");
      const ledger = new PoolLedger(params({ A: BigInt(c.A), minInitialD: 10n ** 6n }));
      expectCode(() => ledger.append({ type: "AddLiquidity", height: 1n, by: "lp", amounts: big(c.balances), minMint: 0n }), "NO_CONVERGENCE");
      expect(ledger.events.length).toBe(0);
    }
    expect(failing).toBeGreaterThan(20);
    console.log(`[reference] Newton non-convergence: ${failing}/${fixture.extremeStates.length} extreme states; max Newton distance from the exact root where it converged: ${maxExtremeDev}`);
  });
});

describe("D drift after a Newton y (A = 1-2, 180:1)", () => {
  it("recomputing Newton's D after a Newton y swap drifts by a few wei, so D comparisons against Newton use a relative tolerance", () => {
    let maxDrift = 0n;
    for (const c of fixture.drift) {
      const xp = xpOf(big(c.balances), rates);
      const amp = BigInt(c.A) * A_PRECISION;
      const d0 = getD(xp, amp);
      expect(absDiff(d0, BigInt(c.dUp)) <= NEWTON_TOL).toBe(true);
      const x = xp[c.i]! + (BigInt(c.dx) * rates[c.i]!) / 10n ** 18n;
      const after = xp.slice();
      after[c.i] = x;
      after[c.j] = getY(c.i, c.j, x, xp, amp, d0);
      let d1: bigint;
      try {
        d1 = getD(after, amp);
      } catch {
        continue;
      }
      const drift = absDiff(d0, d1);
      if (drift > maxDrift) maxDrift = drift;
      expect(relClose(d0, d1, 10n ** 15n)).toBe(true);
    }
    expect(maxDrift > 0n && maxDrift <= 16n).toBe(true);
    console.log(`[reference] max D drift after get_y: ${maxDrift} wei`);
  });

  it("the pool's own swaps on the same states never lower the exactly rounded D", () => {
    for (const c of fixture.drift) {
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
  it("1-2 wei inputs into very skewed pools are rejected with BELOW_MIN_TRADE, in the Newton formula and in the pool", () => {
    let guarded = 0;
    for (const balances of [[1_000_000n * 10n ** 18n, 1n, 10n ** 6n], [10n ** 24n, 10n ** 6n, 3n], [5n, 10n ** 12n, 10n ** 12n]]) {
      for (const A of [1, 2, 100]) {
        const s = snap(balances, A, 0n, 10n ** 18n);
        for (const [i, j] of [[0, 1], [0, 2], [1, 0], [2, 1]] as const) {
          for (const dx of [1n, 2n]) {
            for (const fn of [() => newtonExchangeDy(s, i, j, dx), () => quoteExchange(s, i, j, dx).dy]) {
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

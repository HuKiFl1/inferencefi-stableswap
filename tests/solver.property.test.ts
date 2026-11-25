import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  A_PRECISION,
  MAX_A,
  MAX_ITERATIONS,
  MAX_XP,
  PoolError,
  divUp,
  getD,
  getDDown,
  getDUp,
  getY,
  getYD,
  getYDUp,
  getYUp,
  invariantResidual,
  mulDivDown,
  mulDivUp,
} from "../src/index.js";
import { E18, RUNS, expectCode } from "./helpers.js";

const amp = (a: bigint): bigint => a * A_PRECISION;

/** Balances inside the documented safe range: [1e6, 1e33] normalised units, any mix. */
const safeXp = (n: number) =>
  fc.array(
    fc.oneof(fc.bigInt({ min: 10n ** 6n, max: 10n ** 24n }), fc.bigInt({ min: 10n ** 18n, max: MAX_XP })),
    { minLength: n, maxLength: n },
  );
const ampArb = fc.oneof(fc.constant(1n), fc.bigInt({ min: 1n, max: 10_000n }), fc.bigInt({ min: 1n, max: MAX_A - 1n })).map(amp);

describe("rounding helpers", () => {
  it("divUp / mulDivUp are the ceiling of the exact quotient; Down variants the floor", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 40n }), fc.bigInt({ min: 0n, max: 10n ** 20n }), fc.bigInt({ min: 1n, max: 10n ** 30n }), (a, b, c) => {
        const down = mulDivDown(a, b, c);
        const up = mulDivUp(a, b, c);
        expect(down * c <= a * b && a * b < (down + 1n) * c).toBe(true);
        expect(up * c >= a * b && (up === 0n || (up - 1n) * c < a * b)).toBe(true);
        expect(up - down === ((a * b) % c === 0n ? 0n : 1n)).toBe(true);
        expect(divUp(a, c)).toBe(mulDivUp(a, 1n, c));
      }),
      { numRuns: RUNS * 3 },
    );
  });
});

describe("D solver", () => {
  it("balanced pools: D = Σx exactly", () => {
    for (const n of [2, 3, 4, 8]) {
      for (const a of [1n, 100n, 5000n]) {
        const xp = new Array<bigint>(n).fill(123_456_789n * E18);
        expect(getD(xp, amp(a))).toBe(123_456_789n * E18 * BigInt(n));
        expect(getDUp(xp, amp(a))).toBe(123_456_789n * E18 * BigInt(n));
      }
    }
  });

  it("exactly rounded D brackets the real root: residual(⌈D⌉) <= 0 < residual(⌈D⌉ − 1), ⌊D⌋ >= 0 > ⌊D⌋ + 1", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 5 }).chain((n) => safeXp(n)), ampArb, (xp, a) => {
        let up: bigint;
        try {
          up = getDUp(xp, a);
        } catch (error) {
          expect((error as PoolError).code).toBe("NO_CONVERGENCE");
          return;
        }
        const down = getDDown(xp, a);
        expect(invariantResidual(xp, up, a) <= 0n).toBe(true);
        expect(invariantResidual(xp, up - 1n, a) > 0n).toBe(true);
        expect(invariantResidual(xp, down, a) >= 0n).toBe(true);
        expect(invariantResidual(xp, down + 1n, a) < 0n).toBe(true);
        expect(up - down <= 1n).toBe(true);
        // n·(Πx)^(1/n) <= D <= Σx  (between constant product and constant sum).
        const s = xp.reduce((p, q) => p + q, 0n);
        expect(up <= s).toBe(true);
      }),
      { numRuns: RUNS * 2 },
    );
  });

  it("D is monotone in every balance and in A", () => {
    fc.assert(
      fc.property(safeXp(3), ampArb, fc.integer({ min: 0, max: 2 }), fc.bigInt({ min: 1n, max: 10n ** 24n }), (xp, a, k, bump) => {
        const more = xp.slice();
        more[k] = more[k]! + bump;
        if (more[k]! > MAX_XP) return;
        try {
          expect(getDDown(more, a) >= getDDown(xp, a)).toBe(true);
          if (a * 2n < MAX_A * A_PRECISION) expect(getDUp(xp, a * 2n) >= getDDown(xp, a)).toBe(true);
        } catch (error) {
          expect((error as PoolError).code).toBe("NO_CONVERGENCE");
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("Newton iteration cap: NO_CONVERGENCE instead of returning an unconverged value", () => {
    const xp = [1_000_000n * E18, 3n * E18, 7n * E18];
    expectCode(() => getD(xp, amp(100n), 1), "NO_CONVERGENCE");
    expect(MAX_ITERATIONS).toBe(255);
    // Integer Newton enters a limit cycle on this state (D oscillates by ~16 units)
    // and a pool returning its last iterate would misprice. Both layers revert instead.
    expectCode(() => getD([3807n * E18, E18, E18], amp(1n)), "NO_CONVERGENCE");
    expectCode(() => getDUp([3807n * E18, E18, E18], amp(1n)), "NO_CONVERGENCE");
    expectCode(() => getDDown([3807n * E18, E18, E18], amp(1n)), "NO_CONVERGENCE");
  });

  it("domain preconditions are enforced (zero balance, above MAX_XP, A out of range, n < 2)", () => {
    expectCode(() => getD([E18, 0n, E18], amp(100n)), "DOMAIN");
    expectCode(() => getD([E18, MAX_XP + 1n], amp(100n)), "DOMAIN");
    expectCode(() => getD([E18, E18], 0n), "DOMAIN");
    expectCode(() => getD([E18, E18], MAX_A * A_PRECISION), "DOMAIN");
    expectCode(() => getD([E18], amp(100n)), "DOMAIN");
    expectCode(() => getY(0, 0, E18, [E18, E18], amp(100n), 2n * E18), "DOMAIN");
    expectCode(() => getY(0, 2, E18, [E18, E18], amp(100n), 2n * E18), "DOMAIN");
    expectCode(() => getYD(0, [E18, E18], 0n, amp(100n)), "DOMAIN");
  });

  it("fuzz beyond the safe range: every input either yields a verified result or a typed PoolError", () => {
    const wild = fc.array(
      fc.oneof(fc.constant(0n), fc.bigInt({ min: 1n, max: 1_000n }), fc.bigInt({ min: 1n, max: 10n ** 40n })),
      { minLength: 2, maxLength: 4 },
    );
    const wildAmp = fc.oneof(fc.bigInt({ min: 0n, max: 200n }), fc.bigInt({ min: 0n, max: MAX_A * A_PRECISION * 2n }));
    let ok = 0;
    let rejected = 0;
    fc.assert(
      fc.property(wild, wildAmp, (xp, a) => {
        try {
          const up = getDUp(xp, a);
          expect(invariantResidual(xp, up, a) <= 0n && invariantResidual(xp, up - 1n, a) > 0n).toBe(true);
          ok++;
        } catch (error) {
          expect(error).toBeInstanceOf(PoolError);
          expect(["DOMAIN", "NO_CONVERGENCE"]).toContain((error as PoolError).code);
          rejected++;
        }
      }),
      { numRuns: RUNS * 3 },
    );
    expect(ok).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });
});

describe("y solver", () => {
  it("⌈y⌉ is the smallest balance that keeps the invariant (Solidly-style: keeps k, not nearest)", () => {
    fc.assert(
      fc.property(safeXp(3), ampArb, fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 2 }), fc.bigInt({ min: 1n, max: 10n ** 30n }), (xp, a, i, j, dx) => {
        if (i === j) return;
        const x = xp[i]! + dx;
        if (x > MAX_XP) return;
        let d: bigint;
        let y: bigint;
        try {
          d = getDUp(xp, a);
          y = getYUp(i, j, x, xp, a, d);
        } catch (error) {
          // Newton did not converge, or converged more than 64 units from the exact root.
          expect((error as PoolError).code).toBe("NO_CONVERGENCE");
          return;
        }
        const at = (v: bigint): bigint[] => {
          const out = xp.slice();
          out[i] = x;
          out[j] = v;
          return out;
        };
        expect(invariantResidual(at(y), d, a) >= 0n).toBe(true);
        if (y > 1n) expect(invariantResidual(at(y - 1n), d, a) < 0n).toBe(true);
        // Newton's y is only close to the exact root: tens of wei off at extreme
        // imbalance. The exact solver corrects at most 64 units and reverts beyond that.
        const newton = getY(i, j, x, xp, a, d);
        const diff = newton > y ? newton - y : y - newton;
        expect(diff <= 64n, `Newton ${newton} vs exact ${y}`).toBe(true);
      }),
      { numRuns: RUNS * 2 },
    );
  });

  it("⌈y_D⌉ is the smallest balance reaching D", () => {
    fc.assert(
      fc.property(safeXp(3), ampArb, fc.integer({ min: 0, max: 2 }), fc.bigInt({ min: 1n, max: 999n }), (xp, a, i, permille) => {
        try {
          const d0 = getDUp(xp, a);
          const d1 = d0 - (d0 * permille) / 1000n;
          const y = getYDUp(i, xp, d1, a);
          const at = (v: bigint): bigint[] => xp.map((x, k) => (k === i ? v : x));
          expect(invariantResidual(at(y), d1, a) >= 0n).toBe(true);
          if (y > 1n) expect(invariantResidual(at(y - 1n), d1, a) < 0n).toBe(true);
        } catch (error) {
          // Removing too much D with the other balances fixed has no positive solution,
          // or Newton landed too far from the exact root.
          expect(["DOMAIN", "NO_CONVERGENCE"]).toContain((error as PoolError).code);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("y iteration cap raises NO_CONVERGENCE", () => {
    const xp = [1_000_000n * E18, 3n * E18, 7n * E18];
    const d = getDUp(xp, amp(100n));
    expectCode(() => getY(1, 0, 4n * E18, xp, amp(100n), d, 1), "NO_CONVERGENCE");
    expectCode(() => getYD(0, xp, d / 2n, amp(100n), 1), "NO_CONVERGENCE");
  });
});

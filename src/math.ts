import { A_PRECISION, MAX_A, MAX_ITERATIONS, MAX_XP, PRECISION } from "./constants.js";
import { PoolError } from "./errors.js";

// Every helper here takes non-negative operands and a positive divisor.
// Callers pick the rounding direction explicitly; see SPEC.md §6.

export function divDown(a: bigint, b: bigint): bigint {
  return a / b;
}

export function divUp(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

export function mulDivDown(a: bigint, b: bigint, c: bigint): bigint {
  return (a * b) / c;
}

export function mulDivUp(a: bigint, b: bigint, c: bigint): bigint {
  return divUp(a * b, c);
}

export const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
export const absDiff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);

export function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new PoolError("DOMAIN", `index ${index} out of range`);
  return value;
}

/** Native amount -> normalised amount, rounded down. */
export function toXpDown(amount: bigint, rate: bigint): bigint {
  return mulDivDown(amount, rate, PRECISION);
}

/** Native amount -> normalised amount, rounded up. */
export function toXpUp(amount: bigint, rate: bigint): bigint {
  return mulDivUp(amount, rate, PRECISION);
}

/** Normalised amount -> native amount, rounded down. */
export function fromXpDown(xp: bigint, rate: bigint): bigint {
  return mulDivDown(xp, PRECISION, rate);
}

/** Normalised amount -> native amount, rounded up. */
export function fromXpUp(xp: bigint, rate: bigint): bigint {
  return mulDivUp(xp, PRECISION, rate);
}

/**
 * Normalised balances, rounded down (Curve `_xp`). Rounding the pool's own
 * balances down makes every D computed from them a slight under-estimate of
 * what the pool holds, so shares and outputs derived from D favour the pool.
 */
export function xpOf(balances: readonly bigint[], rates: readonly bigint[]): bigint[] {
  return balances.map((b, k) => toXpDown(b, at(rates, k)));
}

function checkAmp(amp: bigint): void {
  if (amp < A_PRECISION || amp >= MAX_A * A_PRECISION) {
    throw new PoolError("DOMAIN", `amp ${amp} outside [A_PRECISION, MAX_A * A_PRECISION)`);
  }
}

function checkXp(x: bigint, what: string): void {
  if (x <= 0n) throw new PoolError("DOMAIN", `${what} must be > 0 (a zero balance cannot be priced)`);
  if (x > MAX_XP) throw new PoolError("DOMAIN", `${what} exceeds MAX_XP`);
}

const converged = (a: bigint, b: bigint): boolean => absDiff(a, b) <= 1n;

/**
 * StableSwap invariant D for normalised balances `xp` and precise amplification
 * `amp` (A * A_PRECISION). Newton's method started at D = Σx, stopping when
 * |D - D_prev| <= 1 (Curve 3pool `get_D`, lines 195-220, with the NG
 * A_PRECISION scaling). Unlike 3pool, which returns the last iterate, a run
 * that does not converge within `maxIterations` throws NO_CONVERGENCE.
 *
 * Preconditions (DOMAIN): 2 <= n, every 0 < x_i <= MAX_XP, 1 <= A < MAX_A.
 */
export function getD(xp: readonly bigint[], amp: bigint, maxIterations: number = MAX_ITERATIONS): bigint {
  const n = BigInt(xp.length);
  if (n < 2n) throw new PoolError("DOMAIN", "need at least two balances");
  checkAmp(amp);
  let s = 0n;
  for (const x of xp) {
    checkXp(x, "balance");
    s += x;
  }
  const ann = amp * n;
  let d = s;
  for (let k = 0; k < maxIterations; k++) {
    let dP = d;
    for (const x of xp) dP = (dP * d) / (x * n);
    const dPrev = d;
    const numerator = ((ann * s) / A_PRECISION + dP * n) * d;
    const denominator = ((ann - A_PRECISION) * d) / A_PRECISION + (n + 1n) * dP;
    if (denominator <= 0n) throw new PoolError("DOMAIN", "non-positive denominator in D iteration");
    d = numerator / denominator;
    if (converged(d, dPrev)) {
      if (d <= 0n || d > MAX_XP * n) throw new PoolError("DOMAIN", "D outside the solver domain");
      return d;
    }
  }
  throw new PoolError("NO_CONVERGENCE", `D did not converge within ${maxIterations} iterations`);
}

/**
 * Newton iteration for the balance y of one coin, given the sum and product
 * terms of the others: y <- (y^2 + c) / (2y + b - D) (Curve 3pool `get_y`,
 * lines 356-398). Starts at y = D and stops at a precision of 1.
 */
function solveY(d: bigint, amp: bigint, others: readonly bigint[], n: bigint, maxIterations: number): bigint {
  checkAmp(amp);
  if (d <= 0n || d > MAX_XP * n) throw new PoolError("DOMAIN", "D outside the solver domain");
  const ann = amp * n;
  let c = d;
  let s = 0n;
  for (const x of others) {
    checkXp(x, "balance");
    s += x;
    c = (c * d) / (x * n);
  }
  c = (c * d * A_PRECISION) / (ann * n);
  const b = s + (d * A_PRECISION) / ann;
  let y = d;
  for (let k = 0; k < maxIterations; k++) {
    const yPrev = y;
    const denominator = 2n * y + b - d;
    if (denominator <= 0n) throw new PoolError("DOMAIN", "non-positive denominator in y iteration");
    y = (y * y + c) / denominator;
    if (converged(y, yPrev)) return y;
  }
  throw new PoolError("NO_CONVERGENCE", `y did not converge within ${maxIterations} iterations`);
}

/**
 * New balance of coin `j` after coin `i` is set to `x`, holding D fixed.
 * `d` must be the D of `xp` (callers pass it in so it is computed once).
 */
export function getY(
  i: number,
  j: number,
  x: bigint,
  xp: readonly bigint[],
  amp: bigint,
  d: bigint,
  maxIterations: number = MAX_ITERATIONS,
): bigint {
  const n = xp.length;
  if (i === j || i < 0 || j < 0 || i >= n || j >= n) throw new PoolError("DOMAIN", "bad coin indices");
  const others: bigint[] = [];
  for (let k = 0; k < n; k++) {
    if (k === j) continue;
    others.push(k === i ? x : at(xp, k));
  }
  return solveY(d, amp, others, BigInt(n), maxIterations);
}

// ---------------------------------------------------------------- exactly rounded solvers
//
// Curve's Newton iterations floor every intermediate term (c, b, D_P, y), so
// their results can sit on either side of the real root by a unit or so; 3pool
// relies on fees and its "−1" to cover that. These wrappers take the Newton
// result as a starting point and then step it, with an exact integer test, to
// the integer on the pool's side of the real root. The exact test makes them
// independent of Newton's rounding: they return the y that keeps the
// invariant, not the nearest y.

/** Steps allowed to correct a Newton result; Newton lands within a few units. */
const MAX_CORRECTION_STEPS = 64;

/**
 * Sign-exact residual of the StableSwap invariant, in Curve's convention
 * (Ann = A·n):  f(x, D) = Ann·Σx + D − Ann·D − D^(n+1)/(nⁿ·Πx).
 * Returned multiplied by A_PRECISION·nⁿ·Πx > 0, so it is an exact integer with
 * the sign of f. f is increasing in every x and decreasing in D, so
 * residual >= 0 means "x is on or above the level set of D".
 */
export function invariantResidual(xp: readonly bigint[], d: bigint, amp: bigint): bigint {
  const n = BigInt(xp.length);
  const ann = amp * n;
  let s = 0n;
  let p = 1n;
  for (const x of xp) {
    s += x;
    p *= x;
  }
  return (ann * s + A_PRECISION * d - ann * d) * n ** n * p - A_PRECISION * d ** (n + 1n);
}

function correctionLimit(): never {
  throw new PoolError("NO_CONVERGENCE", `Newton result is more than ${MAX_CORRECTION_STEPS} units from the exact root`);
}

function newtonDUp(xp: readonly bigint[], amp: bigint, maxIterations: number): bigint {
  let d = getD(xp, amp, maxIterations);
  let steps = 0;
  while (invariantResidual(xp, d, amp) > 0n) {
    if (++steps > MAX_CORRECTION_STEPS) correctionLimit();
    d += 1n;
  }
  while (d > 1n && invariantResidual(xp, d - 1n, amp) <= 0n) {
    if (++steps > MAX_CORRECTION_STEPS) correctionLimit();
    d -= 1n;
  }
  return d;
}

/**
 * ⌈D⌉: the smallest integer D with residual(xp, D) <= 0. Use for the state
 * before an operation. If Newton does not converge (Curve's integer iteration
 * can settle into a limit cycle at extreme imbalance and low A, where 3pool
 * silently returns its last guess), or lands further than
 * MAX_CORRECTION_STEPS from the exact root, this reverts with NO_CONVERGENCE
 * (StableSwap-NG behaviour): the pool never prices from an unverified D.
 */
export function getDUp(xp: readonly bigint[], amp: bigint, maxIterations: number = MAX_ITERATIONS): bigint {
  return newtonDUp(xp, amp, maxIterations);
}

/** ⌊D⌋: the largest integer D with residual(xp, D) >= 0. Use for the state after an operation. */
export function getDDown(xp: readonly bigint[], amp: bigint, maxIterations: number = MAX_ITERATIONS): bigint {
  const up = getDUp(xp, amp, maxIterations);
  return invariantResidual(xp, up, amp) === 0n ? up : up - 1n;
}

/**
 * Smallest y >= 1 that puts `withY(y)` on or above the level set of `d`,
 * stepping from Newton's estimate. Reverts with NO_CONVERGENCE if Newton does
 * not converge or lands too far from the exact root.
 */
function ceilY(estimate: bigint, withY: (y: bigint) => bigint[], d: bigint, amp: bigint): bigint {
  let y = estimate < 1n ? 1n : estimate;
  let steps = 0;
  while (invariantResidual(withY(y), d, amp) < 0n) {
    if (++steps > MAX_CORRECTION_STEPS) correctionLimit();
    y += 1n;
  }
  while (y > 1n && invariantResidual(withY(y - 1n), d, amp) >= 0n) {
    if (++steps > MAX_CORRECTION_STEPS) correctionLimit();
    y -= 1n;
  }
  return y;
}

/** ⌈y⌉ version of `getY`: the smallest new balance of coin j that keeps D >= d. */
export function getYUp(
  i: number,
  j: number,
  x: bigint,
  xp: readonly bigint[],
  amp: bigint,
  d: bigint,
  maxIterations: number = MAX_ITERATIONS,
): bigint {
  const base = xp.slice();
  base[i] = x;
  return ceilY(
    getY(i, j, x, xp, amp, d, maxIterations),
    (y) => {
      const v = base.slice();
      v[j] = y;
      return v;
    },
    d,
    amp,
  );
}

/** ⌈y⌉ version of `getYD`. */
export function getYDUp(i: number, xp: readonly bigint[], d: bigint, amp: bigint, maxIterations: number = MAX_ITERATIONS): bigint {
  return ceilY(
    getYD(i, xp, d, amp, maxIterations),
    (y) => {
      const v = xp.slice();
      v[i] = y;
      return v;
    },
    d,
    amp,
  );
}

/** Balance of coin `i` that brings the invariant to `d`, other balances fixed (Curve `get_y_D`). */
export function getYD(
  i: number,
  xp: readonly bigint[],
  d: bigint,
  amp: bigint,
  maxIterations: number = MAX_ITERATIONS,
): bigint {
  const n = xp.length;
  if (i < 0 || i >= n) throw new PoolError("DOMAIN", "bad coin index");
  const others = xp.filter((_, k) => k !== i);
  return solveY(d, amp, others, BigInt(n), maxIterations);
}

import { FEE_DENOMINATOR, PRECISION } from "./constants.js";
import { PoolError } from "./errors.js";
import {
  absDiff,
  at,
  divUp,
  fromXpDown,
  fromXpUp,
  getD,
  getDDown,
  getDUp,
  getY,
  getYDUp,
  getYUp,
  max,
  mulDivDown,
  mulDivUp,
  toXpDown,
  toXpUp,
  xpOf,
} from "./math.js";
import type { Amount, CoinIndex } from "./types.js";

/**
 * Everything the pool math needs, detached from the ledger. All quote
 * functions are pure: they never mutate the snapshot and either return a
 * complete result or throw a PoolError.
 */
export interface Snapshot {
  /** LP-owned balances (admin fees excluded), native units. */
  readonly balances: readonly Amount[];
  readonly rates: readonly bigint[];
  /** Precise A at the evaluation height. */
  readonly amp: bigint;
  readonly fee: bigint;
  readonly adminFee: bigint;
  readonly supply: Amount;
  readonly minTradeAmount: Amount;
  readonly minimumLiquidity: Amount;
  readonly minInitialD: Amount;
}

export interface SwapQuote {
  readonly dx: Amount;
  /** What the trader receives. */
  readonly dy: Amount;
  /** Exact-input output for `dx` (>= dy; the difference stays in the pool). */
  readonly dyQuoted: Amount;
  readonly feeXp: bigint;
  readonly adminFee: Amount;
  readonly d0: bigint;
  readonly d1: bigint;
  readonly balances: readonly Amount[];
}

export interface AddQuote {
  readonly minted: Amount;
  readonly locked: Amount;
  readonly fees: readonly Amount[];
  readonly adminFees: readonly Amount[];
  readonly d0: bigint;
  readonly d1: bigint;
  readonly d2: bigint;
  readonly balances: readonly Amount[];
}

export interface RemoveImbalanceQuote {
  readonly burned: Amount;
  readonly fees: readonly Amount[];
  readonly adminFees: readonly Amount[];
  readonly balances: readonly Amount[];
}

export interface RemoveOneQuote {
  readonly dy: Amount;
  readonly fee: Amount;
  readonly adminFee: Amount;
  readonly balances: readonly Amount[];
}

export interface RemoveQuote {
  readonly amounts: readonly Amount[];
  readonly balances: readonly Amount[];
}

const belowMin = (what: string): PoolError => new PoolError("BELOW_MIN_TRADE", what);

/**
 * A priced operation may not leave the pool in a state its solver cannot
 * price (Newton non-convergence): otherwise every later swap, deposit and
 * single-coin exit would revert and only proportional exits would remain.
 */
function requirePriceable(s: Snapshot, balances: readonly Amount[]): void {
  getDDown(xpOf(balances, s.rates), s.amp);
}

function checkPair(s: Snapshot, i: CoinIndex, j: CoinIndex): void {
  const n = s.balances.length;
  if (!Number.isInteger(i) || !Number.isInteger(j) || i === j || i < 0 || j < 0 || i >= n || j >= n) {
    throw new PoolError("INVALID_EVENT", "coin indices must be distinct and in range");
  }
}

function requireLiquidity(s: Snapshot): void {
  if (s.supply === 0n) throw new PoolError("EMPTY_POOL", "pool has not been bootstrapped");
}

/**
 * Per-coin imbalance fee rate fee·n / (4·(n−1)) (Curve 3pool line 274).
 * Rounded up: the depositor/withdrawer pays the fractional part.
 */
export function imbalanceFeeRate(fee: bigint, n: number): bigint {
  const nn = BigInt(n);
  return divUp(fee * nn, 4n * (nn - 1n));
}

/**
 * Imbalance fee for one coin. The ideal balance D1·old/D0 is rounded in
 * whichever direction makes |ideal − new| larger, and the fee is rounded up.
 */
function imbalanceFee(feeRate: bigint, d0: bigint, d1: bigint, oldBalance: Amount, newBalance: Amount): Amount {
  const idealDown = mulDivDown(d1, oldBalance, d0);
  const idealUp = mulDivUp(d1, oldBalance, d0);
  const diff = max(absDiff(newBalance, idealDown), absDiff(newBalance, idealUp));
  return mulDivUp(feeRate, diff, FEE_DENOMINATOR);
}

interface ExactInCore {
  readonly dy: Amount;
  readonly feeXp: bigint;
  readonly adminFee: Amount;
  readonly d0: bigint;
}

/**
 * Exact-input swap core (Curve 3pool `exchange`, lines 431-480):
 *   x      = xp_i + ⌊dx·rate_i/1e18⌋          input credited rounded down
 *   dyG    = xp_j − y − 1                      the −1 absorbs y's ±1 Newton tolerance
 *   fee    = ⌈dyG·fee/1e10⌉                    fee rounded up (3pool: down)
 *   dy     = ⌊(dyG − fee)·1e18/rate_j⌋         output rounded down
 *   admin  = ⌊⌊fee·adminFee/1e10⌋·1e18/rate_j⌋ admin share rounded down (rest stays with LPs)
 */
function exactInCore(s: Snapshot, i: CoinIndex, j: CoinIndex, dx: Amount, xp: readonly bigint[], d0: bigint): ExactInCore {
  if (dx <= 0n) throw belowMin("dx must be > 0");
  const dxXp = toXpDown(dx, at(s.rates, i));
  if (dxXp < s.minTradeAmount) throw belowMin("normalised dx below minTradeAmount");
  const y = getYUp(i, j, at(xp, i) + dxXp, xp, s.amp, d0);
  const xpJ = at(xp, j);
  if (y + 1n >= xpJ) throw belowMin("output rounds to zero");
  const dyGross = xpJ - y - 1n;
  const feeXp = mulDivUp(dyGross, s.fee, FEE_DENOMINATOR);
  const dyNet = dyGross - feeXp;
  if (dyNet < s.minTradeAmount) throw belowMin("normalised dy below minTradeAmount");
  const rateJ = at(s.rates, j);
  const dy = fromXpDown(dyNet, rateJ);
  if (dy === 0n) throw belowMin("output rounds to zero");
  const adminFee = fromXpDown(mulDivDown(feeXp, s.adminFee, FEE_DENOMINATOR), rateJ);
  return { dy, feeXp, adminFee, d0 };
}

function settleSwap(
  s: Snapshot,
  i: CoinIndex,
  j: CoinIndex,
  dx: Amount,
  paid: Amount,
  core: ExactInCore,
): SwapQuote {
  const balances = s.balances.slice();
  balances[i] = at(balances, i) + dx;
  const balanceJ = at(balances, j) - paid - core.adminFee;
  if (balanceJ <= 0n) throw new PoolError("INSUFFICIENT_LIQUIDITY", "swap would empty the output balance");
  balances[j] = balanceJ;
  const d1 = getDDown(xpOf(balances, s.rates), s.amp);
  if (d1 < core.d0) throw new PoolError("INVARIANT_VIOLATION", `swap lowers D from ${core.d0} to ${d1}`);
  return { dx, dy: paid, dyQuoted: core.dy, feeXp: core.feeXp, adminFee: core.adminFee, d0: core.d0, d1, balances };
}

/**
 * Curve's own exchange formula, bit for bit: Newton D and y, `xp_j − y − 1`,
 * fee rounded down (3pool `exchange` lines 461-466; StableSwap-NG `get_dy`
 * with a constant fee). Provided for cross-checking against Curve reference
 * vectors; pools execute `quoteExchange`, which rounds every step toward the
 * pool and so pays at most this amount. Where `xp_j − y − 1` would be zero or
 * negative (1-2 wei inputs in very skewed pools) this throws BELOW_MIN_TRADE
 * instead of underflowing.
 */
export function curveExchangeDy(s: Snapshot, i: CoinIndex, j: CoinIndex, dx: Amount): Amount {
  checkPair(s, i, j);
  if (dx < 0n) throw belowMin("dx must be >= 0");
  const xp = xpOf(s.balances, s.rates);
  const d = getD(xp, s.amp);
  const y = getY(i, j, at(xp, i) + toXpDown(dx, at(s.rates, i)), xp, s.amp, d);
  const xpJ = at(xp, j);
  if (y + 1n >= xpJ) throw belowMin("xp_j − y − 1 <= 0");
  const dy = xpJ - y - 1n;
  const fee = mulDivDown(dy, s.fee, FEE_DENOMINATOR);
  return fromXpDown(dy - fee, at(s.rates, j));
}

/** get_dy / exchange: sell exactly `dx` of coin i for coin j. */
export function quoteExchange(s: Snapshot, i: CoinIndex, j: CoinIndex, dx: Amount): SwapQuote {
  checkPair(s, i, j);
  requireLiquidity(s);
  const xp = xpOf(s.balances, s.rates);
  const d0 = getDUp(xp, s.amp);
  const core = exactInCore(s, i, j, dx, xp, d0);
  return settleSwap(s, i, j, dx, core.dy, core);
}

const EXACT_OUT_SEARCH_LIMIT = 256;

/**
 * get_dx / exact-output exchange: receive exactly `dy` of coin j.
 *
 * The input is the smallest dx (by exponential + binary search around an
 * algebraic estimate) whose exact-input quote pays at least `dy`. The trade is
 * then executed as that exact-input trade, so every rounding step of the
 * exact-input path applies unchanged, and the trader receives exactly `dy`.
 * Any surplus (dyQuoted − dy) stays with LPs. Hence exact-out never pays more,
 * or charges less, than the exact-input trade of the same dx.
 *
 * Estimate (all rounded against the trader):
 *   net   = ⌈dy·rate_j/1e18⌉
 *   gross = ⌈net·1e10/(1e10 − fee)⌉
 *   x     = get_y(j → i, xp_j − gross − 1)
 *   dx₀   = ⌈(x − xp_i)·1e18/rate_i⌉
 */
export function quoteExchangeExactOut(s: Snapshot, i: CoinIndex, j: CoinIndex, dy: Amount): SwapQuote {
  checkPair(s, i, j);
  requireLiquidity(s);
  if (dy <= 0n) throw belowMin("dy must be > 0");
  const xp = xpOf(s.balances, s.rates);
  const d0 = getDUp(xp, s.amp);
  const net = toXpUp(dy, at(s.rates, j));
  if (net < s.minTradeAmount) throw belowMin("normalised dy below minTradeAmount");
  const gross = mulDivUp(net, FEE_DENOMINATOR, FEE_DENOMINATOR - s.fee);
  const yTarget = at(xp, j) - gross - 1n;
  if (yTarget <= 0n) throw new PoolError("INSUFFICIENT_LIQUIDITY", "requested output exceeds the pool balance");
  const x = getYUp(j, i, yTarget, xp, s.amp, d0);
  const xpI = at(xp, i);
  const estimate = x > xpI ? fromXpUp(x - xpI, at(s.rates, i)) : 1n;

  const quoteAt = (dx: Amount): ExactInCore | null => {
    try {
      const core = exactInCore(s, i, j, dx, xp, d0);
      return core.dy >= dy ? core : null;
    } catch (error) {
      if (error instanceof PoolError && error.code === "BELOW_MIN_TRADE") return null;
      throw error;
    }
  };

  let steps = 0;
  const step = (): void => {
    if (++steps > EXACT_OUT_SEARCH_LIMIT) throw new PoolError("NO_CONVERGENCE", "exact-out search did not settle");
  };

  // Bracket: lo fails (or is 0), hi succeeds.
  let lo = 0n;
  let hi = estimate < 1n ? 1n : estimate;
  let best = quoteAt(hi);
  if (best === null) {
    let delta = 1n;
    lo = hi;
    for (;;) {
      step();
      const candidate = lo + delta;
      const q = quoteAt(candidate);
      if (q !== null) {
        hi = candidate;
        best = q;
        break;
      }
      lo = candidate;
      delta *= 2n;
    }
  } else {
    let delta = 1n;
    for (;;) {
      step();
      if (hi - delta < 1n) break;
      const candidate = hi - delta;
      const q = quoteAt(candidate);
      if (q === null) {
        lo = candidate;
        break;
      }
      hi = candidate;
      best = q;
      delta *= 2n;
    }
  }
  while (hi - lo > 1n) {
    step();
    const mid = (lo + hi) / 2n;
    const q = quoteAt(mid);
    if (q === null) lo = mid;
    else {
      hi = mid;
      best = q;
    }
  }
  return settleSwap(s, i, j, hi, dy, best);
}

function checkAmounts(s: Snapshot, amounts: readonly Amount[]): void {
  if (amounts.length !== s.balances.length) throw new PoolError("INVALID_EVENT", "amounts length must equal coin count");
  let any = false;
  amounts.forEach((a, k) => {
    if (a < 0n) throw new PoolError("INVALID_EVENT", "amounts must be >= 0");
    if (a === 0n) return;
    any = true;
    if (toXpDown(a, at(s.rates, k)) < s.minTradeAmount) throw belowMin(`amount of coin ${k} below minTradeAmount`);
  });
  if (!any) throw belowMin("all amounts are zero");
}

/**
 * add_liquidity / calc_token_amount(deposit) (Curve 3pool lines 274-335).
 *
 * Bootstrap (supply = 0): every coin must be deposited, D1 >= minInitialD,
 * and D1 shares are created: `minimumLiquidity` locked forever, the rest
 * (`minted`) to the depositor.
 *
 * Otherwise: imbalance fees (rounded up, see `imbalanceFee`) are charged per
 * coin, D2 is computed on balances net of fees, and
 *   minted = ⌊supply·(D2 − D0)/D0⌋                 rounded down
 */
export function quoteAddLiquidity(s: Snapshot, amounts: readonly Amount[]): AddQuote {
  checkAmounts(s, amounts);
  const n = s.balances.length;
  const zeros = new Array<Amount>(n).fill(0n);
  if (s.supply === 0n) {
    if (amounts.some((a) => a === 0n)) throw new PoolError("BOOTSTRAP", "first deposit must include every coin");
    const d1 = getDDown(xpOf(amounts, s.rates), s.amp);
    if (d1 < s.minInitialD) throw new PoolError("BOOTSTRAP", `initial D ${d1} below minInitialD`);
    return {
      minted: d1 - s.minimumLiquidity,
      locked: s.minimumLiquidity,
      fees: zeros,
      adminFees: zeros,
      d0: 0n,
      d1,
      d2: d1,
      balances: amounts.slice(),
    };
  }
  const d0 = getDUp(xpOf(s.balances, s.rates), s.amp);
  const raised = s.balances.map((b, k) => b + at(amounts, k));
  const d1 = getDDown(xpOf(raised, s.rates), s.amp);
  if (d1 <= d0) throw belowMin("deposit does not increase D");
  const feeRate = imbalanceFeeRate(s.fee, n);
  const fees: Amount[] = [];
  const adminFees: Amount[] = [];
  const net: Amount[] = [];
  const balances: Amount[] = [];
  for (let k = 0; k < n; k++) {
    const f = imbalanceFee(feeRate, d0, d1, at(s.balances, k), at(raised, k));
    const af = mulDivDown(f, s.adminFee, FEE_DENOMINATOR);
    const nb = at(raised, k) - f;
    if (nb <= 0n) throw new PoolError("INSUFFICIENT_LIQUIDITY", "imbalance fee exceeds the balance");
    fees.push(f);
    adminFees.push(af);
    net.push(nb);
    balances.push(at(raised, k) - af);
  }
  const d2 = getDDown(xpOf(net, s.rates), s.amp);
  const minted = d2 > d0 ? mulDivDown(s.supply, d2 - d0, d0) : 0n;
  if (minted === 0n) throw belowMin("deposit mints zero shares");
  requirePriceable(s, balances);
  return { minted, locked: 0n, fees, adminFees, d0, d1, d2, balances };
}

/**
 * remove_liquidity_imbalance / calc_token_amount(withdraw) (Curve 3pool
 * lines 529-553). Fees as for deposits, and
 *   burned = ⌊(D0 − D2)·supply/D0⌋ + 1             rounded up (3pool's "+1")
 */
export function quoteRemoveLiquidityImbalance(s: Snapshot, amounts: readonly Amount[]): RemoveImbalanceQuote {
  requireLiquidity(s);
  checkAmounts(s, amounts);
  const n = s.balances.length;
  const lowered: Amount[] = [];
  for (let k = 0; k < n; k++) {
    const nb = at(s.balances, k) - at(amounts, k);
    if (nb <= 0n) throw new PoolError("INSUFFICIENT_LIQUIDITY", `withdrawal empties coin ${k}`);
    lowered.push(nb);
  }
  const d0 = getDUp(xpOf(s.balances, s.rates), s.amp);
  const d1 = getDDown(xpOf(lowered, s.rates), s.amp);
  const feeRate = imbalanceFeeRate(s.fee, n);
  const fees: Amount[] = [];
  const adminFees: Amount[] = [];
  const net: Amount[] = [];
  const balances: Amount[] = [];
  for (let k = 0; k < n; k++) {
    const f = imbalanceFee(feeRate, d0, d1, at(s.balances, k), at(lowered, k));
    const af = mulDivDown(f, s.adminFee, FEE_DENOMINATOR);
    const nb = at(lowered, k) - f;
    if (nb <= 0n) throw new PoolError("INSUFFICIENT_LIQUIDITY", "imbalance fee exceeds the balance");
    fees.push(f);
    adminFees.push(af);
    net.push(nb);
    balances.push(at(lowered, k) - af);
  }
  const d2 = getDDown(xpOf(net, s.rates), s.amp);
  if (d2 >= d0) throw new PoolError("DOMAIN", "withdrawal does not lower D");
  const burned = mulDivDown(d0 - d2, s.supply, d0) + 1n;
  requirePriceable(s, balances);
  return { burned, fees, adminFees, balances };
}

/**
 * remove_liquidity_one_coin / calc_withdraw_one_coin (Curve 3pool
 * `_calc_withdraw_one_coin`, lines 630-654):
 *   D1     = D0 − ⌊shares·D0/supply⌋                  D reduction rounded down
 *   fee_k  = ⌈feeRate·expected_k/1e10⌉, expected_k rounded up
 *   dy     = ⌊(xp_reduced_i − y(D1) − 1)·1e18/rate_i⌋  output rounded down, minus 1
 *   admin  = ⌊(dy0 − dy)·adminFee/1e10⌋
 */
export function quoteRemoveLiquidityOneCoin(s: Snapshot, shares: Amount, i: CoinIndex): RemoveOneQuote {
  requireLiquidity(s);
  const n = s.balances.length;
  if (!Number.isInteger(i) || i < 0 || i >= n) throw new PoolError("INVALID_EVENT", "coin index out of range");
  if (shares <= 0n || shares >= s.supply) throw new PoolError("INVALID_EVENT", "shares must be in (0, supply)");
  const xp = xpOf(s.balances, s.rates);
  const d0 = getDUp(xp, s.amp);
  const d1 = d0 - mulDivDown(shares, d0, s.supply);
  const newY = getYDUp(i, xp, d1, s.amp);
  const feeRate = imbalanceFeeRate(s.fee, n);
  const reduced: bigint[] = [];
  for (let k = 0; k < n; k++) {
    const xk = at(xp, k);
    const expected = k === i ? absDiff(mulDivUp(xk, d1, d0), newY) : xk - mulDivDown(xk, d1, d0);
    const r = xk - mulDivUp(feeRate, expected, FEE_DENOMINATOR);
    if (r <= 0n) throw new PoolError("INSUFFICIENT_LIQUIDITY", "fee exceeds the balance");
    reduced.push(r);
  }
  const yReduced = getYDUp(i, reduced, d1, s.amp);
  const dyXp = at(reduced, i) - yReduced - 1n;
  if (dyXp < s.minTradeAmount || dyXp <= 0n) throw belowMin("normalised output below minTradeAmount");
  const rateI = at(s.rates, i);
  const dy = fromXpDown(dyXp, rateI);
  if (dy === 0n) throw belowMin("output rounds to zero");
  const xpI = at(xp, i);
  const dy0 = newY < xpI ? fromXpDown(xpI - newY, rateI) : 0n;
  const fee = dy0 > dy ? dy0 - dy : 0n;
  const adminFee = mulDivDown(fee, s.adminFee, FEE_DENOMINATOR);
  const balances = s.balances.slice();
  const nb = at(balances, i) - dy - adminFee;
  if (nb <= 0n) throw new PoolError("INSUFFICIENT_LIQUIDITY", "withdrawal empties the coin");
  balances[i] = nb;
  requirePriceable(s, balances);
  return { dy, fee, adminFee, balances };
}

/** remove_liquidity: amount_k = ⌊balance_k·shares/supply⌋, no fee (Curve 3pool lines 487-509). */
export function quoteRemoveLiquidity(s: Snapshot, shares: Amount): RemoveQuote {
  requireLiquidity(s);
  if (shares <= 0n || shares > s.supply) throw new PoolError("INVALID_EVENT", "shares must be in (0, supply]");
  const amounts = s.balances.map((b) => mulDivDown(b, shares, s.supply));
  const balances = s.balances.map((b, k) => b - at(amounts, k));
  return { amounts, balances };
}

/** D·1e18/supply, rounded down. */
export function virtualPriceOf(s: Snapshot): bigint {
  requireLiquidity(s);
  return mulDivDown(getDDown(xpOf(s.balances, s.rates), s.amp), PRECISION, s.supply);
}

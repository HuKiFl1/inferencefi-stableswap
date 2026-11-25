import {
  A_PRECISION,
  BPS,
  LOCKED_HOLDER,
  MAX_A,
  MAX_A_CHANGE,
  MAX_ADMIN_FEE,
  MAX_COINS,
  MAX_FEE,
  MAX_RATE,
  MIN_COINS,
} from "./constants.js";
import { PoolError } from "./errors.js";
import { absDiff, at, min } from "./math.js";
import {
  quoteAddLiquidity,
  quoteExchange,
  quoteExchangeExactOut,
  quoteRemoveLiquidity,
  quoteRemoveLiquidityImbalance,
  quoteRemoveLiquidityOneCoin,
  virtualPriceOf,
  type AddQuote,
  type RemoveImbalanceQuote,
  type RemoveOneQuote,
  type Snapshot,
  type SwapQuote,
} from "./pool-math.js";
import { ampAt } from "./ramp.js";
import type {
  Amount,
  Applied,
  BackingView,
  CoinIndex,
  Height,
  PartyId,
  PoolEvent,
  PoolParams,
  PoolState,
  Receipt,
  Totals,
} from "./types.js";

const isBigint = (v: unknown): v is bigint => typeof v === "bigint";
const isParty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function bad(message: string): PoolError {
  return new PoolError("INVALID_PARAMS", message);
}

export function validateParams(params: PoolParams): void {
  const { coins } = params;
  if (!Array.isArray(coins) || coins.length < MIN_COINS || coins.length > MAX_COINS) {
    throw bad(`coins must have ${MIN_COINS}..${MAX_COINS} entries`);
  }
  coins.forEach((c, k) => {
    if (typeof c.symbol !== "string") throw bad(`coin ${k}: symbol must be a string`);
    if (!isBigint(c.rate) || c.rate < 1n || c.rate > MAX_RATE) throw bad(`coin ${k}: rate must be in [1, MAX_RATE]`);
    if (c.expiresAt !== undefined && (!isBigint(c.expiresAt) || c.expiresAt < 0n)) {
      throw bad(`coin ${k}: expiresAt must be a bigint >= 0`);
    }
    if (c.backed !== undefined && typeof c.backed !== "boolean") throw bad(`coin ${k}: backed must be a boolean`);
  });
  if (!isBigint(params.A) || params.A < 1n || params.A >= MAX_A) throw bad("A must be in [1, MAX_A)");
  if (!isBigint(params.fee) || params.fee < 0n || params.fee > MAX_FEE) throw bad("fee must be in [0, MAX_FEE]");
  if (!isBigint(params.adminFee) || params.adminFee < 0n || params.adminFee > MAX_ADMIN_FEE) {
    throw bad("adminFee must be in [0, MAX_ADMIN_FEE]");
  }
  if (!isParty(params.admin) || params.admin === LOCKED_HOLDER) throw bad("admin must be a non-empty party id");
  const atLeast = (name: keyof PoolParams, floor: bigint): void => {
    const v = params[name];
    if (!isBigint(v) || v < floor) throw bad(`${name} must be a bigint >= ${floor}`);
  };
  atLeast("minRampBlocks", 1n);
  atLeast("adminDelayBlocks", 1n);
  atLeast("minimumLiquidity", 1n);
  atLeast("minInitialD", params.minimumLiquidity + 1n);
  atLeast("minTradeAmount", 1n);
  atLeast("minRateUpdateBlocks", 0n);
  atLeast("stalenessBlocks", 1n);
  atLeast("challengeWindowBlocks", 1n);
  if (!isBigint(params.maxRateChangeBps) || params.maxRateChangeBps < 0n || params.maxRateChangeBps > BPS) {
    throw bad("maxRateChangeBps must be in [0, 10000]");
  }
  if (params.verifyBacking !== undefined && typeof params.verifyBacking !== "function") {
    throw bad("verifyBacking must be a function when provided");
  }
}

export function initialState(params: PoolParams): PoolState {
  const n = params.coins.length;
  const zeros = (): Amount[] => new Array<Amount>(n).fill(0n);
  const amp = params.A * A_PRECISION;
  const totals: Totals = { deposited: zeros(), withdrawn: zeros(), adminWithdrawn: zeros(), writtenDown: zeros() };
  return {
    head: null,
    seq: 0,
    balances: zeros(),
    adminBalances: zeros(),
    rates: params.coins.map((c) => c.rate),
    rateUpdatedAt: zeros(),
    supply: 0n,
    shares: new Map(),
    fee: params.fee,
    adminFee: params.adminFee,
    pendingFees: null,
    ramp: { initialA: amp, futureA: amp, initialHeight: 0n, futureHeight: 0n },
    backing: params.coins.map((c) =>
      c.backed === true
        ? {
            status: "Live",
            nonce: 0n,
            stateRoot: null,
            recoverable: 0n,
            progressHeight: 0n,
            challengeStartedAt: null,
            reclaimableAt: null,
            reclaimedAmount: null,
          }
        : null,
    ),
    totals,
  };
}

// ---------------------------------------------------------------- modes

export interface PoolMode {
  /** Some coin expired or was reclaimed: only proportional exits and admin/backing events. */
  readonly windDown: boolean;
  readonly expired: readonly CoinIndex[];
  readonly reclaimed: readonly CoinIndex[];
  /** Coins whose backing is in its challenge window: the pool is restricted. */
  readonly challenged: readonly CoinIndex[];
}

export function poolMode(state: PoolState, params: PoolParams, height: Height): PoolMode {
  const expired: CoinIndex[] = [];
  const reclaimed: CoinIndex[] = [];
  const challenged: CoinIndex[] = [];
  params.coins.forEach((c, k) => {
    if (c.expiresAt !== undefined && height >= c.expiresAt) expired.push(k);
    const b = state.backing[k];
    if (b?.status === "Reclaimed") reclaimed.push(k);
    if (b?.status === "Challenge") challenged.push(k);
  });
  return { windDown: expired.length > 0 || reclaimed.length > 0, expired, reclaimed, challenged };
}

function requireTrading(mode: PoolMode): void {
  if (mode.windDown) {
    throw new PoolError("WIND_DOWN", `coins expired [${mode.expired}] / reclaimed [${mode.reclaimed}]: only proportional exits`);
  }
}

export function snapshot(state: PoolState, params: PoolParams, height: Height): Snapshot {
  return {
    balances: state.balances,
    rates: state.rates,
    amp: ampAt(state.ramp, height),
    fee: state.fee,
    adminFee: state.adminFee,
    supply: state.supply,
    minTradeAmount: params.minTradeAmount,
    minimumLiquidity: params.minimumLiquidity,
    minInitialD: params.minInitialD,
  };
}

/** R3: holdings (LP + admin) of every backed coin stay <= its recoverable escrow. */
function checkBackingCaps(state: PoolState, balances: readonly Amount[], adminBalances: readonly Amount[]): void {
  state.backing.forEach((b, k) => {
    if (b === null) return;
    const holdings = at(balances, k) + at(adminBalances, k);
    if (holdings > b.recoverable) {
      throw new PoolError("BACKING_EXCEEDED", `coin ${k} holdings ${holdings} exceed recoverable escrow ${b.recoverable}`);
    }
  });
}

const addAt = (values: readonly Amount[], k: number, delta: Amount): Amount[] => {
  const out = values.slice();
  out[k] = at(out, k) + delta;
  return out;
};
const addAll = (a: readonly Amount[], b: readonly Amount[]): Amount[] => a.map((v, k) => v + at(b, k));

// ---------------------------------------------------------------- plans (shared by events and views)

export function planExchange(state: PoolState, params: PoolParams, height: Height, i: CoinIndex, j: CoinIndex, dx: Amount): SwapQuote {
  const mode = poolMode(state, params, height);
  requireTrading(mode);
  if (mode.challenged.includes(i)) throw new PoolError("COIN_IN_CHALLENGE", `coin ${i} cannot be sold into the pool`);
  const q = quoteExchange(snapshot(state, params, height), i, j, dx);
  checkBackingCaps(state, q.balances, addAt(state.adminBalances, j, q.adminFee));
  return q;
}

export function planExchangeExactOut(
  state: PoolState,
  params: PoolParams,
  height: Height,
  i: CoinIndex,
  j: CoinIndex,
  dy: Amount,
): SwapQuote {
  const mode = poolMode(state, params, height);
  requireTrading(mode);
  if (mode.challenged.includes(i)) throw new PoolError("COIN_IN_CHALLENGE", `coin ${i} cannot be sold into the pool`);
  const q = quoteExchangeExactOut(snapshot(state, params, height), i, j, dy);
  checkBackingCaps(state, q.balances, addAt(state.adminBalances, j, q.adminFee));
  return q;
}

export function planAddLiquidity(state: PoolState, params: PoolParams, height: Height, amounts: readonly Amount[]): AddQuote {
  const mode = poolMode(state, params, height);
  requireTrading(mode);
  for (const k of mode.challenged) {
    if ((amounts[k] ?? 0n) > 0n) throw new PoolError("COIN_IN_CHALLENGE", `coin ${k} cannot be deposited`);
  }
  const q = quoteAddLiquidity(snapshot(state, params, height), amounts);
  checkBackingCaps(state, q.balances, addAll(state.adminBalances, q.adminFees));
  return q;
}

export function planRemoveLiquidityImbalance(
  state: PoolState,
  params: PoolParams,
  height: Height,
  amounts: readonly Amount[],
): RemoveImbalanceQuote {
  const mode = poolMode(state, params, height);
  requireTrading(mode);
  if (mode.challenged.length > 0) {
    throw new PoolError("COIN_IN_CHALLENGE", "imbalanced withdrawals are disabled while a coin is in challenge");
  }
  const q = quoteRemoveLiquidityImbalance(snapshot(state, params, height), amounts);
  checkBackingCaps(state, q.balances, addAll(state.adminBalances, q.adminFees));
  return q;
}

export function planRemoveLiquidityOneCoin(
  state: PoolState,
  params: PoolParams,
  height: Height,
  shares: Amount,
  coin: CoinIndex,
): RemoveOneQuote {
  const mode = poolMode(state, params, height);
  requireTrading(mode);
  if (mode.challenged.length > 0 && !mode.challenged.includes(coin)) {
    throw new PoolError("COIN_IN_CHALLENGE", "while a coin is in challenge, single-coin exits may only take that coin");
  }
  const q = quoteRemoveLiquidityOneCoin(snapshot(state, params, height), shares, coin);
  checkBackingCaps(state, q.balances, addAt(state.adminBalances, coin, q.adminFee));
  return q;
}

// ---------------------------------------------------------------- views

function requireQueryHeight(state: PoolState, height: Height): void {
  if (!isBigint(height) || height < 0n) throw new PoolError("INVALID_EVENT", "height must be a bigint >= 0");
  if (state.head !== null && height < state.head) {
    throw new PoolError("HEIGHT_REGRESSION", `query height ${height} is below ledger head ${state.head}`);
  }
}

/** get_dy: exact-input quote. Identical to the `dy` an Exchange event at this height would pay. */
export function getDy(state: PoolState, params: PoolParams, height: Height, i: CoinIndex, j: CoinIndex, dx: Amount): Amount {
  requireQueryHeight(state, height);
  return planExchange(state, params, height, i, j, dx).dy;
}

/** get_dx: exact-output quote. Identical to the `dx` an ExchangeExactOut event at this height would charge. */
export function getDx(state: PoolState, params: PoolParams, height: Height, i: CoinIndex, j: CoinIndex, dy: Amount): Amount {
  requireQueryHeight(state, height);
  return planExchangeExactOut(state, params, height, i, j, dy).dx;
}

/**
 * calc_token_amount, fee-inclusive (StableSwap-NG semantics, not the original pools'
 * fee-less estimate). Deposit: shares the depositor would receive. Withdrawal:
 * shares RemoveLiquidityImbalance would burn.
 */
export function calcTokenAmount(
  state: PoolState,
  params: PoolParams,
  height: Height,
  amounts: readonly Amount[],
  isDeposit: boolean,
): Amount {
  requireQueryHeight(state, height);
  return isDeposit
    ? planAddLiquidity(state, params, height, amounts).minted
    : planRemoveLiquidityImbalance(state, params, height, amounts).burned;
}

export function calcWithdrawOneCoin(
  state: PoolState,
  params: PoolParams,
  height: Height,
  shares: Amount,
  coin: CoinIndex,
): Amount {
  requireQueryHeight(state, height);
  return planRemoveLiquidityOneCoin(state, params, height, shares, coin).dy;
}

export function virtualPrice(state: PoolState, params: PoolParams, height: Height): bigint {
  requireQueryHeight(state, height);
  return virtualPriceOf(snapshot(state, params, height));
}

/** Raw A at `height` (precise A / A_PRECISION, rounded down). */
export function aAt(state: PoolState, height: Height): bigint {
  return ampAt(state.ramp, height) / A_PRECISION;
}

// ---------------------------------------------------------------- event validation helpers

function invalid(message: string): PoolError {
  return new PoolError("INVALID_EVENT", message);
}

function requireParty(by: unknown): PartyId {
  if (!isParty(by)) throw invalid("`by` must be a non-empty party id");
  if (by === LOCKED_HOLDER) throw new PoolError("UNAUTHORIZED", "the locked holder cannot act");
  return by;
}

function requireAdmin(by: unknown, params: PoolParams): void {
  if (requireParty(by) !== params.admin) throw new PoolError("UNAUTHORIZED", "admin-only action");
}

function requireAmount(v: unknown, name: string, positive = false): bigint {
  if (!isBigint(v) || v < 0n || (positive && v === 0n)) throw invalid(`${name} must be a bigint ${positive ? "> 0" : ">= 0"}`);
  return v;
}

function requireAmounts(v: unknown, n: number, name: string): readonly Amount[] {
  if (!Array.isArray(v) || v.length !== n) throw invalid(`${name} must be an array of ${n} amounts`);
  v.forEach((a, k) => requireAmount(a, `${name}[${k}]`));
  return v as readonly Amount[];
}

function requireCoin(v: unknown, n: number, name = "coin"): CoinIndex {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v >= n) throw invalid(`${name} must be a coin index`);
  return v;
}

function sharesOf(state: PoolState, who: PartyId): Amount {
  return state.shares.get(who) ?? 0n;
}

function requireShares(state: PoolState, who: PartyId, amount: Amount): void {
  if (sharesOf(state, who) < amount) throw new PoolError("INSUFFICIENT_SHARES", `${who} holds fewer than ${amount} shares`);
}

function moveShares(state: PoolState, changes: ReadonlyArray<readonly [PartyId, Amount]>): Map<PartyId, Amount> {
  const next = new Map(state.shares);
  for (const [who, delta] of changes) {
    const v = (next.get(who) ?? 0n) + delta;
    if (v === 0n) next.delete(who);
    else next.set(who, v);
  }
  return next;
}

function withBacking(state: PoolState, k: number, patch: Partial<BackingView>): (BackingView | null)[] {
  const out = state.backing.slice();
  const current = at(out, k);
  if (current === null) throw new PoolError("NOT_BACKED", `coin ${k} is not backed`);
  out[k] = { ...current, ...patch };
  return out;
}

function requireBacking(state: PoolState, k: number): BackingView {
  const b = at(state.backing, k);
  if (b === null) throw new PoolError("NOT_BACKED", `coin ${k} is not backed`);
  if (b.status === "Reclaimed") throw new PoolError("ALREADY_RECLAIMED", `coin ${k} backing was already reclaimed`);
  return b;
}

const zerosLike = (state: PoolState): Amount[] => state.balances.map(() => 0n);

// ---------------------------------------------------------------- apply

/**
 * Pure transition: returns the next state and a receipt, or throws a
 * PoolError and leaves `state` untouched. Applying the same events to the
 * same params always yields the same states and receipts.
 */
export function applyEvent(state: PoolState, event: PoolEvent, params: PoolParams): Applied {
  if (event === null || typeof event !== "object") throw invalid("event must be an object");
  const h = (event as { height?: unknown }).height;
  if (!isBigint(h) || h < 0n) throw invalid("height must be a bigint >= 0");
  if (state.head !== null && h < state.head) {
    throw new PoolError("HEIGHT_REGRESSION", `event height ${h} is below ledger head ${state.head}`);
  }
  const n = params.coins.length;
  const { next, receipt } = transition(state, event, params, h, n);
  return { state: { ...next, head: h, seq: state.seq + 1 }, receipt };
}

interface Step {
  readonly next: PoolState;
  readonly receipt: Receipt;
}

function transition(state: PoolState, e: PoolEvent, params: PoolParams, h: Height, n: number): Step {
  switch (e.type) {
    case "AddLiquidity": {
      const by = requireParty(e.by);
      const amounts = requireAmounts(e.amounts, n, "amounts");
      const minMint = requireAmount(e.minMint, "minMint");
      const q = planAddLiquidity(state, params, h, amounts);
      if (q.minted < minMint) throw new PoolError("SLIPPAGE", `minted ${q.minted} < minMint ${minMint}`);
      const changes: [PartyId, Amount][] = [[by, q.minted]];
      if (q.locked > 0n) changes.push([LOCKED_HOLDER, q.locked]);
      return {
        next: {
          ...state,
          balances: q.balances,
          adminBalances: addAll(state.adminBalances, q.adminFees),
          supply: state.supply + q.minted + q.locked,
          shares: moveShares(state, changes),
          totals: { ...state.totals, deposited: addAll(state.totals.deposited, amounts) },
        },
        receipt: { type: "AddLiquidity", minted: q.minted, locked: q.locked, fees: q.fees, adminFees: q.adminFees, d0: q.d0, d1: q.d1, d2: q.d2 },
      };
    }
    case "RemoveLiquidity": {
      const by = requireParty(e.by);
      const shares = requireAmount(e.shares, "shares", true);
      const minAmounts = requireAmounts(e.minAmounts, n, "minAmounts");
      requireShares(state, by, shares);
      const q = quoteRemoveLiquidity(snapshot(state, params, h), shares);
      q.amounts.forEach((a, k) => {
        if (a < at(minAmounts, k)) throw new PoolError("SLIPPAGE", `coin ${k}: ${a} < minAmount ${at(minAmounts, k)}`);
      });
      return {
        next: {
          ...state,
          balances: q.balances,
          supply: state.supply - shares,
          shares: moveShares(state, [[by, -shares]]),
          totals: { ...state.totals, withdrawn: addAll(state.totals.withdrawn, q.amounts) },
        },
        receipt: { type: "RemoveLiquidity", amounts: q.amounts, burned: shares },
      };
    }
    case "RemoveLiquidityImbalance": {
      const by = requireParty(e.by);
      const amounts = requireAmounts(e.amounts, n, "amounts");
      const maxBurn = requireAmount(e.maxBurn, "maxBurn");
      const q = planRemoveLiquidityImbalance(state, params, h, amounts);
      if (q.burned > maxBurn) throw new PoolError("SLIPPAGE", `burn ${q.burned} > maxBurn ${maxBurn}`);
      requireShares(state, by, q.burned);
      return {
        next: {
          ...state,
          balances: q.balances,
          adminBalances: addAll(state.adminBalances, q.adminFees),
          supply: state.supply - q.burned,
          shares: moveShares(state, [[by, -q.burned]]),
          totals: { ...state.totals, withdrawn: addAll(state.totals.withdrawn, amounts) },
        },
        receipt: { type: "RemoveLiquidityImbalance", burned: q.burned, fees: q.fees, adminFees: q.adminFees },
      };
    }
    case "RemoveLiquidityOneCoin": {
      const by = requireParty(e.by);
      const shares = requireAmount(e.shares, "shares", true);
      const coin = requireCoin(e.coin, n);
      const minAmount = requireAmount(e.minAmount, "minAmount");
      requireShares(state, by, shares);
      const q = planRemoveLiquidityOneCoin(state, params, h, shares, coin);
      if (q.dy < minAmount) throw new PoolError("SLIPPAGE", `dy ${q.dy} < minAmount ${minAmount}`);
      return {
        next: {
          ...state,
          balances: q.balances,
          adminBalances: addAt(state.adminBalances, coin, q.adminFee),
          supply: state.supply - shares,
          shares: moveShares(state, [[by, -shares]]),
          totals: { ...state.totals, withdrawn: addAt(state.totals.withdrawn, coin, q.dy) },
        },
        receipt: { type: "RemoveLiquidityOneCoin", dy: q.dy, fee: q.fee, adminFee: q.adminFee, burned: shares },
      };
    }
    case "Exchange":
    case "ExchangeExactOut": {
      requireParty(e.by);
      const i = requireCoin(e.i, n, "i");
      const j = requireCoin(e.j, n, "j");
      let q: SwapQuote;
      if (e.type === "Exchange") {
        const dx = requireAmount(e.dx, "dx", true);
        const minDy = requireAmount(e.minDy, "minDy");
        q = planExchange(state, params, h, i, j, dx);
        if (q.dy < minDy) throw new PoolError("SLIPPAGE", `dy ${q.dy} < minDy ${minDy}`);
      } else {
        const dy = requireAmount(e.dy, "dy", true);
        const maxDx = requireAmount(e.maxDx, "maxDx");
        q = planExchangeExactOut(state, params, h, i, j, dy);
        if (q.dx > maxDx) throw new PoolError("SLIPPAGE", `dx ${q.dx} > maxDx ${maxDx}`);
      }
      return {
        next: {
          ...state,
          balances: q.balances,
          adminBalances: addAt(state.adminBalances, j, q.adminFee),
          totals: {
            ...state.totals,
            deposited: addAt(state.totals.deposited, i, q.dx),
            withdrawn: addAt(state.totals.withdrawn, j, q.dy),
          },
        },
        receipt: { type: e.type, dx: q.dx, dy: q.dy, dyQuoted: q.dyQuoted, feeXp: q.feeXp, adminFee: q.adminFee, d0: q.d0, d1: q.d1 },
      };
    }
    case "RampA": {
      requireAdmin(e.by, params);
      if (!isBigint(e.futureA) || !isBigint(e.futureHeight)) throw invalid("futureA and futureHeight must be bigints");
      if (h < state.ramp.initialHeight + params.minRampBlocks) {
        throw new PoolError("RAMP_TOO_EARLY", `next ramp allowed at ${state.ramp.initialHeight + params.minRampBlocks}`);
      }
      if (e.futureHeight < h + params.minRampBlocks) throw new PoolError("RAMP_TOO_FAST", "ramp shorter than minRampBlocks");
      if (e.futureA < 1n || e.futureA >= MAX_A) throw new PoolError("A_OUT_OF_RANGE", "futureA must be in [1, MAX_A)");
      const current = ampAt(state.ramp, h);
      const target = e.futureA * A_PRECISION;
      const tooLarge = target < current ? target * MAX_A_CHANGE < current : target > current * MAX_A_CHANGE;
      if (tooLarge) throw new PoolError("A_CHANGE_TOO_LARGE", `A may change by at most ${MAX_A_CHANGE}x per ramp`);
      return {
        next: { ...state, ramp: { initialA: current, futureA: target, initialHeight: h, futureHeight: e.futureHeight } },
        receipt: { type: "RampA", amounts: zerosLike(state) },
      };
    }
    case "StopRampA": {
      requireAdmin(e.by, params);
      const current = ampAt(state.ramp, h);
      return {
        next: { ...state, ramp: { initialA: current, futureA: current, initialHeight: h, futureHeight: h } },
        receipt: { type: "StopRampA", amounts: zerosLike(state) },
      };
    }
    case "CommitFees": {
      requireAdmin(e.by, params);
      if (state.pendingFees !== null) throw new PoolError("ACTION_PENDING", "a fee change is already pending");
      if (!isBigint(e.fee) || e.fee < 0n || e.fee > MAX_FEE) throw new PoolError("FEE_OUT_OF_RANGE", "fee must be in [0, MAX_FEE]");
      if (!isBigint(e.adminFee) || e.adminFee < 0n || e.adminFee > MAX_ADMIN_FEE) {
        throw new PoolError("FEE_OUT_OF_RANGE", "adminFee must be in [0, MAX_ADMIN_FEE]");
      }
      return {
        next: { ...state, pendingFees: { fee: e.fee, adminFee: e.adminFee, deadline: h + params.adminDelayBlocks } },
        receipt: { type: "CommitFees", amounts: zerosLike(state) },
      };
    }
    case "ApplyFees": {
      requireAdmin(e.by, params);
      const pending = state.pendingFees;
      if (pending === null) throw new PoolError("NO_PENDING_ACTION", "no fee change committed");
      if (h < pending.deadline) throw new PoolError("ADMIN_DELAY", `fee change applies at ${pending.deadline}`);
      if (e.fee !== pending.fee || e.adminFee !== pending.adminFee) {
        throw new PoolError("PAYLOAD_MISMATCH", "ApplyFees must repeat the committed fee and adminFee exactly");
      }
      return {
        next: { ...state, fee: pending.fee, adminFee: pending.adminFee, pendingFees: null },
        receipt: { type: "ApplyFees", amounts: zerosLike(state) },
      };
    }
    case "RevertFees": {
      requireAdmin(e.by, params);
      if (state.pendingFees === null) throw new PoolError("NO_PENDING_ACTION", "no fee change committed");
      return { next: { ...state, pendingFees: null }, receipt: { type: "RevertFees", amounts: zerosLike(state) } };
    }
    case "WithdrawAdminFees": {
      requireAdmin(e.by, params);
      const amounts = state.adminBalances.slice();
      return {
        next: {
          ...state,
          adminBalances: zerosLike(state),
          totals: { ...state.totals, adminWithdrawn: addAll(state.totals.adminWithdrawn, amounts) },
        },
        receipt: { type: "WithdrawAdminFees", amounts },
      };
    }
    case "SetRate": {
      requireAdmin(e.by, params);
      const coin = requireCoin(e.coin, n);
      if (!isBigint(e.rate) || e.rate < 1n || e.rate > MAX_RATE) throw new PoolError("RATE_OUT_OF_RANGE", "rate must be in [1, MAX_RATE]");
      const last = at(state.rateUpdatedAt, coin);
      if (h < last + params.minRateUpdateBlocks) {
        throw new PoolError("RATE_UPDATE_TOO_SOON", `coin ${coin} rate may change again at ${last + params.minRateUpdateBlocks}`);
      }
      const old = at(state.rates, coin);
      if (absDiff(e.rate, old) * BPS > old * params.maxRateChangeBps) {
        throw new PoolError("RATE_CHANGE_TOO_LARGE", `rate change exceeds ${params.maxRateChangeBps} bps`);
      }
      const rates = state.rates.slice();
      rates[coin] = e.rate;
      const rateUpdatedAt = state.rateUpdatedAt.slice();
      rateUpdatedAt[coin] = h;
      return { next: { ...state, rates, rateUpdatedAt }, receipt: { type: "SetRate", amounts: zerosLike(state) } };
    }
    case "BackingUpdated": {
      const coin = requireCoin(e.coin, n);
      const b = requireBacking(state, coin);
      if (!isBigint(e.nonce) || e.nonce < 1n) throw invalid("nonce must be a bigint >= 1");
      const recoverable = requireAmount(e.recoverable, "recoverable");
      if (!isParty(e.stateRoot)) throw invalid("stateRoot must be a non-empty string");
      if (b.status === "Challenge" && b.reclaimableAt !== null && h >= b.reclaimableAt) {
        throw new PoolError("CHALLENGE_WINDOW_CLOSED", `backing of coin ${coin} is frozen since ${b.reclaimableAt}`);
      }
      if (e.nonce <= b.nonce) throw new PoolError("STALE_NONCE", `nonce ${e.nonce} <= latest ${b.nonce}`);
      if (params.verifyBacking !== undefined) {
        const input = Object.freeze({ coin, nonce: e.nonce, recoverable, stateRoot: e.stateRoot });
        if (!params.verifyBacking(input)) throw new PoolError("BACKING_REJECTED", "verifyBacking returned false");
      }
      // Write the coin down to the new recoverable amount before anything can
      // pay out against it: admin fees (the reserve) absorb the loss first.
      const lp = at(state.balances, coin);
      const adm = at(state.adminBalances, coin);
      const excess = lp + adm > recoverable ? lp + adm - recoverable : 0n;
      const fromAdmin = min(excess, adm);
      const fromLp = excess - fromAdmin;
      return {
        next: {
          ...state,
          balances: addAt(state.balances, coin, -fromLp),
          adminBalances: addAt(state.adminBalances, coin, -fromAdmin),
          backing: withBacking(state, coin, {
            nonce: e.nonce,
            stateRoot: e.stateRoot,
            recoverable,
            progressHeight: b.status === "Live" ? h : b.progressHeight,
          }),
          totals: { ...state.totals, writtenDown: addAt(state.totals.writtenDown, coin, excess) },
        },
        receipt: { type: "BackingUpdated", coin, writtenDown: excess, writtenDownFromAdmin: fromAdmin },
      };
    }
    case "BackingChallenged": {
      requireParty(e.by);
      const coin = requireCoin(e.coin, n);
      const b = requireBacking(state, coin);
      if (b.status === "Challenge") throw new PoolError("CHALLENGE_ALREADY_STARTED", `coin ${coin} is already in challenge`);
      if (h < b.progressHeight + params.stalenessBlocks) {
        throw new PoolError("NOT_STALE", `coin ${coin} backing is stale from ${b.progressHeight + params.stalenessBlocks}`);
      }
      return {
        next: {
          ...state,
          backing: withBacking(state, coin, {
            status: "Challenge",
            challengeStartedAt: h,
            reclaimableAt: h + params.challengeWindowBlocks,
          }),
        },
        receipt: { type: "BackingChallenged", coin, writtenDown: 0n, writtenDownFromAdmin: 0n },
      };
    }
    case "BackingReclaimed": {
      requireParty(e.by);
      const coin = requireCoin(e.coin, n);
      const b = requireBacking(state, coin);
      if (b.status !== "Challenge" || b.reclaimableAt === null) throw new PoolError("NO_CHALLENGE", `coin ${coin} has no challenge`);
      if (h < b.reclaimableAt) throw new PoolError("CHALLENGE_WINDOW_OPEN", `coin ${coin} reclaimable at ${b.reclaimableAt}`);
      if (e.nonce !== b.nonce || e.amount !== b.recoverable) {
        throw new PoolError("PAYLOAD_MISMATCH", "reclaim must bind the latest backing nonce and recoverable amount");
      }
      const holdings = at(state.balances, coin) + at(state.adminBalances, coin);
      if (holdings > e.amount) throw new PoolError("INVARIANT_VIOLATION", "holdings exceed the reclaimed amount");
      return {
        next: { ...state, backing: withBacking(state, coin, { status: "Reclaimed", reclaimedAmount: e.amount }) },
        receipt: { type: "BackingReclaimed", coin, writtenDown: 0n, writtenDownFromAdmin: 0n },
      };
    }
    default: {
      const t = (e as { type?: unknown }).type;
      throw invalid(`unknown event type ${String(t)}`);
    }
  }
}

/** Rebuilds the state from scratch. Throws on the first rejected event. */
export function replay(params: PoolParams, events: readonly PoolEvent[]): PoolState {
  validateParams(params);
  let state = initialState(params);
  for (const event of events) state = applyEvent(state, event, params).state;
  return state;
}

/** Token amount in the coin's smallest unit. Never a float. */
export type Amount = bigint;
/** Block height. Time in this library is measured only in blocks, supplied by the caller. */
export type Height = bigint;
/** Opaque party identifier (LP, trader, admin, keeper, ...). */
export type PartyId = string;
/** Index of a coin in `PoolParams.coins`. */
export type CoinIndex = number;

export interface CoinConfig {
  /** Display label, e.g. "credit[model-x, provider-1]". Not used by the math. */
  readonly symbol: string;
  /**
   * Initial rate multiplier with 1e18 precision: normalised = amount * rate / 1e18.
   * 10^(36 - decimals) for a token worth one numeraire unit (Curve 3pool `RATES`).
   */
  readonly rate: bigint;
  /** Delivery-epoch expiry. At heights >= expiresAt the coin is void and the pool winds down. */
  readonly expiresAt?: Height;
  /**
   * When true, the pool's holdings of this coin are capped by the recoverable
   * escrow reported through BackingUpdated events (stale-channel reclaim, R3).
   */
  readonly backed?: boolean;
}

export interface BackingUpdateInput {
  readonly coin: CoinIndex;
  readonly nonce: bigint;
  readonly recoverable: Amount;
  readonly stateRoot: string;
}

export interface PoolParams {
  readonly coins: readonly CoinConfig[];
  /** Initial raw amplification coefficient, 1 <= A < MAX_A. */
  readonly A: bigint;
  /** Swap fee in parts of 1e10, <= MAX_FEE. */
  readonly fee: bigint;
  /** Share of the swap fee kept by the admin, in parts of 1e10, <= MAX_ADMIN_FEE. */
  readonly adminFee: bigint;
  /** The only party allowed to ramp A, change fees or rates, and withdraw admin fees. */
  readonly admin: PartyId;
  /** Minimum ramp duration and minimum spacing between ramp starts (Curve MIN_RAMP_TIME, in blocks). */
  readonly minRampBlocks: Height;
  /** Delay between CommitFees and ApplyFees (Curve ADMIN_ACTIONS_DELAY, in blocks). >= 1. */
  readonly adminDelayBlocks: Height;
  /** LP shares locked forever by the first deposit (Uniswap MINIMUM_LIQUIDITY). >= 1. */
  readonly minimumLiquidity: Amount;
  /** Minimum D of the first deposit, in normalised units. > minimumLiquidity. */
  readonly minInitialD: Amount;
  /** Minimum normalised size of any non-zero trade leg or deposit/withdrawal amount. >= 1. */
  readonly minTradeAmount: Amount;
  /** Maximum relative change of a coin's rate per SetRate, in basis points (yETH: 1000). */
  readonly maxRateChangeBps: bigint;
  /** Minimum blocks between two SetRate events for the same coin. */
  readonly minRateUpdateBlocks: Height;
  /** N: blocks without backing progress before a backed coin may be challenged (as in flop-channel-reclaim). >= 1. */
  readonly stalenessBlocks: Height;
  /** W: challenge window length in blocks (as in flop-channel-reclaim). >= 1. */
  readonly challengeWindowBlocks: Height;
  /**
   * Optional authenticity check for backing updates, e.g. verifying that the
   * update is the exact finalized channel state it claims to be. Must be pure
   * and deterministic; it is re-run on replay.
   */
  readonly verifyBacking?: (update: BackingUpdateInput) => boolean;
}

// ---------------------------------------------------------------- events

export interface AddLiquidity {
  readonly type: "AddLiquidity";
  readonly height: Height;
  readonly by: PartyId;
  readonly amounts: readonly Amount[];
  readonly minMint: Amount;
}

export interface RemoveLiquidity {
  readonly type: "RemoveLiquidity";
  readonly height: Height;
  readonly by: PartyId;
  readonly shares: Amount;
  readonly minAmounts: readonly Amount[];
}

export interface RemoveLiquidityImbalance {
  readonly type: "RemoveLiquidityImbalance";
  readonly height: Height;
  readonly by: PartyId;
  readonly amounts: readonly Amount[];
  readonly maxBurn: Amount;
}

export interface RemoveLiquidityOneCoin {
  readonly type: "RemoveLiquidityOneCoin";
  readonly height: Height;
  readonly by: PartyId;
  readonly shares: Amount;
  readonly coin: CoinIndex;
  readonly minAmount: Amount;
}

/** Exact-input swap: sell exactly `dx` of coin i, receive at least `minDy` of coin j. */
export interface Exchange {
  readonly type: "Exchange";
  readonly height: Height;
  readonly by: PartyId;
  readonly i: CoinIndex;
  readonly j: CoinIndex;
  readonly dx: Amount;
  readonly minDy: Amount;
}

/** Exact-output swap: receive exactly `dy` of coin j, pay at most `maxDx` of coin i. */
export interface ExchangeExactOut {
  readonly type: "ExchangeExactOut";
  readonly height: Height;
  readonly by: PartyId;
  readonly i: CoinIndex;
  readonly j: CoinIndex;
  readonly dy: Amount;
  readonly maxDx: Amount;
}

export interface RampA {
  readonly type: "RampA";
  readonly height: Height;
  readonly by: PartyId;
  /** Raw target A. */
  readonly futureA: bigint;
  readonly futureHeight: Height;
}

export interface StopRampA {
  readonly type: "StopRampA";
  readonly height: Height;
  readonly by: PartyId;
}

export interface CommitFees {
  readonly type: "CommitFees";
  readonly height: Height;
  readonly by: PartyId;
  readonly fee: bigint;
  readonly adminFee: bigint;
}

/** Must repeat the committed payload exactly. */
export interface ApplyFees {
  readonly type: "ApplyFees";
  readonly height: Height;
  readonly by: PartyId;
  readonly fee: bigint;
  readonly adminFee: bigint;
}

export interface RevertFees {
  readonly type: "RevertFees";
  readonly height: Height;
  readonly by: PartyId;
}

export interface WithdrawAdminFees {
  readonly type: "WithdrawAdminFees";
  readonly height: Height;
  readonly by: PartyId;
}

export interface SetRate {
  readonly type: "SetRate";
  readonly height: Height;
  readonly by: PartyId;
  readonly coin: CoinIndex;
  readonly rate: bigint;
}

/**
 * A newer finalized state of the escrow backing a coin. `recoverable` is the
 * lender principal the pool could still reclaim at that state (for one Flop
 * channel: `computePayouts(...).toLender`, see `recoverablePrincipal`).
 */
export interface BackingUpdated extends BackingUpdateInput {
  readonly type: "BackingUpdated";
  readonly height: Height;
}

/** Starts the challenge window for a backed coin that has stopped progressing (Flop ReclaimInitiated). */
export interface BackingChallenged {
  readonly type: "BackingChallenged";
  readonly height: Height;
  readonly by: PartyId;
  readonly coin: CoinIndex;
}

/** The escrow was reclaimed (Flop Reclaimed). Must bind the exact (nonce, amount) of the latest backing. */
export interface BackingReclaimed {
  readonly type: "BackingReclaimed";
  readonly height: Height;
  readonly by: PartyId;
  readonly coin: CoinIndex;
  readonly nonce: bigint;
  readonly amount: Amount;
}

export type PoolEvent =
  | AddLiquidity
  | RemoveLiquidity
  | RemoveLiquidityImbalance
  | RemoveLiquidityOneCoin
  | Exchange
  | ExchangeExactOut
  | RampA
  | StopRampA
  | CommitFees
  | ApplyFees
  | RevertFees
  | WithdrawAdminFees
  | SetRate
  | BackingUpdated
  | BackingChallenged
  | BackingReclaimed;

export type PoolEventType = PoolEvent["type"];

// ---------------------------------------------------------------- state

/** Precise A (raw A * A_PRECISION) interpolated linearly in block height. */
export interface RampState {
  readonly initialA: bigint;
  readonly futureA: bigint;
  readonly initialHeight: Height;
  readonly futureHeight: Height;
}

export interface PendingFees {
  readonly fee: bigint;
  readonly adminFee: bigint;
  /** First height at which ApplyFees succeeds. */
  readonly deadline: Height;
}

export type BackingStatus = "Live" | "Challenge" | "Reclaimed";

export interface BackingView {
  readonly status: BackingStatus;
  /** 0 until the first BackingUpdated. */
  readonly nonce: bigint;
  readonly stateRoot: string | null;
  /** Escrow the pool could reclaim at the latest finalized state. Caps holdings of the coin. */
  readonly recoverable: Amount;
  /** Height of the latest BackingUpdated accepted while Live (0 before the first). */
  readonly progressHeight: Height;
  readonly challengeStartedAt: Height | null;
  readonly reclaimableAt: Height | null;
  readonly reclaimedAmount: Amount | null;
}

/** Cumulative per-coin flows. Conservation: deposited - withdrawn - adminWithdrawn - writtenDown = balance + adminBalance. */
export interface Totals {
  readonly deposited: readonly Amount[];
  readonly withdrawn: readonly Amount[];
  readonly adminWithdrawn: readonly Amount[];
  readonly writtenDown: readonly Amount[];
}

export interface PoolState {
  /** Height of the last accepted event, or null for an empty ledger. */
  readonly head: Height | null;
  /** Number of accepted events. */
  readonly seq: number;
  /** LP-owned balances; the only balances the invariant sees. */
  readonly balances: readonly Amount[];
  /** Admin fees held by the pool but excluded from the invariant. */
  readonly adminBalances: readonly Amount[];
  readonly rates: readonly bigint[];
  readonly rateUpdatedAt: readonly Height[];
  readonly supply: Amount;
  readonly shares: ReadonlyMap<PartyId, Amount>;
  readonly fee: bigint;
  readonly adminFee: bigint;
  readonly pendingFees: PendingFees | null;
  readonly ramp: RampState;
  /** One entry per coin; null for coins that are not `backed`. */
  readonly backing: readonly (BackingView | null)[];
  readonly totals: Totals;
}

// ---------------------------------------------------------------- receipts

export interface AddLiquidityReceipt {
  readonly type: "AddLiquidity";
  readonly minted: Amount;
  /** Shares locked to LOCKED_HOLDER (non-zero only on the bootstrap deposit). */
  readonly locked: Amount;
  readonly fees: readonly Amount[];
  readonly adminFees: readonly Amount[];
  readonly d0: bigint;
  readonly d1: bigint;
  readonly d2: bigint;
}

export interface RemoveLiquidityReceipt {
  readonly type: "RemoveLiquidity";
  readonly amounts: readonly Amount[];
  readonly burned: Amount;
}

export interface RemoveLiquidityImbalanceReceipt {
  readonly type: "RemoveLiquidityImbalance";
  readonly burned: Amount;
  readonly fees: readonly Amount[];
  readonly adminFees: readonly Amount[];
}

export interface RemoveLiquidityOneCoinReceipt {
  readonly type: "RemoveLiquidityOneCoin";
  readonly dy: Amount;
  /** dy0 - dy: what the same burn would pay with zero fee, minus what it pays. */
  readonly fee: Amount;
  readonly adminFee: Amount;
  readonly burned: Amount;
}

export interface ExchangeReceipt {
  readonly type: "Exchange" | "ExchangeExactOut";
  readonly dx: Amount;
  /** Amount paid to the trader. */
  readonly dy: Amount;
  /** Exact-input output of `dx`. Equals `dy` for Exchange; >= dy for ExchangeExactOut (the surplus stays with LPs). */
  readonly dyQuoted: Amount;
  /** Swap fee in normalised units. */
  readonly feeXp: bigint;
  /** Admin part of the fee in native units of coin j. */
  readonly adminFee: Amount;
  readonly d0: bigint;
  readonly d1: bigint;
}

export interface BackingReceipt {
  readonly type: "BackingUpdated" | "BackingChallenged" | "BackingReclaimed";
  readonly coin: CoinIndex;
  /** Holdings written off to respect the recoverable cap: admin balance first, then LP balance. */
  readonly writtenDown: Amount;
  readonly writtenDownFromAdmin: Amount;
}

export interface AdminReceipt {
  readonly type: "RampA" | "StopRampA" | "CommitFees" | "ApplyFees" | "RevertFees" | "WithdrawAdminFees" | "SetRate";
  /** Amounts paid out by WithdrawAdminFees; zeros otherwise. */
  readonly amounts: readonly Amount[];
}

export type Receipt =
  | AddLiquidityReceipt
  | RemoveLiquidityReceipt
  | RemoveLiquidityImbalanceReceipt
  | RemoveLiquidityOneCoinReceipt
  | ExchangeReceipt
  | BackingReceipt
  | AdminReceipt;

export interface Applied {
  readonly state: PoolState;
  readonly receipt: Receipt;
}

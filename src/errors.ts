export type PoolErrorCode =
  /** Pool parameters are malformed or out of range. */
  | "INVALID_PARAMS"
  /** Event is structurally malformed (wrong types, negative amounts, bad coin index, ...). */
  | "INVALID_EVENT"
  /** Event height is below the ledger head, or a query height is below the head. */
  | "HEIGHT_REGRESSION"
  /** Caller is not allowed to append this event (admin-only action, locked share holder, ...). */
  | "UNAUTHORIZED"
  /** A listener tried to append while the ledger was dispatching a committed event. */
  | "REENTRANCY"
  /** A solver precondition failed: zero or out-of-range balance, non-positive Newton denominator, ... */
  | "DOMAIN"
  /** Newton iteration did not converge within the iteration cap. */
  | "NO_CONVERGENCE"
  /** Post-condition failed: a swap would have lowered the invariant D. Should be unreachable. */
  | "INVARIANT_VIOLATION"
  /** Result is worse than the caller's limit (minDy, maxDx, minMint, maxBurn, minAmounts). */
  | "SLIPPAGE"
  /** A trade or deposit amount is below `minTradeAmount` (normalised units), or rounds to zero. */
  | "BELOW_MIN_TRADE"
  /** The pool cannot pay the requested output without emptying a balance. */
  | "INSUFFICIENT_LIQUIDITY"
  /** Caller holds fewer LP shares than it tries to burn. */
  | "INSUFFICIENT_SHARES"
  /** First deposit is invalid: a coin is missing, or D is below `minInitialD`. */
  | "BOOTSTRAP"
  /** Operation needs liquidity but the pool has never been bootstrapped. */
  | "EMPTY_POOL"
  /** RampA earlier than `minRampBlocks` after the previous ramp started. */
  | "RAMP_TOO_EARLY"
  /** RampA whose duration is shorter than `minRampBlocks`. */
  | "RAMP_TOO_FAST"
  /** A outside [1, MAX_A). */
  | "A_OUT_OF_RANGE"
  /** One ramp would change A by more than MAX_A_CHANGE in either direction. */
  | "A_CHANGE_TOO_LARGE"
  /** Fee or admin fee above its maximum. */
  | "FEE_OUT_OF_RANGE"
  /** CommitFees while another fee change is pending. */
  | "ACTION_PENDING"
  /** ApplyFees / RevertFees with nothing committed. */
  | "NO_PENDING_ACTION"
  /** ApplyFees before the admin delay has elapsed. */
  | "ADMIN_DELAY"
  /** The executed payload differs from the committed or attested one. */
  | "PAYLOAD_MISMATCH"
  /** SetRate outside [1, MAX_RATE]. */
  | "RATE_OUT_OF_RANGE"
  /** SetRate moves the rate by more than `maxRateChangeBps`. */
  | "RATE_CHANGE_TOO_LARGE"
  /** SetRate sooner than `minRateUpdateBlocks` after the previous update of that coin. */
  | "RATE_UPDATE_TOO_SOON"
  /** Operation not allowed because a coin has expired or been reclaimed (wind-down mode). */
  | "WIND_DOWN"
  /** Operation not allowed because a coin's backing is in its challenge window (restricted mode). */
  | "COIN_IN_CHALLENGE"
  /** Pool holdings of a backed coin would exceed its recoverable escrow (R3). */
  | "BACKING_EXCEEDED"
  /** Backing event for a coin that is not configured as `backed`. */
  | "NOT_BACKED"
  /** Backing update whose nonce is not strictly higher than the latest. */
  | "STALE_NONCE"
  /** `verifyBacking` returned false. */
  | "BACKING_REJECTED"
  /** BackingChallenged before `stalenessBlocks` have passed without progress. */
  | "NOT_STALE"
  | "CHALLENGE_ALREADY_STARTED"
  /** BackingReclaimed without a prior BackingChallenged. */
  | "NO_CHALLENGE"
  /** BackingReclaimed before the challenge window has elapsed. */
  | "CHALLENGE_WINDOW_OPEN"
  /** BackingUpdated after the challenge window has elapsed. */
  | "CHALLENGE_WINDOW_CLOSED"
  /** Any backing event for a coin that has already been reclaimed. */
  | "ALREADY_RECLAIMED";

export class PoolError extends Error {
  override readonly name = "PoolError";
  readonly code: PoolErrorCode;

  constructor(code: PoolErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export function isPoolError(value: unknown, code?: PoolErrorCode): value is PoolError {
  return value instanceof PoolError && (code === undefined || value.code === code);
}

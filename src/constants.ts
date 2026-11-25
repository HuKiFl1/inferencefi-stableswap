/** Fixed-point base for rates and normalised ("xp") balances: 1e18 = one normalised token. */
export const PRECISION = 10n ** 18n;
/** Fees are expressed in parts of 1e10, as in public Curve docs. */
export const FEE_DENOMINATOR = 10n ** 10n;
/** Swap fee cap: 50%, as in public Curve docs. */
export const MAX_FEE = 5n * 10n ** 9n;
/** Admin share of the fee cap: 100%, as in public Curve docs. */
export const MAX_ADMIN_FEE = 10n ** 10n;
/**
 * A is stored multiplied by A_PRECISION (StableSwap-NG) so ramps interpolate
 * smoothly. For an integer A, A_PRECISION cancels exactly and the solvers give
 * the same results as with plain integer A.
 */
export const A_PRECISION = 100n;
/** Exclusive upper bound for raw A, as in public Curve docs. */
export const MAX_A = 10n ** 6n;
/** One ramp may change A by at most this factor in either direction (10x, as in public Curve docs). */
export const MAX_A_CHANGE = 10n;
/** Newton iteration cap for both solvers (255, the usual StableSwap cap). */
export const MAX_ITERATIONS = 255;
/** Supported coin counts (StableSwap-NG supports up to 8). */
export const MIN_COINS = 2;
export const MAX_COINS = 8;
/**
 * Upper bound of the solver domain for any normalised balance or D:
 * 1e15 whole tokens at 18 decimals. Inputs above it fail with DOMAIN rather
 * than being solved outside the range the tests cover.
 */
export const MAX_XP = 10n ** 33n;
/** Rate multipliers must lie in [1, MAX_RATE]; 1e39 covers a 0-decimal token priced at 1000. */
export const MAX_RATE = 10n ** 39n;
/** Basis-point denominator for `maxRateChangeBps`. */
export const BPS = 10_000n;
/** Holder id that owns the shares burned at bootstrap. No event may use it as `by`. */
export const LOCKED_HOLDER = "<locked>";

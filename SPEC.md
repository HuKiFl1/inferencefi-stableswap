# InferenceFi StableSwap Pool: Specification

Version 0.1. The key words "must", "never" and "always" are normative.

## 1. Scope

A pure, deterministic StableSwap pool for `n` (2 to 8) inference-credit tokens
that should trade near 1:1: for example "1M tokens of model X at provider P1"
against the same credit at P2. The pool is specified as an append-only event
ledger. Its state is a pure function of `(params, events)`, the same structure
as the companion library
[flop-channel-reclaim](https://github.com/HuKiFl1/Flop) (stale-channel escrow
reclaim), whose stages a backed coin mirrors (§9).

Out of scope: token transfers, signatures, oracles, networking and clocks. The
caller supplies block heights and decides which events to append.

## 2. Conventions

- Every amount, rate, share and height is a `bigint`. There are no floats.
- `xp_k = ⌊balance_k·rate_k/1e18⌋` is coin `k` in normalised (1e18) units.
- `Ann = A·n` follows the convention in public Curve docs (`A` = paper `A·nⁿ⁻¹`), and is
  stored scaled by `A_PRECISION = 100`. The invariant is
  `Ann·Σx + D = Ann·D + D^(n+1) / (nⁿ·Πx)`.
- Fees are in units of `FEE_DENOMINATOR = 1e10`.
- `⌊·⌋` rounds toward zero (all operands are non-negative) and `⌈·⌉` rounds up.
- A **rejected** event throws `PoolError` with a stable `code` (§12) and leaves
  the ledger exactly as it was.

## 3. Parameters

| Name | Constraint | Meaning |
|---|---|---|
| `coins[k].rate` | `1 ≤ rate ≤ 1e39` | Initial rate multiplier: 1e18·10^(18−decimals)·price. |
| `coins[k].expiresAt` | optional height | Delivery-epoch expiry (§8). |
| `coins[k].backed` | optional | Holdings are capped by reclaimable escrow (§9). |
| `A` | `1 ≤ A < MAX_A = 1e6` | Initial amplification. |
| `fee` | `≤ MAX_FEE = 5e9` | Swap fee (50%). |
| `adminFee` | `≤ 1e10` | Admin share of every fee. |
| `admin` | non-empty, not `"<locked>"` | Only party for admin events. |
| `minRampBlocks` | `≥ 1` | Min ramp duration and spacing between ramp starts. |
| `adminDelayBlocks` | `≥ 1` | Delay between `CommitFees` and `ApplyFees`. |
| `minimumLiquidity` | `≥ 1` | Shares locked forever at bootstrap. |
| `minInitialD` | `> minimumLiquidity` | Smallest allowed bootstrap D. |
| `minTradeAmount` | `≥ 1` | Smallest normalised amount on every priced path. |
| `maxRateChangeBps` | `0 to 10000` | Max rate change per `SetRate`. |
| `minRateUpdateBlocks` | `≥ 0` | Min blocks between rate updates of a coin. |
| `stalenessBlocks` (`N`) | `≥ 1` | Blocks without backing progress before a challenge. |
| `challengeWindowBlocks` (`W`) | `≥ 1` | Challenge window length. |
| `verifyBacking` | optional function | Authenticates backing updates (§9). |

## 4. Ledger rules

1. Event heights are non-decreasing (`HEIGHT_REGRESSION`). Views require
   `height ≥ head`.
2. Every event is validated and applied atomically by
   `applyEvent(state, event, params)`. `replay(params, events)` reproduces the
   live state exactly.
3. One lock spans every state-changing entry point. The state is committed
   before listeners run (checks-effects-interactions). An `append` from inside a
   listener or from `verifyBacking` throws `REENTRANCY`. If a listener throws,
   the whole append is undone and the error propagates, like a reverted
   transaction.
4. Recorded events (including their arrays), receipts and states are frozen.

## 5. Events

| Event | Who | Effect |
|---|---|---|
| `AddLiquidity` | anyone | Deposit; mints shares (§6.3). |
| `RemoveLiquidity` | share holder | Proportional, fee-free exit. |
| `RemoveLiquidityImbalance` | share holder | Exact amounts out; burns shares. |
| `RemoveLiquidityOneCoin` | share holder | Burn shares for one coin. |
| `Exchange` | anyone | Exact-input swap. |
| `ExchangeExactOut` | anyone | Exact-output swap. |
| `RampA`, `StopRampA` | admin | Ramp A over heights (§7). |
| `CommitFees`, `ApplyFees`, `RevertFees` | admin | Delayed fee change (§7). |
| `WithdrawAdminFees` | admin | Pays out admin balances. |
| `SetRate` | admin | Moves one coin's rate multiplier (§7). |
| `BackingUpdated` | anyone with a valid update | Newer finalized escrow state (Flop `StateFinalized`). |
| `BackingChallenged` | anyone | Starts the window (Flop `ReclaimInitiated`). |
| `BackingReclaimed` | anyone | Records the reclaim (Flop `Reclaimed`). |

Every priced event carries a slippage bound (`minDy`, `maxDx`, `minMint`,
`maxBurn`, `minAmount`, `minAmounts`). Violations raise `SLIPPAGE`.

## 6. Pool math

### 6.1 Solvers

`getD`, `getY` and `getYD` are Newton solvers for the invariant, derived from
the StableSwap paper (Egorov 2019); conventions match public Curve docs (±1
convergence, at most 255 iterations). Instead of returning a last guess, they
throw `NO_CONVERGENCE`. They also check their domain and throw
`DOMAIN`: every `0 < xp_i ≤ MAX_XP = 1e33` and `1 ≤ A < MAX_A`.

The pool itself uses **exactly rounded** versions built on the integer
residual

```
f(xp, D) = (Ann·S + AP·D − Ann·D)·nⁿ·Πxp − AP·D^(n+1)      (AP = A_PRECISION)
```

`f` has the sign of the invariant's excess. It is strictly positive below the
real root `D*` and negative above it.

- `getDUp = ⌈D*⌉` and `getDDown = ⌊D*⌋`.
- `getYUp` / `getYDUp` return the smallest integer `y` that keeps the state on
  or above the level set of `D` (Solidly-style "the y that keeps k").

Each starts from Newton's result and corrects it by at most 64 unit steps;
otherwise it throws `NO_CONVERGENCE`. The pool always uses `getDUp` for a
pre-operation D and `getDDown` for a post-operation D. Every priced operation
must also leave the pool in a state where `getDDown` converges, else it
reverts. Proportional exits never compute D, so they always work.

### 6.2 Rounding: every direction, per path

Every rounding below favours the pool, that is, the remaining LPs.

| Path | Step | Direction |
|---|---|---|
| all | input to `xp` | down |
| all | pre-op D / post-op D | up / down |
| exchange | `y` | up (smallest y on the curve) |
| exchange | `dyGross = xp_j − y − 1` | extra −1 |
| exchange | fee `⌈dyGross·fee/1e10⌉` | up (a plain Newton pool rounds down) |
| exchange | `dy` to native units | down |
| exchange | admin share | down (remainder stays with LPs) |
| exact-out | `dx` | smallest dx whose exact-in quote ≥ dy; executed as that exact-in trade, surplus to LPs |
| add / remove imbalance | fee rate `⌈fee·n/(4(n−1))⌉` | up |
| add / remove imbalance | ideal balance `D1·old/D0` | whichever of floor/ceil is farther from the new balance |
| add / remove imbalance | per-coin fee | up |
| add | `minted = ⌊supply·(D2 − D0)/D0⌋` | down |
| remove imbalance | `burned = ⌊supply·(D0 − D2)/D0⌋ + 1` | up (+1) |
| remove one coin | `D1 = D0 − ⌊shares·D0/supply⌋` | reduction down |
| remove one coin | expected amounts, fees | up |
| remove one coin | `dy = ⌊(reduced_i − y − 1)·1e18/rate_i⌋` | down, −1 |
| remove (proportional) | `⌊balance·shares/supply⌋` | down |
| bootstrap | D1 | down |
| write-down | admin first, then LP | n/a (exact) |

Safeguards against dust:

- Every priced path rejects amounts below `minTradeAmount` normalised units
  with `BELOW_MIN_TRADE`.
- An output that would be zero or negative (`xp_j − y − 1 ≤ 0`) is rejected
  rather than underflowing.
- A swap whose post-trade D would fall below its pre-trade D throws
  `INVARIANT_VIOLATION`. By construction this cannot happen; the check is a
  backstop.

### 6.3 Bootstrap

While `supply = 0`, the first deposit must include every coin
(`BOOTSTRAP`) and must reach `D1 ≥ minInitialD` (`BOOTSTRAP`). It creates `D1`
shares: `minimumLiquidity` of them go to the reserved holder `"<locked>"`,
which can never act, and the rest go to the depositor. Supply therefore never
returns to zero, and the bootstrap path cannot be re-entered with dust.
Balances are internal (no donations), so share-price inflation attacks have no
lever.

### 6.4 Views

`getDy`, `getDx`, `calcTokenAmount`, `calcWithdrawOneCoin` and `virtualPrice`
run the same code as the events. A preview at the head height always equals the
executed result.

Like stableswap-ng (and unlike the original pools), `calcTokenAmount` includes
fees. `newtonExchangeDy` exposes the plain Newton formula (floor fee) for
cross-checks only.

## 7. Admin parameters

- **Ramp.**
  - `RampA` requires `h ≥ lastRampStart + minRampBlocks` (`RAMP_TOO_EARLY`)
    and `futureHeight ≥ h + minRampBlocks` (`RAMP_TOO_FAST`).
  - It requires `1 ≤ futureA < MAX_A` (`A_OUT_OF_RANGE`) and at most a 10x
    change from the current A (`A_CHANGE_TOO_LARGE`).
  - A interpolates linearly in height, rounding toward the start value.
  - `StopRampA` freezes the current A.
- **Fees.**
  - `CommitFees` stores `(fee, adminFee)` (`FEE_OUT_OF_RANGE`,
    `ACTION_PENDING`).
  - `ApplyFees` must come at `h ≥ commit + adminDelayBlocks` (`ADMIN_DELAY`).
    It must repeat the committed payload exactly (`PAYLOAD_MISMATCH`), so an
    approval binds the executed values.
- **Rates.** `SetRate` moves a rate by at most `maxRateChangeBps`
  (`RATE_CHANGE_TOO_LARGE`), no sooner than `minRateUpdateBlocks` after the
  coin's last update (`RATE_UPDATE_TOO_SOON`). The resulting rate must stay
  within its bounds (`RATE_OUT_OF_RANGE`).

## 8. Modes

The mode is a function of `(state, height)`:

- **Wind-down.** At least one coin has expired (`h ≥ expiresAt`) or its backing
  has been reclaimed.
  - Every swap, deposit, imbalanced exit and single-coin exit is rejected
    (`WIND_DOWN`).
  - Proportional exits and admin and backing events still work.
  - Expired credit is never priced.
- **Restricted.** At least one backed coin is in Challenge.
  - That coin cannot be sold into the pool or deposited (`COIN_IN_CHALLENGE`);
    it can still be bought out.
  - Imbalanced exits are disabled.
  - Single-coin exits may only take a challenged coin.
  - Proportional exits work. They give every LP the same pro-rata share
    regardless of exit order, so there is no first-exit advantage.
- **Normal.** Neither of the above.

## 9. Backed coins and stale-channel reclaim

A backed coin is credit that the pool lent into one or more Flop payment
channels. `recoverable` is the principal the pool would get back if the escrow
were reclaimed at the latest finalized state. For a single Flop channel it is
`toLender = min(L, E − min(O, E))` (Flop SPEC §10), exported as
`recoverablePrincipal`.

| Pool event | Flop event | Rule |
|---|---|---|
| `BackingUpdated(coin, nonce, recoverable, stateRoot)` | `StateFinalized` | `nonce` strictly increasing (`STALE_NONCE`); optional `verifyBacking` (`BACKING_REJECTED`); rejected at `h ≥ reclaimableAt` (`CHALLENGE_WINDOW_CLOSED`). Progress (`progressHeight = h`) counts only while Live. |
| `BackingChallenged(coin)` | `ReclaimInitiated` | Needs `h ≥ progressHeight + N` (`NOT_STALE`); sets `reclaimableAt = h + W`; sticky (`CHALLENGE_ALREADY_STARTED`). |
| `BackingReclaimed(coin, nonce, amount)` | `Reclaimed` | Needs a challenge (`NO_CHALLENGE`) and `h ≥ reclaimableAt` (`CHALLENGE_WINDOW_OPEN`); `(nonce, amount)` must equal the latest backing exactly (`PAYLOAD_MISMATCH`); once only (`ALREADY_RECLAIMED`). |

Rules for backed coins:

- **R3 cap.** At all times `balance + adminBalance ≤ recoverable`. Any event
  that would break it is rejected (`BACKING_EXCEEDED`). Before the first
  update, `recoverable = 0`.
- **Write-down before payout.** When `BackingUpdated` lowers `recoverable`
  below holdings, the excess is written off immediately:
  - It comes out of the admin balance (the reserve) first, then out of LP
    balances, which spreads the loss pro rata to every LP.
  - Shares are never minted or burned to cover it.
  - It is recorded in `totals.writtenDown`.
- **Reclaim has no surprise.** `BackingReclaimed` changes no balance (R4); the
  loss was marked at the last update.

## 10. Invariants

Each one is asserted by property tests (see TEST_PLAN.md):

1. **Conservation.** For every coin,
   `deposited − withdrawn − adminWithdrawn − writtenDown = balance + adminBalance`,
   and shares sum to supply.
2. **D never decreases on a swap.** The post-swap LP balances lie on or above
   the level set of `⌈D_before⌉`. This is checked exactly with `f`.
3. **Value per share never decreases** on any event except an explicit
   write-down.
4. **Atomicity and determinism.** A rejected event changes nothing, and replay
   reproduces the state.
5. **Previews equal executions.**
6. **Locked shares** exist forever after bootstrap.
7. **R1–R5** of the research notes (§9; R2 is the strictly increasing nonce
   plus the exact reclaim payload; R5 is "a challenge never times out without
   a reclaim").

## 11. Reference compatibility

On the independent reference vectors (`scripts/stableswap_paper_reference.py`,
derived from the StableSwap paper (Egorov 2019); conventions match public Curve
docs; exact integer bisection, no Newton):

- `getDUp`, `getDDown` and `getYUp` equal the exact integer roots. Newton's
  `getD` and `getY` are within 2 units; `newtonExchangeDy` is within 2 native
  units of the ideal output.
- Pool swaps and single-coin exits never pay more than the ideal amount. They
  pay at most 16 normalised units less for 18-decimal coins, or 1 native unit
  for 6-decimal coins (observed maximum: 1 normalised unit).

## 12. Error codes

| Group | Codes |
|---|---|
| Input and ledger | `INVALID_PARAMS`, `INVALID_EVENT`, `HEIGHT_REGRESSION`, `UNAUTHORIZED`, `REENTRANCY` |
| Math | `DOMAIN`, `NO_CONVERGENCE`, `INVARIANT_VIOLATION` |
| Trading | `SLIPPAGE`, `BELOW_MIN_TRADE`, `INSUFFICIENT_LIQUIDITY`, `INSUFFICIENT_SHARES`, `BOOTSTRAP`, `EMPTY_POOL` |
| Ramp | `RAMP_TOO_EARLY`, `RAMP_TOO_FAST`, `A_OUT_OF_RANGE`, `A_CHANGE_TOO_LARGE` |
| Fees | `FEE_OUT_OF_RANGE`, `ACTION_PENDING`, `NO_PENDING_ACTION`, `ADMIN_DELAY`, `PAYLOAD_MISMATCH` |
| Rates | `RATE_OUT_OF_RANGE`, `RATE_CHANGE_TOO_LARGE`, `RATE_UPDATE_TOO_SOON` |
| Modes and backing | `WIND_DOWN`, `COIN_IN_CHALLENGE`, `BACKING_EXCEEDED`, `NOT_BACKED`, `STALE_NONCE`, `BACKING_REJECTED`, `NOT_STALE`, `CHALLENGE_ALREADY_STARTED`, `NO_CHALLENGE`, `CHALLENGE_WINDOW_OPEN`, `CHALLENGE_WINDOW_CLOSED`, `ALREADY_RECLAIMED` |

## 13. Design decisions and rationale

1. **Exactly rounded D and y instead of plain Newton output.** Newton floors
   intermediate terms, and at zero fee this can let real-valued D fall by a
   fraction of a wei per swap. Using ⌈D⌉ before and ⌊D⌋ after makes "D never
   decreases" exactly true. The cost is that the pool pays a few normalised
   units less than a plain Newton pool.
2. **Revert on non-convergence, everywhere.** This is stableswap-ng
   behaviour, not a silent last guess. An operation that would leave an
   unpriceable state also reverts. Proportional exits never need D, so LPs can
   always leave.
3. **Exact-output via search.** The pool finds the minimal `dx` and executes
   it as an exact-input trade, so both paths share one rounding analysis. Any
   surplus goes to LPs.
4. **Fee rounding up** (a plain Newton pool rounds the swap fee down).
5. **Bootstrap lock plus a minimum initial D**, together with the
   all-coins rule (Uniswap `MINIMUM_LIQUIDITY`; the yETH init path).
6. **Write-down at the update, not at the reclaim.** Losses are recognised as
   soon as a finalized state shows them (Yearn-style unrealised loss), so
   exiting early never dodges a known loss and the reclaim itself is neutral.
7. **No cure for a challenge.** As in Flop, a newer state during the window
   updates `recoverable` but neither ends the challenge nor moves its
   deadline, so a provider cannot drip states to keep a challenge open.
8. **Staleness without a challenge does not restrict trading.** Anyone may
   challenge at `progressHeight + N`, and the restrictions begin with that
   event.
9. **Rates are pushed by the admin with per-update and spacing bounds** (the
   yETH 10% lesson), not derived from an on-pool EMA.
10. **calc_token_amount includes fees** (NG semantics). It equals execution
    exactly.

## 14. Open questions

1. **Mapping between coins and channels.** Is one backed coin one Flop
   channel, or an aggregate of many? Should the pool enforce that
   `recoverable` never increases, which mirrors Flop's non-decreasing `owed`,
   or allow increases for top-ups and new lending?
2. **`N` and `W`.** Should the pool's values equal the Flop channel's, so that
   a pool challenge is accepted exactly when the channel's
   `ReclaimInitiated` is? Should heights be finalized heights?
3. **The Stale stage.** The research notes suggest stopping new allocations
   and raising fees when a coin is merely stale. v0.1 waits for an explicit
   challenge (§13.8). Is that enough, or should staleness alone restrict
   trading?
4. **Loss waterfall.** v0.1 uses the admin reserve first, then all LPs pro
   rata. Are junior and senior tranches, or a provider bond to slash, needed
   inside the pool?
5. **After reclaim.** The pool records the reclaim and winds down. What do LPs
   receive for a reclaimed coin: FLOP from vault idle, or the voucher? Who
   moves the FLOP?
6. **Rate source.** Should rates come from an EMA/TWAP over completed periods
   instead of admin pushes? Who may push them?
7. **Expiry grace.** Should there be a grace period after `expiresAt` (the
   research notes mention "E + grace"), or should the pool wind down slightly
   *before* expiry?
8. **Minimum A.** At A ≤ 2 with about 5000:1 imbalance, Newton does not
   converge and the pool reverts. Should `A ≥ 10`, or similar, be required?
9. **Dynamic (off-peg) fees.** Should the fee rise with imbalance, as in NG,
   to price congestion on one provider?
10. **Who may challenge.** Currently anyone may. Is a keeper bounty needed,
    and who would fund it?

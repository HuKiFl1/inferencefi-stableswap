# Future option: StableSwap pool as a native FLOP module

> **Long-term option only. The current product is EVM (Inference Finance on
> HyperEVM testnet).** This repository's current role is an independent
> off-chain reference and test-vector source for that EVM stack; see
> [FLOP.md](../FLOP.md). Nothing below is planned work.

Status: **design proposal**, not adopted. FLOP adds functionality only "as
audited native modules adopted through governance, never as user-deployed
code" ([whitepaper](https://flop.network/whitepaper/), §03 Upgrades), via a
FIP approved by validators (§09). This sketch shows how the logic in this
repo could become such a module (a Substrate pallet). The TypeScript library
and its test suite are the executable reference; anything marked **[YP]**
depends on the unfinished Yellow Paper.

## Storage

All collections are bounded (`BoundedVec` / bounded maps) so storage and
weights have known maxima.

| Item | Type (sketch) | Notes |
|---|---|---|
| `Pools` | `PoolId → PoolInfo` | Coins (2 ≤ n ≤ `MaxCoins` = 8), fee, admin fee, `minimumLiquidity`, `minTradeAmount`, `N`, `W`. |
| `Balances` | `PoolId → BoundedVec<u128, MaxCoins>` | Pool holdings per coin, plus admin (reserve) balances. |
| `Rates` | `PoolId → BoundedVec<(u128 rate, BlockNumber last_update), MaxCoins>` | Rate multipliers, with bounded step size and spacing ([SPEC](../SPEC.md) §7). Rates up to 1e39 exceed `u128`, so this needs `U256` or a narrower bound. |
| `ARamp` | `PoolId → (initial_A, future_A, start, end)` | Linear in block height, with a minimum duration and a 10x limit. |
| `LpSupply` | `PoolId → u128`, `LpBalances: (PoolId, AccountId) → u128` | `minimumLiquidity` locked forever at bootstrap. |
| `PendingFees` | `PoolId → Option<(fee, admin_fee, commit_height)>` | Delayed fee changes. |
| `Backing` | `(PoolId, coin) → BackingState` | Nonce, `recoverable`, progress height, challenge / `reclaimableAt`, reclaimed flag ([SPEC](../SPEC.md) §9). |
| `EventLog` | `PoolId → BoundedVec<EventDigest, MaxLog>` (ring buffer) | A bounded recent log. The full history lives in chain events, which is enough to `replay` off-chain. |

## Dispatchables

| Call | Origin | Maps to |
|---|---|---|
| `exchange(pool, i, j, dx, min_dy)` / `exchange_exact_out(…, dy, max_dx)` | signed | `Exchange` / `ExchangeExactOut` |
| `add_liquidity(pool, amounts, min_mint)` | signed | `AddLiquidity` |
| `remove_liquidity`, `remove_liquidity_imbalance`, `remove_liquidity_one_coin` | signed (LP) | the same events |
| `ramp_a(pool, future_a, end)`, `stop_ramp_a(pool)` | governance origin | `RampA`, `StopRampA` |
| `commit_fees`, `apply_fees`, `revert_fees`, `set_rate` | governance origin | admin events; the delay is enforced in storage |
| `update_backing(pool, coin, nonce, recoverable, state_root, proof)` | signed, with proof checked against channel state **[YP]** | `BackingUpdated` |
| `challenge_backing`, `record_reclaim` | signed (anyone) | `BackingChallenged`, `BackingReclaimed` |

Every priced call carries its slippage bound, and errors map one-to-one onto
the library's stable error codes. Substrate dispatch is transactional, which
matches the library's atomic appends. With no callbacks into user code, the
library's reentrancy lock becomes unnecessary.

## Weights and bounded iteration

- `get_D` / `get_y` use Newton's method capped at **255 iterations**, and the
  exact-rounding correction is capped at **64 steps**; both revert with
  `NO_CONVERGENCE` instead of returning a guess. The worst-case weight is
  therefore `O(255 · n)` big-integer multiply/divide steps plus 64 residual
  evaluations, with n ≤ 8. Benchmark the worst case and charge it, refunding
  the unused part via actual weight.
- Proportional exits never compute D, so they stay cheap and always work,
  including in wind-down.
- Each call touches at most `MaxCoins` balances and one backing entry; there
  are no unbounded loops over LPs. Pro-rata write-downs act on pool balances,
  not on per-LP storage.
- Intermediate products reach roughly D^(n+1); the reference uses unbounded
  `bigint`. The pallet needs `U256`/`U512` with checked arithmetic and the
  `MAX_XP = 1e33` domain bound ([SPEC](../SPEC.md) §6.1).

## FLOP primitives it relies on

- **Escrow-backed coins from channels:** a backed coin is credit lent into
  compute channels and held in FLOP escrow. The pool's cap
  (`balance ≤ recoverable`) and write-downs follow
  [Flop reclaim](https://github.com/HuKiFl1/Flop).
- **HTLC / TCLK for cross-venue settlement:** when a swap's two legs sit on
  different rails, they settle through TCLK's offer → accept → lock → reveal
  or refund (§11). Cross-chain pairs are not yet qualified **[YP]**.
- **FCU units as future pool coins:** FCUs are divisible, transferable,
  expiring claims on compute (§12). Same-window, same-grade FCUs from
  different miners are natural StableSwap pairs, with `expiresAt` set to the
  window's end. FCUs are ratified design, not yet implemented.
- **Governance and enactment delay** for `A`, fees and rates (§09).

## If FLOP ever adopts this natively

FLOP has no EVM by design (§03). The pool is fixed, deterministic integer
arithmetic over a few storage items, with no user-supplied code. That is
exactly the kind of fixed, audited primitive FLOP favours: one pallet serves
every pool, parameterised by storage, instead of a contract deployed per pool.

## Open questions

1. Single pallet with many pools, or one instance per credit family?
2. How do backed coins prove channel state on-chain (signature scheme, state
   root format)? **[YP]**
3. Should pools wait for FCUs, or launch with escrow-backed credit only?
4. Where do admin fees go? The whitepaper says "the protocol itself earns
   nothing" (§07), so a pallet-level admin fee probably belongs to LPs or a
   reserve, not to the protocol.
5. Minimum `A` floor (for example 10) to avoid non-convergence at extreme
   imbalance ([SPEC](../SPEC.md) §14, question 8).
6. Does TCLK's "a timeout does not expire a claim" rule apply to the backing
   challenge window?
7. Is `MaxLog` needed at all, or are chain events plus off-chain replay
   enough?

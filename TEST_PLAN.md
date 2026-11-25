# Test plan: swap and settlement boundaries

This plan is for the protocol author. It lists the boundaries where a
StableSwap pool for inference credit can lose money or get stuck, and the test
that pins each one. It also covers how pool liquidity interacts with Flop's
stale-channel reclaim. Rules are in [SPEC.md](./SPEC.md).

Run it:

```sh
npm ci
npm test                       # all suites, PROPERTY_RUNS=200 by default
PROPERTY_RUNS=2000 npm test    # deeper fuzzing
npm run reference              # regenerate the paper reference vectors (python3, no deps)
```

## 1. Swap boundaries

| Boundary | Expected | Test |
|---|---|---|
| Trade just below / at `minTradeAmount` (normalised) | `BELOW_MIN_TRADE` / accepted, on every priced path | `rounding` "minimum trade amount", `pool` "exchange rejects…" |
| 1 to 2 wei input into a very skewed pool (`xp_j − y − 1 ≤ 0`) | Rejected, never a negative output | `reference` "1-2 wei inputs…" |
| Dust trades in a pool just above `minInitialD`, rates maximising `amount·rate mod 1e18` | State stays on or above the curve (exact residual); fee ≥ rational fee | `rounding` "exact-in swap…" |
| Exact-out: `dx − 1` | Quote of `dx − 1` < `dy` ≤ quote of `dx`; pays exactly `dy` | `rounding`, `pool` "exact-output" |
| Round trips (swap there and back, deposit then exit, withdraw then re-deposit) | Never profitable | `rounding` "round trips never profit" |
| Hundreds of dust round trips (Balancer CSP pattern) | Attacker never ahead; virtual price never falls | `security` §5 Balancer |
| Output that would empty a coin | `INSUFFICIENT_LIQUIDITY` | `pool` |
| States where Newton does not converge (A ≤ 2, about 5000:1) | `NO_CONVERGENCE` on every pricing path; proportional exits still work | `reference`, `invariants` checker, `security` §5 yETH |
| Swap that would lower D | Impossible; backstop `INVARIANT_VIOLATION` | `invariants` (exact residual after every swap) |
| Ramp: A at the first and last block, 10x limit, min duration and spacing | Linear, bounded, rejected outside limits | `pool` ramp, `security` §3.8 property |
| Rate update: one bp over the cap, one block too early | `RATE_CHANGE_TOO_LARGE`, `RATE_UPDATE_TOO_SOON` | `pool`, `security` §3.9 property |
| Previews vs execution | Equal, for every op, at every step | `invariants` |

## 2. Settlement boundaries (backed coins)

Heights for a coin with last progress at `p`, challenge at `s`, `N =
stalenessBlocks` and `W = challengeWindowBlocks`:

| Height | `BackingUpdated` | `BackingChallenged` | `BackingReclaimed` |
|---|---|---|---|
| `< p + N` | accepted (resets `p` while Live) | `NOT_STALE` | `NO_CHALLENGE` |
| `p + N` | accepted | **accepted**, `s = h` | — |
| `s … s + W − 1` | accepted, no cure, `p` frozen | `CHALLENGE_ALREADY_STARTED` | `CHALLENGE_WINDOW_OPEN` |
| `≥ s + W` | `CHALLENGE_WINDOW_CLOSED` | `CHALLENGE_ALREADY_STARTED` | **accepted** if `(nonce, amount)` equals the latest backing, else `PAYLOAD_MISMATCH` |
| after reclaim | `ALREADY_RECLAIMED` | `ALREADY_RECLAIMED` | `ALREADY_RECLAIMED` |

The pinned boundary cases:

- **Cap.** Holdings at the cap are accepted; one unit over is
  `BACKING_EXCEEDED`. Admin fees count toward the cap. Before the first
  update the cap is 0.
- **Write-down.** The admin reserve is hit first, then LPs. Supply and shares
  do not change, and a later higher `recoverable` never writes back up.
- **Restricted mode.** The challenged coin can be bought, but not sold in or
  deposited. Imbalanced exits are blocked, single-coin exits may only take the
  challenged coin, and exit order does not change proportional payouts.
- **Expiry.** Trading works at `expiresAt − 1`; at `expiresAt` the pool is in
  `WIND_DOWN`. After a reclaim, too, only proportional exits, admin and
  backing events remain.

All of these are in `tests/settlement.test.ts`.

## 3. Pool liquidity and stale-channel reclaim (Flop)

A backed coin is credit that the pool lent into
[Flop](https://github.com/HuKiFl1/Flop) payment channels. The pool never pays
out more of that coin than the channel could return.

| Flop (`flop-channel-reclaim`) | Pool | Link |
|---|---|---|
| `StateFinalized(nonce, owed)` | `BackingUpdated(nonce, recoverable)` | `recoverable = toLender = min(L, E − min(O, E))` (`recoverablePrincipal`) |
| Stale at `latest.h + N` | `BackingChallenged` allowed at `progressHeight + N` | Same `N`, and relay at the same height |
| `ReclaimInitiated` → window `[s, s + W − 1]` | `BackingChallenged` → `reclaimableAt = s + W` | Same `W` |
| `StateFinalized` in window: updates owed, no cure | `BackingUpdated` in window: writes down, no cure | Sticky in both |
| `Reclaimed` at `≥ s + W`, pays `toLender` | `BackingReclaimed(nonce, amount = toLender)` | Exact payload; pool enters wind-down |

Worked example (Flop README, `N = 100`, `W = 20`, `E = 1,000,000`,
`L = 900,000`), executed in `settlement` "mirroring a Flop channel":

1. Nonce 1 with owed 250k gives `toLender = 750k`, so the pool may hold up to
   750k of the coin.
2. The challenge is rejected at 1,109 and accepted at 1,110.
3. The provider posts nonce 2 (owed 300k) at 1,129, the last window block.
   `toLender = 700k`, and any holdings above that are written off at once,
   reserve first.
4. A further update at 1,130 is `CHALLENGE_WINDOW_CLOSED`, and the reclaim at
   1,129 is `CHALLENGE_WINDOW_OPEN`.
5. At 1,130 the pool reclaims exactly `(nonce 2, 700k)`, the same `toLender`
   as Flop's settlement.

What the integration must guarantee (not testable in this repo alone):

- **Relay.** The relayer submits each Flop `StateFinalized` as
  `BackingUpdated` at the same height. A lagging relay makes the pool
  challengeable later than the channel, which is safe but slow. A relay that
  skips states only makes `recoverable` stale-high until the next one; pair it
  with `verifyBacking`.
- **No gap between the loss and the cap.** Between a channel's loss and its
  relay, the pool can be over-exposed. Keep the relay delay well below `N`.
- **Suggested cross-library property test.** Drive a Flop `ReclaimLedger` and
  a `PoolLedger` from one random script, relaying every state. Assert that:
  - the three mapped events are accepted at the same heights;
  - pool holdings never exceed Flop's current `toLender`;
  - the pool's reclaim `amount` equals Flop's `settlement.toLender`.

## 4. Coverage of the research notes

§3 Invariants:

| Item | Where |
|---|---|
| 1 D never decreases on a swap; value per share non-decreasing | `invariants` (exact residual + per-step check), `rounding` |
| 2 Rounding per path, dust, `amount·scale mod 1e18`, minimum trade | `rounding`, `reference`, `mutation` |
| 3 Solver: 255 cap, revert, domain, fuzz beyond range, Solidly-style y | `solver`, `reference` |
| 4 Bootstrap lock, no dust re-entry | `pool` bootstrap, `invariants`, `security` §5 yETH |
| 5 Conservation | `invariants`, `settlement` (with write-downs) |
| 6 One reentrancy lock, effects before interactions | `security` §5 Vyper |
| 7 Exact payload binding | `pool` fees, `settlement`, `security` §5 CowSwapBurner |
| 8 Gradual parameter changes | `pool` ramp/fees, `security` §3.8 |
| 9 Bounded rate updates | `pool` rates, `security` §3.9 |
| 10 Expiry | `settlement` wind-down |
| 11 Fair exits, losses through the reserve first | `settlement` restricted mode, write-down |
| 12 Reclaim ≤ escrow; write-down before payout | `settlement` |
| R1 | `settlement` `recoverablePrincipal` properties |
| R2 | `settlement` nonce ordering, exact reclaim payload, `ALREADY_RECLAIMED` |
| R3 | `settlement` cap property over random interleavings |
| R4 | `security` §4 R4 |
| R5 | `security` §4 R5 |

§5 Incidents:

| Incident | Where |
|---|---|
| Vyper reentrancy (2023) | `security` cross-function re-entry, rollback |
| Balancer CSP (2025) | `rounding`, `security` dust round trips |
| yETH (2025) | `solver` domain and cap, `reference` non-convergence, `security` bootstrap |
| Bancor (2022) | `security` / `settlement`: write-downs never mint |
| CowSwapBurner (2026) | `security` payload binding |
| Keep3r (windows) | `settlement` window boundaries |

**Reference values** (`tests/reference.test.ts`). The fixture is an
independent reference derived from the StableSwap paper (Egorov 2019);
conventions match public Curve docs. It solves the invariant by exact integer
bisection, with no Newton iteration.

- Exactly rounded D (16/16 cases) and y (80/80) equal the exact roots; Newton
  is within 2 units, and `newtonExchangeDy` within 2 native units (240/240).
- The pool's own swaps and one-coin exits never pay more than the ideal amount.

**Mutation** (`tests/mutation.test.ts`). 22 injected bugs (rounding, fees,
bootstrap, limits, settlement boundaries, rollback, lock) are each killed by
an independent battery, and the unmutated copy passes it.

## 5. Not covered

- Token transfers and signatures; `verifyBacking` is a hook.
- Multi-block MEV ordering beyond what deterministic ordering of events
  implies.
- The cross-library Flop property test (§3); it needs both packages in one
  harness.

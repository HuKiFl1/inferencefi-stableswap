# inferencefi-stableswap

A small, deterministic TypeScript library implementing **StableSwap pool math
for InferenceFi**: DeFi for AI agents' inference on the FLOP network. It is
meant for credit units that should trade near 1:1, such as the same model's
inference credit from different providers.

It is the companion to
[flop-channel-reclaim](https://github.com/HuKiFl1/Flop) and has the same shape:
an append-only event ledger with `replay`, typed error codes, `bigint` heights
and a pure `applyEvent`. A pool coin can be **backed** by Flop channel escrow.
The pool then never holds more of it than a stale-channel reclaim would
recover.

The full rules are in **[SPEC.md](./SPEC.md)**, and the boundary tests and the
Flop interaction are in **[TEST_PLAN.md](./TEST_PLAN.md)**.

## How this sits on FLOP

**Role:** an independent off-chain reference implementation and test-vector
source for Inference Finance, whose AMM is Solidity on HyperEVM testnet (chain
998), unaudited and TEST mocks only. FLOP has no EVM and no user-deployed code
([whitepaper](https://flop.network/whitepaper/), §03), so DeFi contracts run on
an EVM chain and integrate with FLOP through inference credits, spend receipts,
escrow and channels. A native FLOP module remains a possible long-term path,
not the current plan.

- **Useful for:** a second implementation to check a Solidity StablePool's
  `getDy`, D and one-coin exits against; boundary and incident tests for the
  contract suite (see [TEST_PLAN.md](./TEST_PLAN.md)); pool coins as
  OMER-normalised credits via per-coin rate multipliers.
- **Integrates with FLOP through:** escrow-backed credit lent into compute
  channels (backed coins), settled channel state as spend receipts, and TCLK,
  the HTLC used by agents on Technocore, when swap legs live on different rails.
- **Money legos:** [Flop reclaim](https://github.com/HuKiFl1/Flop) caps
  backed-coin exposure and informs the "reclaimed if unserved" path of a
  receipt-backed credit minter; this pool sets prices between credits.
- **Honest gap:** there is no on-chain FLOP or Pearl inference-credit token
  yet, so any rate for FLOP credit is a placeholder, not a market price.

The full mapping and FLOP-specific open questions are in
**[FLOP.md](./FLOP.md)**. A long-term native-module sketch is in
[docs/FUTURE_NATIVE_MODULE.md](./docs/FUTURE_NATIVE_MODULE.md).

## Properties

- Node 20+, ESM, **zero runtime dependencies**.
- All amounts and heights are `bigint`. No floats, no clocks, no I/O. You pass
  the block height in.
- **StableSwap math** derived from the StableSwap paper (Egorov 2019);
  conventions match public Curve docs. Newton's method for D and y with a
  255-iteration cap, exactly rounded variants checked against the integer
  residual, and explicit `NO_CONVERGENCE` and `DOMAIN` errors.
- **Operations.**
  - `get_dy`/`exchange`, and exact-output `get_dx`.
  - `add_liquidity` (with imbalance fees) and `calc_token_amount`.
  - `remove_liquidity`, `remove_liquidity_imbalance` and
    `remove_liquidity_one_coin`.
  - Swap and admin fees.
  - A ramped over block heights with min-duration and 10x limits.
  - Per-token rate multipliers with bounded updates.
- **Rounding always favours the pool**, per path, including exact-out. Every
  direction is listed in SPEC §6.2 and checked exactly against the
  invariant's integer residual.
- **Bootstrap guard.** The first deposit needs every coin and a minimum D, and
  `minimumLiquidity` shares are locked forever. Every priced path also has a
  minimum trade amount.
- **Ledger.**
  - The event log is the only state, and appends are atomic.
  - One reentrancy lock spans every entry point.
  - Listeners run after the commit; a failing listener reverts the append.

## Usage

```ts
import { PoolLedger, isPoolError } from "inferencefi-stableswap";

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

const pool = new PoolLedger({
  coins: [
    { symbol: "credit[model-x,p1]", rate: E18 },        // 18 decimals
    { symbol: "credit[model-x,p2]", rate: 10n ** 30n }, // 6 decimals
  ],
  A: 200n,
  fee: 4_000_000n,           // 0.04%
  adminFee: 5_000_000_000n,  // 50% of fees
  admin: "dao",
  minRampBlocks: 7_200n,
  adminDelayBlocks: 21_600n,
  minimumLiquidity: 1_000n,
  minInitialD: E18,
  minTradeAmount: 1_000_000n,
  maxRateChangeBps: 1_000n,
  minRateUpdateBlocks: 100n,
  stalenessBlocks: 100n,
  challengeWindowBlocks: 20n,
});

pool.append({ type: "AddLiquidity", height: 1n, by: "lp", amounts: [1_000_000n * E18, 1_000_000n * E6], minMint: 0n });

const quote = pool.getDy(0, 1, 1_000n * E18, 2n);   // ≈ 999.6 units of coin 1
pool.append({ type: "Exchange", height: 2n, by: "agent", i: 0, j: 1, dx: 1_000n * E18, minDy: quote });

try {
  pool.append({ type: "Exchange", height: 2n, by: "agent", i: 0, j: 1, dx: 1n, minDy: 0n });
} catch (e) {
  if (isPoolError(e) && e.code === "BELOW_MIN_TRADE") { /* dust is refused */ }
}
```

Backed coins mirror Flop's channel stages (`BackingUpdated` ↔
`StateFinalized`, `BackingChallenged` ↔ `ReclaimInitiated`,
`BackingReclaimed` ↔ `Reclaimed`). See SPEC §9 and the worked example in
TEST_PLAN §3.

Lower-level pure functions are exported too:

- Ledger: `applyEvent`, `replay`.
- Solvers: `getD`, `getY`, `getYD`, and the exactly rounded `getDUp`,
  `getDDown`, `getYUp`, `getYDUp`, `invariantResidual`.
- Quotes: `quote*` and `newtonExchangeDy` (plain Newton formula with a floor
  fee, for cross-checks).
- `recoverablePrincipal`, which is Flop's `toLender`.

## Development

```sh
npm ci
npm test            # vitest: unit, property, reference, mutation
npm run typecheck   # tsc --noEmit (strict)
npm run build       # emits dist/
npm run reference   # regenerates tests/fixtures/stableswap-paper-reference.json (python3)
```

Set `PROPERTY_RUNS` for more property-test iterations, for example
`PROPERTY_RUNS=2000 npm test`.

Test layout:

- `tests/pool.test.ts`: every operation and rejection code, admin ramp, fees,
  rates, the bootstrap guard and replay.
- `tests/invariants.property.test.ts`: random operation sequences, checked
  after every step:
  - conservation;
  - D never decreases on a swap (exact residual);
  - value per share never falls;
  - previews equal executions;
  - atomicity and replay determinism.

  A coverage guard checks that the generator reaches every operation.
- `tests/rounding.property.test.ts`: per-path rounding in the dust region, fee
  ≥ rational fee, exact-out minimality, unprofitable round trips and the
  minimum trade amount.
- `tests/solver.property.test.ts`: D and y brackets, iteration caps, domain
  checks and fuzzing beyond the safe range.
- `tests/settlement.test.ts`: backing cap (R3), write-down order, staleness
  and window boundaries, restricted mode, wind-down and expiry, the Flop
  example, and `recoverablePrincipal`.
- `tests/security.test.ts`: one test group per incident (reentrancy, dust
  attacks, solver/bootstrap, minting, payload binding), plus gradual
  parameters, R4 and R5.
- `tests/reference.test.ts`: independent StableSwap paper reference values.
- `tests/mutation.test.ts`: 22 injected bugs, each of which must be caught.

### Reference values

`scripts/stableswap_paper_reference.py` is derived from the StableSwap paper
(Egorov 2019); conventions match public Curve docs. It shares no code with any
pool implementation: it solves the paper's invariant exactly over the integers
by bisection (no Newton iteration) and applies fees and unit conversions in
exact rationals (`fractions.Fraction`) with one final floor. It covers 16 pool
and A combinations, balanced, skewed and mixed-decimal, with A from 1 to 5000.
Results:

- The exactly rounded solvers equal the bisection roots exactly: `getDUp` and
  `getDDown` 16/16, `getYUp` 80/80. Newton's `getD` and `getY` land within 2
  units of the exact root.
- `newtonExchangeDy` matches the ideal output in 169/240 cases and is never
  more than 2 native units away.
- **Pool swaps never pay more than the ideal output.**
  - 231 of 240 swaps price, 135 of them exactly; at most 1 normalised unit
    (1 wei of an 18-decimal coin) less.
  - 9 revert with `NO_CONVERGENCE`: after those trades Newton's D does not
    converge.
- Single-coin exits match the ideal exit (imbalance-fee rule from public Curve
  docs) in 96/144 cases and are never higher, at most 1 normalised unit lower.
- Fee-free deposits and withdrawals mint and burn within the exact range
  implied by the integer bounds on D (48/48).
- In 35 of 81 near-5000:1 states at A ≤ 3, integer Newton for D cycles instead
  of converging. A pool that returned its last guess would misprice there; this
  library reverts with `NO_CONVERGENCE`. Where Newton does converge in those
  states it can stop up to 16 units from the exact root, and the exact solvers
  correct it.
- Recomputing D after a Newton `y` swap drifts by up to 8 wei at A = 1–2 with
  180:1 imbalance, so the tests compare D against Newton with a relative
  tolerance. At extreme imbalance, Newton's y lands up to 64 wei from the exact
  root (seen in fuzzing). The exact solvers correct at most 64 units and revert
  beyond that.

## Open questions for the protocol author

These are v0.1 assumptions. Details are in SPEC §14.

1. **Coins and channels.** Is a backed coin one Flop channel or an aggregate?
   Should `recoverable` be allowed to increase?
2. **`N`, `W` and heights.** Should the pool use the channel's `N`/`W` and
   finalized heights?
3. **Stale stage.** Should a merely stale coin (no challenge yet) already
   restrict trading or raise fees?
4. **Loss waterfall.** Is reserve-then-LPs enough, or are tranches or provider
   bonds needed in the pool?
5. **After reclaim.** What do LPs receive for a reclaimed coin, and who moves
   the FLOP?
6. **Rates.** Should they be admin-pushed with bounds (v0.1) or come from an
   EMA/TWAP oracle?
7. **Expiry.** Is a grace period needed, or should the pool wind down before
   `expiresAt`?
8. **Minimum A.** Low A with extreme imbalance does not converge. Should A have
   a floor (for example 10)?
9. **Dynamic fees.** Should the fee rise with imbalance, as in NG?
10. **Challenges.** Who may challenge, and is there a keeper bounty?

## License

MIT. See [LICENSE](./LICENSE).

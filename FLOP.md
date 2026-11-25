# How inferencefi-stableswap sits on FLOP

Source for every statement about FLOP below: the FLOP Network whitepaper,
<https://flop.network/whitepaper/> (draft dated 25 September 2026). The
whitepaper says the Yellow Paper is the definitive specification and that it
is not yet final. Items marked **[YP]** depend on it. Items marked
**Proposal** are our design suggestions, not FLOP facts.

IDs such as IF-F1 or IF-D8 refer to the Inference Finance product spec (an
EVM AMM for inference credits measured in OMER, rehearsed on HyperEVM testnet
with TEST mocks). Its contracts are not public, so this repo describes them
only at the level of that spec.

## 1. What FLOP provides (whitepaper facts)

- A Substrate Layer 1 with **no EVM, deliberately not Turing-complete**.
  General computation runs off-chain inside the agent and settles through
  fixed, audited primitives: transfers, staking, escrow, time locks,
  multi-signature and spend conditions (§03). The whitepaper adds that
  "agents compose off-chain and settle on-chain".
- AlephBFT finality: an ordered block is irreversible (§03).
- Sessions are settled through **compute channels**, and payment channels
  carry the per-call traffic (§03, Glossary).
- The native settlement primitive is the **HTLC**, implemented as **TCLK**:
  offer → accept → lock → reveal or refund. The creator can request a refund
  once the finalized FLOP prefix reaches the deadline. A timeout enables
  refund but does not expire a hashlock claim (§11). Point time-locks (PTLC)
  are also supported. The point-lock path is unaudited reference cryptography,
  and cross-chain pairs are target-only, pending Yellow Paper qualification
  **[YP]** (§11).
- Typed escrow evaluates composable hash, point, signature and time
  conditions with and / or / threshold operators (§11).
- Native atomic swaps and compute reservations carry no protocol fee; only
  the base transaction fee applies (§07).
- **FLOP Compute Units (FCU)** are miner-bonded, prepaid forwards on
  inference compute: windows of whole days up to 30 days, the buyer's payment
  escrowed in full, and units that are "divisible, transferable and expiring
  claims on compute". Settled reservations form a "transaction-anchored term
  tape" (§12). Status: ratified as protocol design, with implementation
  planned after the core protocol.
- New functionality arrives **as audited native modules adopted through
  governance, never as user-deployed code** (§03 Upgrades, §09).
- Technocore is the agent marketplace where work is agreed; the chain settles
  what happens there (§10).

## 2. Mapping

| This package | Inference Finance (EVM) / FLOP piece it relates to |
|---|---|
| Pool coins | OMER-normalised credits in a StableSwap pool with live rates (Inference Finance IF-F1), held as TEST mocks on HyperEVM testnet today. On the FLOP side: escrow-backed credit lent into compute channels; FCU units as candidate coins once FCUs exist. |
| Per-coin rate multipliers with bounded step, spacing and staleness | Keeper-pushed OMER rates (floor/ceiling, max step, min gap, max age) in the EVM rate oracle (IF-F4). |
| `getDy` / `getD` / one-coin exits | Independent differential reference for a Solidity StablePool's quotes (IF-F1, IF-F2). |
| `BackingUpdated` / `BackingChallenged` / `BackingReclaimed` | Channel states, a stale-channel challenge and an escrow reclaim on FLOP, via [Flop reclaim](https://github.com/HuKiFl1/Flop). The same rule informs the "reclaimed if unserved" path of a receipt-backed credit minter (IF-F12). |
| Settled channel state (nonce + cumulative amount owed) | Candidate Flop spend receipt: for settler-attested spend points (IF-F11) and as the hook `jobId` / receipt root (open decision IF-D8). |
| `coins[k].expiresAt` | FCU windows and other credit that expires. |
| Swaps between agents or venues | On EVM, the pool contracts. Legs that touch FLOP settle through FLOP escrow, or through TCLK (HTLC) when the two legs live on different rails. |
| `RampA`, `CommitFees`/`ApplyFees` delays | Owner/timelock powers on EVM; governance plus enactment delay on FLOP (§09). |

## 3. Where it runs

**Role:** an independent off-chain reference implementation and test-vector
source for Inference Finance, whose AMM is Solidity on HyperEVM testnet (chain
998), unaudited and TEST mocks only. FLOP has no EVM and no user-deployed code,
so DeFi contracts run on an EVM chain and integrate with FLOP through inference
credits, spend receipts, escrow and channels. A native FLOP module remains a
possible long-term path, not the current plan; a sketch is kept in
[docs/FUTURE_NATIVE_MODULE.md](./docs/FUTURE_NATIVE_MODULE.md).

The pool is a pure, replayable event ledger, so every quote and swap can be
recomputed by anyone from the event log and compared with a contract's output.

**Honest gap:** there is still no on-chain FLOP or Pearl inference-credit
token, so any rate for FLOP credit is a placeholder, not a market price. A real
pool needs credit issuers and a rate source first.

## 4. Money legos

- **Flop reclaim** ([HuKiFl1/Flop](https://github.com/HuKiFl1/Flop)) bounds the
  pool's exposure to a backed coin at the lender principal a stale-channel
  reclaim would recover (`recoverablePrincipal`).
- **This pool** lets agents swap credit they don't need into credit they do,
  at a near-1:1 price set by a StableSwap curve.
- **Rate checks (in progress, Proposal):** time-weighted prices read from
  this pool, used as a cross-check on keeper-pushed OMER rates rather than a
  replacement for them (SPEC §14, question 6).

## 5. Open questions specific to FLOP

1. Can a backed coin's escrow be expressed with FLOP's typed escrow policies
   alone? **[YP]**
2. If compute channels pay per block **[YP]**, should `recoverable` be updated
   per block or per checkpoint?
3. FCUs are "transferable", with sharing and transfers governed by a separate
   minimum-position rule (§12). Can pooled FCU units satisfy that rule?
4. The backed-coin window rejects late updates at `reclaimableAt`, which
   differs from TCLK's "a timeout does not expire a claim" (see Flop's
   FLOP.md). Should both follow TCLK?

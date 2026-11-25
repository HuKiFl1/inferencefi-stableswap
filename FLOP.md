# How inferencefi-stableswap sits on FLOP

Source for every statement about FLOP below: the FLOP Network whitepaper,
<https://flop.network/whitepaper/> (draft dated 25 September 2026). The
whitepaper says the Yellow Paper is the definitive specification and that it
is not yet final. Items marked **[YP]** depend on it. Items marked
**Proposal** are our design suggestions, not FLOP facts.

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

| This package | FLOP primitive it builds on |
|---|---|
| Pool coins | Inference credit units. **Proposal:** escrow-backed credit lent into compute channels today; FCU units as candidate coins once FCUs exist. |
| `BackingUpdated` / `BackingChallenged` / `BackingReclaimed` | Channel states, a stale-channel challenge and an escrow reclaim on FLOP, via [Flop reclaim](https://github.com/HuKiFl1/Flop). |
| `coins[k].expiresAt` | FCU windows and other credit that expires. |
| Swaps between agents or venues | Settled through FLOP escrow, or through TCLK (HTLC) when the two legs live on different rails. |
| `RampA`, `CommitFees`/`ApplyFees` delays | Governance plus enactment delay. **Proposal:** in a pallet these would be governance origins (§09). |

## 3. Where it runs

The pool is a pure, replayable event ledger. It runs **off-chain**, inside
agents or a venue such as Technocore, so every quote and swap can be
recomputed by anyone from the event log. Funds move only through FLOP's native
escrow, time-lock and HTLC primitives.

**Proposal:** this repository is a reference specification plus test suite
for a governance-adopted native module (a Substrate pallet). It is not an EVM
contract and not user-deployed code. A sketch is in
[PALLET_PROPOSAL.md](./PALLET_PROPOSAL.md).

## 4. Money legos

- **Flop reclaim** ([HuKiFl1/Flop](https://github.com/HuKiFl1/Flop)) bounds the
  pool's exposure to a backed coin at the lender principal a stale-channel
  reclaim would recover (`recoverablePrincipal`).
- **This pool** lets agents swap credit they don't need into credit they do,
  at a near-1:1 price set by a StableSwap curve.
- **Oracle and FCU forward curve (in progress, Proposal):** time-weighted
  prices read from this pool, combined with a 1–30 day curve built only from
  settled FCU reservations (the term tape, §12). The oracle could also
  replace admin-pushed `SetRate` (SPEC §14, question 6).

## 5. Open questions specific to FLOP

1. Can a backed coin's escrow be expressed with FLOP's typed escrow policies
   alone, or does the pool need native module support? **[YP]**
2. If compute channels pay per block **[YP]**, should `recoverable` be updated
   per block or per checkpoint?
3. FCUs are "transferable", with sharing and transfers governed by a separate
   minimum-position rule (§12). Can pooled FCU units satisfy that rule?
4. The backed-coin window rejects late updates at `reclaimableAt`, which
   differs from TCLK's "a timeout does not expire a claim" (see Flop's
   FLOP.md). Should both follow TCLK?

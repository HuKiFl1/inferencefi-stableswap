import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PoolLedger, recoverablePrincipal, type BackingUpdateInput, type PoolEvent, type PoolParams } from "../src/index.js";
import { ADMIN, COINS3, E18, E6, RUNS, expectCode, expectConservation, expectRejectedAtomically, params, units } from "./helpers.js";

/** Coin 2 is an inference credit lent into a Flop payment channel; its holdings are capped by what reclaim would return. */
const BACKED = 2;
const backedParams = (over: Partial<PoolParams> = {}): PoolParams =>
  params({ coins: COINS3.map((c, k) => (k === BACKED ? { ...c, backed: true } : c)), ...over });

const update = (height: bigint, nonce: bigint, recoverable: bigint, coin = BACKED): PoolEvent => ({
  type: "BackingUpdated",
  height,
  coin,
  nonce,
  recoverable,
  stateRoot: `root-${nonce}`,
});

function backedPool(over: Partial<PoolParams> = {}): PoolLedger {
  const ledger = new PoolLedger(backedParams(over));
  ledger.append(update(1n, 1n, 1_200_000n * E6));
  ledger.append({ type: "AddLiquidity", height: 1n, by: "lp0", amounts: units(1_000_000n, 1_000_000n, 1_000_000n), minMint: 0n });
  return ledger;
}

const holdings = (l: PoolLedger, k: number): bigint => l.state.balances[k]! + l.state.adminBalances[k]!;

describe("R3: holdings of a backed coin never exceed the recoverable escrow", () => {
  it("rejects a bootstrap before any backing is reported", () => {
    const ledger = new PoolLedger(backedParams());
    expectRejectedAtomically(ledger, { type: "AddLiquidity", height: 1n, by: "lp0", amounts: units(1n, 1n, 1n), minMint: 0n }, "BACKING_EXCEEDED");
  });

  it("rejects deposits and sells that would push holdings over the cap, at the exact boundary", () => {
    const ledger = backedPool();
    const room = 1_200_000n * E6 - holdings(ledger, BACKED);
    expectRejectedAtomically(ledger, { type: "AddLiquidity", height: 2n, by: "lp1", amounts: [0n, 0n, room + 1n], minMint: 0n }, "BACKING_EXCEEDED");
    ledger.append({ type: "AddLiquidity", height: 2n, by: "lp1", amounts: [0n, 0n, room], minMint: 0n });
    expect(holdings(ledger, BACKED)).toBe(1_200_000n * E6);
    expectRejectedAtomically(ledger, { type: "Exchange", height: 2n, by: "t", i: BACKED, j: 0, dx: E6, minDy: 0n }, "BACKING_EXCEEDED");
    // Buying the backed coin out of the pool is always allowed: it reduces exposure.
    ledger.append({ type: "Exchange", height: 2n, by: "t", i: 0, j: BACKED, dx: 1_000n * E18, minDy: 0n });
    expect(holdings(ledger, BACKED) <= 1_200_000n * E6).toBe(true);
  });

  it("random interleavings of trades and backing updates keep holdings <= recoverable and conserve tokens", () => {
    const cmd = fc.oneof(
      fc.record({ k: fc.constant("swapIn" as const), f: fc.bigInt({ min: 1n, max: 200_000n }) }),
      fc.record({ k: fc.constant("swapOut" as const), f: fc.bigInt({ min: 1n, max: 200_000n }) }),
      fc.record({ k: fc.constant("add" as const), f: fc.bigInt({ min: 1n, max: 300_000n }) }),
      fc.record({ k: fc.constant("update" as const), f: fc.bigInt({ min: 0n, max: 1_500_000n }) }),
      fc.record({ k: fc.constant("one" as const), f: fc.bigInt({ min: 1n, max: 100_000n }) }),
    );
    fc.assert(
      fc.property(fc.array(cmd, { maxLength: 25 }), (cmds) => {
        const ledger = backedPool();
        let nonce = 1n;
        let h = 2n;
        for (const c of cmds) {
          h += 1n;
          const ev: PoolEvent =
            c.k === "swapIn" ? { type: "Exchange", height: h, by: "t", i: BACKED, j: 0, dx: c.f * E6, minDy: 0n }
            : c.k === "swapOut" ? { type: "Exchange", height: h, by: "t", i: 0, j: BACKED, dx: c.f * E18, minDy: 0n }
            : c.k === "add" ? { type: "AddLiquidity", height: h, by: "lp1", amounts: [0n, 0n, c.f * E6], minMint: 0n }
            : c.k === "update" ? update(h, (nonce += 1n), c.f * E6)
            : { type: "RemoveLiquidityOneCoin", height: h, by: "lp0", shares: c.f * E18, coin: BACKED, minAmount: 0n };
          const before = ledger.state;
          const r = ledger.tryAppend(ev);
          if (!r.ok) expect(ledger.state).toBe(before);
          const b = ledger.state.backing[BACKED]!;
          expect(holdings(ledger, BACKED) <= b.recoverable).toBe(true);
          expectConservation(ledger.state);
          // Write-downs never mint or burn shares.
          if (r.ok && ev.type === "BackingUpdated") expect(ledger.state.supply).toBe(before.supply);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe("write-down on a lower recoverable amount (loss absorption order)", () => {
  it("takes admin fees first, then LP balances, never minting shares", () => {
    const ledger = backedPool();
    ledger.append({ type: "Exchange", height: 2n, by: "t", i: 0, j: BACKED, dx: 100_000n * E18, minDy: 0n });
    const adm = ledger.state.adminBalances[BACKED]!;
    expect(adm > 0n).toBe(true);
    const total = holdings(ledger, BACKED);
    const supply = ledger.state.supply;
    const vp = ledger.virtualPrice(2n);

    const r1 = ledger.append(update(3n, 2n, total - adm / 2n));
    expect(r1.type === "BackingUpdated" && r1.writtenDownFromAdmin).toBe(adm / 2n);
    expect(r1.type === "BackingUpdated" && r1.writtenDown).toBe(adm / 2n);
    expect(ledger.virtualPrice(3n)).toBe(vp);

    const lpBefore = ledger.state.balances[BACKED]!;
    const r2 = ledger.append(update(4n, 3n, lpBefore - 1_000n * E6));
    expect(r2.type === "BackingUpdated" && r2.writtenDownFromAdmin).toBe(adm - adm / 2n);
    expect(ledger.state.balances[BACKED]).toBe(lpBefore - 1_000n * E6);
    expect(ledger.state.adminBalances[BACKED]).toBe(0n);
    expect(ledger.state.supply).toBe(supply);
    expect(ledger.virtualPrice(4n) < vp).toBe(true);
    expectConservation(ledger.state);

    // A later, higher recoverable amount never writes anything back up.
    ledger.append(update(5n, 4n, 5_000_000n * E6));
    expect(ledger.state.balances[BACKED]).toBe(lpBefore - 1_000n * E6);
  });
});

describe("backing updates: nonce ordering, verification, binding", () => {
  it("rejects stale or equal nonces, unbacked coins, and updates the verifier refuses", () => {
    const seen: BackingUpdateInput[] = [];
    const ledger = backedPool({ verifyBacking: (u) => (seen.push(u), u.stateRoot !== "root-66") });
    expectRejectedAtomically(ledger, update(2n, 1n, 1n), "STALE_NONCE");
    expectRejectedAtomically(ledger, update(2n, 0n, 1n), "INVALID_EVENT");
    expectRejectedAtomically(ledger, update(2n, 5n, 1n, 0), "NOT_BACKED");
    expectRejectedAtomically(ledger, { type: "BackingChallenged", height: 20n, by: "k", coin: 1 }, "NOT_BACKED");
    expectRejectedAtomically(ledger, update(2n, 66n, 2_000_000n * E6), "BACKING_REJECTED");
    expect(seen.at(-1)).toEqual({ coin: BACKED, nonce: 66n, recoverable: 2_000_000n * E6, stateRoot: "root-66" });
    ledger.append(update(2n, 67n, 2_000_000n * E6));
    expect(ledger.state.backing[BACKED]!.nonce).toBe(67n);
  });
});

describe("staleness and the challenge window (Flop N and W boundaries)", () => {
  it("can be challenged exactly N blocks after the last progress, not one block earlier", () => {
    const ledger = backedPool();
    ledger.append(update(7n, 2n, 1_200_000n * E6));
    expectRejectedAtomically(ledger, { type: "BackingChallenged", height: 16n, by: "keeper", coin: BACKED }, "NOT_STALE");
    ledger.append({ type: "BackingChallenged", height: 17n, by: "keeper", coin: BACKED });
    expect(ledger.state.backing[BACKED]).toMatchObject({ status: "Challenge", challengeStartedAt: 17n, reclaimableAt: 22n });
    expectRejectedAtomically(ledger, { type: "BackingChallenged", height: 17n, by: "keeper", coin: BACKED }, "CHALLENGE_ALREADY_STARTED");
  });

  it("progress during the window updates the state but does not cure the challenge (sticky)", () => {
    const ledger = backedPool();
    ledger.append({ type: "BackingChallenged", height: 11n, by: "keeper", coin: BACKED });
    ledger.append(update(15n, 2n, 1_100_000n * E6));
    const b = ledger.state.backing[BACKED]!;
    expect(b.status).toBe("Challenge");
    expect(b.progressHeight).toBe(1n);
    expect(b.recoverable).toBe(1_100_000n * E6);
    expectRejectedAtomically(ledger, update(16n, 3n, 1_100_000n * E6), "CHALLENGE_WINDOW_CLOSED");
  });

  it("reclaim is accepted at reclaimableAt (not before) and binds the exact latest (nonce, amount)", () => {
    const ledger = backedPool();
    ledger.append({ type: "BackingChallenged", height: 11n, by: "keeper", coin: BACKED });
    const rec = ledger.state.backing[BACKED]!.recoverable;
    const reclaim = (height: bigint, nonce: bigint, amount: bigint): PoolEvent => ({ type: "BackingReclaimed", height, by: "keeper", coin: BACKED, nonce, amount });
    expectRejectedAtomically(ledger, reclaim(15n, 1n, rec), "CHALLENGE_WINDOW_OPEN");
    expectRejectedAtomically(ledger, reclaim(16n, 2n, rec), "PAYLOAD_MISMATCH");
    expectRejectedAtomically(ledger, reclaim(16n, 1n, rec - 1n), "PAYLOAD_MISMATCH");
    expectRejectedAtomically(new PoolLedger(backedParams()), reclaim(16n, 0n, 0n), "NO_CHALLENGE");
    ledger.append(reclaim(16n, 1n, rec));
    expect(ledger.state.backing[BACKED]).toMatchObject({ status: "Reclaimed", reclaimedAmount: rec });
    expectRejectedAtomically(ledger, reclaim(17n, 1n, rec), "ALREADY_RECLAIMED");
    expectRejectedAtomically(ledger, update(17n, 9n, rec), "ALREADY_RECLAIMED");
    expectRejectedAtomically(ledger, { type: "BackingChallenged", height: 17n, by: "k", coin: BACKED }, "ALREADY_RECLAIMED");
  });
});

describe("restricted mode while a coin is in challenge (fair exits, no dumping)", () => {
  const challenged = (): PoolLedger => {
    const ledger = backedPool();
    ledger.append({ type: "AddLiquidity", height: 2n, by: "lp1", amounts: units(1_000n, 1_000n, 1_000n), minMint: 0n });
    ledger.append({ type: "BackingChallenged", height: 11n, by: "keeper", coin: BACKED });
    return ledger;
  };

  it("blocks selling or depositing the challenged coin and imbalanced or other-coin exits", () => {
    const ledger = challenged();
    expectRejectedAtomically(ledger, { type: "Exchange", height: 12n, by: "t", i: BACKED, j: 0, dx: E6, minDy: 0n }, "COIN_IN_CHALLENGE");
    expectRejectedAtomically(ledger, { type: "ExchangeExactOut", height: 12n, by: "t", i: BACKED, j: 0, dy: E18, maxDx: 2n ** 100n }, "COIN_IN_CHALLENGE");
    expectRejectedAtomically(ledger, { type: "AddLiquidity", height: 12n, by: "lp2", amounts: [E18, E6, E6], minMint: 0n }, "COIN_IN_CHALLENGE");
    expectRejectedAtomically(ledger, { type: "RemoveLiquidityImbalance", height: 12n, by: "lp1", amounts: [E18, 0n, 0n], maxBurn: 2n ** 100n }, "COIN_IN_CHALLENGE");
    expectRejectedAtomically(ledger, { type: "RemoveLiquidityOneCoin", height: 12n, by: "lp1", shares: E18, coin: 0, minAmount: 0n }, "COIN_IN_CHALLENGE");
    expectCode(() => ledger.getDy(BACKED, 0, E6, 12n), "COIN_IN_CHALLENGE");
  });

  it("still allows buying the challenged coin, single-coin exits in it, deposits of other coins and proportional exits", () => {
    const ledger = challenged();
    ledger.append({ type: "Exchange", height: 12n, by: "t", i: 0, j: BACKED, dx: E18, minDy: 0n });
    ledger.append({ type: "RemoveLiquidityOneCoin", height: 12n, by: "lp1", shares: E18, coin: BACKED, minAmount: 0n });
    ledger.append({ type: "AddLiquidity", height: 12n, by: "lp2", amounts: [E18, E6, 0n], minMint: 0n });
    ledger.append({ type: "RemoveLiquidity", height: 12n, by: "lp1", shares: ledger.sharesOf("lp1"), minAmounts: [0n, 0n, 0n] });
    expect(ledger.sharesOf("lp1")).toBe(0n);
  });

  it("proportional exits are first-come-first-served neutral: exit order does not change what each LP gets beyond 1 unit", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 6n }), fc.bigInt({ min: 1n, max: 10n ** 6n }), (fa, fb) => {
        const run = (first: "lp0" | "lp1"): Map<string, readonly bigint[]> => {
          const ledger = challenged();
          const take = { lp0: (ledger.sharesOf("lp0") * fa) / 10n ** 6n, lp1: (ledger.sharesOf("lp1") * fb) / 10n ** 6n };
          const out = new Map<string, readonly bigint[]>();
          for (const who of first === "lp0" ? (["lp0", "lp1"] as const) : (["lp1", "lp0"] as const)) {
            if (take[who] === 0n) continue;
            const r = ledger.append({ type: "RemoveLiquidity", height: 12n, by: who, shares: take[who], minAmounts: [0n, 0n, 0n] });
            if (r.type === "RemoveLiquidity") out.set(who, r.amounts);
          }
          return out;
        };
        const a = run("lp0");
        const b = run("lp1");
        for (const who of a.keys()) {
          a.get(who)!.forEach((x, k) => expect(x - b.get(who)![k]! <= 1n && b.get(who)![k]! - x <= 1n).toBe(true));
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe("wind-down after reclaim or expiry", () => {
  it("after reclaim only proportional exits, backing and admin events remain", () => {
    const ledger = backedPool();
    ledger.append({ type: "BackingChallenged", height: 11n, by: "keeper", coin: BACKED });
    const b = ledger.state.backing[BACKED]!;
    ledger.append({ type: "BackingReclaimed", height: 16n, by: "keeper", coin: BACKED, nonce: b.nonce, amount: b.recoverable });
    expect(ledger.mode(16n).windDown).toBe(true);
    expectRejectedAtomically(ledger, { type: "Exchange", height: 16n, by: "t", i: 0, j: 1, dx: E18, minDy: 0n }, "WIND_DOWN");
    expectRejectedAtomically(ledger, { type: "AddLiquidity", height: 16n, by: "x", amounts: [E18, 0n, 0n], minMint: 0n }, "WIND_DOWN");
    expectRejectedAtomically(ledger, { type: "RemoveLiquidityOneCoin", height: 16n, by: "lp0", shares: E18, coin: 0, minAmount: 0n }, "WIND_DOWN");
    expectRejectedAtomically(ledger, { type: "RemoveLiquidityImbalance", height: 16n, by: "lp0", amounts: [E18, 0n, 0n], maxBurn: 2n ** 100n }, "WIND_DOWN");
    ledger.append({ type: "RemoveLiquidity", height: 16n, by: "lp0", shares: ledger.sharesOf("lp0"), minAmounts: [0n, 0n, 0n] });
    ledger.append({ type: "WithdrawAdminFees", height: 16n, by: ADMIN });
    expectConservation(ledger.state);
  });

  it("a coin expiring at height T allows trading at T-1 and switches to wind-down at T", () => {
    const p = params({ coins: COINS3.map((c, k) => (k === 1 ? { ...c, expiresAt: 100n } : c)) });
    const ledger = new PoolLedger(p);
    ledger.append({ type: "AddLiquidity", height: 1n, by: "lp0", amounts: units(1_000n, 1_000n, 1_000n), minMint: 0n });
    ledger.append({ type: "Exchange", height: 99n, by: "t", i: 0, j: 2, dx: E18, minDy: 0n });
    expectRejectedAtomically(ledger, { type: "Exchange", height: 100n, by: "t", i: 0, j: 2, dx: E18, minDy: 0n }, "WIND_DOWN");
    expectCode(() => ledger.getDy(0, 2, E18, 100n), "WIND_DOWN");
    expect(ledger.mode(100n).expired).toEqual([1]);
    ledger.append({ type: "RemoveLiquidity", height: 100n, by: "lp0", shares: E18, minAmounts: [0n, 0n, 0n] });
  });
});

describe("mirroring a Flop channel (the flop-channel-reclaim README example, N = 100, W = 20)", () => {
  it("the pool accepts and rejects at the same heights as the channel, and reclaims exactly toLender", () => {
    // Channel: lenderPrincipal L = 900_000, payerDeposit 100_000, escrow E = 1_000_000 (native units of coin 2).
    const channel = { escrow: 1_000_000n * E6, lenderPrincipal: 900_000n * E6 };
    const p = backedParams({ stalenessBlocks: 100n, challengeWindowBlocks: 20n });
    const ledger = new PoolLedger(p);
    // StateFinalized(nonce 1, owed 250_000) at 1_010  ->  toLender = min(900k, 1M - 250k) = 750k.
    const r1 = recoverablePrincipal({ ...channel, owed: 250_000n * E6 });
    expect(r1).toBe(750_000n * E6);
    ledger.append(update(1_010n, 1n, r1));
    ledger.append({ type: "AddLiquidity", height: 1_010n, by: "lp0", amounts: units(700_000n, 700_000n, 700_000n), minMint: 0n });
    // Stale at latest.h + N = 1_110, not before.
    expectRejectedAtomically(ledger, { type: "BackingChallenged", height: 1_109n, by: "pool-keeper", coin: BACKED }, "NOT_STALE");
    ledger.append({ type: "BackingChallenged", height: 1_110n, by: "pool-keeper", coin: BACKED });
    // The provider's newer state lands on the last window height s + W - 1 = 1_129; owed 300k -> toLender 700k.
    const r2 = recoverablePrincipal({ ...channel, owed: 300_000n * E6 });
    expect(r2).toBe(700_000n * E6);
    const w = ledger.append(update(1_129n, 2n, r2));
    expect(w.type === "BackingUpdated" && w.writtenDown).toBe(0n);
    expectRejectedAtomically(ledger, update(1_130n, 3n, r2), "CHALLENGE_WINDOW_CLOSED");
    expectRejectedAtomically(ledger, { type: "BackingReclaimed", height: 1_129n, by: "pool-keeper", coin: BACKED, nonce: 2n, amount: r2 }, "CHALLENGE_WINDOW_OPEN");
    // Flop's settlement at 1_130 pays toLender = 700_000; the pool binds exactly that.
    ledger.append({ type: "BackingReclaimed", height: 1_130n, by: "pool-keeper", coin: BACKED, nonce: 2n, amount: 700_000n * E6 });
    expect(holdings(ledger, BACKED) <= 700_000n * E6).toBe(true);
    expect(ledger.mode(1_130n).windDown).toBe(true);
  });
});

describe("recoverablePrincipal matches the Flop payout waterfall (toLender)", () => {
  const arb = fc
    .tuple(fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.bigInt({ min: 0n, max: 2n * 10n ** 30n }))
    .map(([l, p, o]) => ({ lenderPrincipal: l, escrow: l + p, owed: o }));

  it("R1/R2: never exceeds the lender principal nor the escrow left after the provider is paid", () => {
    fc.assert(
      fc.property(arb, (x) => {
        const r = recoverablePrincipal(x);
        const toProvider = x.owed < x.escrow ? x.owed : x.escrow;
        const toPayer = x.escrow - toProvider - r;
        expect(r >= 0n && r <= x.lenderPrincipal && r <= x.escrow - toProvider).toBe(true);
        expect(toPayer >= 0n).toBe(true);
        expect(toProvider + r + toPayer).toBe(x.escrow);
      }),
      { numRuns: RUNS },
    );
  });

  it("is non-increasing as more is owed to the provider (later states can only write the coin down)", () => {
    fc.assert(
      fc.property(arb, fc.bigInt({ min: 0n, max: 10n ** 30n }), (x, more) => {
        expect(recoverablePrincipal({ ...x, owed: x.owed + more }) <= recoverablePrincipal(x)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it("rejects inconsistent inputs", () => {
    expect(() => recoverablePrincipal({ escrow: 1n, lenderPrincipal: 2n, owed: 0n })).toThrow(RangeError);
    expect(() => recoverablePrincipal({ escrow: 1n, lenderPrincipal: 0n, owed: -1n })).toThrow(RangeError);
  });
});

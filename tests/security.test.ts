import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { A_PRECISION, MAX_A, PoolError, PoolLedger, getD, replay, xpOf, type PoolEvent, type PoolParams } from "../src/index.js";
import { ADMIN, COINS3, E18, E6, RUNS, bootstrapped, expectCode, expectConservation, params, units } from "./helpers.js";

describe("§5 Vyper reentrancy (Jul 2023): one lock across every entry point, effects before interactions", () => {
  it("cross-function re-entry from a listener (remove_liquidity -> add_liquidity) is refused; a caught refusal keeps the outer call", () => {
    const ledger = bootstrapped();
    let seen: unknown;
    let stateInListener: unknown;
    ledger.subscribe((e) => {
      if (e.type !== "RemoveLiquidity") return;
      stateInListener = ledger.state;
      try {
        ledger.append({ type: "AddLiquidity", height: 2n, by: "lp0", amounts: units(1n, 1n, 1n), minMint: 0n });
      } catch (error) {
        seen = error;
      }
    });
    const r = ledger.append({ type: "RemoveLiquidity", height: 2n, by: "lp0", shares: E18, minAmounts: [0n, 0n, 0n] });
    expect(seen).toBeInstanceOf(PoolError);
    expect((seen as PoolError).code).toBe("REENTRANCY");
    // Effects were committed before the listener ran: it observed the post-withdrawal state.
    expect(stateInListener).toBe(ledger.state);
    expect(r.type).toBe("RemoveLiquidity");
    expect(ledger.events.at(-1)!.type).toBe("RemoveLiquidity");
    expectConservation(ledger.state);
  });

  it("an uncaught re-entry (or any listener failure) reverts the whole append", () => {
    for (const failure of ["reenter", "throw"] as const) {
      const ledger = bootstrapped();
      const unsubscribe = ledger.subscribe(() => {
        if (failure === "reenter") ledger.append({ type: "Exchange", height: 2n, by: "x", i: 0, j: 1, dx: E18, minDy: 0n });
        else throw new Error("listener crashed");
      });
      const events = ledger.events;
      const state = ledger.state;
      expect(() => ledger.append({ type: "Exchange", height: 2n, by: "t", i: 0, j: 1, dx: E18, minDy: 0n })).toThrow();
      expect(ledger.events).toEqual(events);
      expect(ledger.state).toBe(state);
      expect(ledger.receipts.length).toBe(events.length);
      unsubscribe();
      // The lock was released: the ledger keeps working.
      ledger.append({ type: "Exchange", height: 2n, by: "t", i: 0, j: 1, dx: E18, minDy: 0n });
    }
  });

  it("tryAppend turns a re-entry rollback into a typed rejection, and replay of the log matches", () => {
    const ledger = bootstrapped();
    ledger.subscribe((e) => {
      if (e.type === "AddLiquidity") ledger.append({ type: "RemoveLiquidity", height: 3n, by: "lp1", shares: 1n, minAmounts: [0n, 0n, 0n] });
    });
    const r = ledger.tryAppend({ type: "AddLiquidity", height: 3n, by: "lp1", amounts: units(1n, 1n, 1n), minMint: 0n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("REENTRANCY");
    expect(replay(ledger.params, ledger.events)).toEqual(ledger.state);
  });

  it("a backing verifier that re-enters the ledger is refused and the update rejected", () => {
    let ledger: PoolLedger | undefined;
    const p = params({
      coins: COINS3.map((c, k) => (k === 2 ? { ...c, backed: true } : c)),
      verifyBacking: () => {
        ledger!.append({ type: "WithdrawAdminFees", height: 1n, by: ADMIN });
        return true;
      },
    });
    ledger = new PoolLedger(p);
    expectCode(() => ledger!.append({ type: "BackingUpdated", height: 1n, coin: 2, nonce: 1n, recoverable: 1n, stateRoot: "r" }), "REENTRANCY");
    expect(ledger.events.length).toBe(0);
  });

  it("recorded events, receipts and states are immutable: mutating inputs or outputs cannot rewrite history", () => {
    const ledger = bootstrapped();
    const amounts = [E18, 0n, 0n];
    const e: PoolEvent = { type: "AddLiquidity", height: 2n, by: "lp1", amounts, minMint: 0n };
    ledger.append(e);
    amounts[0] = 10n ** 30n;
    const recorded = ledger.events.at(-1)!;
    expect(recorded.type === "AddLiquidity" && recorded.amounts[0]).toBe(E18);
    expect(() => (ledger.state.balances as bigint[]).push(1n)).toThrow(TypeError);
    expect(() => ((ledger.state as { supply: bigint }).supply = 0n)).toThrow(TypeError);
    expect(() => ((ledger.receipts.at(-1) as { minted: bigint }).minted = 0n)).toThrow(TypeError);
    expect(replay(ledger.params, ledger.events)).toEqual(ledger.state);
  });
});

describe("§5 Balancer CSP (Nov 2025): repeated dust swaps in a low-liquidity pool cannot extract value", () => {
  it("hundreds of minimum-size round trips never leave the trader ahead and never lower the virtual price", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 2_000n }), fc.oneof(fc.constant(0n), fc.constant(1_000_000n)), fc.bigInt({ min: 1n, max: 1_000n }), (a, fee, extra) => {
        const coins = [
          { symbol: "a", rate: E18 + 999_999_999_999n },
          { symbol: "b", rate: 10n ** 30n - 1n },
        ];
        const ledger = new PoolLedger(params({ coins, A: a, fee, minInitialD: E18 }));
        ledger.append({ type: "AddLiquidity", height: 1n, by: "lp0", amounts: [E18, E6], minMint: 0n });
        const vp0 = ledger.virtualPrice(1n);
        const dx0 = 1_000_000n + extra;
        let holding = dx0;
        let h = 1n;
        for (let k = 0; k < 150; k++) {
          h += 1n;
          const out = ledger.tryAppend({ type: "Exchange", height: h, by: "atk", i: 0, j: 1, dx: holding, minDy: 0n });
          if (!out.ok || out.receipt.type !== "Exchange") break;
          const back = ledger.tryAppend({ type: "Exchange", height: h, by: "atk", i: 1, j: 0, dx: out.receipt.dy, minDy: 0n });
          if (!back.ok || back.receipt.type !== "Exchange") break;
          holding = back.receipt.dy;
          expect(holding <= dx0).toBe(true);
        }
        expect(ledger.virtualPrice(h) >= vp0).toBe(true);
        expectConservation(ledger.state);
      }),
      { numRuns: Math.max(20, Math.floor(RUNS / 5)) },
    );
  });
});

describe("§5 yETH (Nov/Dec 2025): solver preconditions and the bootstrap path", () => {
  it("a bootstrap on which Newton's D does not converge is refused with a typed error instead of minting from its last guess", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/stableswap-paper-reference.json", import.meta.url), "utf8")) as {
      rates: string[];
      extremeStates: { A: number; balances: string[] }[];
    };
    const rates = fixture.rates.map(BigInt);
    const failing = fixture.extremeStates.filter((c) => {
      try {
        getD(xpOf(c.balances.map(BigInt), rates), BigInt(c.A) * A_PRECISION);
        return false;
      } catch (error) {
        return (error as { code?: string }).code === "NO_CONVERGENCE";
      }
    });
    expect(failing.length).toBeGreaterThan(0);
    for (const c of failing) {
      const ledger = new PoolLedger(params({ A: BigInt(c.A), minInitialD: E6 }));
      const r = ledger.tryAppend({ type: "AddLiquidity", height: 1n, by: "lp0", amounts: c.balances.map(BigInt), minMint: 0n });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("NO_CONVERGENCE");
      expect(ledger.events.length).toBe(0);
      expect(ledger.state.supply).toBe(0n);
    }
  });

  it("no deposit into an existing pool mints more than the value it adds (checked against the exact invariant)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 3_000n }), fc.array(fc.bigInt({ min: 0n, max: 10n ** 7n }), { minLength: 3, maxLength: 3 }), (A, amts) => {
        const ledger = bootstrapped(params({ A }), units(1_000n, 900n, 1_100n));
        const vp0 = ledger.virtualPrice(1n);
        const r = ledger.tryAppend({ type: "AddLiquidity", height: 2n, by: "x", amounts: units(amts[0]!, amts[1]!, amts[2]!), minMint: 0n });
        if (!r.ok) return;
        expect(ledger.virtualPrice(2n) >= vp0 - 1n).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("§5 Bancor (Jun 2022): losses are absorbed by reserves, never covered by minting", () => {
  it("no event other than a deposit can increase supply; write-downs hit admin fees before LPs", () => {
    const p = params({ coins: COINS3.map((c, k) => (k === 2 ? { ...c, backed: true } : c)) });
    const ledger = new PoolLedger(p);
    ledger.append({ type: "BackingUpdated", height: 1n, coin: 2, nonce: 1n, recoverable: 2_000_000n * E6, stateRoot: "r1" });
    ledger.append({ type: "AddLiquidity", height: 1n, by: "lp0", amounts: units(1_000_000n, 1_000_000n, 1_000_000n), minMint: 0n });
    ledger.append({ type: "Exchange", height: 2n, by: "t", i: 0, j: 2, dx: 200_000n * E18, minDy: 0n });
    const before = ledger.state;
    const lp = before.balances[2]!;
    const adm = before.adminBalances[2]!;
    const r = ledger.append({ type: "BackingUpdated", height: 3n, coin: 2, nonce: 2n, recoverable: lp - 5n * E6, stateRoot: "r2" });
    expect(r.type === "BackingUpdated" && [r.writtenDown, r.writtenDownFromAdmin]).toEqual([adm + 5n * E6, adm]);
    expect(ledger.state.supply).toBe(before.supply);
    expect(ledger.state.shares).toEqual(before.shares);
    expect(ledger.state.balances.slice(0, 2)).toEqual(before.balances.slice(0, 2));
    expect(ledger.state.adminBalances.slice(0, 2)).toEqual(before.adminBalances.slice(0, 2));
    expectConservation(ledger.state);
  });
});

describe("§5 CowSwapBurner (Nov 2026) and §3.7: every approval binds the exact executed payload", () => {
  it("the backing verifier sees exactly the fields that are executed and cannot alter them", () => {
    const p: PoolParams = params({
      coins: COINS3.map((c, k) => (k === 2 ? { ...c, backed: true } : c)),
      verifyBacking: (u) => {
        expect(Object.isFrozen(u)).toBe(true);
        expect(Object.keys(u).sort()).toEqual(["coin", "nonce", "recoverable", "stateRoot"]);
        return u.stateRoot === `root-${u.nonce}-${u.recoverable}`;
      },
    });
    const ledger = new PoolLedger(p);
    expectCode(() => ledger.append({ type: "BackingUpdated", height: 1n, coin: 2, nonce: 1n, recoverable: 10n ** 12n, stateRoot: `root-1-${10n ** 13n}` }), "BACKING_REJECTED");
    ledger.append({ type: "BackingUpdated", height: 1n, coin: 2, nonce: 1n, recoverable: 10n ** 12n, stateRoot: `root-1-${10n ** 12n}` });
    expect(ledger.state.backing[2]).toMatchObject({ nonce: 1n, recoverable: 10n ** 12n, stateRoot: `root-1-${10n ** 12n}` });
  });

  it("ApplyFees and BackingReclaimed execute only the committed payload (covered field by field)", () => {
    const ledger = bootstrapped();
    ledger.append({ type: "CommitFees", height: 2n, by: ADMIN, fee: 1_000_000n, adminFee: 1n });
    for (const [fee, adminFee] of [[1_000_001n, 1n], [1_000_000n, 2n], [0n, 0n]] as const) {
      expectCode(() => ledger.append({ type: "ApplyFees", height: 60n, by: ADMIN, fee, adminFee }), "PAYLOAD_MISMATCH");
    }
    ledger.append({ type: "ApplyFees", height: 60n, by: ADMIN, fee: 1_000_000n, adminFee: 1n });
    expect([ledger.state.fee, ledger.state.adminFee]).toEqual([1_000_000n, 1n]);
  });
});

describe("§3.8 gradual parameter changes and §3.9 bounded rate updates (property)", () => {
  it("A never moves faster than (|A1 − A0| / minRampBlocks) per block and never by more than 10x per ramp", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ dh: fc.bigInt({ min: 0n, max: 400n }), futureA: fc.bigInt({ min: 1n, max: 30_000n }), dur: fc.bigInt({ min: 0n, max: 500n }) }), { maxLength: 8 }),
        (ramps) => {
          const ledger = bootstrapped();
          let h = 1n;
          for (const r of ramps) {
            h += r.dh;
            ledger.tryAppend({ type: "RampA", height: h, by: ADMIN, futureA: r.futureA, futureHeight: h + r.dur });
          }
          for (let t = 1n; t <= h + 600n; t += 1n) {
            const a = ledger.A(t);
            expect(a >= 1n && a < MAX_A).toBe(true);
          }
          // Each accepted ramp respects the bounds against the A in force when it started.
          const replayed = new PoolLedger(ledger.params);
          for (const e of ledger.events) {
            if (e.type === "RampA") {
              const start = replayed.A(e.height);
              expect(e.futureA <= start * 10n && e.futureA * 10n >= start).toBe(true);
              expect(e.futureHeight - e.height >= ledger.params.minRampBlocks).toBe(true);
              const slope = (e.futureA > start ? e.futureA - start : start - e.futureA) / (e.futureHeight - e.height) + 1n;
              replayed.append(e);
              for (let t = e.height; t < e.futureHeight && t < e.height + 50n; t += 1n) {
                const step = replayed.A(t + 1n) - replayed.A(t);
                expect(step <= slope && -step <= slope).toBe(true);
              }
            } else replayed.append(e);
          }
        },
      ),
      { numRuns: Math.max(20, Math.floor(RUNS / 4)) },
    );
  });

  it("accepted rate updates move at most maxRateChangeBps each and are at least minRateUpdateBlocks apart", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ dh: fc.bigInt({ min: 0n, max: 15n }), bps: fc.integer({ min: -1_500, max: 1_500 }) }), { maxLength: 30 }), (ups) => {
        const ledger = bootstrapped();
        let h = 1n;
        for (const u of ups) {
          h += u.dh;
          const cur = ledger.state.rates[0]!;
          ledger.tryAppend({ type: "SetRate", height: h, by: ADMIN, coin: 0, rate: (cur * BigInt(10_000 + u.bps)) / 10_000n });
        }
        let last: bigint | null = null;
        let rate = COINS3[0]!.rate;
        for (const e of ledger.events) {
          if (e.type !== "SetRate") continue;
          const diff = e.rate > rate ? e.rate - rate : rate - e.rate;
          expect(diff * 10_000n <= rate * ledger.params.maxRateChangeBps).toBe(true);
          if (last !== null) expect(e.height - last >= ledger.params.minRateUpdateBlocks).toBe(true);
          last = e.height;
          rate = e.rate;
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe("§4 R4 and R5: no surprise losses at reclaim; an open challenge keeps counting until settled", () => {
  const challenged = (): PoolLedger => {
    const p = params({ coins: COINS3.map((c, k) => (k === 2 ? { ...c, backed: true } : c)) });
    const ledger = new PoolLedger(p);
    ledger.append({ type: "BackingUpdated", height: 1n, coin: 2, nonce: 1n, recoverable: 1_000_000n * E6, stateRoot: "r1" });
    ledger.append({ type: "AddLiquidity", height: 1n, by: "lp0", amounts: units(1_000_000n, 1_000_000n, 1_000_000n), minMint: 0n });
    ledger.append({ type: "BackingChallenged", height: 11n, by: "keeper", coin: 2 });
    // The provider's last finalized state (inside the window) lowers what is recoverable: the loss is marked now.
    ledger.append({ type: "BackingUpdated", height: 12n, coin: 2, nonce: 2n, recoverable: 600_000n * E6, stateRoot: "r2" });
    return ledger;
  };

  it("R4: the reclaim itself never changes balances, supply or the virtual price; the loss was marked at the last update", () => {
    const ledger = challenged();
    const vp = ledger.virtualPrice(16n);
    const { balances, adminBalances, supply } = ledger.state;
    ledger.append({ type: "BackingReclaimed", height: 16n, by: "keeper", coin: 2, nonce: 2n, amount: 600_000n * E6 });
    expect(ledger.state.balances).toEqual(balances);
    expect(ledger.state.adminBalances).toEqual(adminBalances);
    expect(ledger.state.supply).toBe(supply);
    // Wind-down makes swaps unavailable, but proportional value is unchanged.
    expect(ledger.virtualPrice(16n)).toBe(vp);
  });

  it("R5: a challenge that is never settled keeps the coin restricted and capped indefinitely", () => {
    const ledger = challenged();
    const far = 10n ** 9n;
    expect(ledger.mode(far).challenged).toEqual([2]);
    expect(ledger.state.backing[2]!.status).toBe("Challenge");
    expectCode(() => ledger.append({ type: "Exchange", height: far, by: "t", i: 2, j: 0, dx: E6, minDy: 0n }), "COIN_IN_CHALLENGE");
    expectCode(() => ledger.append({ type: "BackingUpdated", height: far, coin: 2, nonce: 3n, recoverable: 10n ** 30n, stateRoot: "r3" }), "CHALLENGE_WINDOW_CLOSED");
    expect(ledger.state.backing[2]!.recoverable).toBe(600_000n * E6);
  });
});

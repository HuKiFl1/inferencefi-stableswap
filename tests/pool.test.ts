import { describe, expect, it } from "vitest";
import {
  A_PRECISION,
  FEE_DENOMINATOR,
  LOCKED_HOLDER,
  MAX_A,
  MAX_FEE,
  PoolLedger,
  ampAt,
  imbalanceFeeRate,
  replay,
  type PoolEvent,
} from "../src/index.js";
import { ADMIN, E18, E6, bootstrapped, expectCode, expectConservation, expectRejectedAtomically, params, units } from "./helpers.js";

describe("params", () => {
  it("rejects malformed parameters", () => {
    const cases: Partial<Parameters<typeof params>[0]>[] = [
      { coins: [{ symbol: "a", rate: E18 }] },
      { coins: [{ symbol: "a", rate: 0n }, { symbol: "b", rate: E18 }] },
      { A: 0n },
      { A: MAX_A },
      { fee: MAX_FEE + 1n },
      { adminFee: FEE_DENOMINATOR + 1n },
      { admin: "" },
      { admin: LOCKED_HOLDER },
      { minRampBlocks: 0n },
      { adminDelayBlocks: 0n },
      { minimumLiquidity: 0n },
      { minInitialD: 1_000n },
      { minTradeAmount: 0n },
      { maxRateChangeBps: 10_001n },
      { stalenessBlocks: 0n },
      { challengeWindowBlocks: 0n },
    ];
    for (const c of cases) expectCode(() => new PoolLedger(params(c)), "INVALID_PARAMS");
  });
});

describe("bootstrap (first deposit) and minimum liquidity", () => {
  it("mints D shares, locks minimumLiquidity forever, and credits the rest to the depositor", () => {
    const ledger = new PoolLedger(params());
    const r = ledger.append({ type: "AddLiquidity", height: 1n, by: "lp0", amounts: units(100n, 100n, 100n), minMint: 0n });
    expect(r.type).toBe("AddLiquidity");
    if (r.type !== "AddLiquidity") return;
    expect(r.minted + r.locked).toBe(300n * E18);
    expect(r.locked).toBe(1_000n);
    expect(ledger.sharesOf(LOCKED_HOLDER)).toBe(1_000n);
    expect(ledger.sharesOf("lp0")).toBe(300n * E18 - 1_000n);
    expect(ledger.virtualPrice(1n)).toBe(E18);
  });

  it("requires every coin and D >= minInitialD (dust bootstrap is rejected)", () => {
    const ledger = new PoolLedger(params());
    expectRejectedAtomically(ledger, { type: "AddLiquidity", height: 1n, by: "lp0", amounts: [E18, 0n, E6], minMint: 0n }, "BOOTSTRAP");
    expectRejectedAtomically(ledger, { type: "AddLiquidity", height: 1n, by: "lp0", amounts: [E18 / 10n, E6 / 10n, E6 / 10n], minMint: 0n }, "BOOTSTRAP");
    expectRejectedAtomically(ledger, { type: "AddLiquidity", height: 1n, by: "lp0", amounts: [1n, 1n, 1n], minMint: 0n }, "BELOW_MIN_TRADE");
  });

  it("supply can never return to zero, so the bootstrap path cannot be re-entered with dust", () => {
    const ledger = bootstrapped();
    const all = ledger.sharesOf("lp0");
    ledger.append({ type: "RemoveLiquidity", height: 2n, by: "lp0", shares: all, minAmounts: [0n, 0n, 0n] });
    expect(ledger.state.supply).toBe(1_000n);
    expect(ledger.state.balances.every((b) => b > 0n)).toBe(true);
    // A dust "first deposit" is now an ordinary deposit and locks nothing.
    const r = ledger.tryAppend({ type: "AddLiquidity", height: 3n, by: "attacker", amounts: [E18, E6, E6], minMint: 0n });
    if (r.ok && r.receipt.type === "AddLiquidity") expect(r.receipt.locked).toBe(0n);
    expectCode(() => ledger.append({ type: "RemoveLiquidity", height: 3n, by: LOCKED_HOLDER, shares: 1n, minAmounts: [0n, 0n, 0n] }), "UNAUTHORIZED");
  });

  it("a minimal first depositor cannot dilute the next depositor (no donation path, internal balances)", () => {
    const ledger = new PoolLedger(params());
    ledger.append({ type: "AddLiquidity", height: 1n, by: "attacker", amounts: [E18 / 3n + 1n, E6 / 3n + 1n, E6 / 3n + 1n], minMint: 0n });
    const r = ledger.append({ type: "AddLiquidity", height: 1n, by: "victim", amounts: units(1_000_000n, 1_000_000n, 1_000_000n), minMint: 0n });
    if (r.type !== "AddLiquidity") throw new Error("unreachable");
    // Victim's shares are worth what they deposited, minus at most a dust-level imbalance fee.
    const vp = ledger.virtualPrice(1n);
    const value = (r.minted * vp) / E18;
    expect(3_000_000n * E18 - value < E18 / 1_000n).toBe(true);
  });
});

describe("exchange", () => {
  it("pays the previewed amount, charges the fee, and splits it with the admin", () => {
    const ledger = bootstrapped();
    const dy = ledger.getDy(0, 1, 1_000n * E18, 2n);
    const r = ledger.append({ type: "Exchange", height: 2n, by: "t", i: 0, j: 1, dx: 1_000n * E18, minDy: dy });
    if (r.type !== "Exchange") throw new Error("unreachable");
    expect(r.dy).toBe(dy);
    expect(dy < 1_000n * E6 && dy > 999n * E6).toBe(true);
    expect(r.feeXp > 0n).toBe(true);
    expect(r.adminFee > 0n).toBe(true);
    expect(ledger.state.adminBalances[1]).toBe(r.adminFee);
    expect(r.d1 >= r.d0).toBe(true);
    expectConservation(ledger.state);
  });

  it("rejects bad indices, zero/dust amounts, slippage and draining", () => {
    const ledger = bootstrapped();
    const base = { type: "Exchange", height: 2n, by: "t", minDy: 0n } as const;
    expectRejectedAtomically(ledger, { ...base, i: 0, j: 0, dx: E18 }, "INVALID_EVENT");
    expectRejectedAtomically(ledger, { ...base, i: 0, j: 3, dx: E18 }, "INVALID_EVENT");
    expectRejectedAtomically(ledger, { ...base, i: 0, j: 1, dx: 0n }, "INVALID_EVENT");
    expectRejectedAtomically(ledger, { ...base, i: 0, j: 1, dx: 999_999n }, "BELOW_MIN_TRADE");
    expectRejectedAtomically(ledger, { ...base, i: 0, j: 1, dx: 1_000n * E18, minDy: 1_000n * E6 }, "SLIPPAGE");
    expectRejectedAtomically(ledger, { type: "Exchange", height: 0n, by: "t", i: 0, j: 1, dx: E18, minDy: 0n }, "HEIGHT_REGRESSION");
    expectRejectedAtomically(new PoolLedger(params()), { ...base, i: 0, j: 1, dx: E18 }, "EMPTY_POOL");
  });

  it("exact-output: pays exactly dy, charges the smallest dx whose exact-input quote covers it", () => {
    const ledger = bootstrapped();
    const want = 12_345n * E6 + 7n;
    const dx = ledger.getDx(0, 1, want, 2n);
    expect(ledger.getDy(0, 1, dx, 2n) >= want).toBe(true);
    expect(ledger.getDy(0, 1, dx - 1n, 2n) < want).toBe(true);
    const r = ledger.append({ type: "ExchangeExactOut", height: 2n, by: "t", i: 0, j: 1, dy: want, maxDx: dx });
    if (r.type !== "ExchangeExactOut") throw new Error("unreachable");
    expect(r.dy).toBe(want);
    expect(r.dx).toBe(dx);
    expect(r.dyQuoted >= want).toBe(true);
    expectRejectedAtomically(ledger, { type: "ExchangeExactOut", height: 2n, by: "t", i: 0, j: 1, dy: want, maxDx: 1n }, "SLIPPAGE");
    expectRejectedAtomically(ledger, { type: "ExchangeExactOut", height: 2n, by: "t", i: 0, j: 1, dy: 10_000_000n * E6, maxDx: 2n ** 200n }, "INSUFFICIENT_LIQUIDITY");
  });
});

describe("liquidity", () => {
  it("imbalanced deposit pays the imbalance fee; balanced deposit pays (almost) none", () => {
    const ledger = bootstrapped();
    const bal = ledger.append({ type: "AddLiquidity", height: 2n, by: "lp1", amounts: units(1_000n, 1_000n, 1_000n), minMint: 0n });
    const imb = ledger.append({ type: "AddLiquidity", height: 2n, by: "lp2", amounts: [3_000n * E18, 0n, 0n], minMint: 0n });
    if (bal.type !== "AddLiquidity" || imb.type !== "AddLiquidity") throw new Error("unreachable");
    expect(bal.fees.every((f) => f <= 1n)).toBe(true);
    expect(imb.fees[0]! > 0n && imb.fees[1]! > 0n).toBe(true);
    expect(imb.minted < bal.minted).toBe(true);
    expect(imbalanceFeeRate(4_000_000n, 3)).toBe(1_500_000n);
    expect(imbalanceFeeRate(1_000_001n, 3)).toBe(375_001n);
  });

  it("calc_token_amount equals the executed mint and burn exactly", () => {
    const ledger = bootstrapped();
    const amounts = [10n * E18, 0n, 5n * E6];
    const preview = ledger.calcTokenAmount(amounts, true, 2n);
    const r = ledger.append({ type: "AddLiquidity", height: 2n, by: "lp1", amounts, minMint: preview });
    expect(r.type === "AddLiquidity" && r.minted).toBe(preview);
    const burnPreview = ledger.calcTokenAmount([0n, 3n * E6, 0n], false, 2n);
    const b = ledger.append({ type: "RemoveLiquidityImbalance", height: 2n, by: "lp1", amounts: [0n, 3n * E6, 0n], maxBurn: burnPreview });
    expect(b.type === "RemoveLiquidityImbalance" && b.burned).toBe(burnPreview);
    expectRejectedAtomically(ledger, { type: "AddLiquidity", height: 2n, by: "lp1", amounts, minMint: preview * 2n }, "SLIPPAGE");
    expectRejectedAtomically(ledger, { type: "RemoveLiquidityImbalance", height: 2n, by: "lp1", amounts: [0n, 3n * E6, 0n], maxBurn: 1n }, "SLIPPAGE");
  });

  it("proportional removal is fee-free and rounds every amount down", () => {
    const ledger = bootstrapped(params(), [1_000_003n * E18 + 7n, 999_999n * E6 + 3n, 1_000_001n * E6 + 1n]);
    const s = ledger.state;
    const shares = ledger.sharesOf("lp0") / 3n;
    const r = ledger.append({ type: "RemoveLiquidity", height: 2n, by: "lp0", shares, minAmounts: [0n, 0n, 0n] });
    if (r.type !== "RemoveLiquidity") throw new Error("unreachable");
    r.amounts.forEach((a, k) => {
      expect(a).toBe((s.balances[k]! * shares) / s.supply);
      expect(a * s.supply <= s.balances[k]! * shares).toBe(true);
    });
    expectRejectedAtomically(ledger, { type: "RemoveLiquidity", height: 2n, by: "nobody", shares: 1n, minAmounts: [0n, 0n, 0n] }, "INSUFFICIENT_SHARES");
    expectRejectedAtomically(ledger, { type: "RemoveLiquidity", height: 2n, by: "lp0", shares: 1n, minAmounts: [1n, 0n, 0n] }, "SLIPPAGE");
  });

  it("single-coin withdrawal equals calc_withdraw_one_coin and pays less than a proportional exit's value", () => {
    const ledger = bootstrapped();
    const shares = 1_000n * E18;
    const preview = ledger.calcWithdrawOneCoin(shares, 1, 2n);
    const r = ledger.append({ type: "RemoveLiquidityOneCoin", height: 2n, by: "lp0", shares, coin: 1, minAmount: preview });
    if (r.type !== "RemoveLiquidityOneCoin") throw new Error("unreachable");
    expect(r.dy).toBe(preview);
    expect(r.fee > 0n).toBe(true);
    expect(r.dy < 1_000n * E6).toBe(true);
    expectRejectedAtomically(ledger, { type: "RemoveLiquidityOneCoin", height: 2n, by: "lp0", shares, coin: 1, minAmount: preview * 2n }, "SLIPPAGE");
    expectRejectedAtomically(ledger, { type: "RemoveLiquidityOneCoin", height: 2n, by: "lp0", shares, coin: 5, minAmount: 0n }, "INVALID_EVENT");
  });

  it("withdrawing a whole coin balance is rejected (no zero balances)", () => {
    const ledger = bootstrapped();
    const all = ledger.state.balances[2]!;
    expectRejectedAtomically(ledger, { type: "RemoveLiquidityImbalance", height: 2n, by: "lp0", amounts: [0n, 0n, all], maxBurn: 2n ** 200n }, "INSUFFICIENT_LIQUIDITY");
  });
});

describe("A ramping over block heights", () => {
  it("interpolates linearly, enforces min duration, min spacing and the 10x limit", () => {
    const ledger = bootstrapped();
    const ramp = (height: bigint, futureA: bigint, futureHeight: bigint): PoolEvent => ({ type: "RampA", height, by: ADMIN, futureA, futureHeight });
    expectRejectedAtomically(ledger, ramp(50n, 400n, 300n), "RAMP_TOO_EARLY");
    expectRejectedAtomically(ledger, ramp(100n, 400n, 150n), "RAMP_TOO_FAST");
    expectRejectedAtomically(ledger, ramp(100n, 2_001n, 300n), "A_CHANGE_TOO_LARGE");
    expectRejectedAtomically(ledger, ramp(100n, 19n, 300n), "A_CHANGE_TOO_LARGE");
    expectRejectedAtomically(ledger, ramp(100n, 0n, 300n), "A_OUT_OF_RANGE");
    expectRejectedAtomically(ledger, { type: "RampA", height: 100n, by: "mallory", futureA: 400n, futureHeight: 300n }, "UNAUTHORIZED");
    ledger.append(ramp(100n, 2_000n, 300n));
    expect(ledger.A(100n)).toBe(200n);
    expect(ledger.A(200n)).toBe(1_100n);
    expect(ledger.A(300n)).toBe(2_000n);
    expect(ledger.A(10_000n)).toBe(2_000n);
    expectRejectedAtomically(ledger, ramp(150n, 2_000n, 400n), "RAMP_TOO_EARLY");
    ledger.append({ type: "StopRampA", height: 150n, by: ADMIN });
    expect(ledger.A(150n)).toBe(650n);
    expect(ledger.A(10_000n)).toBe(650n);
  });

  it("interpolation never leaves [min(A0, A1), max(A0, A1)] and rounds toward A0", () => {
    const r = { initialA: 200n * A_PRECISION, futureA: 2_000n * A_PRECISION, initialHeight: 10n, futureHeight: 17n };
    for (let h = 0n; h < 30n; h++) {
      const a = ampAt(r, h);
      expect(a >= r.initialA && a <= r.futureA).toBe(true);
      const down = ampAt({ ...r, initialA: r.futureA, futureA: r.initialA }, h);
      expect(down >= r.initialA && down <= r.futureA).toBe(true);
    }
  });
});

describe("fees: commit / apply with delay and exact payload", () => {
  it("enforces delay, payload equality, range and single pending action", () => {
    const ledger = bootstrapped();
    const commit: PoolEvent = { type: "CommitFees", height: 10n, by: ADMIN, fee: 10_000_000n, adminFee: 0n };
    expectRejectedAtomically(ledger, { type: "ApplyFees", height: 10n, by: ADMIN, fee: 0n, adminFee: 0n }, "NO_PENDING_ACTION");
    expectRejectedAtomically(ledger, { ...commit, fee: MAX_FEE + 1n }, "FEE_OUT_OF_RANGE");
    ledger.append(commit);
    expectRejectedAtomically(ledger, commit, "ACTION_PENDING");
    expectRejectedAtomically(ledger, { type: "ApplyFees", height: 59n, by: ADMIN, fee: 10_000_000n, adminFee: 0n }, "ADMIN_DELAY");
    expectRejectedAtomically(ledger, { type: "ApplyFees", height: 60n, by: ADMIN, fee: 10_000_001n, adminFee: 0n }, "PAYLOAD_MISMATCH");
    ledger.append({ type: "ApplyFees", height: 60n, by: ADMIN, fee: 10_000_000n, adminFee: 0n });
    expect(ledger.state.fee).toBe(10_000_000n);
    ledger.append({ type: "CommitFees", height: 61n, by: ADMIN, fee: 1n, adminFee: 1n });
    ledger.append({ type: "RevertFees", height: 61n, by: ADMIN });
    expect(ledger.state.pendingFees).toBeNull();
  });

  it("admin fees are withdrawn exactly and only by the admin", () => {
    const ledger = bootstrapped();
    ledger.append({ type: "Exchange", height: 2n, by: "t", i: 0, j: 1, dx: 10_000n * E18, minDy: 0n });
    const held = ledger.state.adminBalances.slice();
    expectRejectedAtomically(ledger, { type: "WithdrawAdminFees", height: 2n, by: "lp0" }, "UNAUTHORIZED");
    const r = ledger.append({ type: "WithdrawAdminFees", height: 2n, by: ADMIN });
    expect(r.type === "WithdrawAdminFees" && r.amounts).toEqual(held);
    expect(ledger.state.adminBalances).toEqual([0n, 0n, 0n]);
    expectConservation(ledger.state);
  });
});

describe("rate multipliers", () => {
  it("normalise different decimals: 1 unit of an 18- and a 6-decimal coin swap ~1:1", () => {
    const ledger = bootstrapped();
    const dy = ledger.getDy(1, 0, 100n * E6, 2n);
    expect(dy > 99n * E18 && dy < 100n * E18).toBe(true);
  });

  it("a price rate moves the swap price; updates are bounded per step and spaced in blocks", () => {
    const ledger = bootstrapped();
    expectRejectedAtomically(ledger, { type: "SetRate", height: 20n, by: ADMIN, coin: 0, rate: (E18 * 111n) / 100n }, "RATE_CHANGE_TOO_LARGE");
    expectRejectedAtomically(ledger, { type: "SetRate", height: 5n, by: ADMIN, coin: 0, rate: E18 }, "RATE_UPDATE_TOO_SOON");
    expectRejectedAtomically(ledger, { type: "SetRate", height: 20n, by: ADMIN, coin: 0, rate: 0n }, "RATE_OUT_OF_RANGE");
    const before = ledger.getDy(0, 1, 100n * E18, 20n);
    ledger.append({ type: "SetRate", height: 20n, by: ADMIN, coin: 0, rate: (E18 * 110n) / 100n });
    const after = ledger.getDy(0, 1, 100n * E18, 20n);
    expect(after > before).toBe(true);
    expectRejectedAtomically(ledger, { type: "SetRate", height: 29n, by: ADMIN, coin: 0, rate: E18 }, "RATE_UPDATE_TOO_SOON");
  });
});

describe("ledger", () => {
  it("replay and fromEvents reproduce state and receipts exactly", () => {
    const ledger = bootstrapped();
    ledger.append({ type: "Exchange", height: 2n, by: "t", i: 0, j: 2, dx: 5n * E18, minDy: 0n });
    ledger.append({ type: "AddLiquidity", height: 3n, by: "lp1", amounts: [0n, 7n * E6, 0n], minMint: 0n });
    expect(replay(ledger.params, ledger.events)).toEqual(ledger.state);
    expect(PoolLedger.fromEvents(ledger.params, ledger.events).receipts).toEqual(ledger.receipts);
  });

  it("rejects unknown events and malformed fields atomically", () => {
    const ledger = bootstrapped();
    expectRejectedAtomically(ledger, { type: "Mint", height: 2n } as unknown as PoolEvent, "INVALID_EVENT");
    expectRejectedAtomically(ledger, { type: "Exchange", height: 2, by: "t", i: 0, j: 1, dx: 1n, minDy: 0n } as unknown as PoolEvent, "INVALID_EVENT");
    expectRejectedAtomically(ledger, { type: "Exchange", height: 2n, by: "", i: 0, j: 1, dx: E18, minDy: 0n }, "INVALID_EVENT");
    expectRejectedAtomically(ledger, { type: "AddLiquidity", height: 2n, by: "a", amounts: [1n], minMint: 0n }, "INVALID_EVENT");
    expectRejectedAtomically(ledger, { type: "AddLiquidity", height: 2n, by: "a", amounts: [-1n, 0n, 0n], minMint: 0n }, "INVALID_EVENT");
    expectCode(() => ledger.getDy(0, 1, E18, 0n), "HEIGHT_REGRESSION");
  });
});

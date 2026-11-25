import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  LOCKED_HOLDER,
  PoolLedger,
  ampAt,
  getDDown,
  getDUp,
  invariantResidual,
  replay,
  xpOf,
  type Amount,
  type PoolEvent,
  type PoolParams,
  type PoolState,
  type Receipt,
} from "../src/index.js";
import { ADMIN, RUNS, E18, expectConservation, params, units } from "./helpers.js";

const LPS = ["lp0", "lp1", "lp2"] as const;
/** Fractions in parts per billion, biased toward both dust and large trades. */
const ppb = fc.oneof(
  fc.bigInt({ min: 1n, max: 1_000n }),
  fc.bigInt({ min: 1_000n, max: 10_000_000n }),
  fc.bigInt({ min: 10_000_000n, max: 600_000_000n }),
);
const coin = fc.integer({ min: 0, max: 2 });
const lp = fc.constantFrom(...LPS);

type Cmd =
  | { k: "add"; by: string; f: [bigint, bigint, bigint]; zero: number }
  | { k: "remove"; by: string; f: bigint }
  | { k: "removeImb"; by: string; f: [bigint, bigint, bigint]; zero: number }
  | { k: "removeOne"; by: string; f: bigint; c: number }
  | { k: "swap"; i: number; j: number; f: bigint }
  | { k: "swapOut"; i: number; j: number; f: bigint }
  | { k: "ramp"; up: boolean; factor: bigint; dur: bigint }
  | { k: "fees"; fee: bigint }
  | { k: "rate"; c: number; bps: bigint; up: boolean }
  | { k: "withdrawAdmin" }
  | { k: "wait"; dh: bigint };

const triple = fc.tuple(ppb, ppb, ppb);
const command: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant("add" as const), by: lp, f: triple, zero: fc.integer({ min: -1, max: 2 }) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("remove" as const), by: lp, f: ppb }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("removeImb" as const), by: lp, f: triple, zero: fc.integer({ min: -1, max: 2 }) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("removeOne" as const), by: lp, f: ppb, c: coin }) },
  { weight: 6, arbitrary: fc.record({ k: fc.constant("swap" as const), i: coin, j: coin, f: ppb }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("swapOut" as const), i: coin, j: coin, f: ppb }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("ramp" as const), up: fc.boolean(), factor: fc.bigInt({ min: 1n, max: 12n }), dur: fc.bigInt({ min: 50n, max: 400n }) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("fees" as const), fee: fc.bigInt({ min: 0n, max: 50_000_000n }) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("rate" as const), c: coin, bps: fc.bigInt({ min: 0n, max: 1_200n }), up: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ k: "withdrawAdmin" as const }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("wait" as const), dh: fc.bigInt({ min: 0n, max: 120n }) }) },
);

const frac = (v: bigint, f: bigint): bigint => (v * f) / 1_000_000_000n;

const paramsArb = fc.record({
  A: fc.oneof(fc.constant(1n), fc.bigInt({ min: 1n, max: 5_000n })),
  fee: fc.oneof(fc.constant(0n), fc.bigInt({ min: 0n, max: 40_000_000n })),
  adminFee: fc.oneof(fc.constant(0n), fc.constant(5_000_000_000n), fc.bigInt({ min: 0n, max: 10_000_000_000n })),
});

/** Mostly realistic pools (ratios within 1:20), sometimes tiny or extremely skewed ones. */
const initialDeposits = fc.oneof(
  { weight: 4, arbitrary: fc.bigInt({ min: 1n, max: 10_000_000n }).chain((base) => fc.tuple(...[0, 1, 2].map(() => fc.bigInt({ min: base, max: base * 20n })) as [fc.Arbitrary<bigint>, fc.Arbitrary<bigint>, fc.Arbitrary<bigint>])) },
  { weight: 1, arbitrary: fc.tuple(fc.bigInt({ min: 1n, max: 10_000_000n }), fc.bigInt({ min: 1n, max: 10_000_000n }), fc.bigInt({ min: 1n, max: 10_000_000n })) },
);

/** Events whose effect on value per share must be >= 0 (everything except explicit, accounted changes). */
const VALUE_PRESERVING = new Set<PoolEvent["type"]>([
  "AddLiquidity",
  "RemoveLiquidity",
  "RemoveLiquidityImbalance",
  "RemoveLiquidityOneCoin",
  "Exchange",
  "ExchangeExactOut",
]);

interface Trace {
  ledger: PoolLedger;
  accepted: number;
  rejected: Map<string, number>;
}

function toEvent(cmd: Cmd, s: PoolState, h: bigint): PoolEvent | null {
  const sharesOf = (by: string): bigint => s.shares.get(by) ?? 0n;
  switch (cmd.k) {
    case "add": {
      const amounts = s.balances.map((b, k) => (k === cmd.zero ? 0n : frac(b === 0n ? units(1n, 1n, 1n)[k]! : b, cmd.f[k]!)));
      return { type: "AddLiquidity", height: h, by: cmd.by, amounts, minMint: 0n };
    }
    case "remove":
      return { type: "RemoveLiquidity", height: h, by: cmd.by, shares: frac(sharesOf(cmd.by), cmd.f), minAmounts: [0n, 0n, 0n] };
    case "removeImb": {
      const amounts = s.balances.map((b, k) => (k === cmd.zero ? 0n : frac(b, cmd.f[k]! / 2n)));
      return { type: "RemoveLiquidityImbalance", height: h, by: cmd.by, amounts, maxBurn: sharesOf(cmd.by) };
    }
    case "removeOne":
      return { type: "RemoveLiquidityOneCoin", height: h, by: cmd.by, shares: frac(sharesOf(cmd.by), cmd.f), coin: cmd.c, minAmount: 0n };
    case "swap":
      return { type: "Exchange", height: h, by: "trader", i: cmd.i, j: cmd.j, dx: frac(s.balances[cmd.i]!, cmd.f), minDy: 0n };
    case "swapOut":
      return { type: "ExchangeExactOut", height: h, by: "trader", i: cmd.i, j: cmd.j, dy: frac(s.balances[cmd.j]!, cmd.f), maxDx: 2n ** 255n };
    case "ramp": {
      const a = ampAt(s.ramp, h) / 100n;
      const futureA = cmd.up ? a * cmd.factor : a / cmd.factor;
      return { type: "RampA", height: h, by: ADMIN, futureA, futureHeight: h + cmd.dur };
    }
    case "fees":
      return s.pendingFees === null
        ? { type: "CommitFees", height: h, by: ADMIN, fee: cmd.fee, adminFee: s.adminFee }
        : { type: "ApplyFees", height: h, by: ADMIN, fee: s.pendingFees.fee, adminFee: s.pendingFees.adminFee };
    case "rate": {
      const old = s.rates[cmd.c]!;
      const delta = (old * cmd.bps) / 10_000n;
      return { type: "SetRate", height: h, by: ADMIN, coin: cmd.c, rate: cmd.up ? old + delta : old - delta };
    }
    case "withdrawAdmin":
      return { type: "WithdrawAdminFees", height: h, by: ADMIN };
    case "wait":
      return null;
  }
}

function preview(ledger: PoolLedger, e: PoolEvent): bigint | null {
  try {
    switch (e.type) {
      case "Exchange":
        return ledger.getDy(e.i, e.j, e.dx, e.height);
      case "ExchangeExactOut":
        return ledger.getDx(e.i, e.j, e.dy, e.height);
      case "AddLiquidity":
        return ledger.calcTokenAmount(e.amounts, true, e.height);
      case "RemoveLiquidityImbalance":
        return ledger.calcTokenAmount(e.amounts, false, e.height);
      case "RemoveLiquidityOneCoin":
        return ledger.calcWithdrawOneCoin(e.shares, e.coin, e.height);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function previewed(r: Receipt): bigint | null {
  switch (r.type) {
    case "Exchange":
      return r.dy;
    case "ExchangeExactOut":
      return r.dx;
    case "AddLiquidity":
      return r.minted;
    case "RemoveLiquidityImbalance":
      return r.burned;
    case "RemoveLiquidityOneCoin":
      return r.dy;
    default:
      return null;
  }
}

function checkStep(p: PoolParams, before: PoolState, e: PoolEvent, r: Receipt, after: PoolState): void {
  expectConservation(after);
  if (before.supply > 0n) {
    // Bootstrap guard: the locked shares exist forever and supply never returns to 0.
    expect(after.shares.get(LOCKED_HOLDER)).toBe(p.minimumLiquidity);
    expect(after.supply >= p.minimumLiquidity).toBe(true);
  }
  if (!VALUE_PRESERVING.has(e.type) || before.supply === 0n) return;
  const amp = ampAt(before.ramp, e.height);
  const xb = xpOf(before.balances, before.rates);
  const xa = xpOf(after.balances, after.rates);
  let dUpAfter: bigint;
  let dDownBefore: bigint;
  try {
    dUpAfter = getDUp(xa, amp);
    dDownBefore = getDDown(xb, amp);
  } catch (error) {
    // Proportional exits never price anything, so they must keep working even on states
    // (e.g. after a rate change) where Newton's D does not converge. Every other event
    // computed D itself, so it cannot have been accepted on such a state.
    expect((error as { code?: string }).code).toBe("NO_CONVERGENCE");
    expect(e.type).toBe("RemoveLiquidity");
    return;
  }
  // Value per share never decreases: D1/supply1 >= D0/supply0, up to the
  // one-unit resolution of the (irrational) real D.
  expect(dUpAfter * before.supply >= dDownBefore * after.supply, `${e.type}: virtual price decreased`).toBe(true);
  if (e.type === "Exchange" || e.type === "ExchangeExactOut") {
    // Exact: the post-swap balances lie on or above the level set of ⌈D_before⌉.
    const d0 = getDUp(xb, amp);
    expect(invariantResidual(xa, d0, amp) >= 0n, "swap moved below the level set of D0").toBe(true);
    expect(getDDown(xa, amp) >= d0, "swap lowered D").toBe(true);
    if (r.type === "Exchange" || r.type === "ExchangeExactOut") expect(r.dyQuoted >= r.dy).toBe(true);
  }
  if (e.type === "ExchangeExactOut" && r.type === "ExchangeExactOut") expect(r.dy).toBe(e.dy);
}

function run(p: PoolParams, initial: readonly bigint[], cmds: readonly Cmd[]): Trace {
  const ledger = new PoolLedger(p);
  const trace: Trace = { ledger, accepted: 0, rejected: new Map() };
  const boot = ledger.tryAppend({ type: "AddLiquidity", height: 1n, by: "lp0", amounts: units(initial[0]!, initial[1]!, initial[2]!), minMint: 0n });
  if (!boot.ok) {
    // Extreme bootstrap imbalance at low A: Newton's D does not converge, so the pool refuses it.
    expect(boot.error.code).toBe("NO_CONVERGENCE");
    expect(ledger.events.length).toBe(0);
    return trace;
  }
  trace.accepted = 1;
  let h = 1n;
  for (const cmd of cmds) {
    if (cmd.k === "wait") {
      h += cmd.dh;
      continue;
    }
    const before = ledger.state;
    const e = toEvent(cmd, before, h);
    if (e === null) continue;
    const quoted = preview(ledger, e);
    const res = ledger.tryAppend(e);
    if (!res.ok) {
      trace.rejected.set(res.error.code, (trace.rejected.get(res.error.code) ?? 0) + 1);
      expect(ledger.state).toBe(before);
      expect(quoted === null || res.error.code === "SLIPPAGE" || res.error.code === "INSUFFICIENT_SHARES").toBe(true);
      continue;
    }
    trace.accepted++;
    const got = previewed(res.receipt);
    if (got !== null) expect(quoted, `${e.type} preview`).toBe(got);
    checkStep(p, before, e, res.receipt, res.state);
  }
  return trace;
}

const sequences = fc.array(command, { minLength: 1, maxLength: 60, size: "max" });

describe("invariants over random operation sequences", () => {
  it("conservation, value-per-share monotonicity, D never decreases on swaps, previews equal executions, bootstrap lock, atomicity", () => {
    fc.assert(
      fc.property(paramsArb, initialDeposits, sequences, (pa, initial, cmds) => {
        const p = params(pa);
        const t = run(p, initial, cmds);
        // Determinism: the log alone reproduces the state.
        expect(replay(p, t.ledger.events)).toEqual(t.ledger.state);
        expect(PoolLedger.fromEvents(p, t.ledger.events).receipts).toEqual(t.ledger.receipts);
      }),
      { numRuns: RUNS },
    );
  });

  it("a balanced pool with a 2-coin and an 8-coin layout keeps the same invariants", () => {
    for (const n of [2, 8]) {
      const coins = Array.from({ length: n }, (_, k) => ({ symbol: `c${k}`, rate: k % 2 === 0 ? E18 : 10n ** 30n }));
      const amounts = coins.map((c) => (c.rate === E18 ? 1_000_000n * E18 : 1_000_000n * 10n ** 6n));
      fc.assert(
        fc.property(
          fc.array(fc.tuple(fc.integer({ min: 0, max: n - 1 }), fc.integer({ min: 0, max: n - 1 }), ppb), { maxLength: 30 }),
          (swaps) => {
            const p = params({ coins });
            const ledger = new PoolLedger(p);
            ledger.append({ type: "AddLiquidity", height: 1n, by: "lp0", amounts, minMint: 0n });
            for (const [i, j, f] of swaps) {
              const before = ledger.state;
              const e: PoolEvent = { type: "Exchange", height: 2n, by: "t", i, j, dx: frac(before.balances[i]!, f), minDy: 0n };
              const res = ledger.tryAppend(e);
              if (res.ok) checkStep(p, before, e, res.receipt, res.state);
            }
          },
        ),
        { numRuns: Math.max(20, RUNS / 5) },
      );
    }
  });

  it("re-submitting an accepted state-changing event at a later height never re-mints or double-pays beyond the pool's own rules", () => {
    fc.assert(
      fc.property(paramsArb, initialDeposits, sequences, (pa, initial, cmds) => {
        const p = params(pa);
        const t = run(p, initial, cmds);
        const before: Amount = t.ledger.state.supply;
        // Replaying the bootstrap is an ordinary deposit, never a second bootstrap.
        const r = t.ledger.tryAppend(t.ledger.events[0]!);
        if (r.ok && r.receipt.type === "AddLiquidity") {
          expect(r.receipt.locked).toBe(0n);
          expect(t.ledger.state.supply > before).toBe(true);
        }
      }),
      { numRuns: Math.max(30, RUNS / 4) },
    );
  });
});

describe("generator coverage", () => {
  it("random sequences accept every operation type and reach the important rejection classes", () => {
    const accepted = new Map<string, number>();
    const codes = new Set<string>();
    for (const [pa, initial, cmds] of fc.sample(fc.tuple(paramsArb, initialDeposits, sequences), 300)) {
      const t = run(params(pa), initial, cmds);
      for (const e of t.ledger.events) accepted.set(e.type, (accepted.get(e.type) ?? 0) + 1);
      for (const c of t.rejected.keys()) codes.add(c);
    }
    for (const type of ["AddLiquidity", "RemoveLiquidity", "RemoveLiquidityImbalance", "RemoveLiquidityOneCoin", "Exchange", "ExchangeExactOut", "RampA", "CommitFees", "ApplyFees", "SetRate", "WithdrawAdminFees"]) {
      expect(accepted.get(type) ?? 0, type).toBeGreaterThan(5);
    }
    for (const code of ["BELOW_MIN_TRADE", "INVALID_EVENT", "RAMP_TOO_EARLY", "A_CHANGE_TOO_LARGE", "ADMIN_DELAY", "RATE_CHANGE_TOO_LARGE"]) {
      expect(codes, code).toContain(code);
    }
  });
});

export { run as runSequence, sequences, paramsArb, initialDeposits };

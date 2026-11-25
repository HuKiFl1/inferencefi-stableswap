import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Mutation-style check: each mutant injects one realistic bug into a copy of
 * src/, and an independent battery of checks must fail on it. The unmutated
 * copy must pass the same battery, so a "kill" cannot come from the harness.
 */

type M = typeof import("../src/index.js");

interface Mutant {
  readonly id: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

const MUTANTS: readonly Mutant[] = [
  // math.ts: solver
  { id: "getD-formula", file: "math.ts", find: "+ (n + 1n) * dP;", replace: "+ n * dP;" },
  { id: "getD-silent-last-guess", file: "math.ts", find: "  throw new PoolError(\"NO_CONVERGENCE\", `D did not converge within ${maxIterations} iterations`);", replace: "  return d;" },
  { id: "getDDown-returns-ceil", file: "math.ts", find: "return invariantResidual(xp, up, amp) === 0n ? up : up - 1n;", replace: "return up;" },
  // pool-math.ts: rounding and fees
  { id: "swap-fee-rounded-down", file: "pool-math.ts", find: "const feeXp = mulDivUp(dyGross, s.fee, FEE_DENOMINATOR);", replace: "const feeXp = mulDivDown(dyGross, s.fee, FEE_DENOMINATOR);" },
  { id: "swap-output-plus-one", file: "pool-math.ts", find: "const dyGross = xpJ - y - 1n;", replace: "const dyGross = xpJ - y + 1n;" },
  { id: "bootstrap-no-lock", file: "pool-math.ts", find: "minted: d1 - s.minimumLiquidity,", replace: "minted: d1," },
  { id: "imbalance-fee-rate", file: "pool-math.ts", find: "return divUp(fee * nn, 4n * (nn - 1n));", replace: "return divUp(fee * nn, 4n * nn);" },
  { id: "mint-rounded-up", file: "pool-math.ts", find: "mulDivDown(s.supply, d2 - d0, d0)", replace: "mulDivUp(s.supply, d2 - d0, d0)" },
  { id: "burn-rounded-down", file: "pool-math.ts", find: "const burned = mulDivDown(d0 - d2, s.supply, d0) + 1n;", replace: "const burned = mulDivDown(d0 - d2, s.supply, d0);" },
  { id: "one-coin-fee-ignored", file: "pool-math.ts", find: "const r = xk - mulDivUp(feeRate, expected, FEE_DENOMINATOR);", replace: "const r = xk;" },
  // machine.ts: admin limits
  { id: "ramp-no-10x-limit", file: "machine.ts", find: "const tooLarge = target < current ? target * MAX_A_CHANGE < current : target > current * MAX_A_CHANGE;", replace: "const tooLarge = false;" },
  { id: "ramp-no-min-duration", file: "machine.ts", find: "if (e.futureHeight < h + params.minRampBlocks)", replace: "if (e.futureHeight < h)" },
  { id: "rate-unbounded", file: "machine.ts", find: "if (absDiff(e.rate, old) * BPS > old * params.maxRateChangeBps) {", replace: "if (false) {" },
  // machine.ts: settlement
  { id: "stale-off-by-one", file: "machine.ts", find: "if (h < b.progressHeight + params.stalenessBlocks) {", replace: "if (h + 1n < b.progressHeight + params.stalenessBlocks) {" },
  { id: "reclaim-window-off-by-one", file: "machine.ts", find: "if (h < b.reclaimableAt) throw", replace: "if (h + 1n < b.reclaimableAt) throw" },
  { id: "reclaim-amount-unbound", file: "machine.ts", find: "if (e.nonce !== b.nonce || e.amount !== b.recoverable) {", replace: "if (e.nonce !== b.nonce) {" },
  { id: "write-down-lp-first", file: "machine.ts", find: "const fromAdmin = min(excess, adm);", replace: "const fromAdmin = 0n;" },
  { id: "cap-ignores-admin-balance", file: "machine.ts", find: "    const holdings = at(balances, k) + at(adminBalances, k);", replace: "    const holdings = at(balances, k);" },
  {
    id: "challenge-guards-wrong-side",
    file: "machine.ts",
    find: "if (mode.challenged.includes(i)) throw new PoolError(\"COIN_IN_CHALLENGE\", `coin ${i} cannot be sold into the pool`);\n  const q = quoteExchange(",
    replace: "if (mode.challenged.includes(j)) throw new PoolError(\"COIN_IN_CHALLENGE\", `coin ${i} cannot be sold into the pool`);\n  const q = quoteExchange(",
  },
  { id: "no-wind-down", file: "machine.ts", find: "function requireTrading(mode: PoolMode): void {\n  if (mode.windDown) {", replace: "function requireTrading(mode: PoolMode): void {\n  if (false) {" },
  // ledger.ts: atomicity and the lock
  { id: "no-rollback-on-listener-failure", file: "ledger.ts", find: "      this.#state = previous;\n", replace: "" },
  { id: "no-reentrancy-lock", file: "ledger.ts", find: "if (this.#locked) throw new PoolError(\"REENTRANCY\"", replace: "if (false) throw new PoolError(\"REENTRANCY\"" },
];

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

function battery(m: M): void {
  const base = {
    A: 200n,
    fee: 4_000_000n,
    adminFee: 5_000_000_000n,
    admin: "admin",
    minRampBlocks: 100n,
    adminDelayBlocks: 50n,
    minimumLiquidity: 1_000n,
    minInitialD: E18,
    minTradeAmount: 1_000_000n,
    maxRateChangeBps: 1_000n,
    minRateUpdateBlocks: 10n,
    stalenessBlocks: 10n,
    challengeWindowBlocks: 5n,
  };
  const coins3 = [
    { symbol: "a", rate: E18 },
    { symbol: "b", rate: 10n ** 30n },
    { symbol: "c", rate: 10n ** 30n, backed: true },
  ];
  const u3 = (a: bigint, b: bigint, c: bigint) => [a * E18, b * E6, c * E6];
  const code = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (error) {
      return (error as { code?: string }).code ?? "untyped";
    }
    return undefined;
  };

  // 1. Solver against the independent paper reference (exact bisection roots).
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/stableswap-paper-reference.json", import.meta.url), "utf8")) as {
    rates: string[];
    cases: { balances: string[]; A: number; dUp: string; dDown: string }[];
  };
  const rates = fixture.rates.map(BigInt);
  for (const c of fixture.cases) {
    const xp = m.xpOf(c.balances.map(BigInt), rates);
    const amp = BigInt(c.A) * m.A_PRECISION;
    assert.equal(m.getDUp(xp, amp), BigInt(c.dUp));
    assert.equal(m.getDDown(xp, amp), BigInt(c.dDown));
    const newton = m.getD(xp, amp);
    assert.ok(newton >= BigInt(c.dDown) - 2n && newton <= BigInt(c.dUp) + 2n);
  }
  // A state on which Newton's integer iteration cycles (A = 1, ~2000:1); it must revert, not return a guess.
  const cycling = [2_000n * E18, E6, E6];
  assert.equal(code(() => m.getD(m.xpOf(cycling, rates), 1n * m.A_PRECISION)), "NO_CONVERGENCE");
  for (const xp of [[E18, 3n * E18], [7n * E18 + 3n, 11n * E18 + 5n, 13n * E18 + 1n]]) {
    const up = m.getDUp(xp, 20_000n);
    const down = m.getDDown(xp, 20_000n);
    assert.ok(m.invariantResidual(xp, down, 20_000n) >= 0n && m.invariantResidual(xp, up, 20_000n) <= 0n);
    assert.ok(up - down <= 1n);
  }
  assert.equal(m.imbalanceFeeRate(4_000_000n, 3), 1_500_000n);
  assert.equal(m.imbalanceFeeRate(4_000_000n, 2), 2_000_000n);

  // 2. Swaps: on/above the curve, fee at least the rational fee (18-decimal coins make it exact).
  const coins2 = [{ symbol: "x", rate: E18 }, { symbol: "y", rate: E18 }];
  for (let k = 1n; k <= 40n; k++) {
    for (const fee of [0n, base.fee]) {
      const l = new m.PoolLedger({ ...base, fee, coins: coins2 });
      l.append({ type: "AddLiquidity", height: 1n, by: "lp", amounts: [1_000n * E18, 3_000n * E18], minMint: 0n });
      const before = l.state;
      const d0 = m.getDUp(m.xpOf(before.balances, before.rates), 20_000n);
      const r = l.append({ type: "Exchange", height: 1n, by: "t", i: 0, j: 1, dx: (k * 7_919n * E18) / 100n + k, minDy: 0n });
      assert.ok(r.type === "Exchange");
      assert.ok(m.invariantResidual(m.xpOf(l.state.balances, l.state.rates), d0, 20_000n) >= 0n);
      assert.ok(r.feeXp * m.FEE_DENOMINATOR >= fee * (r.feeXp + r.dy));
    }
  }

  // 3. Bootstrap lock, mint floor, burn ceil, one-coin fee.
  const pool = (over = {}) => {
    const l = new m.PoolLedger({ ...base, coins: coins3, ...over });
    l.append({ type: "BackingUpdated", height: 1n, coin: 2, nonce: 1n, recoverable: 2_000_000n * E6, stateRoot: "r1" });
    l.append({ type: "AddLiquidity", height: 1n, by: "lp", amounts: u3(1_000_000n, 1_000_000n, 1_000_000n), minMint: 0n });
    return l;
  };
  const l1 = pool();
  assert.equal(l1.sharesOf(m.LOCKED_HOLDER), 1_000n);
  assert.equal(l1.sharesOf("lp") + 1_000n, l1.state.supply);
  assert.equal(l1.virtualPrice(1n), E18);
  // A fee-paying swap first, so supply != D and the mint division is not exact.
  l1.append({ type: "Exchange", height: 2n, by: "t", i: 1, j: 0, dx: 54_321n * E6 + 7n, minDy: 0n });
  const s0 = l1.state.supply;
  const add = l1.append({ type: "AddLiquidity", height: 2n, by: "lp2", amounts: [123_456_789n * E18 / 1_000n + 1n, 0n, 0n], minMint: 0n });
  assert.ok(add.type === "AddLiquidity" && add.fees[1]! > 0n);
  assert.ok(add.minted * add.d0 <= s0 * (add.d2 - add.d0));
  assert.ok((s0 * (add.d2 - add.d0)) % add.d0 !== 0n);
  const one = l1.append({ type: "RemoveLiquidityOneCoin", height: 2n, by: "lp", shares: 10_000n * E18, coin: 1, minAmount: 0n });
  assert.ok(one.type === "RemoveLiquidityOneCoin");
  assert.ok(one.fee * m.FEE_DENOMINATOR * 2n >= one.dy * m.imbalanceFeeRate(base.fee, 3));

  const l0 = pool({ fee: 0n });
  const xb = m.xpOf(l0.state.balances, l0.state.rates);
  const sb = l0.state.supply;
  const burn = l0.append({ type: "RemoveLiquidityImbalance", height: 2n, by: "lp", amounts: [77_777n * E18 + 3n, 0n, 0n], maxBurn: 2n ** 200n });
  const d0 = m.getDUp(xb, 20_000n);
  const d2 = m.getDDown(m.xpOf(l0.state.balances, l0.state.rates), 20_000n);
  assert.ok(burn.type === "RemoveLiquidityImbalance" && burn.burned * d0 > sb * (d0 - d2));

  // 4. Admin limits.
  const l2 = pool();
  assert.equal(code(() => l2.append({ type: "RampA", height: 100n, by: "admin", futureA: 2_001n, futureHeight: 300n })), "A_CHANGE_TOO_LARGE");
  assert.equal(code(() => l2.append({ type: "RampA", height: 100n, by: "admin", futureA: 400n, futureHeight: 150n })), "RAMP_TOO_FAST");
  assert.equal(code(() => l2.append({ type: "SetRate", height: 20n, by: "admin", coin: 0, rate: E18 * 2n })), "RATE_CHANGE_TOO_LARGE");

  // 5. Settlement: cap includes admin fees, admin-first write-down, staleness and window boundaries, payload binding.
  const l3 = pool();
  l3.append({ type: "Exchange", height: 2n, by: "t", i: 0, j: 2, dx: 100_000n * E18, minDy: 0n });
  const adm = l3.state.adminBalances[2]!;
  const lpBal = l3.state.balances[2]!;
  const room = 2_000_000n * E6 - lpBal - adm;
  assert.equal(code(() => l3.append({ type: "AddLiquidity", height: 2n, by: "x", amounts: [0n, 0n, room + 1n], minMint: 0n })), "BACKING_EXCEEDED");
  const wd = l3.append({ type: "BackingUpdated", height: 3n, coin: 2, nonce: 2n, recoverable: lpBal + adm - 1n, stateRoot: "r2" });
  assert.ok(wd.type === "BackingUpdated" && wd.writtenDownFromAdmin === 1n);
  assert.equal(code(() => l3.append({ type: "BackingChallenged", height: 12n, by: "k", coin: 2 })), "NOT_STALE");
  l3.append({ type: "BackingChallenged", height: 13n, by: "k", coin: 2 });
  assert.equal(code(() => l3.append({ type: "Exchange", height: 13n, by: "t", i: 2, j: 0, dx: E6, minDy: 0n })), "COIN_IN_CHALLENGE");
  l3.append({ type: "Exchange", height: 13n, by: "t", i: 0, j: 2, dx: E18, minDy: 0n });
  const b = l3.state.backing[2]!;
  assert.equal(code(() => l3.append({ type: "BackingReclaimed", height: 17n, by: "k", coin: 2, nonce: b.nonce, amount: b.recoverable })), "CHALLENGE_WINDOW_OPEN");
  assert.equal(code(() => l3.append({ type: "BackingReclaimed", height: 18n, by: "k", coin: 2, nonce: b.nonce, amount: b.recoverable + 1n })), "PAYLOAD_MISMATCH");
  l3.append({ type: "BackingReclaimed", height: 18n, by: "k", coin: 2, nonce: b.nonce, amount: b.recoverable });
  assert.equal(code(() => l3.append({ type: "Exchange", height: 18n, by: "t", i: 0, j: 1, dx: E18, minDy: 0n })), "WIND_DOWN");

  // 6. Ledger atomicity and the shared lock.
  const l4 = pool();
  const stop = l4.subscribe(() => {
    throw new Error("listener failed");
  });
  const st = l4.state;
  assert.throws(() => l4.append({ type: "Exchange", height: 2n, by: "t", i: 0, j: 1, dx: E18, minDy: 0n }));
  assert.equal(l4.state, st);
  stop();
  let inner: string | undefined;
  l4.subscribe(() => {
    inner ??= code(() => l4.append({ type: "Exchange", height: 2n, by: "x", i: 0, j: 1, dx: E18, minDy: 0n })) ?? "accepted";
  });
  l4.append({ type: "Exchange", height: 2n, by: "t", i: 0, j: 1, dx: E18, minDy: 0n });
  assert.equal(inner, "REENTRANCY");
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = join(root, ".mutants", `run-${process.pid}`);

async function load(id: string, mutate?: Mutant): Promise<M> {
  const dir = join(workDir, id);
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
  if (mutate !== undefined) {
    const path = join(dir, "src", mutate.file);
    const text = readFileSync(path, "utf8");
    const count = text.split(mutate.find).length - 1;
    if (count !== 1) throw new Error(`mutant ${mutate.id}: pattern found ${count} times in ${mutate.file}`);
    writeFileSync(path, text.replace(mutate.find, mutate.replace));
  }
  return (await import(pathToFileURL(join(dir, "src", "index.ts")).href)) as M;
}

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("mutation testing", () => {
  it("the unmutated copy passes the battery", async () => {
    battery(await load("control"));
  });

  it.each(MUTANTS.map((mt) => [mt.id, mt] as const))("kills %s", async (_id, mutant) => {
    const m = await load(mutant.id, mutant);
    expect(() => battery(m), `mutant ${mutant.id} survived`).toThrow();
  });
});

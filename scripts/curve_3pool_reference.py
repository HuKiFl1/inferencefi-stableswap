#!/usr/bin/env python3
"""Reference values for tests/reference.test.ts.

A line-by-line transcription of the pure math in Curve's StableSwap3Pool.vy
(curvefi/curve-contract, contracts/pools/3pool/StableSwap3Pool.vy):

  get_D                   lines 195-220
  calc_token_amount       lines 243-268
  get_y                   lines 356-398
  get_dy                  lines 402-412
  exchange (dy part)      lines 431-480
  get_y_D                 lines 584-627
  _calc_withdraw_one_coin lines 630-661

Python ints are unbounded and `//` floors, which matches Vyper uint256
arithmetic for every value in this table (none overflows 2**256 and none is
negative). Only the standard library is used. Run:

    python3 scripts/curve_3pool_reference.py > tests/fixtures/curve-3pool-reference.json

Optional second implementation: set CURVE_SIMULATION_PY to a local copy of
curve-contract's tests/simulation.py (not vendored here; it is not under a
permissive license). Its `Curve.D()` and `Curve.y()` are then evaluated on
every converging case and must agree to the wei; the result is recorded in
the fixture's `crossChecks`.
"""
import importlib.util
import json
import os

N_COINS = 3
FEE_DENOMINATOR = 10**10
LENDING_PRECISION = 10**18
PRECISION = 10**18
# DAI (18 decimals), USDC (6), USDT (6)
PRECISION_MUL = [1, 10**12, 10**12]
RATES = [10**18, 10**30, 10**30]


def _xp(balances):
    return [RATES[i] * balances[i] // LENDING_PRECISION for i in range(N_COINS)]


def get_D_raw(xp, amp):
    """3pool get_D, reporting whether the 255-iteration loop broke on convergence."""
    S = 0
    for _x in xp:
        S += _x
    if S == 0:
        return 0, True
    Dprev = 0
    D = S
    Ann = amp * N_COINS
    for _i in range(255):
        D_P = D
        for _x in xp:
            D_P = D_P * D // (_x * N_COINS)
        Dprev = D
        D = (Ann * S + D_P * N_COINS) * D // ((Ann - 1) * D + (N_COINS + 1) * D_P)
        if D > Dprev:
            if D - Dprev <= 1:
                return D, True
        else:
            if Dprev - D <= 1:
                return D, True
    return D, False  # 3pool returns this unconverged last guess silently


def get_D(xp, amp):
    S = 0
    for _x in xp:
        S += _x
    if S == 0:
        return 0
    Dprev = 0
    D = S
    Ann = amp * N_COINS
    for _i in range(255):
        D_P = D
        for _x in xp:
            D_P = D_P * D // (_x * N_COINS)
        Dprev = D
        D = (Ann * S + D_P * N_COINS) * D // ((Ann - 1) * D + (N_COINS + 1) * D_P)
        if D > Dprev:
            if D - Dprev <= 1:
                return D  # 3pool: break; return D
        else:
            if Dprev - D <= 1:
                return D
    raise RuntimeError("get_D: 3pool would return the last iterate; reference cases must converge")


def get_y(i, j, x, xp_, amp):
    D = get_D(xp_, amp)
    c = D
    S_ = 0
    Ann = amp * N_COINS
    _x = 0
    for _i in range(N_COINS):
        if _i == i:
            _x = x
        elif _i != j:
            _x = xp_[_i]
        else:
            continue
        S_ += _x
        c = c * D // (_x * N_COINS)
    c = c * D // (Ann * N_COINS)
    b = S_ + D // Ann
    y = D
    for _i in range(255):
        y_prev = y
        y = (y * y + c) // (2 * y + b - D)
        if y > y_prev:
            if y - y_prev <= 1:
                return y
        else:
            if y_prev - y <= 1:
                return y
    raise RuntimeError("get_y did not converge")


def get_dy(i, j, dx, balances, amp, fee):
    """3pool get_dy view: fee taken on the native amount."""
    xp = _xp(balances)
    x = xp[i] + (dx * RATES[i] // PRECISION)
    y = get_y(i, j, x, xp, amp)
    dy = (xp[j] - y - 1) * PRECISION // RATES[j]
    _fee = fee * dy // FEE_DENOMINATOR
    return dy - _fee


def exchange_dy(i, j, dx, balances, amp, fee):
    """3pool exchange: fee taken on the normalised amount (what actually executes)."""
    xp = _xp(balances)
    x = xp[i] + dx * RATES[i] // PRECISION
    y = get_y(i, j, x, xp, amp)
    dy = xp[j] - y - 1
    dy_fee = dy * fee // FEE_DENOMINATOR
    return (dy - dy_fee) * PRECISION // RATES[j]


def get_y_D(A_, i, xp, D):
    c = D
    S_ = 0
    Ann = A_ * N_COINS
    _x = 0
    for _i in range(N_COINS):
        if _i != i:
            _x = xp[_i]
        else:
            continue
        S_ += _x
        c = c * D // (_x * N_COINS)
    c = c * D // (Ann * N_COINS)
    b = S_ + D // Ann
    y = D
    for _i in range(255):
        y_prev = y
        y = (y * y + c) // (2 * y + b - D)
        if y > y_prev:
            if y - y_prev <= 1:
                return y
        else:
            if y_prev - y <= 1:
                return y
    raise RuntimeError("get_y_D did not converge")


def calc_withdraw_one_coin(_token_amount, i, balances, amp, fee, total_supply):
    _fee = fee * N_COINS // (4 * (N_COINS - 1))
    precisions = PRECISION_MUL
    xp = _xp(balances)
    D0 = get_D(xp, amp)
    D1 = D0 - _token_amount * D0 // total_supply
    xp_reduced = list(xp)
    new_y = get_y_D(amp, i, xp, D1)
    dy_0 = (xp[i] - new_y) // precisions[i]
    for j in range(N_COINS):
        dx_expected = 0
        if j == i:
            dx_expected = xp[j] * D1 // D0 - new_y
        else:
            dx_expected = xp[j] - xp[j] * D1 // D0
        xp_reduced[j] -= _fee * dx_expected // FEE_DENOMINATOR
    dy = xp_reduced[i] - get_y_D(amp, i, xp_reduced, D1)
    dy = (dy - 1) // precisions[i]
    return dy, dy_0 - dy


def calc_token_amount(amounts, deposit, balances, amp, token_supply):
    D0 = get_D(_xp(balances), amp)
    new_balances = list(balances)
    for i in range(N_COINS):
        if deposit:
            new_balances[i] += amounts[i]
        else:
            new_balances[i] -= amounts[i]
    D1 = get_D(_xp(new_balances), amp)
    diff = D1 - D0 if deposit else D0 - D1
    return diff * token_supply // D0


DAI, USDC = 10**18, 10**6
POOLS = [
    ("balanced-1M", [1_000_000 * DAI, 1_000_000 * USDC, 1_000_000 * USDC]),
    ("mainnet-like-150M", [50_000_000 * DAI + 123456789, 80_000_000 * USDC + 4321, 20_000_000 * USDC + 99]),
    ("skewed-90-5-5", [9_000_000 * DAI, 500_000 * USDC, 500_000 * USDC]),
    ("small-1k", [1_000 * DAI, 1_000 * USDC, 1_000 * USDC]),
]
AMPS = [1, 100, 2000, 5000]
FEES = [0, 1_000_000, 4_000_000]
SWAPS = [(0, 1, 1 * DAI), (1, 2, 1_000 * USDC), (2, 0, 123_456 * USDC + 789), (0, 2, 250_000 * DAI + 1), (1, 0, 7)]


def load_simulation():
    path = os.environ.get("CURVE_SIMULATION_PY")
    if not path:
        return None
    spec = importlib.util.spec_from_file_location("curve_simulation", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.Curve


def non_convergence_scan():
    """States around 5000:1 (and 2000:1, 180:1) imbalance at A <= 3 where 3pool get_D may not converge."""
    out = []
    for amp in [1, 2, 3]:
        for ratio in [180, 2000, 4990, 4995, 5000, 5003, 5007, 5010, 10000]:
            for tail in [0, 7, 123456789]:
                balances = [ratio * DAI + tail, 1 * USDC, 1 * USDC]
                D, ok = get_D_raw(_xp(balances), amp)
                out.append({"A": amp, "balances": [str(b) for b in balances], "converged": ok, "lastGuess": str(D)})
    return out


def drift_cases():
    """Curve-formula swap (3pool exchange, fee 0) on a 180:1 pool at A = 1, then D recomputed."""
    out = []
    for amp in [1, 2]:
        balances = [180 * DAI, 1 * USDC, 1 * USDC]
        xp = _xp(balances)
        D0 = get_D(xp, amp)
        for (i, j, dx) in [(1, 0, 10**4), (1, 0, 10**5), (2, 0, 3 * 10**5), (0, 1, 10**15), (0, 2, 10**16)]:
            x = xp[i] + dx * RATES[i] // PRECISION
            y = get_y(i, j, x, xp, amp)
            after = list(xp)
            after[i] = x
            after[j] = y
            D1, ok = get_D_raw(after, amp)
            out.append({"A": amp, "balances": [str(b) for b in balances], "i": i, "j": j, "dx": str(dx), "D0": str(D0), "D1": str(D1), "converged": ok})
    return out


def main():
    cases = []
    for name, balances in POOLS:
        for amp in AMPS:
            xp = _xp(balances)
            D = get_D(xp, amp)
            supply = D * 98 // 100
            entry = {"pool": name, "balances": [str(b) for b in balances], "A": amp, "D": str(D), "swaps": [], "withdrawOne": [], "tokenAmount": []}
            for (i, j, dx) in SWAPS:
                xi = xp[i] + dx * RATES[i] // PRECISION
                y = get_y(i, j, xi, xp, amp)
                row = {"i": i, "j": j, "dx": str(dx), "y": str(y), "byFee": []}
                for fee in FEES:
                    row["byFee"].append({
                        "fee": fee,
                        "exchange": str(exchange_dy(i, j, dx, balances, amp, fee)),
                        "getDy": str(get_dy(i, j, dx, balances, amp, fee)),
                    })
                entry["swaps"].append(row)
            for (i, frac) in [(0, 100), (1, 10_000), (2, 3)]:
                amount = supply // frac
                byFee = []
                for fee in FEES:
                    dy, dy_fee = calc_withdraw_one_coin(amount, i, balances, amp, fee, supply)
                    byFee.append({"fee": fee, "dy": str(dy), "fee_amount": str(dy_fee)})
                entry["withdrawOne"].append({"i": i, "shares": str(amount), "supply": str(supply), "byFee": byFee})
            for (amounts, deposit) in [([10 * DAI, 0, 0], True), ([1000 * DAI, 2000 * USDC, 3000 * USDC], True), ([0, 50 * USDC, 0], False)]:
                entry["tokenAmount"].append({
                    "amounts": [str(a) for a in amounts],
                    "deposit": deposit,
                    "supply": str(supply),
                    "result": str(calc_token_amount(amounts, deposit, balances, amp, supply)),
                })
            cases.append(entry)
    cross_checks = []
    Curve = load_simulation()
    if Curve is not None:
        agreed = 0
        for c in cases:
            balances = [int(b) for b in c["balances"]]
            sim = Curve(c["A"], balances, N_COINS, p=RATES)
            assert sim.D() == int(c["D"]), c["pool"]
            agreed += 1
            for sw in c["swaps"]:
                x = _xp(balances)[sw["i"]] + int(sw["dx"]) * RATES[sw["i"]] // PRECISION
                assert sim.y(sw["i"], sw["j"], x) == int(sw["y"]), (c["pool"], sw)
                agreed += 1
        cross_checks.append("curve-contract tests/simulation.py Curve.D() and Curve.y(): %d/%d values agree to the wei" % (agreed, agreed))
    print(json.dumps({
        "source": "Line-by-line Python transcription of curvefi/curve-contract StableSwap3Pool.vy (see scripts/curve_3pool_reference.py)",
        "crossChecks": cross_checks,
        "rates": [str(r) for r in RATES],
        "cases": cases,
        "nonConvergence": non_convergence_scan(),
        "drift": drift_cases(),
    }, indent=1))


if __name__ == "__main__":
    main()

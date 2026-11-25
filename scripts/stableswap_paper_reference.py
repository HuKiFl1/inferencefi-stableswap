#!/usr/bin/env python3
"""Independent reference values for tests/reference.test.ts.

Derived from the StableSwap paper (Egorov 2019); conventions match public
Curve docs. Nothing here follows any pool implementation: every value comes
from the paper's invariant, solved exactly over the integers by bisection,
with exact rational arithmetic (fractions.Fraction) where a fee or a unit
conversion is applied and a single floor at the end.

The invariant, for n coins with normalised balances x_k, sum s and product p:

    a * n^n * s + d = a * d * n^n + d^(n+1) / (n^n * p)

`amp` below uses the convention of the public docs and of this library:
amp = a * n^(n-1), so a * n^n = amp * n. Multiplying the invariant by
n^n * p > 0 gives an integer with the same sign:

    g(x, d) = (k*s + d - k*d) * n^n * p - d^(n+1),   k = amp * n

g increases with every x_k and decreases with d for d > 0 (amp >= 1), so each
balance has one root on each side and bisection finds the integers around it:

    d_up(x)      smallest integer d >= 1 with g(x, d) <= 0     (ceiling of d)
    d_down(x)    largest integer d with g(x, d) >= 0            (floor of d)
    y_up(x, j, d) smallest integer x_j >= 1 with g(x, d) >= 0   (ceiling of y)

The root of d lies in (0, s] because g(x, s) = s * (n^n*p - s^n) <= 0 (AM-GM).

Normalisation: x_k = floor(amount_k * rate_k / 10^18), with
rate_k = 10^(36 - decimals). Fees are parts of 10^10. Run:

    python3 scripts/stableswap_paper_reference.py > tests/fixtures/stableswap-paper-reference.json

Standard library only.
"""
from fractions import Fraction
import json
import math

UNIT = 10**18
FEE_SCALE = 10**10
DECIMALS = [18, 6, 6]
RATES = [10 ** (36 - dec) for dec in DECIMALS]
N = len(RATES)


def normalise(amounts):
    return [amt * rate // UNIT for amt, rate in zip(amounts, RATES)]


def g(xs, d, amp):
    """Paper invariant times n^n * product(xs): exact integer, sign of the residual."""
    n = len(xs)
    k = amp * n
    total = sum(xs)
    prod = math.prod(xs)
    return (k * total + d - k * d) * n**n * prod - d ** (n + 1)


def d_up(xs, amp):
    lo, hi = 1, sum(xs)  # g(hi) <= 0 always; search the first d with g <= 0
    while lo < hi:
        mid = (lo + hi) // 2
        if g(xs, mid, amp) <= 0:
            hi = mid
        else:
            lo = mid + 1
    return lo


def d_down(xs, amp):
    top = d_up(xs, amp)
    return top if g(xs, top, amp) == 0 else top - 1


def y_up(xs, j, d, amp):
    """Smallest integer balance of coin j that keeps g(x, d) >= 0, other balances fixed."""
    def at(v):
        w = list(xs)
        w[j] = v
        return g(w, d, amp)
    hi = 1
    while at(hi) < 0:
        hi *= 2
    lo = 1
    while lo < hi:
        mid = (lo + hi) // 2
        if at(mid) >= 0:
            hi = mid
        else:
            lo = mid + 1
    return lo


def to_native_floor(value, rate):
    """Normalised (possibly Fraction) amount to native units, rounded down."""
    return math.floor(Fraction(value) * UNIT / rate)


def ideal_swap(balances, i, j, dx, amp, fee):
    """Largest output that keeps the post-trade state on or above ceil(d), fee applied exactly, one floor."""
    xs = normalise(balances)
    top = d_up(xs, amp)
    moved = list(xs)
    moved[i] = xs[i] + dx * RATES[i] // UNIT
    new_y = y_up(moved, j, top, amp)
    gross = xs[j] - new_y
    net = Fraction(gross) * (FEE_SCALE - fee) / FEE_SCALE
    return new_y, max(to_native_floor(net, RATES[j]), 0)


def ideal_withdraw_one(balances, shares, supply, i, amp, fee):
    """One-coin exit to d1 = d0 * (supply - shares) / supply.

    Fee rule from the public docs: each coin is charged fee * n / (4 * (n - 1))
    on how far the exit moves it from a proportional exit. Exact rationals,
    integer roots by bisection, one floor at the end.
    """
    xs = normalise(balances)
    d0 = d_up(xs, amp)
    d1 = Fraction(d0) * (supply - shares) / supply
    d1_int = math.ceil(d1)  # pool's side: the remaining state must keep at least d1
    y_plain = y_up(xs, i, d1_int, amp)
    rate = Fraction(fee * N, 4 * (N - 1) * FEE_SCALE)
    reduced = []
    for k, x in enumerate(xs):
        proportional = Fraction(x) * d1 / d0
        expected = proportional - y_plain if k == i else x - proportional
        reduced.append(Fraction(x) - rate * abs(expected))
    reduced_int = [math.floor(r) for r in reduced]
    y_fee = y_up(reduced_int, i, d1_int, amp)
    out = Fraction(reduced_int[i] - y_fee)
    return max(to_native_floor(out, RATES[i]), 0)


def lp_bounds(balances, amounts, deposit, supply, amp):
    """Range of the exact LP amount for a fee-free deposit or withdrawal, from the integer bounds on d."""
    before = normalise(balances)
    after_bal = [b + a if deposit else b - a for b, a in zip(balances, amounts)]
    after = normalise(after_bal)
    d0_lo, d0_hi = d_down(before, amp), d_up(before, amp)
    d1_lo, d1_hi = d_down(after, amp), d_up(after, amp)
    if deposit:
        low = Fraction(d1_lo - d0_hi) * supply / d0_hi
        high = Fraction(d1_hi - d0_lo) * supply / d0_lo
    else:
        low = Fraction(d0_lo - d1_hi) * supply / d0_lo
        high = Fraction(d0_hi - d1_lo) * supply / d0_hi
    return math.floor(low), math.ceil(high)


DAI, USDC = 10**18, 10**6
POOLS = [
    ("balanced-1M", [1_000_000 * DAI, 1_000_000 * USDC, 1_000_000 * USDC]),
    ("mixed-150M", [50_000_000 * DAI + 123456789, 80_000_000 * USDC + 4321, 20_000_000 * USDC + 99]),
    ("skewed-90-5-5", [9_000_000 * DAI, 500_000 * USDC, 500_000 * USDC]),
    ("small-1k", [1_000 * DAI, 1_000 * USDC, 1_000 * USDC]),
]
AMPS = [1, 100, 2000, 5000]
FEES = [0, 1_000_000, 4_000_000]
SWAPS = [(0, 1, 1 * DAI), (1, 2, 1_000 * USDC), (2, 0, 123_456 * USDC + 789), (0, 2, 250_000 * DAI + 1), (1, 0, 7)]


def extreme_states():
    """Low amp and extreme imbalance (180:1 to 10000:1), where Newton's integer iteration may cycle."""
    out = []
    for amp in [1, 2, 3]:
        for ratio in [180, 2000, 4990, 4995, 5000, 5003, 5007, 5010, 10000]:
            for tail in [0, 7, 123456789]:
                balances = [ratio * DAI + tail, 1 * USDC, 1 * USDC]
                xs = normalise(balances)
                out.append({"A": amp, "balances": [str(b) for b in balances], "dUp": str(d_up(xs, amp)), "dDown": str(d_down(xs, amp))})
    return out


def drift_states():
    """Inputs for the Newton drift check: 180:1 pools at amp 1-2 and the trades applied to them."""
    out = []
    for amp in [1, 2]:
        balances = [180 * DAI, 1 * USDC, 1 * USDC]
        xs = normalise(balances)
        for (i, j, dx) in [(1, 0, 10**4), (1, 0, 10**5), (2, 0, 3 * 10**5), (0, 1, 10**15), (0, 2, 10**16)]:
            out.append({"A": amp, "balances": [str(b) for b in balances], "i": i, "j": j, "dx": str(dx), "dUp": str(d_up(xs, amp))})
    return out


def main():
    cases = []
    for name, balances in POOLS:
        for amp in AMPS:
            xs = normalise(balances)
            top, bottom = d_up(xs, amp), d_down(xs, amp)
            supply = top * 98 // 100
            entry = {"pool": name, "balances": [str(b) for b in balances], "A": amp, "dUp": str(top), "dDown": str(bottom), "swaps": [], "withdrawOne": [], "tokenAmount": []}
            for (i, j, dx) in SWAPS:
                row = {"i": i, "j": j, "dx": str(dx), "byFee": []}
                for fee in FEES:
                    new_y, dy = ideal_swap(balances, i, j, dx, amp, fee)
                    row["yUp"] = str(new_y)
                    row["byFee"].append({"fee": fee, "dyIdeal": str(dy)})
                entry["swaps"].append(row)
            for (i, frac) in [(0, 100), (1, 10_000), (2, 3)]:
                shares = supply // frac
                byFee = [{"fee": fee, "dyIdeal": str(ideal_withdraw_one(balances, shares, supply, i, amp, fee))} for fee in FEES]
                entry["withdrawOne"].append({"i": i, "shares": str(shares), "supply": str(supply), "byFee": byFee})
            for (amounts, deposit) in [([10 * DAI, 0, 0], True), ([1000 * DAI, 2000 * USDC, 3000 * USDC], True), ([0, 50 * USDC, 0], False)]:
                low, high = lp_bounds(balances, amounts, deposit, supply, amp)
                entry["tokenAmount"].append({"amounts": [str(a) for a in amounts], "deposit": deposit, "supply": str(supply), "low": str(low), "high": str(high)})
            cases.append(entry)
    print(json.dumps({
        "source": "Independent reference from the StableSwap paper invariant (Egorov 2019), exact integer bisection and rational arithmetic; see scripts/stableswap_paper_reference.py",
        "rates": [str(r) for r in RATES],
        "cases": cases,
        "extremeStates": extreme_states(),
        "drift": drift_states(),
    }, indent=1))


if __name__ == "__main__":
    main()
